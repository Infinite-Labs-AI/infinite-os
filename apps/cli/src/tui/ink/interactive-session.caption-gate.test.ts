// The caption gate in a running session (round 4): an answer that comes with
// a view shows two sentences above it and a dim `… more (?)` line. `?` (the
// keys not on the view) opens the rest in the live turn; after tab the keys
// are on the view and `?` is its explanation, as before. The next question
// commits the turn: two sentences above the view, the folded rest under it,
// dim, every word once. Fake TTY, real Ink, read back through a small
// terminal emulator. Synthetic data only (shared vector V1).
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ToolViewFrameV1 } from "@infinite-os/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { resetTurnState } from "../app/turn-store.js";
import { paneWidths } from "../views/layout.js";
import { runInkInteractiveSession } from "./interactive-session.js";
import { VtBuffer } from "./vt-buffer.test-util.js";

const V1 = "Spend is up 12% this week. I would not scale this yet: trials are not confirmed. Today is still open, so treat it separately.";
const FOLDED = "Today is still open, so treat it separately.";

function metaFrame(): ToolViewFrameV1 {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../views/__fixtures__/meta-level-campaigns.json", import.meta.url)), "utf8"));
  const view = decodeAnswerView({ ...raw, explain: "Sample explanation of these numbers." });
  if (!view) throw new Error("fixture does not decode");
  return { type: "tool.view", stage: "tool", message: view.title, viewId: "v1", name: view.tool, view };
}

afterEach(() => {
  resetTurnState();
});

async function start(cols: number, rows: number) {
  const input = ttyInput();
  const vt = new VtBuffer(cols, rows);
  const output = ttyOutput(cols, rows, vt);
  const session = runInkInteractiveSession({
    errorOutput: ttyOutput(cols, rows),
    input,
    output,
    title: "Infinite TUI",
    async onSubmitLine(line, _onProgress, _signal, onView) {
      if (line === "/exit") return { exit: true, messages: [] };
      if (line === "how is spend?") {
        onView?.(metaFrame());
        return { messages: [{ role: "assistant", text: V1 }] };
      }
      return { messages: [{ role: "assistant", text: "Done." }] };
    }
  });
  await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
  return { input, vt, output, session };
}

const keyBar = (vt: VtBuffer) => vt.screenText().filter((row) => row.trim()).at(-1) ?? "";
/** The answer's words on screen: the left pane's when split. */
const answerWords = (vt: VtBuffer, cols: number) => {
  const panes = paneWidths(cols);
  return vt.screenText().map((row) => (panes.wide ? row.slice(0, panes.left) : row)).join(" ").replace(/\s+/gu, " ");
};

describe("the caption gate in a running session (fake TTY, skipped on CI)", () => {
  for (const [cols, rows] of [[100, 40], [140, 44]] as const) {
    it.skipIf(process.env.CI === "true")(`${cols}x${rows}: ? opens the folded rest; the next question commits it under the view`, { timeout: 30_000 }, async () => {
      const { input, vt, session } = await start(cols, rows);
      await sendKeys(input, "how is spend?\r");
      await waitFor(() => vt.screenText().some((row) => row.includes("… more (?)")), 4_000, () => vt.screenText().join("\n"));
      expect(answerWords(vt, cols)).toContain("trials are not confirmed.");
      expect(answerWords(vt, cols)).not.toContain(FOLDED);
      expect(keyBar(vt)).toMatch(/^\s*\?\s+more/u);
      await sendKeys(input, "?");
      await waitFor(() => answerWords(vt, cols).includes(FOLDED), 4_000, () => vt.screenText().join("\n"));
      expect(vt.screenText().some((row) => row.includes("… more (?)"))).toBe(false);
      // `?` opened the fold: nothing was typed.
      expect(vt.screenText().some((row) => row.startsWith("❯ Ask Infinite"))).toBe(true);

      await sendKeys(input, "next\r");
      await waitFor(() => vt.allText().some((row) => row.startsWith("∞ Done.")), 4_000, () => vt.allText().join("\n"));
      const all = vt.allText();
      const head = all.findIndex((row) => row.includes("Ads by campaign"));
      const rest = all.findIndex((row) => row.includes(FOLDED));
      expect(head, all.join("\n")).toBeGreaterThan(0);
      expect(rest, all.join("\n")).toBeGreaterThan(head);
      expect(all.filter((row) => row.includes(FOLDED))).toHaveLength(1);
      expect(all.slice(0, head).join(" ")).toContain("trials are not confirmed.");
      await sendKeys(input, "/exit\r");
      await session;
    });
  }

  it.skipIf(process.env.CI === "true")("100x40: after tab, ? is the view's explanation; the fold stays closed", { timeout: 30_000 }, async () => {
    const { input, vt, session } = await start(100, 40);
    await sendKeys(input, "how is spend?\r");
    await waitFor(() => vt.screenText().some((row) => row.includes("… more (?)")), 4_000, () => vt.screenText().join("\n"));
    await sendKeys(input, "\t");
    await waitFor(() => /\?\s+what it does/u.test(keyBar(vt)), 4_000, () => keyBar(vt));
    await sendKeys(input, "?");
    await waitFor(() => /\?\s+hide/u.test(keyBar(vt)), 4_000, () => keyBar(vt));
    expect(vt.screenText().some((row) => row.includes("Sample explanation of these numbers."))).toBe(true);
    expect(vt.screenText().some((row) => row.includes("… more (?)"))).toBe(true);
    expect(answerWords(vt, 100)).not.toContain(FOLDED);
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

function ttyOutput(columns: number, rows: number, vt?: VtBuffer) {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & NodeJS.WriteStream & {
    columns: number;
    isTTY: boolean;
    rows: number;
    text: () => string;
  };
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  stream.on("data", (chunk) => {
    chunks.push(String(chunk));
    vt?.write(String(chunk));
  });
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
  for (const k of keys) {
    input.write(k);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
