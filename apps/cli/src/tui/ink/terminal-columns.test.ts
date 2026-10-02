import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { renderInkInteractiveSessionToString, runInkInteractiveSession } from "./interactive-session.js";
import { subscribeTerminalColumns } from "./terminal-columns.js";
import { displayWidth } from "../lib/display-width.js";
import type { Msg } from "../types.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (value: string) => value.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");

describe("terminal columns", () => {
  it("reports every resize and unsubscribes cleanly", () => {
    const out = Object.assign(new EventEmitter(), { columns: 100 }) as unknown as NodeJS.WriteStream;
    const seen: number[] = [];
    const stop = subscribeTerminalColumns(out, (c) => seen.push(c));
    (out as any).columns = 62; out.emit("resize");
    (out as any).columns = 140; out.emit("resize");
    stop(); (out as any).columns = 90; out.emit("resize");
    expect(seen).toEqual([62, 140]);
    expect(out.listenerCount("resize")).toBe(0);
  });

  it("ignores a resize that reports no usable width, and tolerates a missing stream", () => {
    const out = Object.assign(new EventEmitter(), { columns: 100 }) as unknown as NodeJS.WriteStream;
    const seen: number[] = [];
    const stop = subscribeTerminalColumns(out, (c) => seen.push(c));
    (out as any).columns = 0; out.emit("resize");
    (out as any).columns = undefined; out.emit("resize");
    stop();
    expect(seen).toEqual([]);
    expect(() => subscribeTerminalColumns(undefined, () => {})()).not.toThrow();
  });
});

describe("the session draws at the width it is given", () => {
  // Synthetic content only (infinite-os is public).
  const messages: Msg[] = [
    { role: "user", text: "how did the ads do this week across every ad set and every campaign we run" },
    {
      role: "assistant",
      text: "Ad set 01 spent $100.00 and Ad set 02 spent $200.00. " +
        "This sentence is deliberately long so that it has to wrap at a narrow width and at a wide width alike. ".repeat(4)
    },
    { kind: "slash", role: "system", text: "a long system note ".repeat(12) }
  ];

  it.each([60, 120])("no row is wider than %i columns", (columns) => {
    const rendered = renderInkInteractiveSessionToString({
      columns,
      initialInputValue: "a draft that is also long enough to wrap the composer row ".repeat(3),
      initialMessages: messages,
      async onSubmitLine() {
        return { messages: [] };
      },
      status: ["session s_1"],
      title: "Infinite TUI"
    });
    const rows = stripAnsi(rendered).split("\n");
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      expect(displayWidth(row), JSON.stringify(row)).toBeLessThanOrEqual(columns);
    }
    // The top rule spans the full width, so the frame really is drawn at `columns`.
    expect(displayWidth(rows[0] ?? "")).toBe(columns);
  });
});

describe("live width in a running session (fake TTY; skipped on CI like the other PTY tests)", () => {
  it.skipIf(process.env.CI === "true")("redraws at the new width after a resize", { timeout: 30_000 }, async () => {
    const input = ttyInput();
    const output = ttyOutput(60);
    const errorOutput = ttyOutput(60);

    const session = runInkInteractiveSession({
      errorOutput,
      input,
      async onSubmitLine() {
        return { exit: true, messages: [] };
      },
      output,
      title: "Infinite TUI"
    });

    await waitFor(() => topRuleWidths(output.text()).includes(60), 4_000, output.text);

    output.columns = 100;
    output.emit("resize");
    await waitFor(() => topRuleWidths(output.text()).includes(100), 4_000, output.text);

    for (const key of "/exit\r") {
      input.write(key);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await session;
  });
});

function topRuleWidths(text: string): number[] {
  return stripAnsi(text)
    .split(/\r?\n/)
    .filter((line) => line.includes("Infinite TUI ─"))
    .map((line) => displayWidth(line.trimEnd()));
}

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

function ttyOutput(columns: number) {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & NodeJS.WriteStream & {
    columns: number;
    isTTY: boolean;
    rows: number;
    text: () => string;
  };
  stream.columns = columns;
  stream.rows = 24;
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
