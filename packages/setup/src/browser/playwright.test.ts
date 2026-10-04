import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

type PlaywrightModule = typeof import("./playwright.js");
type SessionStoreModule = typeof import("./session-store.js");

async function loadPlaywrightModule(): Promise<PlaywrightModule | null> {
  try {
    return await import("./playwright.js");
  } catch {
    return null;
  }
}

async function loadSessionStoreModule(): Promise<SessionStoreModule | null> {
  try {
    return await import("./session-store.js");
  } catch {
    return null;
  }
}

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("playwright LocalBrowser factory", () => {
  it("fails with an actionable message when Playwright is unavailable", async () => {
    const mod = await loadPlaywrightModule();
    expect(mod, "playwright module should exist").not.toBeNull();
    if (!mod) return;

    const factory = mod.createPlaywrightBrowserFactory({
      loadPlaywright: async () => {
        throw new Error("Cannot find package 'playwright'");
      }
    });

    await expect(factory.create({ provider: "posthog", purpose: "provider_auth" })).rejects.toThrow(
      /playwright.*install|pnpm add -D playwright/i
    );
  });

  it("launches a persistent profile, records network activity, and persists only safe session refs", async () => {
    const mod = await loadPlaywrightModule();
    const sessionStoreMod = await loadSessionStoreModule();
    expect(mod, "playwright module should exist").not.toBeNull();
    expect(sessionStoreMod, "session-store module should exist").not.toBeNull();
    if (!mod || !sessionStoreMod) return;

    const dir = await mkdtemp(join(tmpdir(), "setup-playwright-"));
    createdDirs.push(dir);
    const profileRoot = join(dir, "profiles");
    const sessionFile = join(dir, "sessions.json");
    const sessionStore = sessionStoreMod.createFileBrowserSessionStore(sessionFile);

    let currentUrl = "about:blank";
    const responseHandlers: Array<(response: { url(): string; status(): number }) => void> = [];
    const page = {
      async goto(url: string) {
        currentUrl = url;
      },
      url() {
        return currentUrl;
      },
      async evaluate<T>(pageFunction: (arg: unknown) => Promise<T>, arg: unknown) {
        const input = arg as {
          url: string;
          init?: {
            method?: "GET" | "POST";
            headers?: Record<string, string>;
            body?: string;
          };
        };
        void pageFunction;
        return {
          ok: false,
          status: 404,
          text: JSON.stringify({
            url: input.url,
            method: input.init?.method ?? "GET"
          })
        } as T;
      },
      on(event: string, handler: (response: { url(): string; status(): number }) => void) {
        if (event === "response") {
          responseHandlers.push(handler);
        }
      }
    };
    const close = vi.fn(async () => undefined);
    const launchPersistentContext = vi.fn(async () => ({
      pages: () => [page],
      newPage: async () => page,
      close
    }));

    const factory = mod.createPlaywrightBrowserFactory({
      profileRoot,
      sessionStore,
      loadPlaywright: async () => ({
        chromium: {
          launchPersistentContext
        }
      })
    });

    const browser = await factory.create({
      provider: "posthog",
      purpose: "provider_auth",
      contextRef: "PostHog Founder/1"
    });

    const rawLaunchCalls = launchPersistentContext.mock.calls as unknown as Array<unknown[]>;
    const profilePath = rawLaunchCalls[0]?.[0];
    expect(profilePath).toEqual(expect.any(String));
    expect(profilePath).toContain("posthog-founder-1");

    await browser.goto("https://app.posthog.com/login?code=oauth-secret#access_token=token-secret");
    responseHandlers[0]?.({
      url: () => "https://us.i.posthog.com/i/v0/e/",
      status: () => 200
    });

    setTimeout(() => {
      currentUrl = "https://app.posthog.com/settings/project?api_key=phx-secret#state=session-secret";
    }, 10);

    await expect(browser.waitForSignal((url) => url.includes("/settings/project"), 250)).resolves.toEqual({
      url: "https://app.posthog.com/settings/project?api_key=phx-secret#state=session-secret"
    });
    expect(await browser.readNetwork()).toEqual([{ url: "https://us.i.posthog.com/i/v0/e/", status: 200 }]);
    await expect(browser.request("https://us.posthog.com/api/organizations/")).resolves.toMatchObject({
      ok: false,
      status: 404
    });

    const persisted = await sessionStore.load(
      sessionStoreMod.buildBrowserSessionKey("posthog", "PostHog Founder/1")
    );
    expect(persisted).toMatchObject({
      profileRef: "posthog-founder-1",
      lastUrl: "https://app.posthog.com/settings/project"
    });
    expect(persisted?.resumeNonce).toEqual(expect.any(String));
    expect(Object.keys(persisted ?? {}).sort()).toEqual(["lastUrl", "profileRef", "resumeNonce"]);

    await browser.destroy();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
