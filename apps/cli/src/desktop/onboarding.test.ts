import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as cli from "../index.js";
import {
  DEFAULT_READY_TIMEOUT_MS,
  INFINITE_DOWNLOAD_URL,
  INFINITE_INSTALL_COMMAND,
  INFINITE_ONBOARDING_URI,
  OnboardingError,
  normalizeOnboardingState,
  runOnboarding,
  type DesktopLaunchTarget,
  type OnboardingState
} from "./onboarding.js";

// Capturing io double. runOnboarding only calls writeOut/writeErr.
function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    writeOut: (text: string) => out.push(text),
    writeErr: (text: string) => err.push(text)
  };
}

// A canonical home under the real user HOME for the requested dev slot, so the
// canonical-home matcher (parent === HOME, basename === .growth-os[-devN]) fires.
function home(slot: string): string {
  return join(homedir(), `.growth-os-${slot}`);
}

describe("runOnboarding", () => {
  it("normalizes future state values as generic not-ready", () => {
    expect(normalizeOnboardingState("future_gate")).toBe("other_not_ready");
    expect(normalizeOnboardingState(undefined)).toBeNull();
  });

  it("launches the exact prod onboarding URI through the located app bundle", async () => {
    const launched: DesktopLaunchTarget[] = [];
    const result = await runOnboarding(
      { HOME: "/Users/x", GROWTH_OS_HOME: "/Users/x/.growth-os" },
      sink(),
      {
        resolveAppPath: () => "/Applications/Infinite.app",
        launch: (target) => launched.push(target),
        readState: () => "ready",
        liveBridgeReady: () => true,
        pollMs: 1,
        timeoutMs: 100
      }
    );
    expect(result).toEqual({ result: "ready" });
    expect(launched).toEqual([
      {
        appName: "Infinite",
        appPath: "/Applications/Infinite.app",
        onboardingUri: "infinite://onboarding",
        scheme: "infinite",
        variant: "prod"
      }
    ]);
  });

  it("exports the canonical onboarding and recovery constants", () => {
    expect(INFINITE_INSTALL_COMMAND).toBe("npx infinite-os@latest");
    expect(INFINITE_ONBOARDING_URI).toBe("infinite://onboarding");
  });

  it("uses the current executable's app bundle for a custom app directory with spaces", () => {
    expect(
      cli.currentDesktopAppPath(
        "/Users/x/Apps With Spaces/Infinite.app/Contents/MacOS/Infinite",
        "Infinite"
      )
    ).toBe("/Users/x/Apps With Spaces/Infinite.app");
  });

  it("prints canonical recovery when the app is missing or moved", async () => {
    const io = sink();
    const result = await runOnboarding(
      { HOME: "/Users/x", GROWTH_OS_HOME: "/Users/x/.growth-os" },
      io,
      {
        resolveAppPath: () => null,
        launch: () => {
          throw new Error("must not launch");
        },
        readState: () => null,
        liveBridgeReady: () => false
      }
    );
    expect(result).toEqual({ result: "not_installed" });
    expect(io.out.join("")).toBe(
      "Infinite Desktop is missing or moved.\n" +
        `Run \`${INFINITE_INSTALL_COMMAND}\`, then open ${INFINITE_ONBOARDING_URI}.\n`
    );
  });

  it("does not launch a custom home and explains the requested identity", async () => {
    const io = sink();
    const launched: DesktopLaunchTarget[] = [];
    const result = await runOnboarding(
      { HOME: "/Users/x", GROWTH_OS_HOME: "/tmp/custom" },
      io,
      {
        resolveAppPath: () => "/Applications/Infinite.app",
        launch: (target) => launched.push(target),
        readState: () => null,
        liveBridgeReady: () => false
      }
    );
    expect(result).toEqual({ result: "unsupported_home" });
    expect(launched).toEqual([]);
    expect(io.out.join("")).toMatch(
      /requested Desktop identity.*cannot be launched/i
    );
  });

  it("one-shot with no bridge launches nothing and prints URI plus canonical recovery", async () => {
    const io = sink();
    const launched: DesktopLaunchTarget[] = [];
    await expect(
      runOnboarding(
        { HOME: "/Users/x", GROWTH_OS_HOME: "/Users/x/.growth-os" },
        io,
        {
          resolveAppPath: () => "/Applications/Infinite.app",
          launch: (target) => launched.push(target),
          readState: () => "booting",
          liveBridgeReady: () => false,
          oneShot: true
        }
      )
    ).rejects.toMatchObject({ code: "desktop_bridge_absent" });
    expect(launched).toEqual([]);
    expect(io.out.join("")).toContain(INFINITE_ONBOARDING_URI);
    expect(io.out.join("")).toContain(INFINITE_INSTALL_COMMAND);
  });

  it("wraps launch failures as desktop_launch_failed", async () => {
    await expect(
      runOnboarding(
        { HOME: "/Users/x", GROWTH_OS_HOME: "/Users/x/.growth-os" },
        sink(),
        {
          resolveAppPath: () => "/Applications/Infinite.app",
          launch: () => {
            throw new Error("open failed");
          },
          readState: () => null,
          liveBridgeReady: () => false
        }
      )
    ).rejects.toMatchObject({ code: "desktop_launch_failed" });
  });

  it("keeps every canonical variant on only its own onboarding scheme", async () => {
    const cases = [
      [".growth-os", "Infinite", "infinite://onboarding"],
      [".growth-os-dev", "Infinite Dev", "infinite-dev://onboarding"],
      [".growth-os-dev6", "Infinite Dev 6", "infinite-dev-6://onboarding"],
      [".growth-os-clean", "Infinite Clean", "infinite-clean://onboarding"]
    ] as const;
    for (const [homeName, appName, onboardingUri] of cases) {
      const launched: DesktopLaunchTarget[] = [];
      await runOnboarding(
        { HOME: "/Users/x", GROWTH_OS_HOME: `/Users/x/${homeName}` },
        sink(),
        {
          resolveAppPath: () => `/Applications/${appName}.app`,
          launch: (target) => launched.push(target),
          readState: () => "ready",
          liveBridgeReady: () => true
        }
      );
      expect(launched).toHaveLength(1);
      expect(launched[0]?.appName).toBe(appName);
      expect(launched[0]?.onboardingUri).toBe(onboardingUri);
    }
  });

  it("guides (no launch) for a custom GROWTH_OS_HOME", async () => {
    const io = sink();
    const launched: DesktopLaunchTarget[] = [];
    await runOnboarding({ GROWTH_OS_HOME: "/tmp/custom" }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => null,
      resolveAppPath: () => "/Applications/Infinite.app"
    });
    expect(launched).toEqual([]); // never launch a home open -a can't fill
    expect(io.out.join("")).toContain(INFINITE_INSTALL_COMMAND);
  });

  it("launches Infinite Dev 3 for ~/.growth-os-dev3 and polls to ready", async () => {
    const io = sink();
    const launched: DesktopLaunchTarget[] = [];
    let n = 0;
    await runOnboarding({ GROWTH_OS_HOME: home("dev3") }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => (n++ > 1 ? "ready" : "booting"),
      resolveAppPath: () => "/Applications/Infinite Dev 3.app",
      pollMs: 1,
      timeoutMs: 100
    });
    expect(launched.map((target) => target.appName)).toEqual([
      "Infinite Dev 3"
    ]);
  });

  it("launches Infinite for the default ~/.growth-os home", async () => {
    const io = sink();
    const launched: DesktopLaunchTarget[] = [];
    await runOnboarding({ GROWTH_OS_HOME: join(homedir(), ".growth-os") }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => "ready",
      resolveAppPath: () => "/Applications/Infinite.app",
      pollMs: 1,
      timeoutMs: 100
    });
    expect(launched.map((target) => target.appName)).toEqual(["Infinite"]);
  });

  it("launches Infinite Dev for the bare ~/.growth-os-dev home (instance 1)", async () => {
    const io = sink();
    const launched: DesktopLaunchTarget[] = [];
    await runOnboarding({ GROWTH_OS_HOME: home("dev") }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => "ready",
      resolveAppPath: () => "/Applications/Infinite Dev.app",
      pollMs: 1,
      timeoutMs: 100
    });
    expect(launched.map((target) => target.appName)).toEqual(["Infinite Dev"]);
  });

  it("launches Infinite Clean for the ~/.growth-os-clean home", async () => {
    const io = sink();
    const launched: DesktopLaunchTarget[] = [];
    await runOnboarding({ GROWTH_OS_HOME: home("clean") }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => "ready",
      resolveAppPath: () => "/Applications/Infinite Clean.app",
      pollMs: 1,
      timeoutMs: 100
    });
    expect(launched.map((target) => target.appName)).toEqual([
      "Infinite Clean"
    ]);
  });

  it("guides (no launch) for ~/.growth-os-dev1 — not a real install", async () => {
    // runtime-identity has no dev instance 1 numbered home: instance 1 is the
    // bare ~/.growth-os-dev. A ~/.growth-os-dev1 path matches no launchable app.
    const io = sink();
    const launched: DesktopLaunchTarget[] = [];
    await runOnboarding({ GROWTH_OS_HOME: home("dev1") }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => null,
      resolveAppPath: () => "/Applications/Infinite.app"
    });
    expect(launched).toEqual([]);
    expect(io.out.join("")).toContain(INFINITE_INSTALL_COMMAND);
  });

  it("renders signed_out guidance while polling", async () => {
    const io = sink();
    let n = 0;
    await runOnboarding({ GROWTH_OS_HOME: home("dev2") }, io, {
      liveBridgeReady: () => true,
      launch: () => undefined,
      readState: () => (n++ > 0 ? "ready" : "signed_out"),
      resolveAppPath: () => "/Applications/Infinite Dev 2.app",
      pollMs: 1,
      timeoutMs: 100
    });
    expect(io.out.join("")).toContain("Sign in");
  });

  it("renders no_provider guidance while polling", async () => {
    const io = sink();
    let n = 0;
    await runOnboarding({ GROWTH_OS_HOME: home("dev2") }, io, {
      liveBridgeReady: () => true,
      launch: () => undefined,
      readState: () => (n++ > 0 ? "ready" : "no_provider"),
      resolveAppPath: () => "/Applications/Infinite Dev 2.app",
      pollMs: 1,
      timeoutMs: 100
    });
    expect(io.out.join("")).toContain(
      "Connect Codex or Claude in Infinite Desktop to continue."
    );
  });

  it("prints Desktop recovery on ready timeout", async () => {
    const io = sink();
    const launched: DesktopLaunchTarget[] = [];
    let clock = 0;
    await runOnboarding({ GROWTH_OS_HOME: home("dev4") }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => "booting", // never ready
      resolveAppPath: () => "/Applications/Infinite Dev 4.app",
      pollMs: 5,
      timeoutMs: 20,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      }
    });
    expect(launched.map((target) => target.appName)).toEqual([
      "Infinite Dev 4"
    ]);
    expect(io.out.join("")).toContain(INFINITE_INSTALL_COMMAND);
  });

  it("prints canonical recovery when the app is not installed", async () => {
    const io = sink();
    const launched: DesktopLaunchTarget[] = [];
    await runOnboarding({ GROWTH_OS_HOME: home("dev5") }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => null,
      resolveAppPath: () => null
    });
    expect(launched).toEqual([]);
    const printed = io.out.join("");
    expect(printed).toContain(INFINITE_INSTALL_COMMAND);
    expect(printed).toContain(INFINITE_ONBOARDING_URI);
  });

  it("errors with guidance for a one-shot invocation with no bridge (no launch)", async () => {
    const io = sink();
    const launched: DesktopLaunchTarget[] = [];
    await expect(
      runOnboarding({ GROWTH_OS_HOME: home("dev6") }, io, {
        liveBridgeReady: () => true,
        launch: (a) => launched.push(a),
        readState: () => "booting", // not ready → no bridge
        resolveAppPath: () => "/Applications/Infinite Dev 6.app",
        oneShot: true
      })
    ).rejects.toBeInstanceOf(OnboardingError);
    expect(launched).toEqual([]);
  });
});

