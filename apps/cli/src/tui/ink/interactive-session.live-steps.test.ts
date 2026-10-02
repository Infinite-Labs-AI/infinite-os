import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetTurnState } from "../app/turn-store.js";
import { stripAnsi } from "../lib/display-width.js";
import { runInkInteractiveSession, type InkInteractiveLineResult } from "./interactive-session.js";

// A live session fed the frames a desktop sends (fake TTY): the working line
// while nothing has come back, then Steps rows worded by the app, a row that
// waits for the person's OK, and an older desktop's unworded frames. Synthetic
// data only: made-up tool names and words.
const RAW_LIST = "mcp__sample_app__list_sample_rows";
const RAW_PROPOSE = "mcp__sample_app__propose_pause_sample_item";
const KAOMOJI = /[＀-￯　-〿︰-﹏\u{1f300}-\u{1faff}]|pondering|contemplating/u;

describe("a live turn's working line and Steps (fake TTY; skipped on CI like the other PTY tests)", () => {
  afterEach(() => {
    resetTurnState();
  });

  it.skipIf(process.env.CI === "true")("says Working… at once, then rows in the app's words; a step waiting for an OK is ▣", { timeout: 30_000 }, async () => {
    const input = ttyInput();
    const output = ttyOutput();
    let progress: Parameters<Parameters<typeof runInkInteractiveSession>[0]["onSubmitLine"]>[1] = () => {};
    let finish: (result: InkInteractiveLineResult) => void = () => {};

    const session = runInkInteractiveSession({
      columns: 100,
      errorOutput: ttyOutput(),
      input,
      output,
      turnStoppable: true,
      onSubmitLine(line, onProgress) {
        if (line === "/exit") {
          return Promise.resolve({ exit: true, messages: [] });
        }
        progress = onProgress;
        return new Promise<InkInteractiveLineResult>((resolve) => {
          finish = resolve;
        });
      }
    });

    // The boot key bar is `/ commands` alone (no side to switch to yet).
    await waitFor(() => lastLineWith(output.text(), "commands") !== "", 4_000, output.text);
    await sendKeys(input, "how are the sample rows?\r");

    // Nothing has come back yet: the answer's place says the turn is working.
    await waitFor(() => /[⠀-⣿] Working…/u.test(stripAnsi(output.text())), 4_000, output.text);
    expect(stripAnsi(output.text())).not.toMatch(KAOMOJI);

    // Worded frames (step.words.v1): the row is the app's label and result.
    progress({ type: "tool.start", stage: "tool", message: RAW_LIST, toolId: "call-1", name: RAW_LIST, context: '{"level":"row"}', words: { label: "checking the catalog" } } as never);
    await waitFor(() => lastLineWith(output.text(), "checking the catalog") !== "", 4_000, output.text);
    progress({ type: "tool.complete", stage: "tool", message: RAW_LIST, toolId: "call-1", name: RAW_LIST, status: "ok", words: { label: "checking the catalog", result: "3 rows" } } as never);
    await waitFor(() => /checking the catalog\s+━+\s+✓ 3 rows/u.test(lastLineWith(output.text(), "checking the catalog")), 4_000, output.text);

    // A proposal's step waits for the person's OK: pending (▣), never a tick.
    progress({ type: "tool.complete", stage: "tool", message: RAW_PROPOSE, toolId: "call-2", name: RAW_PROPOSE, status: "requires_confirmation", words: { label: "waiting for your OK", result: "pause 1 item" } } as never);
    await waitFor(() => /waiting for your OK\s+━+\s+▣ pause 1 item/u.test(lastLineWith(output.text(), "waiting for your OK")), 4_000, output.text);
    expect(lastLineWith(output.text(), "waiting for your OK")).not.toContain("✓");

    // An older desktop's frame: no words, no call id. Generic words, its own row.
    progress({ type: "tool.complete", stage: "tool", message: RAW_LIST, toolId: "", name: RAW_LIST, status: "ok" } as never);
    await waitFor(() => lastLineWith(output.text(), "listing sample rows") !== "", 4_000, output.text);
    expect(lastLineWith(output.text(), "checking the catalog")).toMatch(/✓ 3 rows/u);

    const drawn = stripAnsi(output.text());
    expect(drawn).not.toMatch(/mcp__|sample_app|"level"/u);
    expect(drawn).not.toMatch(KAOMOJI);

    finish({ messages: [{ role: "assistant", text: "Three rows changed." }] });
    await waitFor(() => stripAnsi(output.text()).includes("∞ Three rows changed."), 4_000, output.text);
    // The turn answered: the working line is gone from the frame that follows.
    await waitFor(() => !lastLineWith(output.text(), "commands").includes("esc"), 4_000, output.text);
    const after = stripAnsi(output.text()).slice(stripAnsi(output.text()).lastIndexOf("∞ Three rows changed."));
    expect(after).not.toContain("Working…");

    await sendKeys(input, "/exit\r");
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

async function sendKeys(input: NodeJS.WritableStream, keys: string) {
  for (const key of keys) {
    input.write(key);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The last drawn line that contains `text` (the frame is redrawn whole, so this is the latest one). */
function lastLineWith(output: string, text: string): string {
  return stripAnsi(output).split(/\r?\n/u).filter((line) => line.includes(text)).at(-1) ?? "";
}
