import { describe, expect, it } from "vitest";
import { ANSWER_VIEW_KINDS, ANSWER_VIEW_STATES, type AnswerViewV1 } from "./answer-view.js";
const stripped = (k: string) => { const n = k.toLowerCase().replace(/[^a-z0-9]/g, "");
  return n.endsWith("token") || n.includes("credential") || n === "confirmationid"; };
describe("answer view contract v1", () => {
  it("has 12 kinds and 24 states", () => {
    expect(ANSWER_VIEW_KINDS).toHaveLength(12); expect(ANSWER_VIEW_STATES).toHaveLength(24);
  });
  it("a numbers view keeps today out of the settled leg", () => {
    const view = { v: 1, kind: "numbers", tool: "t", title: "T", state: "ready", asOf: null,
      scope: { workspaceName: "W", crossWorkspace: false }, caveats: [],
      body: { layout: "kpis", currency: "USD", columns: [{ key: "spend", label: "Spend", unit: "money", factGroup: "meta" }],
        legs: { settled: { window: { from: "2026-09-24", to: "2026-09-30", tz: "America/Los_Angeles", label: "Sep 24–30" }, final: true, asOf: null,
          rows: [{ id: "a", label: "All", cells: { spend: { value: null, reason: { code: "not_synced", words: "not synced yet" } } } }] },
          today: { window: { from: "2026-10-01", to: "2026-10-01", tz: "America/Los_Angeles", label: "Today" }, final: false, asOf: "2026-10-01T18:30:00Z", rows: [] } } },
    } satisfies AnswerViewV1;
    const keys: string[] = []; const walk = (v: unknown): void => { if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
    walk(view); expect(keys.filter(stripped)).toEqual([]);
  });
});
