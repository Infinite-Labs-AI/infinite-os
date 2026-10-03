// Live T5 (round 4): the live check's text dump of a 100-column session showed
// the whole live frame (Steps, rule, composer, `esc stop`, top bar, question,
// answer) stacked again and again in scrollback. The cause class: a frame
// that reaches the window height scrolls its top rows out of the cursor's
// reach, so the next repaint cannot erase them (live T1-140's bytes hold one:
// a running frame of 40 rows plus the cursor's row in a 40-row window left 7
// top bars behind). The T5 dump itself reproduces exactly when its bytes are
// replayed in a 31-row emulator while the PTY was 50 rows (T1-100's 14 copies:
// 36 rows for a 40-row PTY); at the PTY's own size the bytes, the PNG and an
// xterm.js replay hold one top bar. Here two turns stream ~20 text deltas each
// (a short one and one taller than the window, with and without a tall view,
// a call running in the Steps strip), and afterwards the buffer, scrollback
// included, holds each earlier turn once and exactly one top bar, in the live
// region at the bottom; every frame stays within the window (no erase reaches
// past it, no fullscreen clear). Fake TTY, real Ink, read back through a small
// terminal emulator. Synthetic data only.
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ToolViewFrameV1 } from "@infinite-os/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { resetTurnState } from "../app/turn-store.js";
import { runInkInteractiveSession, type InkInteractiveLineResult } from "./interactive-session.js";
import { segmentsWidth } from "../lib/styled-segments.js";
import { topBarSegments, type TopBarData } from "./top-bar.js";
import { VtBuffer } from "./vt-buffer.test-util.js";

const SYNC_START = "\u001b[?2026h";
const SYNC_END = "\u001b[?2026l";

const TOP_BAR: TopBarData = {
  workspace: "Demo workspace",
  sources: [
    { label: "Sample ads", state: "connected" as const },
    { label: "Sample shop", state: "connected" as const },
    { label: "Sample site", state: "connected" as const }
  ]
};

/**
 * A synthetic top bar that fills exactly `cols` columns (live T5's bar ended
 * on its last cell, `… ● <source> ` at 100): the brief's first named cause, a
 * bar as wide as the window that wraps and leaves the eraser one row short.
 */
function windowWideTopBar(cols: number): TopBarData {
  const sources: { label: string; state: "connected" }[] = [];
  const width = () => segmentsWidth(topBarSegments({ ...TOP_BAR, sources }, cols));
  // `● Sample N ` is 11 cells; stop while a last source of 8+ letters still fits.
  while (cols - width() >= 11 + 14) sources.push({ label: `Sample ${sources.length + 1}`, state: "connected" });
  const room = cols - width() - 3;
  sources.push({ label: `Sample ${"w".repeat(Math.max(1, room - 7))}`, state: "connected" });
  const bar = { ...TOP_BAR, sources };
  if (segmentsWidth(topBarSegments(bar, cols)) !== cols) throw new Error(`the wide top bar is not ${cols} columns`);
  return bar;
}

function tallListFrame(count: number): ToolViewFrameV1 {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../views/__fixtures__/list-rows.json", import.meta.url)), "utf8"));
  const template = raw.body.rows[0];
  raw.body.rows = Array.from({ length: count }, (_unused, index) => ({
    ...template, id: `row_${index + 1}`, title: `Sample row ${String(index + 1).padStart(2, "0")}`
  }));
  delete raw.body.total;
  const view = decodeAnswerView(raw);
  if (!view) throw new Error("list fixture does not decode");
  return { type: "tool.view", stage: "tool", message: view.title, viewId: "tall1", name: view.tool, view };
}

/** ~20 deltas of synthetic prose; `long` makes the answer taller than the window. */
function deltas(long: boolean): string[] {
  const sentence = (index: number) => `Sentence ${index + 1} about the sample rows, kept short.`;
  return Array.from({ length: 20 }, (_unused, index) => `${sentence(index)}${long && index % 2 === 1 ? "\n\n" : " "}`);
}

afterEach(() => {
  resetTurnState();
});

type Progress = Parameters<Parameters<typeof runInkInteractiveSession>[0]["onSubmitLine"]>[1];

