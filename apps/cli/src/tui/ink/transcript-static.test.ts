import { readFileSync } from "node:fs";
import type { InSessionConfirmationAction } from "../../desktop/confirm-in-session.js";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import { getTurnState, resetTurnState } from "../app/turn-store.js";
import { displayWidth } from "../lib/display-width.js";
import {
  renderInkInteractiveSessionToString,
  runInkInteractiveSession,
  wouldTriggerInkFullscreen,
  type InkInteractiveLineResult
} from "./interactive-session.js";
import { inkTranscriptLayout, inkTranscriptRowCount, renderInkTranscriptToString } from "./transcript-app.js";
import {
  commitOnSubmit,
  liveRegionCap,
  livePageHint,
  livePageKey,
  liveWindow,
  pageLiveWindow,
  type CommittedEntry
} from "./transcript-static.js";

resetTurnState();
const emptyState = getTurnState();
const ESC = String.fromCharCode(27);
const stripAnsi = (value: string) => value.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");
const key = (overrides: Partial<Key> = {}) => ({ pageDown: false, pageUp: false, ...overrides }) as Key;

describe("transcript Static: committed turns leave the live region", () => {
  it("predicts composer rows from the live region only", () => {
    const live = { transcript: { state: emptyState } , columns: 80 };
    const many = Array.from({ length: 300 }, (_, i) => ({ id: String(i), lines: [`line ${i}`] }));
    expect(inkTranscriptRowCount({ ...live, committed: many })).toBe(inkTranscriptRowCount({ ...live, committed: [] }));
  });

  it("counts the live latest turn, and never more than the cap", () => {
    const tall = { id: "t1", lines: Array.from({ length: 200 }, (_, i) => `row ${i}`) };
    const rows = inkTranscriptRowCount({ transcript: { state: emptyState }, columns: 80, rows: 40, latest: tall, committed: [] });
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual(liveRegionCap(40, 3, 1));
  });

  it("the latest turn commits only when the next line is submitted", () => {
    const s = commitOnSubmit({ committed: [], latest: { id: "t1", lines: ["a"] } }, "next question");
    expect(s.committed.map((e) => e.id)).toEqual(["t1"]); expect(s.latest).toBeNull();
  });

  it("finished messages go to Static, the running turn does not", () => {
    const src = readFileSync(fileURLToPath(new URL("./transcript-app.tsx", import.meta.url)), "utf8");
    expect(src).toMatch(/<Static items=\{committed\}/);
  });

  it("the live latest turn is counted, row for row, while it fits", () => {
    const base = inkTranscriptRowCount({ transcript: { state: emptyState }, columns: 80, rows: 40 });
    const three = { id: "t1", lines: ["a", "b", "c"] };
    // The empty live region draws one blank row; three latest-turn rows replace it.
    expect(inkTranscriptRowCount({ transcript: { state: emptyState }, columns: 80, rows: 40, latest: three })).toBe(base + 2);
  });

  it("the predicted row count equals the rendered live rows, capped or not, with committed rows printed above", () => {
    const tall = { id: "t1", lines: Array.from({ length: 200 }, (_, i) => `row ${i}`) };
    const committed = [{ id: "c1", lines: ["committed one"] }, { id: "c2", lines: ["committed two"] }];
    for (const rows of [undefined, 24, 40]) {
      const props = { transcript: { state: emptyState }, columns: 80, rows, latest: tall, committed, showComposer: false };
      const rendered = stripAnsi(renderInkTranscriptToString(props)).split("\n");
      // Ink prints <Static> output first; everything after it is the live region.
      expect(rendered.slice(0, 2)).toEqual(["committed one", "committed two"]);
      expect(rendered.length - 2).toBe(inkTranscriptRowCount(props));
    }
  });

  it("a capped latest turn shows a page, then a hint, never past the width", () => {
    const tall = { id: "t1", lines: Array.from({ length: 200 }, (_, i) => `row ${i}`) };
    const live = stripAnsi(renderInkTranscriptToString({
      transcript: { state: emptyState }, columns: 48, rows: 24, latest: tall, livePage: 0, showComposer: false
    })).split("\n");
    expect(live).toContain("row 0");
    expect(live).not.toContain("row 199");
    expect(live.some((line) => line.includes("more lines"))).toBe(true);
    expect(live.every((line) => displayWidth(line) <= 48)).toBe(true);
    // Following the tail (a running turn) shows the end instead.
    const tail = stripAnsi(renderInkTranscriptToString({
      transcript: { state: emptyState }, columns: 48, rows: 24, latest: tall, livePage: null, showComposer: false
    })).split("\n");
    expect(tail).toContain("row 199");
    expect(tail).not.toContain("row 0");
  });

  it.each([12, 24, 40, 60])("a capped live region never trips the fullscreen redraw (%i rows)", (rows) => {
    const tall = { id: "t1", lines: Array.from({ length: 500 }, (_, i) => `row ${i}`) };
    for (const busy of [false, true]) {
      const rowsAboveComposer = inkTranscriptRowCount({
        busy, transcript: { state: emptyState }, columns: 80, rows, latest: tall, showComposer: false
      });
      // + the key bar row (T7) above a composer that may wrap to 3 rows.
      expect(wouldTriggerInkFullscreen({ rowsAboveComposer: rowsAboveComposer + 1, composerRows: 3, terminalRows: rows })).toBe(false);
    }
  });

  it("the layout reports what can be paged", () => {
    const tall = { id: "t1", lines: Array.from({ length: 200 }, (_, i) => `row ${i}`) };
    const top = inkTranscriptLayout({ transcript: { state: emptyState }, columns: 80, rows: 40, latest: tall, livePage: 0 });
    expect(top.window.hiddenAbove).toBe(0);
    expect(top.window.hiddenBelow).toBeGreaterThan(0);
    const uncapped = inkTranscriptLayout({ transcript: { state: emptyState }, columns: 80, latest: tall });
    expect(uncapped.window.paged).toBe(false);
    expect(uncapped.rowCount).toBeGreaterThan(200);
  });
});

