import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANSWER_VIEW_KINDS, ANSWER_VIEW_STATES, type AnswerViewV1, type TodayLegV1 } from "./answer-view.js";
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
  it("no key declared anywhere in the contract source carries a token, credential or confirmation id", () => {
    const keysIn = (src: string): string[] => [
      ...src.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm),
      ...src.matchAll(/[{;,]\s*([A-Za-z_][A-Za-z0-9_]*)\??:/g),
    ].map((m) => m[1]);
    // The scan must be able to fail: a leaked key in a body interface is caught.
    expect(keysIn("export interface X { label: string; accessToken?: string }").filter(stripped)).toEqual(["accessToken"]);
    const keys = keysIn(readFileSync(new URL("./answer-view.ts", import.meta.url), "utf8"));
    // Not vacuous: the scan sees the real contract keys.
    expect(keys).toEqual(expect.arrayContaining(["final", "asOf", "confirmationHandle", "archiveAssetId"]));
    expect(keys.filter(stripped)).toEqual([]);
  });
});

// Type-level pins, compiled by `tsc -b` (the CI typecheck), not by vitest:
// today is never final, and today always carries asOf.
const pinWindow = { from: "2026-10-01", to: "2026-10-01", tz: "America/Los_Angeles", label: "Today" };
const finalToday = { window: pinWindow, final: true, asOf: "2026-10-01T18:30:00Z", rows: [] };
// @ts-expect-error today is never final
export const _todayNeverFinal: TodayLegV1 = finalToday;
const undatedToday = { window: pinWindow, final: false as const, asOf: null, rows: [] };
// @ts-expect-error today needs asOf
export const _todayNeedsAsOf: TodayLegV1 = undatedToday;
