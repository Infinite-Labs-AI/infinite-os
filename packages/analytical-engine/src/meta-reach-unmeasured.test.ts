import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInfiniteOsDb, runMigrations, type InfiniteOsDb } from "@infinite-os/db";

import { REACH_EXCLUDES_UNMEASURED_DAYS_CAVEAT, createActionHandlers } from "./index.js";

// Reach/frequency over a window that includes the hot lane's derived open day, against real
// PGlite. Derived campaign/ad set rows (actions_raw.derivation.method = "sum_of_ad_insights")
// store reach = NULL — unmeasured. Before: reach silently skipped the day while frequency
// divided that day's impressions by nobody (2 settled days at 1000 impressions / 500 reach each
// plus a derived day of 3000 impressions read 5000 / 1000 = 5.0). After: frequency is computed
// over the measured days only (2000 / 1000 = 2.0) and both answers are flagged.
describe("Meta reach/frequency over unmeasured (derived) days — real PGlite", () => {
  let dataDir: string;
  let db: InfiniteOsDb;
  const workspaceId = "ws_reach_unmeasured";
  let sourceId = "";
  const ctx = { workspaceId, authority: "tool_agent" as const, surface: "api" as const, actorId: "operator", sessionId: "session" };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "infinite-os-reach-unmeasured-"));
    const url = `pglite://${dataDir}`;
    await runMigrations(url);
    db = createInfiniteOsDb(url);
    const source = await db.connectSource({ workspaceId, provider: "meta_ads", connectionName: "Meta", accountExternalId: "act_1" });
    sourceId = (source as { id: string }).id;
    const rows: Array<[string, string, number, number | null, Record<string, unknown> | null]> = [
      ["c1", "2026-09-20", 1000, 500, null],
      ["c1", "2026-09-21", 1000, 500, null],
      // The open day, derived by summing ad insights: reach unmeasured.
      ["c1", "2026-09-22", 3000, null, { derivation: { method: "sum_of_ad_insights", version: 1, source_grain: "ad" } }],
      // A second campaign, fully measured.
      ["c2", "2026-09-21", 600, 300, null],
    ];
    for (const [campaignId, day, impressions, reach, actionsRaw] of rows) {
      await db.query(
        `insert into meta_ads_campaign_daily (id, workspace_id, source_id, ad_account_id, campaign_id, campaign_name, occurred_on, impressions, reach, actions_raw)
         values ($1,$2,$3,'act_1',$4,$4,$5,$6,$7,$8::jsonb)`,
        [`row_${campaignId}_${day}`, workspaceId, sourceId, campaignId, day, impressions, reach, actionsRaw ? JSON.stringify(actionsRaw) : null],
      );
    }
  }, 120_000);

  afterAll(async () => {
    if (db) await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const windowed = (metric: string, since: string, until: string, extra: Record<string, unknown> = {}) => ({
    metric,
    filters: [
      { field: "occurred_on", operator: "gte", value: since },
      { field: "occurred_on", operator: "lte", value: until },
      { field: "campaign_id", operator: "equals", value: "c1" },
    ],
    ...extra,
  });

  it("frequency divides only measured days' impressions by their reach, and is flagged", async () => {
    const result = await createActionHandlers(db).run_metric_query?.(windowed("frequency", "2026-09-20", "2026-09-22"), ctx);
    const rows = (result?.data as { rows: Array<Record<string, unknown>> }).rows;
    expect(Number(rows[0]?.frequency)).toBeCloseTo(2, 9);
    expect(result?.caveats).toContain(REACH_EXCLUDES_UNMEASURED_DAYS_CAVEAT);
  });

  it("reach sums the measured days only (never a fake 0 for the open day) and is flagged", async () => {
    const result = await createActionHandlers(db).run_metric_query?.(windowed("reach", "2026-09-20", "2026-09-22"), ctx);
    const rows = (result?.data as { rows: Array<Record<string, unknown>> }).rows;
    expect(Number(rows[0]?.reach)).toBe(1000);
    // The flag rides second (right after unbounded_date_range, absent here) so the digest keeps it.
    expect(result?.caveats?.[0]).toBe(REACH_EXCLUDES_UNMEASURED_DAYS_CAVEAT);
  });

  it("a fully measured window is unchanged and unflagged", async () => {
    for (const metric of ["reach", "frequency"]) {
      const result = await createActionHandlers(db).run_metric_query?.(windowed(metric, "2026-09-20", "2026-09-21"), ctx);
      const value = Number((result?.data as { rows: Array<Record<string, unknown>> }).rows[0]?.[metric]);
      expect(value).toBe(metric === "reach" ? 1000 : 2);
      expect(result?.caveats).not.toContain(REACH_EXCLUDES_UNMEASURED_DAYS_CAVEAT);
    }
  });

  it("a window holding ONLY unmeasured days returns no frequency (NULL), not a number", async () => {
    const result = await createActionHandlers(db).run_metric_query?.(windowed("frequency", "2026-09-22", "2026-09-22"), ctx);
    expect((result?.data as { rows: Array<Record<string, unknown>> }).rows[0]?.frequency).toBeNull();
    expect(result?.caveats).toContain(REACH_EXCLUDES_UNMEASURED_DAYS_CAVEAT);
  });

  it("breakdowns apply the same exclusion per group and flag the answer", async () => {
    const result = await createActionHandlers(db).run_breakdown_query?.({
      metric: "frequency",
      groupBy: ["campaign_id"],
      filters: [
        { field: "occurred_on", operator: "gte", value: "2026-09-20" },
        { field: "occurred_on", operator: "lte", value: "2026-09-22" },
      ],
    }, ctx);
    const rows = (result?.data as { rows: Array<Record<string, unknown>> }).rows;
    const byCampaign = Object.fromEntries(rows.map(row => [row.campaign_id, Number(row.frequency)]));
    expect(byCampaign).toEqual({ c1: 2, c2: 2 });
    expect(result?.caveats).toContain(REACH_EXCLUDES_UNMEASURED_DAYS_CAVEAT);
  });
});
