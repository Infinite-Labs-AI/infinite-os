// Live L8 (round 4), in a running session: a finished answer taller than the
// window went whole to scrollback, the bar dropped to `/ commands`, Tab did
// nothing and `o` typed an `o`. From 80 columns the last finished turn now
// keeps the split and its keys until the next question: tab (the view first,
// as the layout decision says), then o opens the view's place; tab again puts
// the keys on the answer pane (its rule marked), where ↓ scrolls it alone. The
// next question commits the turn whole, in one column. Below 80 the turn goes
// to scrollback in one column, and its view stays focusable there: tab, then
// o still opens its place until the next question. 80x24, 100x40 and 140x44,
// with the list_sources health view and the get_meta_performance composite.
// Fake TTY, real Ink, read back through a small terminal emulator. Synthetic data only.
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ToolViewFrameV1 } from "@infinite-os/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { resetTurnState } from "../app/turn-store.js";
import { paneWidths } from "../views/layout.js";
import type { AppOpenTarget } from "../views/open-target.js";
import { runInkInteractiveSession } from "./interactive-session.js";
import { VtBuffer } from "./vt-buffer.test-util.js";

const DOWN = "\u001b[B";
const LINES = 40;
const ANSWER = Array.from({ length: LINES }, (_unused, index) => `Line ${index + 1} of the answer.`).join("\n\n");

function frame(name: string, patch: Record<string, unknown>): ToolViewFrameV1 {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL(`../views/__fixtures__/${name}.json`, import.meta.url)), "utf8"));
  const view = decodeAnswerView({ ...raw, ...patch });
  if (!view) throw new Error(`${name} does not decode`);
  return { type: "tool.view", stage: "tool", message: view.title, viewId: "v1", name: view.tool, view };
}

const FIXTURES = {
  "list_sources health": () => frame("health-connections", { tool: "list_sources", appLink: { place: "settings.connections", label: "Open in Connections" } }),
  "get_meta_performance composite": () => frame("meta-level-campaigns", { appLink: { place: "ads.meta", label: "Open in Meta Ads" } })
} as const;

afterEach(() => {
  resetTurnState();
});

async function start(cols: number, rows: number, view: () => ToolViewFrameV1) {
  const input = ttyInput();
  const vt = new VtBuffer(cols, rows);
  const output = ttyOutput(cols, rows, vt);
  const opened: AppOpenTarget[] = [];
  const session = runInkInteractiveSession({
    appCaps: () => ({ open: true, watch: false, retry: false }),
    errorOutput: ttyOutput(cols, rows),
    input,
    output,
    title: "Infinite TUI",
    async onOpenAppLink(target) {
      opened.push(target);
      return { ok: true };
    },
    async onSubmitLine(line, _onProgress, _signal, onView) {
      if (line === "/exit") return { exit: true, messages: [] };
      if (line === "how are my sources?") {
        onView?.(view());
        return { messages: [{ role: "assistant", text: ANSWER }] };
      }
      return { messages: [{ role: "assistant", text: "Done." }] };
    }
  });
  await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
  return { input, vt, output, opened, session };
}

const keyBar = (vt: VtBuffer) => vt.screenText().filter((row) => row.trim()).at(-1) ?? "";
const composer = (vt: VtBuffer) => vt.screenText().find((row) => row.startsWith("❯ ") && !row.startsWith("❯ how")) ?? "";

