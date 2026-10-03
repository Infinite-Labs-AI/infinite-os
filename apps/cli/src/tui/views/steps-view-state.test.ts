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

  it("a failed read whose view is blocked or out of budget stays ✗ with its own words", () => {
    for (const state of ["blocked", "hit_limit", "failed"]) {
      const [row] = rows([step({ status: "fail", result: "not allowed" })], [view("read_metrics", state)]);
      expect(row).toMatch(/✗ not allowed$/u);
    }
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