describe("transcript-static pure helpers", () => {
  it("commitOnSubmit keeps order, and does nothing for a blank line or an empty turn", () => {
    const committed: CommittedEntry[] = [{ id: "home", lines: ["h"] }];
    const s = commitOnSubmit({ committed, latest: { id: "t1", lines: ["a"] } }, "  next  ");
    expect(s.committed.map((e) => e.id)).toEqual(["home", "t1"]);
    expect(committed.map((e) => e.id)).toEqual(["home"]); // never mutates
    const blank = { committed, latest: { id: "t1", lines: ["a"] } };
    expect(commitOnSubmit(blank, "   ")).toBe(blank);
    const none = { committed, latest: null };
    expect(commitOnSubmit(none, "next")).toBe(none);
  });

  it("liveRegionCap leaves the composer, the key bar and two rows of margin", () => {
    expect(liveRegionCap(40, 3, 1)).toBe(34);
    expect(liveRegionCap(24, 1, 0)).toBe(21);
    expect(liveRegionCap(undefined, 3, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(liveRegionCap(5, 3, 1)).toBeGreaterThanOrEqual(4); // a tiny window still shows something
  });

  it("liveWindow pages from the top, or follows the tail when the offset is null", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `l${i}`);
    expect(liveWindow(lines, 60, 0)).toMatchObject({ paged: false, hiddenAbove: 0, hiddenBelow: 0 });
    const top = liveWindow(lines, 11, 0);
    expect(top).toMatchObject({ paged: true, pageSize: 10, start: 0, hiddenAbove: 0, hiddenBelow: 40 });
    expect(top.lines).toEqual(lines.slice(0, 10));
    const tail = liveWindow(lines, 11, null);
    expect(tail).toMatchObject({ start: 40, hiddenAbove: 40, hiddenBelow: 0 });
    expect(liveWindow(lines, 11, 999).start).toBe(40); // clamped, e.g. after a resize
  });

  it("pageLiveWindow moves a page at a time and lands on the tail at the end", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `l${i}`);
    const top = liveWindow(lines, 11, 0);
    expect(pageLiveWindow(top, "next")).toBe(10);
    expect(pageLiveWindow(liveWindow(lines, 11, 10), "next")).toBeNull(); // 20 ≥ last start 15 → tail
    expect(pageLiveWindow(liveWindow(lines, 11, null), "previous")).toBe(5);
    expect(pageLiveWindow(liveWindow(lines, 11, 5), "previous")).toBe(0);
    expect(pageLiveWindow(liveWindow(["a"], 11, 0), "next")).toBeNull();
  });

  it("paging keys: PgDn/PgUp always, space only on an empty prompt with more below", () => {
    const can = { composerEmpty: true, canPageNext: true, canPagePrevious: true };
    expect(livePageKey("", key({ pageDown: true }), { ...can, composerEmpty: false })).toBe("next");
    expect(livePageKey("", key({ pageUp: true }), can)).toBe("previous");
    expect(livePageKey(" ", key(), can)).toBe("next");
    expect(livePageKey(" ", key(), { ...can, composerEmpty: false })).toBeNull(); // space types
    expect(livePageKey(" ", key(), { ...can, canPageNext: false })).toBeNull();
    expect(livePageKey("", key({ pageDown: true }), { ...can, canPageNext: false })).toBeNull();
    // `m` and every letter keep typing in the composer; paging never approves anything.
    for (const letter of ["m", "y", "n", "j", "k"]) {
      expect(livePageKey(letter, key(), can)).toBeNull();
    }
    expect(livePageKey("", key({ return: true }), can)).toBeNull();
  });

  it("the hint says what is hidden and how to reach it", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `l${i}`);
    expect(livePageHint(liveWindow(lines, 11, 0))).toMatch(/15 more lines/);
    expect(livePageHint(liveWindow(lines, 11, null))).toMatch(/15 lines above/);
    expect(livePageHint(liveWindow(lines, 60, 0))).toBeNull();
  });

  it("the hint offers space only while space pages (a card or picker keeps space)", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `l${i}`);
    expect(livePageHint(liveWindow(lines, 11, 0))).toMatch(/space or PgDn$/);
    expect(livePageHint(liveWindow(lines, 11, 0), { spacePages: true })).toMatch(/space or PgDn$/);
    const cardOpen = livePageHint(liveWindow(lines, 11, 0), { spacePages: false });
    expect(cardOpen).toMatch(/15 more lines · PgDn$/);
    expect(cardOpen).not.toContain("space");
  });
});