describe("a finished tall turn keeps the split and its keys (live L8; fake TTY, skipped on CI)", () => {
  for (const [cols, rows] of [[80, 24], [100, 40], [140, 44]] as const) {
    for (const [name, view] of Object.entries(FIXTURES)) {
      it.skipIf(process.env.CI === "true")(`${cols}x${rows}, ${name}: split kept, tab then o opens, tab again scrolls the answer, next commits whole`, { timeout: 30_000 }, async () => {
        const left = paneWidths(cols).left;
        const { input, vt, opened, session } = await start(cols, rows, view);
        await sendKeys(input, "how are my sources?\r");
        // The caption gate folds the answer to two sentences beside the view; `?` opens the rest (round 4).
        await waitFor(() => vt.screenText().some((row) => row.slice(0, left).trim() === "… more (?)"), 4_000, () => vt.screenText().join("\n"));
        expect(keyBar(vt)).toMatch(/^\s*\?\s+more/u);
        await sendKeys(input, "?");
        await waitFor(() => vt.screenText().some((row) => /↓ \d+ more · tab, then ↓/u.test(row.slice(0, left))), 4_000, () => vt.screenText().join("\n"));
        expect(vt.screenText().some((row) => row.includes("… more (?)"))).toBe(false);

        const screen = vt.screenText();
        const question = screen.findIndex((row) => row.startsWith("❯ how are my sources?"));
        expect(question, screen.join("\n")).toBeGreaterThan(0);
        // The split survives the finish: the question row keeps the separator.
        expect(screen[question]!.slice(left, left + 2)).toBe(" │");
        // At rest the bar says what tab unlocks, never only `/ commands`.
        expect(keyBar(vt), screen.join("\n")).toMatch(/tab\s+then o open/u);

        // tab, then o: the app opens the view's place; nothing is typed.
        await sendKeys(input, "\t");
        // The bar is one row; when it is too wide, lower keys give way so `o open` and `tab switch side` stay whole (S2).
        await waitFor(() => /o\s+open/u.test(keyBar(vt)) && /tab\s+switch side/u.test(keyBar(vt)), 4_000, () => keyBar(vt));
        expect(keyBar(vt), keyBar(vt)).not.toMatch(/tab\s+switch si…/u);
        await sendKeys(input, "o");
        await waitFor(() => opened.length === 1, 4_000, () => vt.screenText().join("\n"));
        expect(composer(vt)).toMatch(/^❯ Ask Infinite/u);

        // tab again: the keys go to the answer pane, its rule is marked, ↓ scrolls it alone.
        await sendKeys(input, "\t");
        await waitFor(() => /↑ ↓\s+scroll/u.test(keyBar(vt)), 4_000, () => keyBar(vt));
        const before = vt.screenText();
        const at = before.findIndex((row) => row.startsWith("❯ how are my sources?"));
        expect(before[at - 1]!.slice(0, left)).toBe("━".repeat(left));
        input.write(DOWN);
        await waitFor(() => !vt.screenText().some((row) => row.startsWith("❯ how are my sources?")), 4_000, () => vt.screenText().join("\n"));
        const after = vt.screenText();
        const rowAt = before.findIndex((row) => row.startsWith("❯ how are my sources?"));
        for (let row = rowAt; row < rowAt + 8; row += 1) {
          expect(after[row]!.slice(left + 3), `row ${row}`).toBe(before[row]!.slice(left + 3));
        }
        expect(composer(vt)).toMatch(/^❯ Ask Infinite/u);

        // The next question commits the turn whole, in one column: every line once.
        await sendKeys(input, "next\r");
        await waitFor(() => vt.allText().some((row) => row.startsWith("∞ Done.")), 4_000, () => vt.allText().join("\n"));
        const all = vt.allText();
        for (const n of [1, 20, LINES]) {
          const rowsWith = all.filter((row) => row.includes(`Line ${n} of the answer.`));
          expect(rowsWith, `Line ${n}`).toHaveLength(1);
          expect(rowsWith[0]!.includes(" │ "), rowsWith[0]).toBe(false);
        }
        await sendKeys(input, "/exit\r");
        await session;
      });
    }
  }

  for (const [name, view] of Object.entries(FIXTURES)) {
    it.skipIf(process.env.CI === "true")(`79x24, ${name}: one column, the turn goes up, tab then o still opens its place`, { timeout: 30_000 }, async () => {
      const { input, vt, opened, session } = await start(79, 24, view);
      await sendKeys(input, "how are my sources?\r");
      // A view that does not fit goes up at once (its folded rest under it); one that fits shows the fold: `?` opens it, and then it does not fit.
      await waitFor(() => vt.allText().some((row) => row.includes(`Line ${LINES} of the answer.`) || row.trim() === "… more (?)"), 4_000, () => vt.allText().join("\n"));
      if (!vt.allText().some((row) => row.includes(`Line ${LINES} of the answer.`))) await sendKeys(input, "?");
      await waitFor(() => vt.allText().some((row) => row.includes(`Line ${LINES} of the answer.`)), 4_000, () => vt.allText().join("\n"));
      await waitFor(() => /tab\s+then o open/u.test(keyBar(vt)), 4_000, () => vt.screenText().join("\n"));
      await sendKeys(input, "\t");
      await waitFor(() => /o\s+open/u.test(keyBar(vt)) && !/then o/u.test(keyBar(vt)), 4_000, () => keyBar(vt));
      await sendKeys(input, "o");
      await waitFor(() => opened.length === 1, 4_000, () => vt.screenText().join("\n"));
      expect(composer(vt)).toMatch(/^❯ Ask Infinite/u);
      // The next question ends it: its keys are gone.
      await sendKeys(input, "next\r");
      await waitFor(() => vt.allText().some((row) => row.startsWith("∞ Done.")), 4_000, () => vt.allText().join("\n"));
      expect(keyBar(vt)).not.toMatch(/o\s+open/u);
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
