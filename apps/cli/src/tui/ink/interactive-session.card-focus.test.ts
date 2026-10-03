// Live check 2, W3L2-M2 (safety): "Pause my worst-performing ad" drew a week
// table and a 65-ad list before its pause card, and the right pane opened at
// its top. The key bar offered `p pause` while the card was 136 lines below
// the fold, so one `p` would pause an ad the user never saw. Now the pane
// opens on the waiting card (its title, rows and keys on screen), and the OK
// key is offered, and acts, only while the card is on screen: ↑ scrolls it
// off and `p` leaves the bar and does nothing; `n` stays a real decline.
// Fake TTY, real Ink, read back through a small terminal emulator, at 80x24,
// 100x40 and 140x44. Synthetic data only.
import { readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ToolViewFrameV1 } from "@infinite-os/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import type { InSessionConfirmationAction } from "../../desktop/confirm-in-session.js";
import { resetTurnState } from "../app/turn-store.js";
import { runInkInteractiveSession } from "./interactive-session.js";
import { VtBuffer } from "./vt-buffer.test-util.js";

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const fixtureJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../views/__fixtures__/${name}.json`, import.meta.url)), "utf8"));

function frame(raw: unknown, viewId: string): ToolViewFrameV1 {
  const view = decodeAnswerView(raw);
  if (!view) throw new Error(`${viewId} does not decode`);
  return { type: "tool.view", stage: "tool", message: view.title, viewId, name: view.tool, view };
}

/** 65 sample ads, none of them the card's ad (so nothing folds into the card). */
function tallList(): ToolViewFrameV1 {
  const raw = fixtureJson("list-rows");
  const template = raw.body.rows[0];
  raw.title = "Sample ads";
  raw.body.rows = Array.from({ length: 65 }, (_unused, index) => ({
    ...template, id: `row_${index + 1}`, title: `Sample row ${String(index + 1).padStart(2, "0")}`
  }));
  delete raw.body.total;
  return frame(raw, "list65");
}

/** The pause card with a source line and its target's parents (a path row), as the live card had: 11 rows drawn whole. */
function pauseCard(): InSessionConfirmationAction {
  const raw = fixtureJson("change-pause-card");
  raw.body.target.path = ["Sample campaign · trials", "Sample ad set · broad"];
  raw.provenance = { source: "Sample · ad", via: "our_db" };
  const view = decodeAnswerView(raw);
  if (!view) throw new Error("change-pause-card does not decode");
  return {
    turnId: "turn_1", confirmationHandle: "h_1", summary: "Pause ad Demo A",
    confirmationDetails: [{ label: "Ad", value: "Demo A" }], confirmFieldsCapable: true, view
  };
}

const CARD_TITLE = /┌─ Pause ad “Demo A”\?/u;
const keyBar = (screen: readonly string[]) => [...screen].reverse().find((row) => row.trim() !== "") ?? "";
const offersPause = (screen: readonly string[]) => /^ p {2}pause\b/u.test(keyBar(screen));

afterEach(() => {
  resetTurnState();
});

describe("a waiting card under a tall view is on screen whenever p is offered (fake TTY; skipped on CI like the other PTY tests)", () => {
  for (const [cols, rows] of [[80, 24], [100, 40], [140, 44]] as const) {
    it.skipIf(process.env.CI === "true")(`at ${cols}x${rows}: opens on the card; ↑ hides p and p does nothing; ↓ brings both back; n declines`, { timeout: 30_000 }, async () => {
      const decisions: string[] = [];
      const input = ttyInput();
      const vt = new VtBuffer(cols, rows);
      const output = ttyOutput(cols, rows, vt);
      const session = runInkInteractiveSession({
        errorOutput: ttyOutput(cols, rows),
        input,
        async onSubmitLine(line, onProgress, _signal, onView) {
          if (line === "/exit") return { exit: true, messages: [] };
          // Two Steps rows, as the live turn had: a read, then the proposal waiting for the OK.
          onProgress?.({ type: "tool.start", stage: "tool", message: "list_sample", toolId: "c1", name: "list_sample", words: { label: "checking your campaigns" } } as never);
          onProgress?.({ type: "tool.complete", stage: "tool", message: "list_sample", toolId: "c1", name: "list_sample", status: "ok", words: { label: "checking your campaigns", result: "65 ads" } } as never);
          onProgress?.({ type: "tool.complete", stage: "tool", message: "propose_pause", toolId: "c2", name: "propose_pause", status: "requires_confirmation", words: { label: "waiting for your OK", result: "pause on Meta" } } as never);
          onView?.(frame(fixtureJson("numbers-ads"), "week"));
          onView?.(tallList());
          return {
            messages: [{ role: "assistant", text: "Ready. It stops spending once you say OK." }],
            pendingConfirmations: [pauseCard()]
          };
        },
        async onConfirmAction(_action, decision) {
          decisions.push(decision);
          return { messages: [{ role: "assistant", text: "Okay, left it running." }] };
        },
        output,
        title: "Infinite TUI"
      });

      await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
      await sendKeys(input, "pause my worst ad\r");
      await waitFor(() => vt.screenText().some((row) => CARD_TITLE.test(row)), 4_000, () => vt.screenText().join("\n"));

      // Opened on the card: its title, its row and its keys are on screen, with p on the bar.
      const opened = vt.screenText();
      if (process.env.CARD_FOCUS_DUMP) writeFileSync(`${process.env.CARD_FOCUS_DUMP}/opened-${cols}x${rows}.txt`, opened.join("\n"));
      expect(opened.every((row) => [...row].length <= cols)).toBe(true);
      expect(offersPause(opened), keyBar(opened)).toBe(true);
      expect(opened.some((row) => row.includes("│ status   on → paused") || /status\s+on → paused/u.test(row))).toBe(true);
      expect(opened.some((row) => /p {2}Pause {4}n {2}dismiss/u.test(row) && !row.startsWith(" p"))).toBe(true);
      expect(opened.some((row) => row.includes("Sample campaign"))).toBe(true);
      expect(opened.some((row) => /waiting for your OK\s+━+\s+▣ pause on Meta/u.test(row)), opened.join("\n")).toBe(true);
      // Whole, never paged: no `page 1 of 2` in it and no `space next page` on the bar.
      expect(opened.some((row) => /page \d of \d/u.test(row)), opened.join("\n")).toBe(false);
      expect(keyBar(opened)).not.toContain("next page");
      expect(opened.some((row) => /↑ \d+ above · ↑ PgUp/u.test(row))).toBe(true);
      expect(opened.some((row) => row.startsWith("❯ pause my worst ad"))).toBe(true);

      // ↑ moves the pane up a row: the card's foot leaves the screen, and p leaves the bar (n stays).
      input.write(UP);
      await waitFor(() => !offersPause(vt.screenText()), 4_000, () => vt.screenText().join("\n"));
      const scrolled = vt.screenText();
      expect(keyBar(scrolled)).toMatch(/n {2}dismiss/u);
      // Whenever p is offered, the card's title row is on screen (here: p is not offered).
      for (let index = 0; index < 80 && vt.screenText().some((row) => CARD_TITLE.test(row)); index += 1) {
        input.write(UP);
        await new Promise((resolve) => setTimeout(resolve, 15));
        const now = vt.screenText();
        if (offersPause(now)) expect(now.some((row) => CARD_TITLE.test(row)), now.join("\n")).toBe(true);
      }
      await waitFor(() => !vt.screenText().some((row) => CARD_TITLE.test(row)), 4_000, () => vt.screenText().join("\n"));
      const away = vt.screenText();
      if (process.env.CARD_FOCUS_DUMP) writeFileSync(`${process.env.CARD_FOCUS_DUMP}/away-${cols}x${rows}.txt`, away.join("\n"));
      expect(offersPause(away), keyBar(away)).toBe(false);
      expect(keyBar(away)).toMatch(/n {2}dismiss/u);
      // p with the card off screen does nothing: no decision, the card still waits.
      await sendKeys(input, "p");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(decisions).toEqual([]);
      expect(vt.screenText().join("\n")).not.toContain("Okay, left it running.");

      // ↓ back to the foot: the card is whole again and p is back.
      for (let index = 0; index < 200 && !offersPause(vt.screenText()); index += 1) {
        input.write(DOWN);
        await new Promise((resolve) => setTimeout(resolve, 15));
        const now = vt.screenText();
        if (offersPause(now)) expect(now.some((row) => CARD_TITLE.test(row)), now.join("\n")).toBe(true);
      }
      const back = vt.screenText();
      expect(offersPause(back), back.join("\n")).toBe(true);
      expect(back.some((row) => CARD_TITLE.test(row))).toBe(true);

      // n is a real decline.
      await sendKeys(input, "n");
      await waitFor(() => decisions.length === 1, 4_000, () => vt.screenText().join("\n"));
      expect(decisions).toEqual(["decline"]);
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
