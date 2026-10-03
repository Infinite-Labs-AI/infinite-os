// Wave 3 r1 (TJ-10, terminal half): when exactly one view stands for a step,
// the view's state sets the row. The desktop bridge reports a refused read
// (not connected) as a failed call (`status: "error"`, cmdl-local-bridge
// publicToolCompleteData), so a not-connected read is `· not connected`
// (r4 flow-numbers-05), never `✗ didn't go through`; a view that asks a
// question waits for an answer, never for an OK.
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import type { TurnStep } from "../app/turn-store.js";
import { stepRowLines, unsettledStepLines } from "./steps.js";
import { resolveTheme } from "../theme.js";

const theme = resolveTheme({});
const step = (over: Partial<TurnStep> & Pick<TurnStep, "status">): TurnStep => ({
  id: "s1", name: "mcp__sample_app__read_metrics", label: "checking your metrics", startedAt: 0, endedAt: 1000, result: "", ...over
});
const view = (tool: string, state: string, extra: Record<string, unknown> = {}) =>
  ({ v: 1, kind: "numbers", tool, title: "Metrics", state, asOf: null, scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [], body: {}, ...extra }) as unknown as AnswerViewV1;
const rows = (steps: TurnStep[], views: AnswerViewV1[], width = 100) =>
  stepRowLines(steps, { width, color: false, theme, nowMs: 1000, views });

