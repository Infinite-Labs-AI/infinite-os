import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANSWER_VIEW_CONTRACT_REVISION, ANSWER_VIEW_KINDS, ANSWER_VIEW_LIMITS, ANSWER_VIEW_STATES, ARCHIVE_ASSET_ID_PATTERN,
  type AnswerViewV1, type ChangeBodyV1, type LeaderV1, type ListBodyV1, type RecordBodyV1, type TodayLegV1
} from "./answer-view.js";
const stripped = (k: string) => { const n = k.toLowerCase().replace(/[^a-z0-9]/g, "");
  return n.endsWith("token") || n.includes("credential") || n === "confirmationid"; };
describe("answer view contract v1", () => {
  it("has 12 kinds and 24 states", () => {
    expect(ANSWER_VIEW_KINDS).toHaveLength(12); expect(ANSWER_VIEW_STATES).toHaveLength(24);
  });
  it("revision 3: a change target may name its picture by reference and its parents (both optional)", () => {
    expect(ANSWER_VIEW_CONTRACT_REVISION).toBe(3);
    expect(ANSWER_VIEW_LIMITS.maxTargetPathParts).toBe(4);
    expect(ANSWER_VIEW_LIMITS.maxTargetPathPartChars).toBeGreaterThan(0);
    const rev3 = { target: { kind: "ad", id: "ad_1", label: "Hook B", creativeRef: { archiveAssetId: "asset_1" },
      path: ["Example campaign", "Example ad set"] }, rows: [{ label: "status", before: "on", after: "PAUSED" }], warnings: [] } satisfies ChangeBodyV1;
    // A revision 2 body (no picture, no path) is still a valid body.
    const rev2 = { target: { kind: "ad", label: "Hook B" }, rows: [], warnings: [] } satisfies ChangeBodyV1;
    expect(rev3.target.path).toHaveLength(2);
    expect("path" in rev2.target).toBe(false);
  });
  it("revision 3: an archive id is one shared pattern, never a URL, a data URI or a path", () => {
    for (const id of ["asset_1", "asset_0a1b-2c", "a1", "arch:v2.3"]) expect(ARCHIVE_ASSET_ID_PATTERN.test(id)).toBe(true);
    for (const id of ["", "https://example.test/a.png", "data:image/png;base64,AA", "/Users/example/a.png",
      "a/b", "_lead", "a".repeat(129), "asset\u001b[31m1", "asset 1"]) expect(ARCHIVE_ASSET_ID_PATTERN.test(id)).toBe(false);
    expect(ARCHIVE_ASSET_ID_PATTERN.test("a".repeat(128))).toBe(true);
  });
  it("revision 3: an archive id never starts with a URL scheme, in any case", () => {
    for (const id of ["https:example.test", "javascript:void", "mailto:a", "http:a", "HTTPS:example.test", "Javascript:void",
      "data:a", "file:a", "blob:a", "vbscript:a", "ftp:a", "MailTo:a"]) expect(ARCHIVE_ASSET_ID_PATTERN.test(id), id).toBe(false);
    // Real-shaped archive ids still pass, including ones that hold a ':' or start with a scheme's letters.
    for (const id of ["asset_gallery_hook_b", "meta:1202:thumb.v2", "thumb-1", "asset_c4", "asset-1",
      "0f8e2a4c-5b6d-4e7f-8a9b-0c1d2e3f4a5b", "https_asset", "datastore:a", "files:a", "mailtox:a", "blob1:a"]) {
      expect(ARCHIVE_ASSET_ID_PATTERN.test(id), id).toBe(true);
    }
  });
  it("revision 3: a list may name its row-name column, a record its own status, a leader its context line", () => {
    expect(ANSWER_VIEW_CONTRACT_REVISION).toBe(3);
    expect(ANSWER_VIEW_LIMITS.maxShortTextChars).toBe(80);
    const list = { layout: "rows", nameLabel: "Ad", columns: [], rows: [], total: 0, shown: 0 } satisfies ListBodyV1;
    const record = { title: "Hook B", status: { word: "Paused", tone: "muted" }, fields: [] } satisfies RecordBodyV1;
    const leader = { measure: { key: "ctr", label: "CTR" }, rowId: "ad_1", rowLabel: "Hook B", value: { value: 2.1 },
      detail: "51 of 357 impressions" } satisfies LeaderV1;
    // All three are optional: a body without them is still valid.
    const oldList = { layout: "rows", columns: [], rows: [], total: 0, shown: 0 } satisfies ListBodyV1;
    const oldRecord = { fields: [] } satisfies RecordBodyV1;
    const oldLeader = { measure: { key: "ctr", label: "CTR" }, rowId: "ad_1", rowLabel: "Hook B", value: { value: null } } satisfies LeaderV1;
    expect([list.nameLabel, record.status.word, leader.detail]).toEqual(["Ad", "Paused", "51 of 357 impressions"]);
    expect(["nameLabel" in oldList, "status" in oldRecord, "detail" in oldLeader]).toEqual([false, false, false]);
  });
  it("revision 3: the contract source documents the new fields and the short-text rule", () => {
    const src = readFileSync(new URL("./answer-view.ts", import.meta.url), "utf8");
    expect(src).toMatch(/ANSWER_VIEW_CONTRACT_REVISION = 3 as const;.*ListBodyV1\.nameLabel; RecordBodyV1\.status; LeaderV1\.detail/);
    expect(src).toMatch(/nameLabel\?: string;.*rev 3/);
    expect(src).toMatch(/status\?: StatusWordV1;.*rev 3/);
    expect(src).toMatch(/detail\?: string;.*rev 3/);
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
