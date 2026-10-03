// A turn taller than the window keeps the split in a running session (layout
// decision, 2026-10-03: an everyday window should see it). In a 44-row window, from 80
// columns, a 60-row view stays beside its question: the details pane is cut
// to the window with `↓ N more · tab, then ↓`, tab then ↓ scrolls it, and the
// next line commits the turn whole, in one column, into scrollback. Fake TTY,
// real Ink, read back through a small terminal emulator. Synthetic data only.
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

const ROWS = 44;
const DOWN = "\u001b[B";

function tallListFrame(count = 60): ToolViewFrameV1 {
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

afterEach(() => {
  resetTurnState();
});

describe("a tall turn keeps the split in a 44-row window (fake TTY; skipped on CI like the other PTY tests)", () => {
  for (const cols of [80, 100, 120]) {
    it.skipIf(process.env.CI === "true")(`at ${cols} columns: split, cut with ↓ N more, scrolled after tab, then committed whole`, { timeout: 30_000 }, async () => {
      const left = paneWidths(cols).left;
      const input = ttyInput();
      const vt = new VtBuffer(cols, ROWS);
      const output = ttyOutput(cols, ROWS, vt);
      const session = runInkInteractiveSession({
        errorOutput: ttyOutput(cols, ROWS),
        input,
        async onSubmitLine(line, _onProgress, _signal, onView) {
          if (line === "/exit") return { exit: true, messages: [] };
          if (line === "show me every row") {
            onView?.(tallListFrame());
            return { messages: [{ role: "assistant", text: "Here they are, newest first." }] };
          }
          return { messages: [{ role: "assistant", text: "Done." }] };
        },
        output,
        title: "Infinite TUI"
      });

      await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
      await sendKeys(input, "show me every row\r");
      await waitFor(() => vt.screenText().some((row) => /↓ \d+ more · tab, then ↓/u.test(row)), 4_000, () => vt.screenText().join("\n"));

      const screen = vt.screenText();
      expect(screen.every((row) => [...row].length <= cols)).toBe(true);
      const question = screen.findIndex((row) => row.startsWith("❯ show me every row"));
      expect(question, screen.join("\n")).toBeGreaterThan(0);
      expect(screen[question - 2]).toContain("∞ Infinite");
      const more = screen.findIndex((row) => /↓ \d+ more · tab, then ↓/u.test(row));
      // Every pane row, the question's to the more line's, keeps the separator in its column.
      for (const row of screen.slice(question, more + 1)) {
        expect(row.slice(left, left + 2), row).toBe(" │");
      }
      expect(screen.some((row) => row.includes("Sample row 01"))).toBe(true);
      expect(screen.some((row) => row.includes("Sample row 60"))).toBe(false);
      // The frame is whole under the turn: the composer and the key bar are on screen.
      expect(screen.some((row) => row.startsWith("❯ Ask Infinite"))).toBe(true);

      // tab, then ↓: the details pane moves on a row, the question stays where it was.
      const paneAt = (rows: readonly string[], row: number) => rows[row]!.slice(left + 3);
      await sendKeys(input, "\t");
      input.write(DOWN);
      await waitFor(() => paneAt(vt.screenText(), question) === paneAt(screen, question + 1), 4_000, () => vt.screenText().join("\n"));
      const scrolled = vt.screenText();
      expect(scrolled[question]).toMatch(/^❯ show me every row/u);
      expect(paneAt(scrolled, question + 5)).toBe(paneAt(screen, question + 6));
      expect(scrolled.some((row) => /↓ \d+ more · ↓ PgDn/u.test(row))).toBe(true);
      expect(scrolled.some((row) => row.includes("↑ ↓  scroll"))).toBe(true);
      for (const row of scrolled.slice(question, more + 1)) {
        expect(row.slice(left, left + 2), row).toBe(" │");
      }

      // The next line commits the turn: every row of the view is in scrollback, once, in one column.
      await sendKeys(input, "\tnext\r");
      await waitFor(() => vt.allText().some((row) => row.startsWith("∞ Done.")), 4_000, () => vt.allText().join("\n"));
      const all = vt.allText();
      for (let index = 1; index <= 60; index += 1) {
        const name = `Sample row ${String(index).padStart(2, "0")}`;
        const rows = all.filter((row) => row.includes(name));
        expect(rows, name).toHaveLength(1);
        expect(rows[0]!.includes(" │ "), rows[0]).toBe(false);
      }
      expect(all.some((row) => /more · tab, then ↓/u.test(row))).toBe(false);
      await sendKeys(input, "/exit\r");
      await session;
    });
  }
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
