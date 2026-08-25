import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

type SessionStoreModule = typeof import("./session-store.js");

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

describe("browser session store", () => {
  it("sanitizes persisted session refs down to profileRef, resumeNonce, and lastUrl", async () => {
    const mod = await loadSessionStoreModule();
    expect(mod, "session-store module should exist").not.toBeNull();
    if (!mod) return;

    const dir = await mkdtemp(join(tmpdir(), "setup-session-store-"));
    createdDirs.push(dir);
    const filePath = join(dir, "sessions.json");
    const store = mod.createFileBrowserSessionStore(filePath);

    await store.save("posthog", {
      profileRef: "posthog-founder-1",
      resumeNonce: "nonce-123",
      lastUrl: "https://app.posthog.com/settings",
      username: "founder@example.com",
      password: "super-secret",
      otp: "123456",
      cookies: [{ name: "sessionid" }]
    } as never);

    expect(await store.load("posthog")).toEqual({
      profileRef: "posthog-founder-1",
      resumeNonce: "nonce-123",
      lastUrl: "https://app.posthog.com/settings"
    });

    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(raw).toEqual({
      posthog: {
        profileRef: "posthog-founder-1",
        resumeNonce: "nonce-123",
        lastUrl: "https://app.posthog.com/settings"
      }
    });
    expect(JSON.stringify(raw)).not.toContain("founder@example.com");
    expect(JSON.stringify(raw)).not.toContain("super-secret");
    expect(JSON.stringify(raw)).not.toContain("123456");
    expect(JSON.stringify(raw)).not.toContain("sessionid");
  });

  it("strips query and hash data from persisted lastUrl values", async () => {
    const mod = await loadSessionStoreModule();
    expect(mod, "session-store module should exist").not.toBeNull();
    if (!mod) return;

    const dir = await mkdtemp(join(tmpdir(), "setup-session-store-"));
    createdDirs.push(dir);
    const filePath = join(dir, "sessions.json");
    const store = mod.createFileBrowserSessionStore(filePath);

    await store.save("posthog", {
      profileRef: "posthog-founder-1",
      resumeNonce: "nonce-123",
      lastUrl: "https://app.posthog.com/settings/project?code=oauth-secret#access_token=token-secret"
    });

    expect(await store.load("posthog")).toEqual({
      profileRef: "posthog-founder-1",
      resumeNonce: "nonce-123",
      lastUrl: "https://app.posthog.com/settings/project"
    });

    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(raw).toEqual({
      posthog: {
        profileRef: "posthog-founder-1",
        resumeNonce: "nonce-123",
        lastUrl: "https://app.posthog.com/settings/project"
      }
    });
    expect(JSON.stringify(raw)).not.toContain("oauth-secret");
    expect(JSON.stringify(raw)).not.toContain("token-secret");
  });

  it("drops invalid lastUrl values instead of persisting raw input", async () => {
    const mod = await loadSessionStoreModule();
    expect(mod, "session-store module should exist").not.toBeNull();
    if (!mod) return;

    const dir = await mkdtemp(join(tmpdir(), "setup-session-store-"));
    createdDirs.push(dir);
    const filePath = join(dir, "sessions.json");
    const store = mod.createFileBrowserSessionStore(filePath);

    await store.save("posthog", {
      profileRef: "posthog-founder-1",
      resumeNonce: "nonce-123",
      lastUrl: "not-a-url?code=oauth-secret#access_token=token-secret"
    });

    expect(await store.load("posthog")).toEqual({
      profileRef: "posthog-founder-1",
      resumeNonce: "nonce-123"
    });

    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(raw).toEqual({
      posthog: {
        profileRef: "posthog-founder-1",
        resumeNonce: "nonce-123"
      }
    });
    expect(JSON.stringify(raw)).not.toContain("oauth-secret");
    expect(JSON.stringify(raw)).not.toContain("token-secret");
  });

  it("drops non-http lastUrl values before persisting or reloading them", async () => {
    const mod = await loadSessionStoreModule();
    expect(mod, "session-store module should exist").not.toBeNull();
    if (!mod) return;

    const dir = await mkdtemp(join(tmpdir(), "setup-session-store-"));
    createdDirs.push(dir);
    const filePath = join(dir, "sessions.json");
    const store = mod.createFileBrowserSessionStore(filePath);
    const cases = [
      ["posthog-javascript", "javascript:alert(1)"],
      ["posthog-ftp", "ftp://example.com/path?token=secret"]
    ] as const;

    for (const [sessionKey, lastUrl] of cases) {
      await store.save(sessionKey, {
        profileRef: `${sessionKey}-profile`,
        resumeNonce: `${sessionKey}-nonce`,
        lastUrl
      });

      expect(await store.load(sessionKey)).toEqual({
        profileRef: `${sessionKey}-profile`,
        resumeNonce: `${sessionKey}-nonce`
      });
    }

    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(raw).toEqual({
      "posthog-javascript": {
        profileRef: "posthog-javascript-profile",
        resumeNonce: "posthog-javascript-nonce"
      },
      "posthog-ftp": {
        profileRef: "posthog-ftp-profile",
        resumeNonce: "posthog-ftp-nonce"
      }
    });
    expect(JSON.stringify(raw)).not.toContain("javascript:alert(1)");
    expect(JSON.stringify(raw)).not.toContain("ftp://example.com/path?token=secret");
    expect(JSON.stringify(raw)).not.toContain("token=secret");
  });

  it("clears stored refs without leaving stale keys behind", async () => {
    const mod = await loadSessionStoreModule();
    expect(mod, "session-store module should exist").not.toBeNull();
    if (!mod) return;

    const dir = await mkdtemp(join(tmpdir(), "setup-session-store-"));
    createdDirs.push(dir);
    const filePath = join(dir, "sessions.json");
    const store = mod.createFileBrowserSessionStore(filePath);

    await store.save("ga4", {
      profileRef: "ga4-founder-1",
      resumeNonce: "nonce-456",
      lastUrl: "https://accounts.google.com/o/oauth2/auth"
    });
    await store.clear("ga4");

    expect(await store.load("ga4")).toBeNull();
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(raw).toEqual({});
  });

  it("treats an empty session index file as no saved browser sessions", async () => {
    const mod = await loadSessionStoreModule();
    expect(mod, "session-store module should exist").not.toBeNull();
    if (!mod) return;

    const dir = await mkdtemp(join(tmpdir(), "setup-session-store-"));
    createdDirs.push(dir);
    const filePath = join(dir, "sessions.json");
    await writeFile(filePath, "", "utf8");
    const store = mod.createFileBrowserSessionStore(filePath);

    expect(await store.load("posthog")).toBeNull();
    await store.save("posthog", {
      profileRef: "posthog-api-key",
      resumeNonce: "nonce-789",
      lastUrl: "https://us.posthog.com/settings/user-api-keys"
    });

    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(raw).toEqual({
      posthog: {
        profileRef: "posthog-api-key",
        resumeNonce: "nonce-789",
        lastUrl: "https://us.posthog.com/settings/user-api-keys"
      }
    });
  });

  it("isolates browser handoff state across workspace and run scoped session keys", async () => {
    const mod = await loadSessionStoreModule();
    expect(mod, "session-store module should exist").not.toBeNull();
    if (!mod) return;

    const dir = await mkdtemp(join(tmpdir(), "setup-session-store-"));
    createdDirs.push(dir);
    const filePath = join(dir, "sessions.json");
    const store = mod.createFileBrowserSessionStore(filePath);
    const workspaceRunOneKey = mod.buildBrowserSessionKey("posthog", "posthog-api-key", "workspace:ws_1:run:run_1");
    const workspaceRunTwoKey = mod.buildBrowserSessionKey("posthog", "posthog-api-key", "workspace:ws_2:run:run_2");

    await store.save(workspaceRunOneKey, {
      profileRef: "posthog-run-1",
      resumeNonce: "nonce-1",
      lastUrl: "https://us.posthog.com/settings/user-api-keys"
    });
    await store.save(workspaceRunTwoKey, {
      profileRef: "posthog-run-2",
      resumeNonce: "nonce-2",
      lastUrl: "https://eu.posthog.com/settings/user-api-keys"
    });

    expect(await store.load(workspaceRunOneKey)).toEqual({
      profileRef: "posthog-run-1",
      resumeNonce: "nonce-1",
      lastUrl: "https://us.posthog.com/settings/user-api-keys"
    });
    expect(await store.load(workspaceRunTwoKey)).toEqual({
      profileRef: "posthog-run-2",
      resumeNonce: "nonce-2",
      lastUrl: "https://eu.posthog.com/settings/user-api-keys"
    });

    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual([workspaceRunOneKey, workspaceRunTwoKey].sort());
  });

  it("rejects session keys with multiple provider segments", async () => {
    const mod = await loadSessionStoreModule();
    expect(mod, "session-store module should exist").not.toBeNull();
    if (!mod) return;

    const malformedKey = "scope=workspace%3Aws_1|provider=posthog|context=posthog-api-key|provider=ga4";

    expect(mod.browserSessionKeyMatchesProvider(malformedKey, "posthog")).toBe(false);
    expect(mod.browserSessionKeyMatchesProvider(malformedKey, "ga4")).toBe(false);
    expect(mod.browserSessionKeyForProvider(malformedKey, "posthog")).toBeUndefined();
    expect(mod.browserSessionKeyForProvider(malformedKey, "ga4")).toBeUndefined();

    const canonicalKey = mod.buildBrowserSessionKey("posthog", "posthog-api-key", "workspace:ws_1");
    expect(mod.browserSessionKeyMatchesProvider(canonicalKey, "posthog")).toBe(true);
    expect(mod.browserSessionKeyForProvider(canonicalKey, "posthog")).toBe(canonicalKey);
  });
});
