// Typing is never lost: not in a burst before the session has drawn its first
// frame, and not when keys arrive faster than the session re-renders.
//
// The eval harness saw both on the Wave 1 CLI (origin/main as of 2026-10-02):
// at 12 ms per key and at start-up, characters went missing. The cause was the
// composer's key handler closing over the composer value of the render that
// created it. Ink re-subscribes `useInput` in an effect after each render, so a
// second key that arrived before that re-render ran against the stale value and
// overwrote the first. The composer now composes each key on the edit state of
// the last key (`editRef`) through one stable subscription, so every key lands.
// These pin that: each would drop characters with a handler that reads its
// render's `value`. Fake TTY, real Ink.
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { resetTurnState } from "../app/turn-store.js";
import { runInkInteractiveSession } from "./interactive-session.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (value: string) => value.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");
// 60 characters, every one of them visible (a dropped space shows as a joined word).
const LINE = "how did my ads do this week and which one should I pause now";

describe("typing reaches the composer whole (fake TTY; skipped on CI like the other PTY tests)", () => {
  it("is a 60-character line", () => {
    expect(LINE).toHaveLength(60);
  });

  it.skipIf(process.env.CI === "true")("a 60-character line written in one chunk right at start-up is all in the composer, then sent whole", { timeout: 30_000 }, async () => {
    resetTurnState();
    const input = ttyInput();
    const output = ttyOutput();
    const sent: string[] = [];
    const session = runInkInteractiveSession({
      errorOutput: ttyOutput(),
      input,
      async onSubmitLine(line) {
        sent.push(line);
        return { messages: [{ role: "assistant", text: "done" }] };
      },
      output
    });
    // Before Ink has drawn anything or put the terminal in raw mode.
    input.write(LINE);
    await waitFor(() => stripAnsi(output.text()).includes(`❯ ${LINE}`), 4_000, output.text);
    input.write("\r");
    await waitFor(() => sent.length === 1, 4_000, output.text);
    expect(sent).toEqual([LINE]);
    input.write("\u0003");
    await session;
  });

  it.skipIf(process.env.CI === "true")("a line typed key by key from the very start, each key its own read and faster than a frame, keeps every key", { timeout: 30_000 }, async () => {
    resetTurnState();
    const input = ttyInput();
    const output = ttyOutput();
    const sent: string[] = [];
    const session = runInkInteractiveSession({
      errorOutput: ttyOutput(),
      input,
      async onSubmitLine(line) {
        sent.push(line);
        return { messages: [{ role: "assistant", text: "done" }] };
      },
      output
    });
    // Starts while the session mounts; each key is a separate read, with only a
    // macrotask between keys, so several keys reach the handler before React
    // has re-rendered (the race that dropped characters).
    for (const key of LINE) {
      input.write(key);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await waitFor(() => stripAnsi(output.text()).includes(`❯ ${LINE}`), 4_000, output.text);
    input.write("\r");
    await waitFor(() => sent.length === 1, 4_000, output.text);
    expect(sent).toEqual([LINE]);

    // The same after the first answer, at 1 ms a key.
    for (const key of LINE.toUpperCase()) {
      input.write(key);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    input.write("\r");
    await waitFor(() => sent.length === 2, 4_000, output.text);
    expect(sent).toEqual([LINE, LINE.toUpperCase()]);
    input.write("\u0003");
    await session;
  });
});

function ttyInput() {
  const stream = new PassThrough() as PassThrough & NodeJS.ReadStream & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (enabled: boolean) => void;
    unref: () => void;
  };
  stream.isTTY = true;
  stream.ref = vi.fn();
  stream.setRawMode = vi.fn();
  stream.unref = vi.fn();
  return stream;
}

function ttyOutput() {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & NodeJS.WriteStream & {
    columns: number;
    isTTY: boolean;
    rows: number;
    text: () => string;
  };
  stream.columns = 100;
  stream.rows = 30;
  stream.isTTY = true;
  stream.on("data", (chunk) => chunks.push(String(chunk)));
  stream.text = () => chunks.join("");
  return stream;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000, debug?: () => string) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate(), debug?.()).toBe(true);
}
