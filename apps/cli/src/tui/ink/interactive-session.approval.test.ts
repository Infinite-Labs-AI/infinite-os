import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ApprovalFieldAnswerV1 } from "@infinite-os/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import type { InSessionConfirmationAction } from "../../desktop/confirm-in-session.js";
import { recordCreativeDraft, resetTurnState } from "../app/turn-store.js";
import { displayWidth } from "../lib/display-width.js";
import {
  renderInkInteractiveSessionToString,
  runInkInteractiveSession,
  type InkInteractiveLineResult
} from "./interactive-session.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (value: string) => value.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");
const sessionSource = readFileSync(fileURLToPath(new URL("./interactive-session.tsx", import.meta.url)), "utf8");

function card(name: string, over: Partial<InSessionConfirmationAction> = {}): InSessionConfirmationAction {
  const raw = readFileSync(fileURLToPath(new URL(`../views/__fixtures__/${name}.json`, import.meta.url)), "utf8");
  const view = decodeAnswerView(JSON.parse(raw));
  if (!view) throw new Error(`${name} does not decode`);
  return {
    turnId: "turn_1",
    confirmationHandle: "h_1",
    summary: "Pause ad Hook A",
    confirmationDetails: [{ label: "Ad", value: "Hook A" }],
    confirmFieldsCapable: true,
    view,
    ...over
  };
}

afterEach(() => resetTurnState());

describe("the write card draws its approval view (CI-runnable)", () => {
  it("renders action.view when present: the framed card and its named OK key", () => {
    const out = stripAnsi(renderInkInteractiveSessionToString({
      columns: 80,
      initialPendingConfirmations: [card("change-pause-card")],
      onSubmitLine: async () => ({ messages: [] })
    }));
    expect(out).toContain("Pause ad “Hook A”?");
    expect(out).toContain("status  on → paused");
    expect(out).toContain("p Pause   n dismiss");
    // The old card's summary line is not drawn when the view is.
    expect(out).not.toContain("Approve this write?");
    expect(out).not.toContain("Stops this ad's spend");
    expect(out.split("\n").every((line) => displayWidth(line) <= 80)).toBe(true);
  });

  it("keeps the confirmationDetails card for an old desktop (no view)", () => {
    const out = stripAnsi(renderInkInteractiveSessionToString({
      columns: 80,
      initialPendingConfirmations: [card("change-pause-card", { view: undefined })],
      onSubmitLine: async () => ({ messages: [] })
    }));
    expect(out).toContain("Approve this write? — Pause ad Hook A");
    expect(out).toContain("Ad: Hook A");
    expect(out).toContain("y Confirm   n dismiss");
  });

  it("a send card offers v view; a card whose desktop can't take fields asks to update", () => {
    const send = stripAnsi(renderInkInteractiveSessionToString({
      columns: 80,
      initialPendingConfirmations: [card("launch-send-card")],
      onSubmitLine: async () => ({ messages: [] })
    }));
    expect(send).toContain("v view   s Send to 200 people   n dismiss");
    const old = stripAnsi(renderInkInteractiveSessionToString({
      columns: 80,
      initialPendingConfirmations: [card("change-budget-field", { confirmFieldsCapable: false })],
      onSubmitLine: async () => ({ messages: [] })
    }));
    expect(old).toContain("Update the Infinite app to set a value here");
    expect(old).not.toContain("l Lower to $30/day");
  });

  it("image drafts in progress print one text line per run, never a URL", () => {
    recordCreativeDraft({
      type: "creative.draft", runId: "run_1", status: "running", count: 3, format: "png", aspectRatio: "4:5",
      quality: "high", pending: [{ startedAtMs: 0, etaMs: null }]
    });
    const out = stripAnsi(renderInkInteractiveSessionToString({
      columns: 80,
      onSubmitLine: async () => ({ messages: [] })
    }));
    expect(out).toContain("Drawing 3 images");
    expect(out).not.toMatch(/http/u);
  });

  it("the card's keys all go through the keymap and the card step; fields go out with the decision", () => {
    expect(sessionSource).toContain("const step = cardKeyStep(action, headCard, cardUi);");
    expect(sessionSource).toContain("resolveConfirmAction(step.effect.decision, step.effect.fields);");
    expect(sessionSource).toContain("confirmKeys={cardKeyCtx}");
    // Enter in a card field sets the value; it never reaches the brain or the history.
    const submit = sessionSource.slice(sessionSource.indexOf("const submitLine = useCallback"), sessionSource.indexOf("rememberInputLine(line);\n    runSubmittedLine(line);"));
    expect(submit.indexOf("commitCardFieldValue(rawLine)")).toBeGreaterThan(-1);
  });
});