// Replays a scripted sequence of state.json values, holding the LAST one.
function depsWithStates(states: Array<OnboardingState | null>) {
  let n = 0;
  return {
    liveBridgeReady: () => true,
    launch: () => undefined,
    readState: () => states[Math.min(n++, states.length - 1)] ?? null,
    resolveAppPath: () => "/Applications/Infinite Dev 7.app",
    pollMs: 1,
    timeoutMs: 1000
  };
}

describe("runOnboarding structured result", () => {
  const env = { GROWTH_OS_HOME: home("dev7") };
  const io = () => sink();

  it("returns ready when state.json reaches ready", async () => {
    const out = await runOnboarding(
      env,
      io(),
      depsWithStates(["booting", "signed_out", "ready"])
    );
    expect(out.result).toBe("ready");
  });

  it("returns not_installed when the app is absent", async () => {
    const out = await runOnboarding(env, io(), {
      liveBridgeReady: () => true,
      launch: () => undefined,
      readState: () => null,
      resolveAppPath: () => null
    });
    expect(out.result).toBe("not_installed");
  });

  it("returns unsupported_home for a custom GROWTH_OS_HOME", async () => {
    const out = await runOnboarding({ GROWTH_OS_HOME: "/tmp/custom" }, io(), {
      liveBridgeReady: () => true,
      launch: () => undefined,
      readState: () => null,
      resolveAppPath: () => "/Applications/Infinite.app"
    });
    expect(out.result).toBe("unsupported_home");
  });

  it("returns timed_out when the ready deadline passes", async () => {
    let clock = 0;
    const out = await runOnboarding(env, io(), {
      liveBridgeReady: () => true,
      launch: () => undefined,
      readState: () => "booting",
      resolveAppPath: () => "/Applications/Infinite Dev 7.app",
      pollMs: 5,
      timeoutMs: 20,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      }
    });
    expect(out.result).toBe("timed_out");
  });

  it("returns ready for a one-shot whose bridge state is already ready", async () => {
    const out = await runOnboarding(env, io(), {
      launch: () => undefined,
      readState: () => "ready",
      liveBridgeReady: () => true,
      resolveAppPath: () => "/Applications/Infinite Dev 7.app",
      oneShot: true
    });
    expect(out.result).toBe("ready");
  });

  // state.json alone is NEVER trusted (spec §6.4): a crashed/SIGKILLed Desktop
  // leaves state.json="ready" behind with a dead bridge.json. Ready requires
  // BOTH the state file AND a live bridge probe.
  it("one-shot does NOT trust a stale state.json ready when the live bridge is dead", async () => {
    await expect(
      runOnboarding(env, io(), {
        launch: () => undefined,
        readState: () => "ready", // stale: Desktop died after writing ready
        liveBridgeReady: () => false,
        resolveAppPath: () => "/Applications/Infinite Dev 7.app",
        oneShot: true
      })
    ).rejects.toBeInstanceOf(OnboardingError);
  });

  it("polling does NOT trust a stale state.json ready when the live bridge is dead", async () => {
    let clock = 0;
    const out = await runOnboarding(env, io(), {
      launch: () => undefined,
      readState: () => "ready", // stale ready; nothing answers /v1/status
      liveBridgeReady: () => false,
      resolveAppPath: () => "/Applications/Infinite Dev 7.app",
      pollMs: 5,
      timeoutMs: 20,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      }
    });
    expect(out.result).toBe("timed_out");
  });

  it("polling returns ready when state.json is ready AND the bridge is live", async () => {
    const out = await runOnboarding(env, io(), {
      launch: () => undefined,
      readState: () => "ready",
      liveBridgeReady: () => true,
      resolveAppPath: () => "/Applications/Infinite Dev 7.app",
      pollMs: 1,
      timeoutMs: 100
    });
    expect(out.result).toBe("ready");
  });

  it("surfaces no_linked_workspace guidance while polling", async () => {
    const sunk = sink();
    await runOnboarding(
      env,
      sunk,
      depsWithStates(["no_linked_workspace", "ready"])
    );
    expect(sunk.out.join("")).toContain("workspace");
  });

  it("renders subscription_required as generic setup guidance", async () => {
    const sunk = sink();
    await runOnboarding(
      env,
      sunk,
      depsWithStates(["subscription_required", "ready"])
    );
    expect(sunk.out.join("")).toContain(
      "Finish setup in Infinite Desktop to continue."
    );
    expect(sunk.out.join("")).not.toMatch(/billing|subscription/i);
  });

  it("is cancellable: an aborted signal returns interrupted", async () => {
    const controller = new AbortController();
    let polls = 0;
    const out = await runOnboarding(env, io(), {
      liveBridgeReady: () => true,
      launch: () => undefined,
      readState: () => {
        if (++polls >= 3) controller.abort();
        return "booting"; // never ready
      },
      resolveAppPath: () => "/Applications/Infinite Dev 7.app",
      pollMs: 1,
      timeoutMs: 60_000,
      signal: controller.signal
    });
    expect(out.result).toBe("interrupted");
    expect(polls).toBeLessThan(10); // the abort ended the wait, not the deadline
  });

  it("waits far longer than the old 60s cap by default (OTP + payment take time)", () => {
    expect(DEFAULT_READY_TIMEOUT_MS).toBeGreaterThan(10 * 60_000);
  });

  it.each([
    ["signed_out", "→ Sign in to Infinite Desktop to continue."],
    [
      "no_linked_workspace",
      "→ Create or link your workspace in Infinite Desktop to continue."
    ],
    [
      "no_provider",
      "→ Connect Codex or Claude in Infinite Desktop to continue."
    ],
    [
      "subscription_required",
      "→ Finish setup in Infinite Desktop to continue."
    ],
    ["other_not_ready", "→ Finish setup in Infinite Desktop to continue."]
  ] as const)(
    "renders only the current %s instruction once per transition",
    async (state, line) => {
      const sunk = sink();
      await runOnboarding(env, sunk, depsWithStates([state, state, "ready"]));
      expect(sunk.out.join("").split(line)).toHaveLength(2);
    }
  );

  it("keeps every onboarding outcome free of local/Docker/billing fallback copy", async () => {
    const forbidden =
      /trial|infinite local|docker|self-host|local engine|billing|subscription/i;
    const missing = sink();
    await runOnboarding(env, missing, {
      resolveAppPath: () => null,
      launch: () => undefined,
      readState: () => null,
      liveBridgeReady: () => false
    });
    const timedOut = sink();
    let clock = 0;
    await runOnboarding(env, timedOut, {
      resolveAppPath: () => "/Applications/Infinite Dev 7.app",
      launch: () => undefined,
      readState: () => "subscription_required",
      liveBridgeReady: () => false,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      pollMs: 1,
      timeoutMs: 1
    });
    const interrupted = sink();
    const controller = new AbortController();
    controller.abort();
    await runOnboarding(env, interrupted, {
      resolveAppPath: () => "/Applications/Infinite Dev 7.app",
      launch: () => undefined,
      readState: () => "booting",
      liveBridgeReady: () => false,
      signal: controller.signal
    });
    for (const text of [
      missing.out.join(""),
      timedOut.out.join(""),
      interrupted.out.join("")
    ]) {
      expect(text).not.toMatch(forbidden);
    }
  });
});