describe("a streamed turn leaves no copy of the frame in scrollback (live T5; fake TTY, skipped on CI)", () => {
  // 140x40 is live T1-140's window (its running frame drew 40 rows + the cursor's: 7 top bars in scrollback);
  // 100x16 is short enough that the panes are not held to the window.
  // A top bar exactly as wide as the window (S3, live T5's own bar) at 100 and 80.
  const sizes: readonly (readonly [number, number, boolean?])[] = [
    [100, 40], [80, 24], [140, 44], [79, 24], [140, 40], [100, 16], [100, 40, true], [80, 24, true]
  ];
  for (const [cols, rows, wideBar = false] of sizes) {
    for (const withView of [false, true]) {
      it.skipIf(process.env.CI === "true")(
        `${cols}x${rows}${wideBar ? ", a top bar as wide as the window" : ""}${withView ? ", with a tall view" : ""}: two streamed turns, each once, one top bar at the bottom`,
        { timeout: 60_000 },
        async () => {
          const input = ttyInput();
          const vt = new VtBuffer(cols, rows);
          const output = ttyOutput(cols, rows, vt);
          let progress: Progress = () => {};
          let finish: (result: InkInteractiveLineResult) => void = () => {};
          const session = runInkInteractiveSession({
            errorOutput: ttyOutput(cols, rows),
            input,
            output,
            title: "Infinite TUI",
            topBar: wideBar ? windowWideTopBar(cols) : TOP_BAR,
            turnStoppable: true,
            onSubmitLine(line, onProgress, _signal, onView) {
              if (line === "/exit") return Promise.resolve({ exit: true, messages: [] });
              progress = onProgress;
              if (withView && line === "second question") onView?.(tallListFrame(60));
              return new Promise<InkInteractiveLineResult>((resolve) => {
                finish = resolve;
              });
            }
          });
          await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);

          for (const [question, long] of [["first question", false], ["second question", true]] as const) {
            const sent = output.text().length;
            await sendKeys(input, `${question}\r`);
            await waitFor(() => stripAnsi(output.text().slice(sent)).includes(`❯ ${question}`), 4_000, () => vt.allText().join("\n"));
            // A call that runs while the answer streams (the Steps strip), as in a real turn.
            progress({ type: "tool.start", stage: "tool", message: "read_rows", toolId: `call-${question}`, name: "read_rows", words: { label: "checking the sample rows" } } as never);
            progress({ type: "message.start" } as never);
            let text = "";
            for (const piece of deltas(long)) {
              text += piece;
              progress({ type: "message.delta", text: piece } as never);
              await new Promise((resolve) => setTimeout(resolve, 15));
            }
            progress({ type: "tool.complete", stage: "tool", message: "read_rows", toolId: `call-${question}`, name: "read_rows", status: "ok", words: { label: "checking the sample rows", result: "60 rows" } } as never);
            finish({ messages: [{ role: "assistant", text: text.trim() }] });
            await waitFor(() => !lastFrame(output.text()).includes("esc"), 4_000, () => lastFrame(output.text()));
            await new Promise((resolve) => setTimeout(resolve, 60));
          }
          // The next line commits the second turn too.
          await sendKeys(input, "third question\r");
          await waitFor(() => vt.screenText().some((row) => row.includes("third question")), 4_000, () => vt.allText().join("\n"));
          await new Promise((resolve) => setTimeout(resolve, 60));

          const all = vt.allText();
          const dump = all.join("\n");
          // D1: ONE top bar, in the live region at the bottom.
          const bars = all.flatMap((row, index) => (row.includes("Demo workspace") ? [index] : []));
          expect(bars, dump).toHaveLength(1);
          expect(bars[0]!, dump).toBeGreaterThanOrEqual(all.length - rows);
          // On one row: the rule is right under it, never a wrapped piece of the bar.
          expect(all[bars[0]! + 1]!.startsWith("─"), dump).toBe(true);
          // Each earlier turn once: its question and its first and last sentences.
          for (const question of ["first question", "second question"]) {
            expect(all.filter((row) => row.startsWith(`❯ ${question}`)), `${question}\n${dump}`).toHaveLength(1);
          }
          // Answers wrap: count their sentences in the buffer's words, row breaks read as spaces.
          const words = all.join(" ").replace(/\s+/gu, " ");
          expect(words.split("Sentence 20 about the sample rows").length - 1, dump).toBe(2);
          expect(words.split("Sentence 1 about the sample rows").length - 1, dump).toBe(2);
          // Nothing of the frame is in scrollback: no composer, key bar or Steps rule above the live region.
          const scrollback = all.slice(0, Math.max(0, all.length - rows));
          expect(scrollback.filter((row) => row.startsWith("❯ Ask Infinite") || /\bcommands$/u.test(row)), dump).toEqual([]);
          // Every live frame Ink drew stayed within the window: the next repaint erases it whole
          // (its rows plus the cursor's row under the key bar), so no erase reaches past the top.
          // A frame as tall as the window takes Ink's fullscreen branch instead, which clears the
          // screen (and the scrollback): no frame may do that either (the width never changes here).
          for (const frame of frames(output.text())) {
            expect(erasedRows(frame), frame).toBeLessThanOrEqual(rows);
            expect(/\u001b\[(?:2J|3J)/u.test(frame), frame).toBe(false);
          }
          expect(/\u001b\[(?:2J|3J)/u.test(output.text())).toBe(false);
          await sendKeys(input, "/exit\r");
          await session;
        }
      );
    }
  }
});

/** Every synchronized frame Ink wrote, as written. */
function frames(text: string): string[] {
  return text.split(SYNC_START).slice(1).map((chunk) => chunk.split(SYNC_END)[0] ?? "");
}

/** The rows a repaint erases before it draws (the live frame it replaces). */
function erasedRows(frame: string): number {
  const lead = /^(?:\u001b\[\?25l)?(?:\u001b\[\d*B)?(?:\u001b\[1G)?((?:\u001b\[2K\u001b\[1A)*\u001b\[2K)?/u.exec(frame)?.[1] ?? "";
  return lead.split("\u001b[2K").length - 1;
}

function lastFrame(text: string): string {
  return stripAnsi(text.split(SYNC_START).at(-1) ?? "");
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "").replace(/\u001b\][^\u0007]*\u0007/gu, "");
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