describe("the session wires the live cap (CI-run)", () => {
  const sessionSource = readFileSync(fileURLToPath(new URL("./interactive-session.tsx", import.meta.url)), "utf8");

  it("the live hint drops space while a card or picker owns it", () => {
    // Mirrors the key handler's `composerEmpty` gate (confirmActionActive /
    // selectionActive / pendingConfirmation) at the render site.
    expect(sessionSource).toContain(
      "livePageSpace={pendingConfirmActions.length === 0 && !pendingSelection && !pendingOperatorLine}"
    );
  });

  it("a 200-line turn in a 24-row session renders one capped page, the composer and a hint", () => {
    const text = Array.from({ length: 200 }, (_, i) => `gamma line ${i}`).join("\n");
    const rendered = stripAnsi(renderInkInteractiveSessionToString({
      columns: 80,
      rows: 24,
      initialMessages: [{ role: "assistant", text }],
      async onSubmitLine() {
        return { messages: [] };
      },
      title: "Infinite TUI"
    })).split("\n");
    // The live frame fits under the cap (rows - (composer 3 + key bar 1 + 2)),
    // plus the hint row, plus the composer below it.
    expect(rendered.length).toBeLessThanOrEqual(24 - (3 + 1 + 2) - 1 + 3);
    expect(rendered.some((line) => /more lines|lines above/.test(line))).toBe(true);
    // A turn the session starts with follows its tail, so its first lines are paged away.
    expect(rendered.some((line) => /gamma line 199(?!\d)/.test(line))).toBe(true);
    expect(rendered.some((line) => /gamma line 0(?!\d)/.test(line))).toBe(false);
  });

  it("space pages only from the composer; a card or picker keeps the key", () => {
    const call = sessionSource.slice(sessionSource.indexOf("livePageKey(input, key, {"));
    expect(call.slice(0, call.indexOf("});"))).toMatch(
      /composerEmpty: value\.length === 0 && !confirmActionActive && !cardFieldActive && !selectionActive && !pendingConfirmation/
    );
  });

  it("every exit path commits the live turn before Ink unmounts", () => {
    // /exit, /quit, a result's `exit` and idle Ctrl-C all go through requestExit.
    const direct = sessionSource.match(/app\.exit\(\)/g) ?? [];
    expect(direct).toHaveLength(1);
    expect(sessionSource).toMatch(/if \(exitRequested\) \{\s*app\.exit\(\);/);
    expect(sessionSource).toMatch(/commitLatestTurn\("\/exit"\);\s*setExitRequested\(true\)/);
  });
});

describe("scrollback in a running session (fake TTY; skipped on CI like the other PTY tests)", () => {
  it.skipIf(process.env.CI === "true")("200-line answers stay whole in scrollback and never trip a fullscreen redraw", { timeout: 30_000 }, async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const errorOutput = ttyOutput();
    const answer = (name: string) => Array.from({ length: 200 }, (_, i) => `${name} line ${i}`).join("\n");

    const session = runInkInteractiveSession({
      errorOutput,
      input,
      async onSubmitLine(line) {
        if (line === "first") {
          return { messages: [{ role: "assistant", text: answer("alpha") }] };
        }
        if (line === "second") {
          return { messages: [{ role: "assistant", text: answer("beta") }] };
        }
        return { exit: true, messages: [] };
      },
      output,
      title: "Infinite TUI"
    });

    await waitFor(() => output.text().includes("ready"), 4_000, output.text);
    await sendKeys(input, "first\r");
    // A finished tall answer opens at its top, with a hint, inside the cap.
    await waitFor(() => output.text().includes("alpha line 0") && output.text().includes("more lines"), 4_000, output.text);
    expect(output.text()).not.toContain("alpha line 100");

    // space on an empty prompt pages the live answer.
    await sendKeys(input, " ");
    await waitFor(() => output.text().includes("alpha line 20"), 4_000, output.text);
    expect(output.text()).not.toContain("alpha line 100");

    // The next line commits the whole first turn to scrollback, every line once.
    await sendKeys(input, "second\r");
    await waitFor(() => output.text().includes("beta line 0"), 4_000, output.text);
    const text = stripAnsi(output.text());
    for (const i of [0, 1, 100, 198, 199]) {
      expect(text).toContain(`alpha line ${i}`);
    }
    expect(text.split("alpha line 100 ").length - 1).toBe(1);
    expect(text).toContain("┊ ❯ first");

    await sendKeys(input, "/exit\r");
    await session;
    // Exiting commits the live answer first, so all of it reaches scrollback, once.
    const final = stripAnsi(output.text());
    for (const i of [100, 150, 199]) {
      expect(countLine(final, `beta line ${i}`)).toBe(1);
    }
    expect(countLine(final, "beta line 0")).toBeGreaterThanOrEqual(1);
    // ink only clears the terminal (and the scrollback with it) after a frame as
    // tall as the window; the cap means that never happens.
    expect(output.text()).not.toContain(`${ESC}[3J`);
    expect(output.text()).not.toContain(`${ESC}[2J`);
  });

  it.skipIf(process.env.CI === "true")("idle Ctrl-C still writes the whole last answer before quitting", { timeout: 30_000 }, async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const session = runInkInteractiveSession({
      errorOutput: ttyOutput(),
      input,
      async onSubmitLine() {
        return { messages: [{ role: "assistant", text: Array.from({ length: 200 }, (_, i) => `alpha line ${i}`).join("\n") }] };
      },
      output,
      title: "Infinite TUI"
    });
    await waitFor(() => output.text().includes("ready"), 4_000, output.text);
    await sendKeys(input, "first\r");
    await waitFor(() => output.text().includes("more lines"), 4_000, output.text);
    expect(output.text()).not.toContain("alpha line 150");
    input.write("\u0003");
    await session;
    const final = stripAnsi(output.text());
    for (const i of [150, 199]) {
      expect(countLine(final, `alpha line ${i}`)).toBe(1);
    }
    expect(output.text()).not.toContain(`${ESC}[2J`);
  });

  it.skipIf(process.env.CI === "true")("space reaches an open card, not the pager; PgDn still pages", { timeout: 30_000 }, async () => {
    const pending: InSessionConfirmationAction = {
      turnId: "t1",
      confirmationHandle: "h1",
      summary: "Publish landing page to production",
      confirmationDetails: [{ label: "domain", value: "acme.example.com" }]
    };
    const input = ttyInput();
    const output = ttyOutput();
    const decisions: string[] = [];
    const session = runInkInteractiveSession({
      errorOutput: ttyOutput(),
      input,
      onConfirmAction: async (_action, decision) => {
        decisions.push(decision);
        return { ok: true };
      },
      async onSubmitLine(): Promise<InkInteractiveLineResult> {
        return {
          messages: [{ role: "assistant", text: Array.from({ length: 200 }, (_, i) => `alpha line ${i}`).join("\n") }],
          pendingConfirmations: [pending]
        };
      },
      output,
      title: "Infinite TUI"
    });
    await waitFor(() => output.text().includes("ready"), 4_000, output.text);
    await sendKeys(input, "publish it\r");
    await waitFor(() => output.text().includes("Approve this write?") && output.text().includes("more lines"), 4_000, output.text);
    const before = maxLine(output.text(), "alpha");
    await sendKeys(input, " ");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(maxLine(output.text(), "alpha")).toBe(before);
    expect(decisions).toEqual([]);
    input.write(`${ESC}[6~`);
    await waitFor(() => maxLine(output.text(), "alpha") > before, 4_000, output.text);
    expect(decisions).toEqual([]);
    // `n` is the card's real "no" (T6): it reaches the app as a decline.
    await sendKeys(input, "n");
    // Wait for the decline to land and the card to leave before typing: the card
    // swallows "/", so "/exit" typed while it is still drawn would run "exit".
    await waitFor(() => decisions.length === 1 && stripAnsi(output.text()).includes("Dismissed"), 4_000, output.text);
    const afterDecline = output.text().length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(output.text().slice(afterDecline)).not.toContain("Approve this write?");
    await sendKeys(input, "/exit\r");
    await session;
    expect(decisions).toEqual(["decline"]);
  });
});

function countLine(text: string, line: string) {
  return text.match(new RegExp(`${line}(?!\\d)`, "g"))?.length ?? 0;
}

function maxLine(text: string, name: string) {
  return Math.max(-1, ...[...stripAnsi(text).matchAll(new RegExp(`${name} line (\\d+)`, "g"))].map((m) => Number(m[1])));
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

function ttyOutput() {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & NodeJS.WriteStream & {
    columns: number;
    isTTY: boolean;
    rows: number;
    text: () => string;
  };
  stream.columns = 80;
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

async function sendKeys(input: NodeJS.WritableStream, keys: string) {
  for (const k of keys) {
    input.write(k);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