describe("a step follows the one view that stands for it (TJ-10)", () => {
  it("a refused read whose view is not connected is `· not connected`, never ✗", () => {
    const failed = step({ status: "fail", result: "didn't go through" });
    const [row] = rows([failed], [view("read_metrics", "not_connected")]);
    expect(row).toMatch(/· not connected$/u);
    expect(row).not.toContain("✗");
    expect(row).not.toContain("didn't go through");
  });

  it("a failed call whose view failed stays ✗ with its own words", () => {
    const [row] = rows([step({ status: "fail", result: "not allowed" })], [view("read_metrics", "failed")]);
    expect(row).toMatch(/✗ not allowed$/u);
  });

  it("two calls of the tool and one view: no telling which, the call keeps its own status", () => {
    const steps = [step({ id: "a", status: "fail", result: "didn't go through" }), step({ id: "b", status: "ok", result: "" })];
    const drawn = rows(steps, [view("read_metrics", "not_connected")]);
    expect(drawn[0]).toMatch(/✗ didn't go through$/u);
  });

  it("a view that needs an answer waits for an answer, not for an OK", () => {
    const [row] = rows([step({ status: "ok", name: "mcp__sample_app__resolve_item", label: "finding the item" })], [view("resolve_item", "needs_answer", { kind: "list" })]);
    expect(row).toMatch(/▣ waiting for an answer$/u);
    expect(row).not.toContain("waiting for your OK");
    const [card] = rows([step({ status: "ok", name: "mcp__sample_app__resolve_item", label: "finding the item" })], [view("resolve_item", "needs_yes", { kind: "list" })]);
    expect(card).toMatch(/▣ waiting for your OK$/u);
  });

  it("in scrollback, a not-connected read is not kept as an unsettled row", () => {
    expect(unsettledStepLines([step({ status: "fail", result: "didn't go through" })], { width: 100, color: false, theme, views: [view("read_metrics", "not_connected")] })).toEqual([]);
  });

  for (const width of [48, 60, 80, 100, 140]) {
    it(`fits ${width} columns`, () => {
      for (const line of rows([step({ status: "fail", result: "didn't go through" })], [view("read_metrics", "not_connected")], width)) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    });
  }
});

// Wave 3 r2 (W3-quiet-blocked, W3-quiet-limit, W3-quiet-unknown, W3-chg-nochange):
// a frame carries no refusal code, but the one view that stands for the call
// does. Its typed state sets the row's words (r4 `✗ not allowed`, `✗ limit`),
// and a row never ends in a lone mark (`?`, `·`).
describe("a step's words come from the view that stands for it (W3 r2)", () => {
  const quiet = (tool: string, state: string, extra: Record<string, unknown> = {}) => view(tool, state, { kind: "quiet", ...extra });

  it("a refused call whose view is blocked says `✗ not allowed`, never the transport's generic words", () => {
    const [row] = rows([step({ status: "fail", result: "didn't go through" })], [quiet("read_metrics", "blocked")]);
    expect(row).toMatch(/✗ not allowed$/u);
    expect(row).not.toContain("didn't go through");
  });

  it("a refused call whose view hit a limit says `✗ limit`", () => {
    const [row] = rows([step({ status: "fail", result: "didn't go through" })], [quiet("read_metrics", "hit_limit")]);
    expect(row).toMatch(/✗ limit$/u);
    expect(row).not.toContain("didn't go through");
  });

  it("a finished call whose view is blocked or hit a limit says the same words", () => {
    expect(rows([step({ status: "ok", result: "" })], [quiet("read_metrics", "blocked")])[0]).toMatch(/✗ not allowed$/u);
    expect(rows([step({ status: "ok", result: "" })], [quiet("read_metrics", "hit_limit")])[0]).toMatch(/✗ limit$/u);
  });

  it("two calls of the tool and one blocked view: no telling which, each call keeps its own words", () => {
    const steps = [step({ id: "a", status: "fail", result: "didn't go through" }), step({ id: "b", status: "fail", result: "didn't go through" })];
    for (const row of rows(steps, [quiet("read_metrics", "blocked")])) expect(row).toMatch(/✗ didn't go through$/u);
  });

  it("an outcome-unknown view's row says it is not sure, never a lone ?", () => {
    const [row] = rows([step({ status: "ok", result: "" })], [quiet("read_metrics", "outcome_unknown", { outcome: "unknown" })]);
    expect(row).toMatch(/\? not sure it happened$/u);
    expect(row).not.toMatch(/\?$/u);
  });

  it("an outcome-unknown view with a short reason says that short", () => {
    const [row] = rows([step({ status: "ok", result: "" })], [quiet("read_metrics", "outcome_unknown", { outcome: "unknown", stateReason: { code: "sample", words: "A sample sentence.", short: "Timed out" } })]);
    expect(row).toMatch(/\? timed out$/u);
  });

  it("a no-change view's row says nothing to change, never a lone ·", () => {
    const [row] = rows([step({ status: "ok", result: "" })], [view("read_metrics", "no_change", { kind: "change", outcome: "no_change" })]);
    expect(row).toMatch(/· nothing to change$/u);
  });

  it("the app's own result words still win for unknown and no-change rows", () => {
    expect(rows([step({ status: "ok", result: "already off" })], [view("read_metrics", "no_change", { kind: "change" })])[0]).toMatch(/· already off$/u);
    expect(rows([step({ status: "ok", result: "sample words" })], [quiet("read_metrics", "outcome_unknown")])[0]).toMatch(/\? sample words$/u);
  });

  it("in scrollback, blocked, limit and unknown rows keep their words", () => {
    const kept = (state: string, status: "fail" | "ok") =>
      unsettledStepLines([step({ status, result: status === "fail" ? "didn't go through" : "" })], { width: 100, color: false, theme, views: [quiet("read_metrics", state)] });
    expect(kept("blocked", "fail")).toEqual([expect.stringMatching(/✗ not allowed$/u)]);
    expect(kept("hit_limit", "fail")).toEqual([expect.stringMatching(/✗ limit$/u)]);
    expect(kept("outcome_unknown", "ok")).toEqual([expect.stringMatching(/\? not sure it happened$/u)]);
  });

  for (const width of [48, 60, 100, 140]) {
    it(`fits ${width} columns`, () => {
      for (const state of ["blocked", "hit_limit", "outcome_unknown", "no_change"]) {
        for (const line of rows([step({ status: state.startsWith("b") || state.startsWith("h") ? "fail" : "ok", result: "" })], [quiet("read_metrics", state)], width)) {
          expect(line.length).toBeLessThanOrEqual(width);
        }
      }
    });
  }
});
