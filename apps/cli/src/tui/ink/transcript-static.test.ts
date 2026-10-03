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
  CLEAR_SCREEN_AND_SCROLLBACK,
  commitLatest,
  commitOnSubmit,
  DEFAULT_COMPOSER_ROWS,
  liveRegionCap,
  livePageHint,
  livePageKey,
  liveWindow,
  pageLiveWindow,
  redrawCommitted,
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
      // Ink prints <Static> output first, a thin rule under each turn (D1, no
      // top bar per turn, and the live top bar never sits flush on the last
      // answer); everything after it is the live region.
      expect(rendered.slice(0, 4)).toEqual(["committed one", "─".repeat(80), "committed two", "─".repeat(80)]);
      expect(rendered.length - 4).toBe(inkTranscriptRowCount(props));
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
      // The session reserves the rule over the composer with the composer (r4).
      const rowsAboveComposer = inkTranscriptRowCount({
        busy, transcript: { state: emptyState }, columns: 80, rows, latest: tall, showComposer: false,
        composerRows: DEFAULT_COMPOSER_ROWS + 1
      });
      // + the rule over a composer that may wrap to 3 rows, and the key bar under it (the last row).
      expect(wouldTriggerInkFullscreen({
        rowsAboveComposer: rowsAboveComposer + 1, composerRows: 3, rowsBelowComposer: 1, terminalRows: rows
      })).toBe(false);
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
    // A finished turn too tall for the live region commits with no line at all.
    const tall = commitLatest({ committed, latest: { id: "t2", lines: ["a"] } });
    expect(tall.committed.map((e) => e.id)).toEqual(["home", "t2"]);
    expect(tall.latest).toBeNull();
    expect(commitLatest(none)).toBe(none);
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

  it("a finished 200-line turn in a 24-row session is whole above the frame: no page of it, no hint", () => {
    const text = Array.from({ length: 200 }, (_, i) => `gamma line ${i}`).join("\n");
    const rendered = stripAnsi(renderInkInteractiveSessionToString({
      columns: 80,
      rows: 24,
      initialMessages: [{ role: "user", text: "how did it go?" }, { role: "assistant", text }],
      async onSubmitLine() {
        return { messages: [] };
      },
      title: "Infinite TUI"
    })).split("\n");
    // Every line of the turn is printed, once, in order, above the live frame.
    const joined = rendered.join("\n");
    for (const i of [0, 1, 99, 100, 198, 199]) {
      expect(countLine(joined, `gamma line ${i}`), `gamma line ${i}`).toBe(1);
    }
    expect(rendered[0]).toBe("❯ how did it go?");
    expect(rendered.some((line) => /more lines|lines above/.test(line))).toBe(false);
    // Under the turn's one rule only the frame stays live: top bar, rule, composer, key bar.
    const last = rendered.findIndex((line) => /gamma line 199(?!\d)/.test(line));
    const frame = rendered.slice(last + 1);
    expect(frame).toHaveLength(5);
    expect(frame[0]).toBe("─".repeat(80));
    expect(frame[1]).toContain("∞ Infinite");
    expect(frame[2]).toBe("─".repeat(80));
    expect(frame[3]).toContain("❯ Ask Infinite…");
    expect(frame[4]).toContain("/  commands");
  });

  it("a finished turn that fits a 24-row session stays live, under the top bar, with nothing printed above", () => {
    const rendered = stripAnsi(renderInkInteractiveSessionToString({
      columns: 80,
      rows: 24,
      initialMessages: [{ role: "user", text: "how did it go?" }, { role: "assistant", text: "gamma line 0\n\ngamma line 1" }],
      async onSubmitLine() {
        return { messages: [] };
      },
      title: "Infinite TUI"
    })).split("\n");
    expect(rendered[0]).toContain("∞ Infinite");
    expect(rendered[2]).toBe("❯ how did it go?");
    expect(rendered.some((line) => /more lines|lines above/.test(line))).toBe(false);
  });

  it("the overflow commit runs only for a finished turn, keeps a waiting card, and never draws the paged turn", () => {
    const rule = sessionSource.slice(sessionSource.indexOf("const finished ="), sessionSource.indexOf("// With nothing live after the first turn"));
    expect(rule).toMatch(/const finished = !transcriptBusy && !exitRequested/u);
    expect(rule).toContain("let finishedOverflow = finished && turnLayout.window.paged;");
    // Decided against the resting frame, so a draft or a menu never sends a turn up.
    expect(rule).toContain("if (finishedOverflow && reservedRows !== restingReservedRows) {");
    expect(rule).toContain("finishedOverflow = pagedAtRest(compactTurn);");
    // A finished turn that misses by its blank rows is drawn without them before it is given up.
    expect(rule).toContain("const compactTurn = finished && renderTurnAt !== null && pagedAtRest(false) && wholeCompactAtRest();");
    expect(rule).toContain("drawTurnWith(restingReservedRows, compact)");
    expect(rule).toContain('commitLiveTurn("overflow", pendingConfirmActions.length > 0)');
    expect(rule).toContain("const liveLatestShown = finishedOverflow ? null : liveLatest;");
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
  it.skipIf(process.env.CI === "true")("a 200-line finished answer is whole in scrollback at once: no pager hint, no fullscreen redraw", { timeout: 30_000 }, async () => {
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

    await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
    await sendKeys(input, "first\r");
    // The finished answer does not fit 24 rows: all of it is printed, once, the
    // moment it finishes, with no key pressed and no next question.
    await waitFor(() => output.text().includes("alpha line 199"), 4_000, output.text);
    const first = stripAnsi(output.text());
    for (const i of [0, 1, 20, 100, 198, 199]) {
      expect(countLine(first, `alpha line ${i}`), `alpha line ${i}`).toBe(1);
    }
    expect(first).toContain("❯ first");
    expect(first).not.toMatch(/more lines|lines above/u);
    // What scrollback holds: the question, then the answer in order, nothing cut.
    const rows = scrollbackRows(output.text());
    const at = rows.findIndex((row) => row.startsWith("❯ first"));
    expect(at, rows.join("\n")).toBeGreaterThanOrEqual(0);
    expect(rows.slice(at + 2, at + 202).map((row) => row.trim().replace(/^∞ /u, ""))).toEqual(
      Array.from({ length: 200 }, (_, i) => `alpha line ${i}`)
    );
    // Only the frame stays live under it: the turn's rule, the top bar, one rule, the composer, the key bar.
    expect(rows.slice(at + 202).map((row) => row.trimEnd()).filter(Boolean)).toEqual([
      "─".repeat(80), " ∞ Infinite", "─".repeat(80), "❯ Ask Infinite…", " /  commands"
    ]);

    // The composer still takes the next question; its answer lands the same way.
    await sendKeys(input, "second\r");
    await waitFor(() => output.text().includes("beta line 199"), 4_000, output.text);
    await sendKeys(input, "/exit\r");
    await session;
    const final = stripAnsi(output.text());
    for (const i of [0, 100, 150, 199]) {
      expect(countLine(final, `alpha line ${i}`), `alpha line ${i}`).toBe(1);
      expect(countLine(final, `beta line ${i}`), `beta line ${i}`).toBe(1);
    }
    expect(final).not.toMatch(/more lines|lines above/u);
    expect(final).not.toContain("┊");
    // ink only clears the terminal (and the scrollback with it) after a frame as
    // tall as the window; the live region never grows that tall.
    expect(output.text()).not.toContain(`${ESC}[3J`);
    expect(output.text()).not.toContain(`${ESC}[2J`);
  });

  it.skipIf(process.env.CI === "true")("a streaming answer shows its tail; once finished it is whole in scrollback, each line once", { timeout: 30_000 }, async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const text = Array.from({ length: 120 }, (_, i) => `alpha line ${i}`).join("\n");
    let finish: () => void = () => {};
    const session = runInkInteractiveSession({
      errorOutput: ttyOutput(),
      input,
      async onSubmitLine(line, onProgress) {
        if (line === "/exit") return { exit: true, messages: [] };
        onProgress?.({ type: "message.start", stage: "message", message: "" });
        onProgress?.({ type: "message.delta", stage: "message", message: "", text });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { messages: [{ role: "assistant", text }] };
      },
      output,
      title: "Infinite TUI"
    });
    await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
    await sendKeys(input, "first\r");
    // While it streams the live region follows the tail, with the hint for what is above.
    await waitFor(() => output.text().includes("alpha line 119") && output.text().includes("lines above"), 4_000, output.text);
    expect(stripAnsi(output.text())).not.toContain("alpha line 50");
    finish();
    await waitFor(() => output.text().includes("alpha line 50"), 4_000, output.text);
    await sendKeys(input, "/exit\r");
    await session;
    // Finished: the tail's rows were erased and the whole turn printed once, in order, with no hint left.
    const rows = scrollbackRows(output.text());
    const answer = rows.map((row) => row.trim().replace(/^∞ /u, "")).filter((row) => /^alpha line \d+$/u.test(row));
    expect(answer).toEqual(Array.from({ length: 120 }, (_, i) => `alpha line ${i}`));
    expect(rows.some((row) => /more lines|lines above/u.test(row))).toBe(false);
    expect(stripAnsi(output.text())).not.toContain("more lines");
    expect(output.text()).not.toContain(`${ESC}[2J`);
    expect(output.text()).not.toContain(`${ESC}[3J`);
  });

  it.skipIf(process.env.CI === "true")("scrollback separates finished turns with exactly one thin rule (D1)", { timeout: 30_000 }, async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const errorOutput = ttyOutput();
    const session = runInkInteractiveSession({
      errorOutput,
      input,
      async onSubmitLine(line) {
        if (line === "/exit") return { exit: true, messages: [] };
        return { messages: [{ role: "assistant", text: `answer-${line}` }] };
      },
      output
    });

    await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
    for (const line of ["one", "two", "three"]) {
      await sendKeys(input, `${line}\r`);
      await waitFor(() => output.text().includes(`answer-${line}`), 4_000, output.text);
    }
    await sendKeys(input, "/exit\r");
    await session;
    // Exiting commits the last turn, so all three are in scrollback: each pair
    // is separated by ONE rule row, never two stacked rules.
    const rows = scrollbackRows(output.text());
    const rule = "─".repeat(80);
    for (const [answer, nextQuestion] of [["answer-one", "two"], ["answer-two", "three"]] as const) {
      const from = rows.findIndex((row) => row.includes(answer));
      const to = rows.findIndex((row, index) => index > from && row.includes(`❯ ${nextQuestion}`));
      expect(from, rows.join("\n")).toBeGreaterThanOrEqual(0);
      expect(to, rows.join("\n")).toBeGreaterThan(from);
      const rules = rows.slice(from + 1, to).filter((row) => /^─+$/u.test(row.trim()));
      expect(rules, rows.join("\n")).toEqual([rule]);
    }
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
    await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
    await sendKeys(input, "first\r");
    // The finished answer is already whole in scrollback; quitting prints nothing twice.
    await waitFor(() => output.text().includes("alpha line 199"), 4_000, output.text);
    input.write("\u0003");
    await session;
    const final = stripAnsi(output.text());
    for (const i of [0, 150, 199]) {
      expect(countLine(final, `alpha line ${i}`)).toBe(1);
    }
    expect(final).not.toContain("more lines");
    expect(output.text()).not.toContain(`${ESC}[2J`);
  });

  it.skipIf(process.env.CI === "true")("a pending card stays live: the long answer goes whole into scrollback, the card keeps its keys", { timeout: 30_000 }, async () => {
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
    await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
    await sendKeys(input, "publish it\r");
    // The answer is printed whole above; the card (its summary in its border) is what stays live, with its keys.
    await waitFor(() => output.text().includes("alpha line 199") && stripAnsi(output.text()).includes("n  dismiss"), 4_000, output.text);
    const shown = stripAnsi(output.text());
    for (const i of [0, 100, 199]) {
      expect(countLine(shown, `alpha line ${i}`), `alpha line ${i}`).toBe(1);
    }
    expect(shown).not.toMatch(/more lines|lines above/u);
    const rows = scrollbackRows(output.text());
    const answerEnd = rows.findIndex((row) => /alpha line 199$/u.test(row.trimEnd()));
    const card = rows.findIndex((row) => row.includes("Publish landing page to production"));
    expect(card, rows.join("\n")).toBeGreaterThan(answerEnd);
    // The live frame under the answer: the turn's rule, the top bar and its rule, then the card.
    expect(rows.slice(answerEnd + 1, answerEnd + 4).map((row) => row.trimEnd())).toEqual(["─".repeat(80), " ∞ Infinite", "─".repeat(80)]);
    // Space, Enter and PgDn decide nothing and move nothing.
    const before = output.text().length;
    await sendKeys(input, " \r");
    input.write(`${ESC}[6~`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(decisions).toEqual([]);
    expect(stripAnsi(output.text().slice(before))).not.toContain("alpha line");
    // `n` is the card's real "no" (T6): it reaches the app as a decline.
    await sendKeys(input, "n");
    // Wait for the decline to land and the card to leave before typing: the card
    // swallows "/", so "/exit" typed while it is still drawn would run "exit".
    await waitFor(() => decisions.length === 1 && stripAnsi(output.text()).includes("Dismissed"), 4_000, output.text);
    const afterDecline = output.text().length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(output.text().slice(afterDecline)).not.toContain("Publish landing page to production");
    await sendKeys(input, "/exit\r");
    await session;
    expect(decisions).toEqual(["decline"]);
    expect(countLine(stripAnsi(output.text()), "alpha line 100")).toBe(1);
  });
});