describe("the view card in a running session (fake TTY; skipped on CI like the other PTY tests)", () => {
  it.skipIf(process.env.CI === "true")(
    "a money field is asked before OK, Enter only sets it, and OK sends it as fields",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const calls: { decision: string; fields?: Record<string, ApprovalFieldAnswerV1> }[] = [];
      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput: ttyOutput(),
        input,
        output,
        title: "Infinite TUI",
        onConfirmAction: async (_action, decision, fields) => {
          calls.push({ decision, ...(fields ? { fields } : {}) });
          return { ok: true };
        },
        async onSubmitLine(): Promise<InkInteractiveLineResult> {
          return { messages: [], pendingConfirmations: [card("change-budget-field")] };
        }
      });
      await waitFor(() => output.text().includes("ready"));
      await sendKeys(input, "lower it\r");
      await waitFor(() => output.text().includes("Change the budget"), 4_000, output.text);
      await sendKeys(input, "l");
      await waitFor(() => stripAnsi(output.text()).includes("enter set"), 4_000, output.text);
      expect(calls).toEqual([]);
      await sendKeys(input, "30\r");
      await waitFor(() => stripAnsi(output.text()).includes("$30.00/day"), 4_000, output.text);
      expect(calls).toEqual([]);
      await sendKeys(input, "l");
      await waitFor(() => calls.length === 1, 4_000, output.text);
      expect(calls).toEqual([{ decision: "approve", fields: { adSetBudget: { text: "30" } } }]);
      await sendKeys(input, "/exit\r");
      await session;
    }
  );

  it.skipIf(process.env.CI === "true")(
    "a card brought back after 'not sure it happened' re-sends the same answers, and shows its reconcile step",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const calls: { decision: string; fields?: Record<string, ApprovalFieldAnswerV1> }[] = [];
      const budget = card("change-budget-field");
      const unsure = {
        ...budget.view!, approval: undefined, state: "outcome_unknown", outcome: "unknown", retry: "safe_resend",
        receipt: { sentence: "Not sure it happened", tone: "warn", revertible: false },
        reconcile: { label: "Check first", ask: "did the budget change land?" }
      };
      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput: ttyOutput(),
        input,
        output,
        title: "Infinite TUI",
        onConfirmAction: async (_action, decision, fields) => {
          calls.push({ decision, ...(fields ? { fields } : {}) });
          if (calls.length === 1) {
            // A failed resolution throws, carrying its receipt view (desktop-app-client confirm).
            throw Object.assign(new Error("Not sure it happened"), { code: "dispatch_uncertain", view: unsure });
          }
          return { ok: true };
        },
        async onSubmitLine(): Promise<InkInteractiveLineResult> {
          return { messages: [], pendingConfirmations: [budget] };
        }
      });
      await waitFor(() => output.text().includes("ready"));
      await sendKeys(input, "lower it\r");
      await waitFor(() => output.text().includes("Change the budget"), 4_000, output.text);
      await sendKeys(input, "l");
      await waitFor(() => stripAnsi(output.text()).includes("enter set"), 4_000, output.text);
      await sendKeys(input, "30\r");
      await waitFor(() => stripAnsi(output.text()).includes("$30.00/day"), 4_000, output.text);
      await sendKeys(input, "l");
      await waitFor(() => calls.length === 1, 4_000, output.text);
      await waitFor(() => stripAnsi(output.text()).includes("→ Check first"), 4_000, output.text);
      await waitFor(() => stripAnsi(output.text()).includes("l check again"), 4_000, output.text);
      await sendKeys(input, "l");
      await waitFor(() => calls.length === 2, 4_000, output.text);
      expect(calls).toEqual([
        { decision: "approve", fields: { adSetBudget: { text: "30" } } },
        { decision: "approve", fields: { adSetBudget: { text: "30" } } }
      ]);
      await sendKeys(input, "/exit\r");
      await session;
    }
  );

  it.skipIf(process.env.CI === "true")(
    "an answer the app refuses (field_invalid) keeps the card, with the app's words, for a corrected value",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const calls: { decision: string; fields?: Record<string, ApprovalFieldAnswerV1> }[] = [];
      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput: ttyOutput(),
        input,
        output,
        title: "Infinite TUI",
        onConfirmAction: async (_action, decision, fields) => {
          calls.push({ decision, ...(fields ? { fields } : {}) });
          if (calls.length === 1) {
            throw Object.assign(new Error("Budget is above the cap. Nothing was executed."), { code: "field_invalid" });
          }
          return { ok: true };
        },
        async onSubmitLine(): Promise<InkInteractiveLineResult> {
          return { messages: [], pendingConfirmations: [card("change-budget-field")] };
        }
      });
      await waitFor(() => output.text().includes("ready"));
      await sendKeys(input, "lower it\r");
      await waitFor(() => output.text().includes("Change the budget"), 4_000, output.text);
      await sendKeys(input, "l");
      await waitFor(() => stripAnsi(output.text()).includes("enter set"), 4_000, output.text);
      await sendKeys(input, "9000\r");
      await waitFor(() => stripAnsi(output.text()).includes("$9,000.00/day"), 4_000, output.text);
      await sendKeys(input, "l");
      await waitFor(() => calls.length === 1, 4_000, output.text);
      await waitFor(() => stripAnsi(output.text()).includes("Budget is above the cap."), 4_000, output.text);
      await waitFor(() => stripAnsi(output.text()).includes("l Lower to $30/day"), 4_000, output.text);
      await sendKeys(input, "l");
      await waitFor(() => stripAnsi(output.text()).includes("enter set"), 4_000, output.text);
      await sendKeys(input, "45\r");
      await waitFor(() => stripAnsi(output.text()).includes("$45.00/day"), 4_000, output.text);
      await sendKeys(input, "l");
      await waitFor(() => calls.length === 2, 4_000, output.text);
      expect(calls[1]).toEqual({ decision: "approve", fields: { adSetBudget: { text: "45" } } });
      await sendKeys(input, "/exit\r");
      await session;
    }
  );

  it.skipIf(process.env.CI === "true")(
    "v opens the email bodies, 2 switches, Enter and Esc never decide, n sends a real no",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput();
      const decisions: string[] = [];
      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput: ttyOutput(),
        input,
        output,
        title: "Infinite TUI",
        onConfirmAction: async (_action, decision) => {
          decisions.push(decision);
          return { ok: true };
        },
        async onSubmitLine(): Promise<InkInteractiveLineResult> {
          return { messages: [], pendingConfirmations: [card("launch-send-card")] };
        }
      });
      await waitFor(() => output.text().includes("ready"));
      await sendKeys(input, "send it\r");
      await waitFor(() => output.text().includes("Send this to 200 people?"), 4_000, output.text);
      await sendKeys(input, "v");
      await waitFor(() => output.text().includes("Hi {first name},"), 4_000, output.text);
      await sendKeys(input, "2");
      await waitFor(() => output.text().includes("Here are three things."), 4_000, output.text);
      await sendKeys(input, "\r");
      await sendKeys(input, "\x1b");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(decisions).toEqual([]);
      await sendKeys(input, "n");
      await waitFor(() => decisions.length === 1, 4_000, output.text);
      expect(decisions).toEqual(["decline"]);
      await sendKeys(input, "/exit\r");
      await session;
    }
  );
});

