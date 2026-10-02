import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ToolViewFrameV1 } from "@infinite-os/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { getTurnState, patchTurnState, recordStepEnd, recordTurnView, resetTurnState } from "../app/turn-store.js";
import { displayWidth } from "../lib/display-width.js";
import { renderInkInteractiveSessionToString, runInkInteractiveSession } from "./interactive-session.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (value: string) => value.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");
const sessionSource = readFileSync(fileURLToPath(new URL("./interactive-session.tsx", import.meta.url)), "utf8");
const indexSource = readFileSync(fileURLToPath(new URL("../../index.ts", import.meta.url)), "utf8");

function listFrame(viewId = "v1", fixture = "list-rows"): ToolViewFrameV1 {
  const raw = readFileSync(fileURLToPath(new URL(`../views/__fixtures__/${fixture}.json`, import.meta.url)), "utf8");
  const view = decodeAnswerView(JSON.parse(raw));
  if (!view) throw new Error(`${fixture} fixture does not decode`);
  return { type: "tool.view", stage: "tool", message: view.title, viewId, name: view.tool, view };
}

afterEach(() => {
  resetTurnState();
  vi.unstubAllEnvs();
});

describe("the session draws the latest turn's answer views (CI-runnable)", () => {
  it("a finished turn with views shows the answer left and the view right from 120 columns", () => {
    resetTurnState();
    recordTurnView(listFrame());
    const out = stripAnsi(renderInkInteractiveSessionToString({
      columns: 120,
      initialMessages: [{ role: "user", text: "which ads are on?" }, { role: "assistant", text: "Two are on." }],
      onSubmitLine: async () => ({ messages: [] })
    }));
    expect(out).toContain("❯ which ads are on?");
    expect(out).toContain("∞ Two are on.");
    expect(out).toMatch(/│ {2}Ads running {2}✓ Ready/u);
    expect(out.split("\n").every((line) => displayWidth(line) <= 120)).toBe(true);
  });

  it.each([120, 140, 159])("at %i a turn whose answer has a table is one column: the table bordered and whole, the view under it", (columns) => {
    resetTurnState();
    recordTurnView(listFrame());
    const table = [
      "| Ad | Spend | Purchases | ROAS | CPA | Note |",
      "| --- | ---: | ---: | ---: | ---: | --- |",
      "| Spring demo, hook 3 | $1,284.50 | 42 | 3.41 | $30.58 | Strongest hook; watch for fatigue next week |",
      "| Founder story, 30s | $612.00 | 1 | 0.29 | $612.00 | One purchase so far: the pause candidate |"
    ].join("\n");
    const rows = stripAnsi(renderInkInteractiveSessionToString({
      columns,
      initialMessages: [{ role: "user", text: "which ads are on?" }, { role: "assistant", text: `Two are on.\n\n${table}` }],
      onSubmitLine: async () => ({ messages: [] })
    })).split("\n");
    expect(rows.some((row) => /│ Ad\s+│\s+Spend │\s+Purchases │\s+ROAS │\s+CPA │ Note\s+│/u.test(row))).toBe(true);
    expect(rows.some((row) => /^\s*(Ad|Spend|Purchases|ROAS|CPA|Note): /u.test(row))).toBe(false);
    // The view sits under the answer and a rule, never beside it.
    const view = rows.findIndex((row) => / Ads running {2}✓ Ready/u.test(row));
    expect(view).toBeGreaterThan(rows.findIndex((row) => row.includes("Founder story, 30s")));
    expect(rows[view]!.startsWith(" Ads running")).toBe(true);
    expect(rows[view - 1]).toBe("─".repeat(columns));
    expect(rows.every((row) => displayWidth(row) <= columns)).toBe(true);
  });

  it("a list opens on the row its view names (`body.selected`), with no focus fed from outside (run-r2 MUST 1)", () => {
    resetTurnState();
    const frame = listFrame();
    const view = { ...frame.view, body: { ...(frame.view.body as unknown as Record<string, unknown>), selected: "ad_2" } } as unknown as typeof frame.view;
    recordTurnView({ ...frame, view });
    const out = stripAnsi(renderInkInteractiveSessionToString({
      columns: 100,
      initialMessages: [{ role: "user", text: "which ads are on?" }, { role: "assistant", text: "Two are on." }],
      onSubmitLine: async () => ({ messages: [] })
    }));
    expect(out).toMatch(/^▸ ● on +Hook B/mu);
    expect(out).not.toMatch(/^▸ ● on +Hook A/mu);
  });

  it("the turn's Steps strip is drawn once, from the turn store's calls", () => {
    resetTurnState();
    recordTurnView(listFrame());
    patchTurnState((state) => ({
      ...state,
      steps: [{ id: "c1", name: "list_meta_entities", label: "listing meta entities", status: "ok", startedAt: 0, endedAt: 500, result: "3 ads" }]
    }));
    const out = stripAnsi(renderInkInteractiveSessionToString({
      columns: 120,
      initialMessages: [{ role: "user", text: "which ads are on?" }, { role: "assistant", text: "Two are on." }],
      onSubmitLine: async () => ({ messages: [] })
    }));
    expect(out.split("─ Steps ").length - 1).toBe(1);
    expect(out).toMatch(/^ {2}listing meta entities +━+ ✓ 3 ads$/mu);
  });

  it("under 120 columns the live turn is one column: the view under the answer", () => {
    resetTurnState();
    recordTurnView(listFrame());
    const out = stripAnsi(renderInkInteractiveSessionToString({
      columns: 100,
      initialMessages: [{ role: "user", text: "which ads are on?" }, { role: "assistant", text: "Two are on." }],
      onSubmitLine: async () => ({ messages: [] })
    }));
    expect(out).toContain("∞ Two are on.");
    expect(out).toMatch(/^ {1}Ads running {2}✓ Ready/mu);
    expect(out).not.toContain(" │ ");
  });

  it("stacks the view under the answer below 80 columns", () => {
    resetTurnState();
    recordTurnView(listFrame());
    const out = stripAnsi(renderInkInteractiveSessionToString({
      columns: 60,
      initialMessages: [{ role: "user", text: "which ads are on?" }, { role: "assistant", text: "Two are on." }],
      onSubmitLine: async () => ({ messages: [] })
    }));
    expect(out).toContain("Ads running  ✓ Ready");
    expect(out).not.toContain(" │ ");
    expect(out.split("\n").every((line) => displayWidth(line) <= 60)).toBe(true);
  });

  it("without views the transcript is unchanged (an old desktop sends none)", () => {
    resetTurnState();
    const out = stripAnsi(renderInkInteractiveSessionToString({
      columns: 100,
      initialMessages: [{ role: "user", text: "which ads are on?" }, { role: "assistant", text: "Two are on." }],
      onSubmitLine: async () => ({ messages: [] })
    }));
    expect(out).not.toContain(" │ ");
    expect(out).toContain("Two are on.");
  });

  it("a turn that asked for a source that is not connected leads the top bar with its amber mark, live and once the turn is in scrollback", () => {
    const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../views/__fixtures__/r4/flow-numbers-05-not-connected.json", import.meta.url)), "utf8"));
    const view = decodeAnswerView(fixture.turn.views[0]);
    if (!view) throw new Error("the not-connected fixture does not decode");
    const frame: ToolViewFrameV1 = { type: "tool.view", stage: "tool", message: view.title, viewId: "nc1", name: view.tool, view };
    const topBar = {
      workspace: "Infinite workspace",
      throughApp: true,
      sources: [
        { label: "Shopify", state: "broken" as const }, { label: "GA4", state: "connected" as const },
        { label: "Stripe", state: "connected" as const }, { label: "PostHog", state: "connected" as const },
        { label: "Google Ads", state: "missing" as const }, { label: "Meta", state: "connected" as const }
      ]
    };
    const question = { role: "user" as const, text: "google ads since launch?" };
    const barOf = (rows: string[]) => rows.filter((row) => row.includes("∞ Infinite ")).at(-1)!.trimEnd();

    // Live at 60 columns: r4 leads with the asked source and cuts the dots from the right.
    resetTurnState();
    recordTurnView(frame);
    const live = stripAnsi(renderInkInteractiveSessionToString({
      columns: 60, topBar, initialMessages: [question, { role: "assistant", text: "Google Ads isn't connected for this workspace." }],
      onSubmitLine: async () => ({ messages: [] })
    })).split("\n");
    expect(barOf(live)).toBe(" ∞ Infinite   Infinite workspace   ⊘ Google Ads ⊘ Shopify ●…");

    // An 80x24 window and a turn too tall for it: the turn goes to scrollback, and the bar under it still leads with the mark.
    resetTurnState();
    recordTurnView(frame);
    const tall = Array.from({ length: 30 }, (_, index) => `note ${index}`).join("\n\n");
    const committed = stripAnsi(renderInkInteractiveSessionToString({
      columns: 80, rows: 24, topBar, initialMessages: [question, { role: "assistant", text: tall }],
      onSubmitLine: async () => ({ messages: [] })
    })).split("\n");
    expect(committed.findIndex((row) => row.includes("note 29"))).toBeLessThan(committed.findIndex((row) => row.includes("∞ Infinite ")));
    expect(barOf(committed)).toBe(" ∞ Infinite   Infinite workspace   ⊘ Google Ads ⊘ Shopify ● GA4 ● Stripe ● Post…");

    // A turn that asked for nothing missing: the mark is drawn only when everything else fits (not at 80).
    resetTurnState();
    const plain = stripAnsi(renderInkInteractiveSessionToString({
      columns: 80, topBar, initialMessages: [question, { role: "assistant", text: "Two are on." }],
      onSubmitLine: async () => ({ messages: [] })
    })).split("\n");
    expect(barOf(plain)).toBe(" ∞ Infinite   Infinite workspace   ⊘ Shopify ● GA4 ● Stripe ● PostHog ● Meta");
  });

  it("in an 80x24 window a finished turn that misses by its blank rows stays live, compact; a taller one still goes whole to scrollback", () => {
    const r4 = (screen: string) => {
      const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(`../views/__fixtures__/r4/${screen}.json`, import.meta.url)), "utf8"));
      const view = decodeAnswerView(fixture.turn.views[0]);
      if (!view) throw new Error(`${screen} does not decode`);
      return { fixture, frame: { type: "tool.view", stage: "tool", message: view.title, viewId: "v1", name: view.tool, view } as ToolViewFrameV1 };
    };
    const draw = (screen: string) => {
      const { fixture, frame } = r4(screen);
      resetTurnState();
      recordTurnView(frame);
      recordStepEnd({ id: "c1", name: frame.name, label: fixture.turn.steps[0].label, status: "ok", result: fixture.turn.steps[0].result, endedAt: 2_000, durationMs: 1_000 });
      return stripAnsi(renderInkInteractiveSessionToString({
        columns: 80, rows: 24,
        initialMessages: [{ role: "user", text: fixture.turn.question }, { role: "assistant", text: fixture.turn.answer }],
        onSubmitLine: async () => ({ messages: [] })
      })).replace(/\n+$/u, "").split("\n").map((row) => row.trimEnd());
    };

    // The health view is 19 rows as r4 spaces it, two more than the window gives a turn: compact, it is 16.
    const health = draw("view-10-health");
    expect(health[0]).toContain("∞ Infinite");
    expect(health[2]).toBe("❯ is everything connected?");
    const answer = health.findIndex((row) => row.startsWith("∞ 5 of 6 are fine."));
    expect(health[answer + 1]).toBe("─".repeat(80));
    expect(health[answer + 2]).toMatch(/Connections\s+✓ Ready/u);
    const strip = health.findIndex((row) => row.startsWith("─ Steps"));
    expect(health[strip - 1]).toBe("Fix it: Reconnect Shopify");
    expect(health[strip + 1]).toMatch(/checking connections\s+━+\s+✓ 6 sources/u);
    expect(health.at(-1)).toBe(" tab  switch side    /  commands");
    expect(health.length).toBeLessThanOrEqual(22);
    expect(health.some((row) => /more lines|lines above/u.test(row))).toBe(false);

    // The numbers view does not fit even compact: whole in scrollback, in r4's own spacing, the frame under it.
    const numbers = draw("view-01-numbers");
    expect(numbers[0]).toBe("❯ google ads since launch?");
    const rule = numbers.findIndex((row) => row === "─".repeat(80));
    expect(numbers[rule - 1]).toBe("");
    expect(numbers.slice(-5, -1)).toEqual(["─".repeat(80), " ∞ Infinite", "─".repeat(80), "❯ Ask Infinite…"]);
    expect(numbers.at(-1)).toBe(" /  commands");
    expect(numbers.some((row) => row.startsWith("─ Steps"))).toBe(false);
  });

  it("the desktop entry forwards each tool.view and creative.draft frame to the session", () => {
    expect(indexSource).toMatch(/async onSubmitLine\(line, onProgress, signal, onView, onCreativeDraft\)/u);
    expect(indexSource).toMatch(/runner\.turn\(trimmed, onProgress, linked\.signal, onView, onCreativeDraft\)/u);
  });

  it("a turn records its views in the turn store; the next submit commits and clears them", () => {
    expect(sessionSource).toMatch(/\}, signal, recordTurnView, recordCreativeDraft\);/u);
    const commit = sessionSource.slice(sessionSource.indexOf("const commitLiveTurn"), sessionSource.indexOf("const [exitRequested"));
    expect(commit).toContain("renderCommittedTurn({");
    expect(commit).toContain("steps,");
    expect(commit).toContain("clearTurnViews();");
    expect(commit).toContain("setViewFocus(null);");
  });

  it("c copies through an OSC 52 write to a TTY, and through pbcopy on a local Mac", () => {
    const handler = sessionSource.slice(sessionSource.indexOf("const handleViewKey"), sessionSource.indexOf("return next.handled;"));
    expect(handler).toMatch(/next\.effect\?\.type === "copy"/u);
    expect(handler).toContain("copyTargets(process.env, process.platform)");
    expect(handler).toMatch(/targets\.osc52 && sessionStdout\?\.isTTY/u);
    expect(handler).toContain("sessionStdout.write(clipboardSequence(next.effect.text));");
    expect(handler).toMatch(/targets\.pbcopy/u);
    expect(handler).toContain("copyThroughPbcopy(next.effect.text)");
  });

  it("the live turn is drawn to the rows the live region gives it, and commits whole (every page, one column)", () => {
    const sizing = sessionSource.slice(sessionSource.indexOf("const drawTurnWith"), sessionSource.indexOf("const turnLayout = layoutOf("));
    expect(sizing).toContain("inkLatestTurnRows({");
    expect(sizing).toContain("keyBarRowCount(keyHintsFor(");
    const commit = sessionSource.slice(sessionSource.indexOf("const commitLiveTurn"), sessionSource.indexOf("const [exitRequested"));
    expect(commit).not.toContain("rows:");
  });

  it("a long document's page fits the window: the top of the page is on screen", () => {
    resetTurnState();
    const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the body.`).join("\n");
    const doc = decodeAnswerView({
      v: 1, kind: "document", tool: "read_draft", title: "Win-back sequence", state: "ready", asOf: null,
      scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
      body: {
        meta: [{ label: "From", value: "Demo Team" }, { label: "To", value: "Trial users" }, { label: "Subject", value: "Your trial ended" }],
        sections: [{ text: long, format: "plain" }, { text: "The second email.", format: "plain" }],
        versions: [{ id: "e1", label: "Email 1", sectionIndexes: [0] }, { id: "e2", label: "Email 2", sectionIndexes: [1] }]
      }
    });
    if (!doc) throw new Error("document view does not decode");
    recordTurnView({ type: "tool.view", stage: "tool", message: doc.title, viewId: "d1", name: doc.tool, view: doc });
    const draw = (rows: number) => stripAnsi(renderInkInteractiveSessionToString({
      columns: 100,
      rows,
      initialMessages: [{ role: "user", text: "show me the win-back emails" }, { role: "assistant", text: "Here are both emails." }],
      onSubmitLine: async () => ({ messages: [] })
    }));
    for (const rows of [30, 40]) {
      const out = draw(rows);
      expect(out, `${rows} rows`).toContain("Win-back sequence");
      expect(out, `${rows} rows`).toContain("Line 1 of the body.");
      expect(out, `${rows} rows`).toMatch(/page 1 of \d+/u);
      expect(out.split("\n").length, `${rows} rows`).toBeLessThan(rows);
    }
    // 24 rows have no room for the turn even at the document's smallest page:
    // the finished turn goes whole into scrollback instead of being paged
    // (both emails, every line, no page line and no pager hint).
    resetTurnState();
    recordTurnView({ type: "tool.view", stage: "tool", message: doc.title, viewId: "d1", name: doc.tool, view: doc });
    const whole = draw(24);
    expect(whole).toContain("Win-back sequence");
    expect(whole).toContain("Line 1 of the body.");
    expect(whole).toContain("Line 60 of the body.");
    expect(whole).toContain("The second email.");
    expect(whole).not.toMatch(/page \d+ of \d+|more lines|lines above/u);
  });

  it("view keys are tried only with an empty composer and no card, picker or operator confirm", () => {
    const gate = sessionSource.slice(sessionSource.indexOf("if (\n      onViewKey &&"), sessionSource.indexOf("const page = livePageKey("));
    for (const condition of ["!busy", "value.length === 0", "!confirmActionActive", "!cardFieldActive", "!selectionActive", "!pendingConfirmation"]) {
      expect(gate).toContain(condition);
    }
    // After the wizard and connect-confirm branches, before the pager and the write gate.
    expect(sessionSource.indexOf("onViewKey(input, key)")).toBeGreaterThan(sessionSource.indexOf("if (connectConfirmActive) {"));
    expect(sessionSource.indexOf("onViewKey(input, key)")).toBeLessThan(sessionSource.indexOf("if (confirmActionActive) {"));
  });
});

describe("views in a running session (fake TTY; skipped on CI like the other PTY tests)", () => {
  it.skipIf(process.env.CI === "true")("the latest turn's view stays live with its keys, then commits with the turn", { timeout: 30_000 }, async () => {
    resetTurnState();
    const input = ttyInput();
    const output = ttyOutput(100);
    const lines: string[] = [];
    const session = runInkInteractiveSession({
      errorOutput: ttyOutput(100),
      input,
      async onSubmitLine(line, _onProgress, _signal, onView) {
        lines.push(line);
        if (line === "which ads are on?") {
          onView?.(listFrame());
          return { messages: [{ role: "assistant", text: "Two are on." }] };
        }
        if (line === "/exit") {
          return { exit: true, messages: [] };
        }
        return { messages: [{ role: "assistant", text: `echo ${line}` }] };
      },
      output,
      title: "Infinite TUI"
    });

    await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
    await sendKeys(input, "which ads are on?\r");
    await waitFor(() => / {1}Ads running {2}✓ Ready/u.test(stripAnsi(output.text())), 4_000, output.text);
    // The key bar offers only what works on the view: rows to move, tab to type.
    await waitFor(() => stripAnsi(output.text()).includes("j k  move"), 4_000, output.text);
    // j then k move the selection and type nothing; h starts a message and types.
    await sendKeys(input, "jkh");
    await sendKeys(input, "ello\r");
    await waitFor(() => stripAnsi(output.text()).includes("echo hello"), 4_000, output.text);
    expect(lines).toEqual(["which ads are on?", "hello"]);
    expect(getTurnState().views).toEqual([]);
    // The first turn went to scrollback in its two-pane layout, once.
    const text = stripAnsi(output.text());
    expect(text).toContain("❯ which ads are on?");
    await sendKeys(input, "/exit\r");
    await session;
  });
});

describe("a running turn's views (r4 working frames)", () => {
  it("the turn is drawn with its views while it runs, not only once it ends", () => {
    const draw = sessionSource.slice(sessionSource.indexOf("const renderTurnAt"), sessionSource.indexOf("// (end of the drawn turn)"));
    expect(draw).not.toMatch(/if \(busy \|\|/u);
    expect(draw).toContain("workingTurnMessages(");
    expect(draw).toContain("workingTurnSteps(");
    expect(draw).toContain("besideWorkingTurn(");
  });

  it.skipIf(process.env.CI === "true")("at 160 a view that arrives mid-turn sits right of the arriving answer", { timeout: 30_000 }, async () => {
    resetTurnState();
    const input = ttyInput();
    const output = ttyOutput(160);
    let finish: () => void = () => {};
    const session = runInkInteractiveSession({
      errorOutput: ttyOutput(160),
      input,
      async onSubmitLine(line, onProgress, _signal, onView) {
        if (line === "/exit") {
          return { exit: true, messages: [] };
        }
        onView?.(listFrame());
        onProgress?.({ type: "message.start", stage: "message", message: "" });
        onProgress?.({ type: "message.delta", stage: "message", message: "", text: "Two are on; pausing **Cold brew car" });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { messages: [{ role: "assistant", text: "Two are on; paused **Cold brew carousel**." }] };
      },
      output,
      title: "Infinite TUI"
    });

    await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
    await sendKeys(input, "which ads are on?\r");
    await waitFor(() => /∞ Two are on; pausing Cold brew car +│/u.test(stripAnsi(output.text())), 4_000, output.text);
    expect(stripAnsi(output.text())).toMatch(/❯ which ads are on\? +│ +Ads running/u);
    expect(stripAnsi(output.text())).not.toContain("**Cold");
    finish();
    await waitFor(() => /∞ Two are on; paused Cold brew +│/u.test(stripAnsi(output.text())), 4_000, output.text);
    await sendKeys(input, "/exit\r");
    await session;
  });
});

describe("typing over a live view (fake TTY; skipped on CI like the other PTY tests)", () => {
  it.skipIf(process.env.CI === "true")("\"just\" typed right after a list turn arrives whole; an ask of /exit never quits", { timeout: 30_000 }, async () => {
    resetTurnState();
    const input = ttyInput();
    const output = ttyOutput(100);
    const lines: string[] = [];
    const slashNext = listFrame();
    slashNext.view = { ...slashNext.view, next: [{ label: "Quit", ask: "/exit" }] } as typeof slashNext.view;
    const session = runInkInteractiveSession({
      errorOutput: ttyOutput(100),
      input,
      async onSubmitLine(line, _onProgress, _signal, onView) {
        lines.push(line);
        if (line === "which ads are on?") {
          onView?.(slashNext);
          return { messages: [{ role: "assistant", text: "Two are on." }] };
        }
        if (line === "/exit") {
          return { exit: true, messages: [] };
        }
        return { messages: [{ role: "assistant", text: `echo ${line}` }] };
      },
      output,
      title: "Infinite TUI"
    });

    await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
    await sendKeys(input, "which ads are on?\r");
    await waitFor(() => stripAnsi(output.text()).includes("j k  move"), 4_000, output.text);
    await sendKeys(input, "just do it\r");
    await waitFor(() => stripAnsi(output.text()).includes("echo just do it"), 4_000, output.text);
    expect(lines).toEqual(["which ads are on?", "just do it"]);

    // A next step whose ask is /exit: Enter on it sends nothing and never quits.
    await sendKeys(input, "which ads are on?\r");
    await waitFor(() => lines.length === 3, 4_000, output.text);
    await waitFor(() => stripAnsi(output.text()).split("j k  move").length > 2, 4_000, output.text);
    await sendKeys(input, "\t");
    // Three rows, then the next step (the fourth row).
    for (let i = 0; i < 3; i += 1) await sendKeys(input, "j");
    await sendKeys(input, "\r");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lines).toEqual(["which ads are on?", "just do it", "which ads are on?"]);
    await sendKeys(input, "\tstill here\r");
    await waitFor(() => stripAnsi(output.text()).includes("echo still here"), 4_000, output.text);
    await sendKeys(input, "/exit\r");
    await session;
  });
});

describe("copy in a running session (fake TTY; skipped on CI like the other PTY tests)", () => {
  it.skipIf(process.env.CI === "true")("tab then c puts the minted link on the clipboard", { timeout: 30_000 }, async () => {
    resetTurnState();
    // Copy as over SSH (OSC 52 only), so the test never touches this Mac's clipboard.
    vi.stubEnv("SSH_TTY", "/dev/ttys999");
    const input = ttyInput();
    const output = ttyOutput(100);
    const session = runInkInteractiveSession({
      errorOutput: ttyOutput(100),
      input,
      async onSubmitLine(line, _onProgress, _signal, onView) {
        if (line === "make a link") {
          onView?.(listFrame("v1", "link-minted"));
          return { messages: [{ role: "assistant", text: "Here it is." }] };
        }
        return { exit: true, messages: [] };
      },
      output,
      title: "Infinite TUI"
    });

    await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
    await sendKeys(input, "make a link\r");
    await waitFor(() => /https:\/\/go\.example\.com\/abc1/u.test(stripAnsi(output.text())), 4_000, output.text);
    // Unengaged, `c` would type: the body offers no `c copy` yet.
    expect(stripAnsi(output.text())).not.toContain("c copy");
    expect(stripAnsi(output.text())).not.toContain("c  copy");
    const osc52 = `${ESC}]52;c;${Buffer.from("https://go.example.com/abc1").toString("base64")}\u0007`;
    expect(output.text()).not.toContain(osc52);
    await sendKeys(input, "\t");
    // The body's copy key is r4's chip: ` c ` then ` copy`.
    await waitFor(() => stripAnsi(output.text()).includes("https://go.example.com/abc1   c  copy"), 4_000, output.text);
    await waitFor(() => stripAnsi(output.text()).includes("c  copy    tab"), 4_000, output.text);
    await sendKeys(input, "c");
    await waitFor(() => output.text().includes(osc52), 4_000, output.text);
    await sendKeys(input, "\t/exit\r");
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

function ttyOutput(columns: number) {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & NodeJS.WriteStream & {
    columns: number;
    isTTY: boolean;
    rows: number;
    text: () => string;
  };
  stream.columns = columns;
  stream.rows = 40;
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
