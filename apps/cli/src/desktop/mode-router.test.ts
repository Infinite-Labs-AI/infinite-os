import { describe, expect, it } from "vitest";
import { resolveMode, type ModeDeps, type ModeIo } from "./mode-router.js";

const D = (o: Partial<ModeDeps> = {}): ModeDeps => ({
  isMac: () => true,
  desktopReady: () => false,
  ...o
});
const TTY: ModeIo = { inputIsTTY: true, outputIsTTY: true };
const PIPE: ModeIo = { inputIsTTY: false, outputIsTTY: false };

describe("resolveMode", () => {
  it("non-mac product routing is unsupported", () => {
    expect(resolveMode({}, TTY, D({ isMac: () => false }))).toBe("unsupported");
  });

  it("non-mac stays unsupported even when Desktop is ready", () =>
    expect(
      resolveMode(
        {},
        TTY,
        D({ isMac: () => false, desktopReady: () => true })
      )
    ).toBe("unsupported"));

  it("routes cloud only when Desktop is ready, not on a stale seen.json", () => {
    const mode = resolveMode({}, TTY, {
      ...D(),
      isMac: () => true,
      desktopReady: () => false
    });
    expect(mode).toBe("onboarding"); // stale marker, dead bridge → onboard, not cloud
  });

  it("does not route cloud when only the live bridge is ready", () => {
    expect(
      resolveMode(
        {},
        TTY,
        D({ desktopReady: () => false })
      )
    ).toBe("onboarding");
  });

  it("routes cloud when durable state and live bridge are both ready", () => {
    expect(
      resolveMode({}, TTY, {
        ...D(),
        isMac: () => true,
        desktopReady: () => true
      })
    ).toBe("cloud");
  });

  it("a live bridge remains usable for a non-TTY one-shot", () =>
    expect(
      resolveMode(
        {},
        PIPE,
        D({ desktopReady: () => true })
      )
    ).toBe("cloud"));

  it("non-interactive with no live bridge does not silently go local", () => {
    const mode = resolveMode({}, PIPE, {
      ...D(),
      isMac: () => true,
      desktopReady: () => false
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
        D({ desktopReady: () => true })
      )
    ).toBe("cloud"));

  it("GROWTH_OS_DEFAULT_TARGET=local cannot silently turn a product invocation local", () =>
    expect(
      resolveMode(
        { GROWTH_OS_DEFAULT_TARGET: "local" },
        TTY,
        D({ desktopReady: () => false })
      )
    ).toBe("onboarding"));

  it("mac+TTY, no live bridge → onboarding", () =>
    expect(resolveMode({}, TTY, D())).toBe("onboarding"));
});