describe("a tall card in a running session (fake TTY; skipped on CI like the other PTY tests)", () => {
  /** A launch of `sets` ad sets with 3 ads each (synthetic names). */
  function tallLaunch(sets: number): InSessionConfirmationAction {
    const base = card("launch-tree");
    const view = JSON.parse(JSON.stringify(base.view)) as {
      body: { tree: { children: Record<string, unknown>[] }[] };
      approval: Record<string, unknown>;
    };
    const tree = view.body.tree[0]!;
    const adSet = tree.children[0]!;
    tree.children = Array.from({ length: sets }, (_, index) => ({ ...adSet, name: `Ad set ${index + 1}` }));
    view.approval = { ...view.approval, title: `Launch ${sets * 3} ads?`, confirmLabel: `Launch ${sets * 3} ads` };
    return { ...base, summary: `Launch ${sets * 3} ads`, view: decodeAnswerView(view)! };
  }

  it.skipIf(process.env.CI === "true")(
    "a launch of 10 ad sets at 80×24 never clears the screen, and its head, title and OK key stay on screen",
    { timeout: 30_000 },
    async () => {
      const input = ttyInput();
      const output = ttyOutput(80, 24);
      const session = runInkInteractiveSession({
        columns: 80,
        errorOutput: ttyOutput(),
        initialPendingConfirmations: [tallLaunch(10)],
        input,
        output,
        title: "Infinite TUI",
        onSubmitLine: async () => ({ messages: [] })
      });
      await waitFor(() => stripAnsi(output.text()).includes("l Launch 30 ads"), 4_000, output.text);
      // A few clock ticks: every redraw stays below the window height.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await sendKeys(input, " ");
      await waitFor(() => /page 2 of \d+ · space/u.test(stripAnsi(output.text())), 4_000, output.text);
      const last = stripAnsi(output.lastFrame());
      expect(last).toContain("Needs your OK");
      expect(last).toContain("Launch 30 ads?");
      expect(last).toContain("l Launch 30 ads");
      expect(output.text()).not.toContain(`${ESC}[2J`);
      expect(output.text()).not.toContain(`${ESC}[3J`);
      input.write("\u0003");
      await session;
    }
  );
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

function ttyOutput(columns = 80, rows = 40) {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & NodeJS.WriteStream & {
    columns: number;
    isTTY: boolean;
    rows: number;
    text: () => string;
    lastFrame: () => string;
  };
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  stream.on("data", (chunk) => chunks.push(String(chunk)));
  stream.text = () => chunks.join("");
  // The last full frame Ink drew (log-update erases the previous frame, then writes the next whole).
  stream.lastFrame = () => [...chunks].reverse().find((chunk) => chunk.includes("Needs your OK") || chunk.length > 200) ?? "";
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