// A call that did not end clean stays readable once its turn is in scrollback
// (round 4, scenario S11): the Steps strip belongs to the live turn (D1), but
// the failed call's row is printed under the answer. Synthetic names only.
describe("a failed step survives the commit to scrollback (fake TTY; skipped on CI like the other PTY tests)", () => {
  const RAW = "mcp__sample_app__get_sample_rows";
  const FAILED_ROW = "  reading today ✗ not synced yet";
  const text = Array.from({ length: 200 }, (_, i) => `alpha line ${i}`).join("\n");
  /** Two calls of one tool, in the app's words: the first ends clean, the second fails. */
  const twoCalls = (onProgress: ((frame: never) => void) | undefined) => {
    const frame = (type: string, toolId: string, rest: Record<string, unknown>) =>
      onProgress?.({ type, stage: "tool", message: RAW, toolId, name: RAW, ...rest } as never);
    frame("tool.start", "call-1", { context: "{}", words: { label: "reading the last 200 days" } });
    frame("tool.complete", "call-1", { status: "ok", words: { label: "reading the last 200 days", result: "200 days" } });
    frame("tool.start", "call-2", { context: "{}", words: { label: "reading today" } });
    frame("tool.complete", "call-2", { status: "error", words: { label: "reading today", result: "not synced yet" } });
  };

  it.skipIf(process.env.CI === "true")("two calls, the second fails, then a 200-line answer: the failed row is under the answer in scrollback, the clean one is not", { timeout: 30_000 }, async () => {
    resetTurnState();
    const input = ttyInput();
    const output = ttyOutput();
    let finish: () => void = () => {};
    const session = runInkInteractiveSession({
      errorOutput: ttyOutput(),
      input,
      async onSubmitLine(line, onProgress) {
        if (line === "/exit") return { exit: true, messages: [] };
        twoCalls(onProgress as never);
        onProgress?.({ type: "message.start", stage: "message", message: "" });
        onProgress?.({ type: "message.delta", stage: "message", message: "", text });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { messages: [{ role: "assistant", text }] };
      },
      output,
      title: "Infinite TUI"
    });
    await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
    await sendKeys(input, "first\r");
    // While it streams, the Steps strip shows both calls, the failed one with its reason.
    await waitFor(() => /reading today\s+━+\s+✗ not synced yet/u.test(stripAnsi(output.text())), 4_000, output.text);
    finish();
    await waitFor(() => output.text().includes("alpha line 50"), 4_000, output.text);
    await waitFor(() => scrollbackRows(output.text()).some((row) => row.trimEnd() === FAILED_ROW), 4_000, output.text);
    const rows = scrollbackRows(output.text()).map((row) => row.trimEnd());
    const last = rows.findIndex((row) => /alpha line 199$/u.test(row));
    // Under the answer: a blank row, the failed call with its reason, then the turn's rule and the frame.
    expect(rows.slice(last + 1).filter(Boolean)).toEqual([
      FAILED_ROW, "─".repeat(80), " ∞ Infinite", "─".repeat(80), "❯ Ask Infinite…", " /  commands"
    ]);
    expect(rows[last + 1]).toBe("");
    // The clean call and the strip itself are gone with the live turn.
    expect(rows.some((row) => row.includes("reading the last 200 days"))).toBe(false);
    expect(rows.some((row) => row.includes("─ Steps"))).toBe(false);
    expect(rows.some((row) => /more lines|lines above/u.test(row))).toBe(false);
    await sendKeys(input, "/exit\r");
    await session;
    expect(scrollbackRows(output.text()).filter((row) => row.trimEnd() === FAILED_ROW)).toHaveLength(1);
  });

  it.skipIf(process.env.CI === "true")("a turn that fits keeps its Steps live; the next line commits it with the failed row only", { timeout: 30_000 }, async () => {
    resetTurnState();
    const input = ttyInput();
    const output = ttyOutput();
    const session = runInkInteractiveSession({
      errorOutput: ttyOutput(),
      input,
      async onSubmitLine(line, onProgress) {
        if (line === "/exit") return { exit: true, messages: [] };
        if (line === "second") return { messages: [{ role: "assistant", text: "answer-second" }] };
        twoCalls(onProgress as never);
        return { messages: [{ role: "assistant", text: "Up 12% on the week." }] };
      },
      output,
      title: "Infinite TUI"
    });
    await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
    await sendKeys(input, "first\r");
    await waitFor(() => stripAnsi(output.text()).includes("∞ Up 12% on the week."), 4_000, output.text);
    // Live: the whole strip, bars and all.
    const live = scrollbackRows(output.text()).map((row) => row.trimEnd());
    expect(live.some((row) => /reading the last.*━+\s+✓ 200 days/u.test(row))).toBe(true);
    expect(live.some((row) => /reading today\s+━+\s+✗ not synced yet/u.test(row))).toBe(true);
    expect(live).not.toContain(FAILED_ROW);
    await sendKeys(input, "second\r");
    await waitFor(() => stripAnsi(output.text()).includes("answer-second"), 4_000, output.text);
    await sendKeys(input, "/exit\r");
    await session;
    const rows = scrollbackRows(output.text()).map((row) => row.trimEnd());
    const answer = rows.findIndex((row) => row.includes("∞ Up 12% on the week."));
    expect(rows.slice(answer + 1, answer + 4)).toEqual(["", FAILED_ROW, "─".repeat(80)]);
    expect(rows.filter((row) => row === FAILED_ROW)).toHaveLength(1);
    expect(rows.some((row) => row.includes("reading the last 200 days"))).toBe(false);
  });

  it.skipIf(process.env.CI === "true")("with a card still waiting the calls stay live under it; the failed row is printed once, when the card's turn is committed", { timeout: 30_000 }, async () => {
    resetTurnState();
    const pending: InSessionConfirmationAction = {
      turnId: "t1",
      confirmationHandle: "h1",
      summary: "Publish landing page to production",
      confirmationDetails: [{ label: "domain", value: "acme.example.com" }]
    };
    const input = ttyInput();
    const output = ttyOutput();
    const session = runInkInteractiveSession({
      errorOutput: ttyOutput(),
      input,
      onConfirmAction: async () => ({ ok: true }),
      async onSubmitLine(line, onProgress): Promise<InkInteractiveLineResult> {
        if (line === "/exit") return { exit: true, messages: [] };
        twoCalls(onProgress as never);
        return { messages: [{ role: "assistant", text }], pendingConfirmations: [pending] };
      },
      output,
      title: "Infinite TUI"
    });
    await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
    await sendKeys(input, "publish it\r");
    await waitFor(() => output.text().includes("alpha line 199") && stripAnsi(output.text()).includes("n  dismiss"), 4_000, output.text);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const waiting = scrollbackRows(output.text()).map((row) => row.trimEnd());
    const answerEnd = waiting.findIndex((row) => /alpha line 199$/u.test(row));
    // The answer went up alone: right under it the turn's rule, then the frame with the card and its Steps.
    expect(waiting.slice(answerEnd + 1, answerEnd + 4)).toEqual(["─".repeat(80), " ∞ Infinite", "─".repeat(80)]);
    expect(waiting).not.toContain(FAILED_ROW);
    expect(waiting.slice(answerEnd).some((row) => /reading today\s+━+\s+✗ not synced yet/u.test(row))).toBe(true);
    // The card is answered, the session ends: what was live is committed, the failed call with it, once.
    await sendKeys(input, "n");
    await waitFor(() => stripAnsi(output.text()).includes("Dismissed"), 4_000, output.text);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sendKeys(input, "/exit\r");
    await session;
    const rows = scrollbackRows(output.text()).map((row) => row.trimEnd());
    expect(rows.filter((row) => row === FAILED_ROW)).toHaveLength(1);
    expect(rows.findIndex((row) => row === FAILED_ROW)).toBeGreaterThan(rows.findIndex((row) => /alpha line 199$/u.test(row)));
    expect(countLine(stripAnsi(output.text()), "alpha line 100")).toBe(1);
  });
});

