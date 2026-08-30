import { describe, expect, it } from "vitest";
import { resolveMode, type ModeDeps, type ModeIo } from "./mode-router.js";

const D = (o: Partial<ModeDeps> = {}): ModeDeps => ({
  isMac: () => true,
  liveBridgeAvailable: () => false,
  ...o
});
const TTY: ModeIo = { inputIsTTY: true, outputIsTTY: true };
const PIPE: ModeIo = { inputIsTTY: false, outputIsTTY: false };

describe("resolveMode", () => {
  it("non-mac product routing is unsupported", () => {
    expect(resolveMode({}, TTY, D({ isMac: () => false }))).toBe("unsupported");
  });

  it("non-mac stays unsupported even with a live bridge probe", () =>
    expect(
      resolveMode(
        {},
        TTY,
        D({ isMac: () => false, liveBridgeAvailable: () => true })
      )
    ).toBe("unsupported"));

  it("routes cloud only when a LIVE bridge exists, not on a stale seen.json", () => {
    const mode = resolveMode({}, TTY, {
      ...D(),
      isMac: () => true,
      liveBridgeAvailable: () => false
    });
    expect(mode).toBe("onboarding"); // stale marker, dead bridge → onboard, not cloud
  });

  it("routes cloud when the bridge is live", () => {
    expect(
      resolveMode({}, TTY, {
        ...D(),
        isMac: () => true,
        liveBridgeAvailable: () => true
      })
    ).toBe("cloud");
  });

  it("a live bridge remains usable for a non-TTY one-shot", () =>
    expect(resolveMode({}, PIPE, D({ liveBridgeAvailable: () => true }))).toBe(
      "cloud"
    ));

  it("non-interactive with no live bridge does not silently go local", () => {
    const mode = resolveMode({}, PIPE, {
      ...D(),
      isMac: () => true,
      liveBridgeAvailable: () => false
    });
    expect(mode).toBe("onboarding"); // caller exits non-zero with guidance
  });

  it("config cloud with no live bridge → onboarding (launch Desktop, never a dead cloud)", () =>
    expect(resolveMode({ GROWTH_OS_DEFAULT_TARGET: "cloud" }, TTY, D())).toBe(
      "onboarding"
    ));

  it("config cloud with a live bridge → cloud", () =>
    expect(
      resolveMode(
        { GROWTH_OS_DEFAULT_TARGET: "cloud" },
        TTY,
        D({ liveBridgeAvailable: () => true })
      )
    ).toBe("cloud"));

  it("GROWTH_OS_DEFAULT_TARGET=local cannot silently turn a product invocation local", () =>
    expect(
      resolveMode(
        { GROWTH_OS_DEFAULT_TARGET: "local" },
        TTY,
        D({ liveBridgeAvailable: () => false })
      )
    ).toBe("onboarding"));

  it("mac+TTY, no live bridge → onboarding", () =>
    expect(resolveMode({}, TTY, D())).toBe("onboarding"));
});
