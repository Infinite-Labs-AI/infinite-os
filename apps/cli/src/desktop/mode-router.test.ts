import { describe, expect, it } from "vitest";
import { resolveMode, type ModeDeps, type ModeIo } from "./mode-router.js";

const D = (o: Partial<ModeDeps> = {}): ModeDeps => ({
  isMac: () => true,
  markerExists: () => false,
  liveBridgeAvailable: () => false,
  readConfigTarget: () => undefined,
  ...o
});
const TTY: ModeIo = { inputIsTTY: true, outputIsTTY: true };
const PIPE: ModeIo = { inputIsTTY: false, outputIsTTY: false };

describe("resolveMode", () => {
  it("non-mac → local", () =>
    expect(resolveMode({}, TTY, D({ isMac: () => false }))).toBe("local"));

  it("non-mac stays local even with a live bridge probe", () =>
    expect(
      resolveMode(
        {},
        TTY,
        D({ isMac: () => false, liveBridgeAvailable: () => true })
      )
    ).toBe("local"));

  it("routes cloud only when a LIVE bridge exists, not on a stale seen.json", () => {
    const mode = resolveMode({}, TTY, {
      ...D(),
      isMac: () => true,
      markerExists: () => true,
      liveBridgeAvailable: () => false
    });
    expect(mode).toBe("onboarding"); // stale marker, dead bridge → onboard, not cloud
  });

  it("routes cloud when the bridge is live", () => {
    expect(
      resolveMode({}, TTY, { ...D(), isMac: () => true, liveBridgeAvailable: () => true })
    ).toBe("cloud");
  });

  it("a live bridge routes cloud for non-TTY (pipes/scripts) too", () =>
    expect(
      resolveMode({}, PIPE, D({ liveBridgeAvailable: () => true }))
    ).toBe("cloud"));

  it("non-interactive with no live bridge does not silently go local", () => {
    const mode = resolveMode({}, PIPE, {
      ...D(),
      isMac: () => true,
      liveBridgeAvailable: () => false
    });
    expect(mode).toBe("onboarding"); // caller exits non-zero with guidance
  });

  it("config cloud with no live bridge → onboarding (launch Desktop, never a dead cloud)", () =>
    expect(
      resolveMode({}, TTY, D({ readConfigTarget: () => "cloud" }))
    ).toBe("onboarding"));

  it("config cloud with a live bridge → cloud", () =>
    expect(
      resolveMode(
        {},
        TTY,
        D({ readConfigTarget: () => "cloud", liveBridgeAvailable: () => true })
      )
    ).toBe("cloud"));

  it("config local overrides even a live bridge → local", () =>
    expect(
      resolveMode(
        {},
        TTY,
        D({ liveBridgeAvailable: () => true, readConfigTarget: () => "local" })
      )
    ).toBe("local"));

  it("mac+TTY, no live bridge → onboarding", () =>
    expect(resolveMode({}, TTY, D())).toBe("onboarding"));
});
