import { describe, expect, it, vi } from "vitest";

import { runOnboarding } from "./onboarding-controller.js";
import type { SetupRunStore } from "./setup-controller.js";
import type { Provisioner, ProvisionerContext } from "./provisioner.js";
import type { DetectionState, SetupInterview } from "./types.js";

const store: SetupRunStore = {
  async startOrResume() { return { runId: "r", resumed: false }; },
  async recordPhase() {},
  async recordSetupState() {},
  async finish() {}
};
const ctx = {
  workspaceId: "ws1",
  browser: { async create() { throw new Error("unused"); } },
  actions: { async execute() { throw new Error("unused"); } },
  prompt: { async ask() { return ""; }, note() {} },
  log() {}
} as unknown as ProvisionerContext;

function tool(id: Provisioner["tool"], state: DetectionState, connect?: Provisioner["connect"]): Provisioner {
  return {
    tool: id, friction: "green", capabilities: { detect: { rung: "api", automatable: true } },
    async detect() { return state; },
    async setup() { return { status: "ok", detail: "" }; },
    connect: connect ?? (async () => ({ status: "ok", detail: "" })),
    async sync() { return { status: "ok", detail: "" }; },
    async implement() { return { status: "ok", detail: "" }; }
  };
}
const blank: DetectionState = { accountExists: false, assetExists: false };

describe("runOnboarding", () => {
  it("collects paused tools and continues past them", async () => {
    const interview: SetupInterview = {
      projectName: "Acme",
      websiteUrl: "https://acme.test",
      productSurface: "web",
      providerInventory: [
        { provider: "ga4", hasAccount: false, installState: "unknown", selected: true, recommended: true },
        { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
        { provider: "x", hasAccount: false, installState: "unknown", selected: false, recommended: false }
      ]
    };
    const tools = [
      tool("ga4", blank),
      tool("posthog", blank, async () => ({ status: "needs_human", detail: "log in" })),
      tool("stripe", blank)
    ];
    const result = await runOnboarding({ interview, provisioners: tools }, ctx, store);
    expect(result.completed).toEqual(["ga4"]); // posthog paused, x unselected, stripe not a v1 onboarding provider
    expect(result.paused).toEqual(["posthog"]);
    expect(result.failed).toEqual([]);
    expect(result.selectedProviders).toEqual(["ga4", "posthog"]);
    expect(result.recommendedProviders).toEqual(["ga4", "posthog"]);
  });

  it("runs only selected recommended providers, in the provided order, without parallel overlap", async () => {
    const interview: SetupInterview = {
      projectName: "Acme",
      websiteUrl: "https://acme.test",
      productSurface: "web",
      providerInventory: [
        { provider: "ga4", hasAccount: false, installState: "unknown", selected: true, recommended: true },
        { provider: "posthog", hasAccount: false, installState: "unknown", selected: true, recommended: true },
        { provider: "x", hasAccount: false, installState: "unknown", selected: true, recommended: false }
      ]
    };

    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstFinished = false;

    const first: Provisioner = {
      tool: "posthog",
      friction: "green",
      capabilities: { detect: { rung: "api", automatable: true } },
      async detect() {
        events.push("posthog:detect");
        return blank;
      },
      async setup() {
        events.push("posthog:setup:start");
        await new Promise<void>((resolve) => {
          releaseFirst = () => {
            firstFinished = true;
            resolve();
          };
        });
        events.push("posthog:setup:end");
        return { status: "ok", detail: "done" };
      }
    };

    const second: Provisioner = {
      tool: "x",
      friction: "amber",
      capabilities: { detect: { rung: "browser_assist", automatable: false } },
      async detect() {
        if (!firstFinished) {
          throw new Error("x started before posthog finished");
        }
        events.push("x:detect");
        return blank;
      },
      async setup() {
        events.push("x:setup");
        return { status: "ok", detail: "done" };
      }
    };

    const third: Provisioner = {
      tool: "ga4",
      friction: "green",
      capabilities: { detect: { rung: "oauth_loopback", automatable: true } },
      async detect() {
        if (!firstFinished) {
          throw new Error("ga4 started before posthog finished");
        }
        events.push("ga4:detect");
        return blank;
      },
      async setup() {
        events.push("ga4:setup");
        return { status: "ok", detail: "done" };
      }
    };

    const runPromise = runOnboarding({ interview, provisioners: [first, second, third] }, ctx, store);
    await vi.waitFor(() => {
      expect(events).toEqual(["posthog:detect", "posthog:setup:start"]);
    });
    releaseFirst?.();

    const result = await runPromise;

    expect(result.selectedProviders).toEqual(["posthog", "x", "ga4"]);
    expect(result.recommendedProviders).toEqual(["ga4", "posthog", "x"]);
    expect(result.completed).toEqual(["posthog", "x", "ga4"]);
    expect(events).toEqual([
      "posthog:detect",
      "posthog:setup:start",
      "posthog:setup:end",
      "x:detect",
      "x:setup",
      "ga4:detect",
      "ga4:setup"
    ]);
  });
});
