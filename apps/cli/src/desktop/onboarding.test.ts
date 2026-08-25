import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_READY_TIMEOUT_MS,
  INFINITE_DOWNLOAD_URL,
  OnboardingError,
  runOnboarding,
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
  it("guides (no launch) for a custom GROWTH_OS_HOME", async () => {
    const io = sink();
    const launched: string[] = [];
    await runOnboarding({ GROWTH_OS_HOME: "/tmp/custom" }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => null,
      appInstalled: () => true
    });
    expect(launched).toEqual([]); // never launch a home open -a can't fill
    expect(io.out.join("")).toContain("infinite local");
  });

  it("launches Infinite Dev 3 for ~/.growth-os-dev3 and polls to ready", async () => {
    const io = sink();
    const launched: string[] = [];
    let n = 0;
    await runOnboarding({ GROWTH_OS_HOME: home("dev3") }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => (n++ > 1 ? "ready" : "booting"),
      appInstalled: () => true,
      pollMs: 1,
      timeoutMs: 100
    });
    expect(launched).toEqual(["Infinite Dev 3"]);
  });

  it("launches Infinite for the default ~/.growth-os home", async () => {
    const io = sink();
    const launched: string[] = [];
    await runOnboarding({ GROWTH_OS_HOME: join(homedir(), ".growth-os") }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => "ready",
      appInstalled: () => true,
      pollMs: 1,
      timeoutMs: 100
    });
    expect(launched).toEqual(["Infinite"]);
  });

  it("launches Infinite Dev for the bare ~/.growth-os-dev home (instance 1)", async () => {
    const io = sink();
    const launched: string[] = [];
    await runOnboarding({ GROWTH_OS_HOME: home("dev") }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => "ready",
      appInstalled: () => true,
      pollMs: 1,
      timeoutMs: 100
    });
    expect(launched).toEqual(["Infinite Dev"]);
  });

  it("launches Infinite Clean for the ~/.growth-os-clean home", async () => {
    const io = sink();
    const launched: string[] = [];
    await runOnboarding({ GROWTH_OS_HOME: home("clean") }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => "ready",
      appInstalled: () => true,
      pollMs: 1,
      timeoutMs: 100
    });
    expect(launched).toEqual(["Infinite Clean"]);
  });

  it("guides (no launch) for ~/.growth-os-dev1 — not a real install", async () => {
    // runtime-identity has no dev instance 1 numbered home: instance 1 is the
    // bare ~/.growth-os-dev. A ~/.growth-os-dev1 path matches no launchable app.
    const io = sink();
    const launched: string[] = [];
    await runOnboarding({ GROWTH_OS_HOME: home("dev1") }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => null,
      appInstalled: () => true
    });
    expect(launched).toEqual([]);
    expect(io.out.join("")).toContain("infinite local");
  });

  it("renders signed_out guidance while polling", async () => {
    const io = sink();
    let n = 0;
    await runOnboarding({ GROWTH_OS_HOME: home("dev2") }, io, {
      liveBridgeReady: () => true,
      launch: () => undefined,
      readState: () => (n++ > 0 ? "ready" : "signed_out"),
      appInstalled: () => true,
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
      appInstalled: () => true,
      pollMs: 1,
      timeoutMs: 100
    });
    expect(io.out.join("")).toContain("provider");
  });

  it("routes to `infinite local` on ready timeout", async () => {
    const io = sink();
    const launched: string[] = [];
    let clock = 0;
    await runOnboarding({ GROWTH_OS_HOME: home("dev4") }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => "booting", // never ready
      appInstalled: () => true,
      pollMs: 5,
      timeoutMs: 20,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      }
    });
    expect(launched).toEqual(["Infinite Dev 4"]);
    expect(io.out.join("")).toContain("infinite local");
  });

  it("prints the sign-up/download link when the app is not installed", async () => {
    const io = sink();
    const launched: string[] = [];
    await runOnboarding({ GROWTH_OS_HOME: home("dev5") }, io, {
      liveBridgeReady: () => true,
      launch: (a) => launched.push(a),
      readState: () => null,
      appInstalled: () => false
    });
    expect(launched).toEqual([]);
    const printed = io.out.join("");
    expect(printed).toContain(INFINITE_DOWNLOAD_URL);
    expect(printed).toContain("infinite local");
  });

  it("errors with guidance for a one-shot invocation with no bridge (no launch)", async () => {
    const io = sink();
    const launched: string[] = [];
    await expect(
      runOnboarding({ GROWTH_OS_HOME: home("dev6") }, io, {
        liveBridgeReady: () => true,
        launch: (a) => launched.push(a),
        readState: () => "booting", // not ready → no bridge
        appInstalled: () => true,
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
    appInstalled: () => true,
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
      appInstalled: () => false
    });
    expect(out.result).toBe("not_installed");
  });

  it("returns unsupported_home for a custom GROWTH_OS_HOME", async () => {
    const out = await runOnboarding({ GROWTH_OS_HOME: "/tmp/custom" }, io(), {
      liveBridgeReady: () => true,
      launch: () => undefined,
      readState: () => null,
      appInstalled: () => true
    });
    expect(out.result).toBe("unsupported_home");
  });

  it("returns timed_out when the ready deadline passes", async () => {
    let clock = 0;
    const out = await runOnboarding(env, io(), {
      liveBridgeReady: () => true,
      launch: () => undefined,
      readState: () => "booting",
      appInstalled: () => true,
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
      appInstalled: () => true,
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
        appInstalled: () => true,
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
      appInstalled: () => true,
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
      appInstalled: () => true,
      pollMs: 1,
      timeoutMs: 100
    });
    expect(out.result).toBe("ready");
  });

  it("surfaces no_linked_workspace guidance while polling", async () => {
    const sunk = sink();
    await runOnboarding(env, sunk, depsWithStates(["no_linked_workspace", "ready"]));
    expect(sunk.out.join("")).toContain("workspace");
  });

  it("surfaces subscription_required guidance while polling", async () => {
    const sunk = sink();
    await runOnboarding(env, sunk, depsWithStates(["subscription_required", "ready"]));
    expect(sunk.out.join("")).toMatch(/subscription/i);
  });

  it("is cancellable: an aborted signal ends the wait as timed_out", async () => {
    const controller = new AbortController();
    let polls = 0;
    const out = await runOnboarding(env, io(), {
      liveBridgeReady: () => true,
      launch: () => undefined,
      readState: () => {
        if (++polls >= 3) controller.abort();
        return "booting"; // never ready
      },
      appInstalled: () => true,
      pollMs: 1,
      timeoutMs: 60_000,
      signal: controller.signal
    });
    expect(out.result).toBe("timed_out");
    expect(polls).toBeLessThan(10); // the abort ended the wait, not the deadline
  });

  it("waits far longer than the old 60s cap by default (OTP + payment take time)", () => {
    expect(DEFAULT_READY_TIMEOUT_MS).toBeGreaterThan(10 * 60_000);
  });
});