// What scrollback keeps: Ink writes each <Static> chunk once, ahead of the live
// frame it then redraws (erasing the previous frame with cursor moves + erase).
// Replaying the stream on a tiny screen model (rows, a cursor, erase) keeps the
// static rows and drops the erased live frames.
function scrollbackRows(raw: string): string[] {
  const rows: string[][] = [[]];
  let row = 0;
  let col = 0;
  const at = (r: number) => (rows[r] ??= []);
  for (const token of raw.split(new RegExp(`(${ESC}\\[[0-9;?]*[A-Za-z]|\\n|\\r)`, "g"))) {
    if (!token) continue;
    if (token === "\n") {
      row += 1;
      col = 0;
      at(row);
    } else if (token === "\r") {
      col = 0;
    } else if (token.startsWith(ESC)) {
      const match = /^\x1b\[(\d*)(?:;(\d*))?([A-Za-z])$/u.exec(token);
      if (!match) continue;
      const n = Number(match[1] || 1);
      switch (match[3]) {
        case "A": row = Math.max(0, row - n); break;
        case "B": row += n; at(row); break;
        case "C": col += n; break;
        case "D": col = Math.max(0, col - n); break;
        case "G": col = n - 1; break;
        case "K": at(row).length = match[1] === "2" ? 0 : Math.min(at(row).length, col); break;
        case "J": rows.length = row + 1; at(row).length = Math.min(at(row).length, col); break;
        default: break;
      }
    } else {
      for (const char of token) {
        at(row)[col] = char;
        col += 1;
      }
    }
  }
  return rows.map((cells) => Array.from(cells, (cell) => cell ?? " ").join(""));
}

function countLine(text: string, line: string) {
  return text.match(new RegExp(`${line}(?!\\d)`, "g"))?.length ?? 0;
}

function minLine(text: string, name: string) {
  return Math.min(Number.POSITIVE_INFINITY, ...[...stripAnsi(text).matchAll(new RegExp(`${name} line (\\d+)`, "g"))].map((m) => Number(m[1])));
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

describe("a width change reprints scrollback (run-r2 MUST 4)", () => {
  it("redrawCommitted draws each entry that can be drawn again at the new width, in order, and keeps the rest", () => {
    const at = (width: number) => [`turn at ${width}`];
    const entries: CommittedEntry[] = [
      { id: "turn:1", lines: at(160), redraw: (width) => ({ lines: at(width) }) },
      { id: "note", lines: ["kept as printed"] },
      { id: "turn:2", lines: at(160), redraw: (width) => ({ lines: at(width) }) }
    ];
    const redrawn = redrawCommitted(entries, 60);
    expect(redrawn.map((entry) => [entry.id, ...entry.lines])).toEqual([["turn:1", "turn at 60"], ["note", "kept as printed"], ["turn:2", "turn at 60"]]);
    expect(entries[0]!.lines).toEqual(["turn at 160"]);
  });

  it("the clear erases the screen, then the scrollback, then homes the cursor", () => {
    expect(CLEAR_SCREEN_AND_SCROLLBACK).toBe(`${ESC}[2J${ESC}[3J${ESC}[H`);
  });

  it("the session reprints on a settled width change, through Ink, only on a terminal with the stock renderer", () => {
    const source = readFileSync(fileURLToPath(new URL("./interactive-session.tsx", import.meta.url)), "utf8");
    const effect = source.slice(source.indexOf("const printedColumns = useRef(columns);"), source.indexOf("// Every way out of the session"));
    expect(effect).toContain("writeAboveFrame(CLEAR_SCREEN_AND_SCROLLBACK)");
    expect(effect).toContain("redrawCommitted(current, width)");
    expect(effect).toContain("setStaticEpoch(");
    expect(effect).toMatch(/sessionStdout\?\.isTTY/u);
    expect(effect).toContain('activeInkRenderer !== "stock"');
    expect(effect).toContain("RESIZE_REPRINT_MS");
  });
});

