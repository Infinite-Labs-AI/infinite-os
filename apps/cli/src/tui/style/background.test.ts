import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { BACKGROUND_QUERY, detectTerminalBackground, parseBackgroundReply, probeBackground, shouldProbeBackground } from "./background.js";

/** A raw-mode-capable stdin stand-in that records what the probe does to it. */
function fakeInput(options: { isTTY?: boolean; isRaw?: boolean } = {}) {
  const input = Object.assign(new EventEmitter(), {
    isTTY: options.isTTY ?? true,
    isRaw: options.isRaw ?? false,
    rawCalls: [] as boolean[],
    unshifted: [] as string[],
    paused: false,
    setRawMode(mode: boolean) {
      input.rawCalls.push(mode);
      input.isRaw = mode;
      return input;
    },
    resume() {
      input.paused = false;
      return input;
    },
    pause() {
      input.paused = true;
      return input;
    },
    unshift(chunk: Buffer | string) {
      input.unshifted.push(chunk.toString());
    }
  });
  return input;
}

function fakeOutput(onWrite: (data: string) => void = () => {}) {
  const written: string[] = [];
  return {
    written,
    write(data: string) {
      written.push(data);
      onWrite(data);
      return true;
    }
  };
}

const DA1 = "\u001b[?62;22c";

describe("parseBackgroundReply", () => {
  it("reads an OSC 11 rgb reply (BEL or ST, 1–4 hex digits) as light or dark", () => {
    expect(parseBackgroundReply("\u001b]11;rgb:ffff/ffff/ffff\u0007")).toBe("light");
    expect(parseBackgroundReply("\u001b]11;rgb:0a0a/0d0d/1111\u001b\\")).toBe("dark");
    expect(parseBackgroundReply("\u001b]11;rgb:fb/f1/c7\u0007")).toBe("light");
    expect(parseBackgroundReply("\u001b]11;rgb:1e1e/1e1e/1e1e\u0007")).toBe("dark");
    expect(parseBackgroundReply("\u001b]11;rgba:ffff/ffff/ffff/ffff\u0007")).toBe("light");
  });

  it("returns undefined without a reply", () => {
    expect(parseBackgroundReply("")).toBeUndefined();
    expect(parseBackgroundReply(DA1)).toBeUndefined();
    expect(parseBackgroundReply("\u001b]11;?\u0007")).toBeUndefined();
  });
});

describe("probeBackground", () => {
  it("queries OSC 11 then DA1 in raw mode, reads the reply, and restores the terminal", async () => {
    const input = fakeInput();
    const output = fakeOutput(() => queueMicrotask(() => input.emit("data", Buffer.from(`\u001b]11;rgb:f5f5/f5f5/f5f5\u0007${DA1}`))));
    await expect(probeBackground(input, output)).resolves.toBe("light");
    expect(output.written).toEqual([BACKGROUND_QUERY]);
    expect(input.rawCalls).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.paused).toBe(true);
    expect(input.unshifted).toEqual([]);
  });

  it("stops at the DA1 sentinel when the terminal does not answer OSC 11", async () => {
    vi.useFakeTimers();
    try {
      const input = fakeInput();
      const output = fakeOutput(() => queueMicrotask(() => input.emit("data", DA1)));
      const result = probeBackground(input, output, { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBeUndefined();
      expect(input.rawCalls).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the timeout, and hands typed-ahead keys back to stdin", async () => {
    vi.useFakeTimers();
    try {
      const input = fakeInput({ isRaw: true });
      const output = fakeOutput(() => queueMicrotask(() => input.emit("data", "hi")));
      const result = probeBackground(input, output, { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toBeUndefined();
      expect(input.rawCalls).toEqual([true]);
      expect(input.isRaw).toBe(true);
      expect(input.unshifted).toEqual(["hi"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps typed-ahead keys that arrive around the replies", async () => {
    const input = fakeInput();
    const output = fakeOutput(() => queueMicrotask(() => input.emit("data", `a\u001b]11;rgb:0000/0000/0000\u0007b${DA1}`)));
    await expect(probeBackground(input, output)).resolves.toBe("dark");
    expect(input.unshifted).toEqual(["ab"]);
  });

  it("does nothing without a raw-mode TTY", async () => {
    const output = fakeOutput();
    await expect(probeBackground(fakeInput({ isTTY: false }), output)).resolves.toBeUndefined();
    expect(output.written).toEqual([]);
  });
});

describe("shouldProbeBackground", () => {
  it("probes only when a light background would change a colour tier the user did not pin", () => {
    expect(shouldProbeBackground({ COLORTERM: "truecolor" })).toBe(true);
    expect(shouldProbeBackground({ TERM_PROGRAM: "Apple_Terminal" })).toBe(true);
    expect(shouldProbeBackground({ TERM: "xterm" })).toBe(false);
    expect(shouldProbeBackground({ COLORTERM: "truecolor", NO_COLOR: "1" })).toBe(false);
    expect(shouldProbeBackground({ COLORTERM: "truecolor", INFINITE_COLOR: "truecolor" })).toBe(false);
    expect(shouldProbeBackground({ COLORTERM: "truecolor", FORCE_COLOR: "3" })).toBe(false);
    expect(shouldProbeBackground({ COLORTERM: "truecolor", COLORFGBG: "15;0" })).toBe(false);
    expect(shouldProbeBackground({ COLORTERM: "truecolor", INFINITE_BACKGROUND: "dark" })).toBe(false);
    expect(shouldProbeBackground({ COLORTERM: "truecolor", SSH_TTY: "/dev/ttys001" })).toBe(false);
    expect(shouldProbeBackground({ COLORTERM: "truecolor", SSH_CONNECTION: "a b c d" })).toBe(false);
  });
});

describe("detectTerminalBackground", () => {
  it("records a probed background in INFINITE_BACKGROUND for the tier to read", async () => {
    const env: NodeJS.ProcessEnv = { COLORTERM: "truecolor" };
    await detectTerminalBackground(env, fakeInput(), fakeOutput(), async () => "light");
    expect(env.INFINITE_BACKGROUND).toBe("light");
  });

  it("leaves the env alone when it should not probe, or the terminal does not say", async () => {
    const probe = vi.fn(async () => "light" as const);
    const pinned: NodeJS.ProcessEnv = { COLORTERM: "truecolor", COLORFGBG: "15;0" };
    await detectTerminalBackground(pinned, fakeInput(), fakeOutput(), probe);
    expect(probe).not.toHaveBeenCalled();
    expect(pinned.INFINITE_BACKGROUND).toBeUndefined();
    const silent: NodeJS.ProcessEnv = { COLORTERM: "truecolor" };
    await detectTerminalBackground(silent, fakeInput(), fakeOutput(), async () => undefined);
    expect(silent.INFINITE_BACKGROUND).toBeUndefined();
  });
});
