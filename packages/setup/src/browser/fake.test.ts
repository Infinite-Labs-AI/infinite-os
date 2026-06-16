import { describe, expect, it } from "vitest";

import { createFakeBrowserFactory } from "./fake.js";

describe("fake LocalBrowser", () => {
  it("rejects evasion options for provider_auth sessions", async () => {
    const factory = createFakeBrowserFactory();
    await expect(
      factory.create({ provider: "meta", purpose: "provider_auth", solveCaptchas: true })
    ).rejects.toThrow(/ToS-safe|must not enable/i);
  });

  it("resolves waitForSignal on the scripted login URL and records destroy", async () => {
    const factory = createFakeBrowserFactory({
      loginSignalUrl: "https://app.posthog.com/project/settings",
      network: [{ url: "https://us.i.posthog.com/i/v0/e/", status: 200 }],
      async request(url) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { url };
          },
          async text() {
            return JSON.stringify({ url });
          }
        };
      }
    });
    const browser = await factory.create({ provider: "posthog", purpose: "provider_auth" });
    await browser.goto("https://app.posthog.com/login");
    const signal = await browser.waitForSignal((u) => u.includes("/settings"), 1000);
    expect(signal).toEqual({ url: "https://app.posthog.com/project/settings" });
    expect(await browser.readNetwork()).toEqual([{ url: "https://us.i.posthog.com/i/v0/e/", status: 200 }]);
    await expect(browser.request("https://us.posthog.com/api/organizations/")).resolves.toMatchObject({
      ok: true,
      status: 200
    });
    await browser.destroy();
    expect(factory.destroyed).toBe(true);
  });

  it("returns null from waitForSignal when nothing matches (timeout path)", async () => {
    const factory = createFakeBrowserFactory({ loginSignalUrl: "https://example.com/done" });
    const browser = await factory.create({ provider: "x", purpose: "provider_auth" });
    expect(await browser.waitForSignal((u) => u.includes("/never"), 1000)).toBeNull();
  });
});
