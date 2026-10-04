import { describe, expect, it } from "vitest";
import { type InfiniteOsDb } from "@infinite-os/db";
import {
  freshnessForProviders,
  freshnessForViews,
  parseFreshnessTargetMs
} from "./index.js";

// ---------------------------------------------------------------------------
// REAL FRESHNESS CONTRACT tests. The envelope shape is unchanged
// ({ target, asOf, stale }); these pin the new semantics:
//   asOf  = per required provider, MAX over its sources of
//           coalesce(last_synced_at, latest succeeded sync_runs.finished_at);
//           MIN across providers (stalest input bounds the answer);
//           null when any required provider never synced.
//   stale = asOf null, or now - asOf > target.
//   target comes from queryable_views.freshness_target (strictest wins).
// Failure-safety: db errors ⇒ undefined (freshness omitted, query unharmed).
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-10T12:00:00.000Z");

function fakeDb(handler: (sql: string, params?: unknown[]) => unknown[]): InfiniteOsDb {
  return {
    query: async (sql: string, params?: unknown[]) => handler(sql, params),
    one: async () => null,
    close: async () => {}
  } as unknown as InfiniteOsDb;
}

function providerRows(rows: Array<{ provider: string; as_of: string | null }>) {
  return fakeDb((sql) => {
    if (sql.includes("from sources")) {
      return rows;
    }
    throw new Error(`unexpected sql: ${sql}`);
  });
}

describe("parseFreshnessTargetMs", () => {
  it("parses the seeded target vocabulary", () => {
    expect(parseFreshnessTargetMs("24 hours")).toBe(24 * 3_600_000);
    expect(parseFreshnessTargetMs("15 minutes")).toBe(15 * 60_000);
    expect(parseFreshnessTargetMs("1 hour")).toBe(3_600_000);
    expect(parseFreshnessTargetMs("7 days")).toBe(7 * 86_400_000);
  });

  it("rejects garbage instead of guessing", () => {
    expect(parseFreshnessTargetMs("soon")).toBeUndefined();
    expect(parseFreshnessTargetMs("")).toBeUndefined();
  });
});

describe("freshnessForProviders", () => {
  it("reports fresh (stale: false) when the provider synced within target", async () => {
    const db = providerRows([{ provider: "stripe", as_of: "2026-07-10T09:00:00.000Z" }]);
    const freshness = await freshnessForProviders(db, "ws1", ["stripe"], "24 hours", NOW);
    expect(freshness).toEqual({
      target: "24 hours",
      asOf: "2026-07-10T09:00:00.000Z",
      stale: false
    });
  });

  it("reports stale when the last sync is older than the target", async () => {
    const db = providerRows([{ provider: "stripe", as_of: "2026-07-08T09:00:00.000Z" }]);
    const freshness = await freshnessForProviders(db, "ws1", ["stripe"], "24 hours", NOW);
    expect(freshness).toMatchObject({ asOf: "2026-07-08T09:00:00.000Z", stale: true });
  });

  it("reports asOf null + stale when the provider never synced (no source rows)", async () => {
    const db = providerRows([]);
    const freshness = await freshnessForProviders(db, "ws1", ["posthog"], "24 hours", NOW);
    expect(freshness).toEqual({ target: "24 hours", asOf: null, stale: true });
  });

  it("reports the MIN across providers — the stalest input bounds the answer", async () => {
    const db = providerRows([
      { provider: "meta_ads", as_of: "2026-07-10T11:00:00.000Z" },
      { provider: "stripe", as_of: "2026-07-06T00:00:00.000Z" }
    ]);
    const freshness = await freshnessForProviders(db, "ws1", ["meta_ads", "stripe"], "24 hours", NOW);
    expect(freshness).toMatchObject({ asOf: "2026-07-06T00:00:00.000Z", stale: true });
  });

  it("reports asOf null when ANY required provider never synced", async () => {
    const db = providerRows([{ provider: "meta_ads", as_of: "2026-07-10T11:00:00.000Z" }]);
    const freshness = await freshnessForProviders(db, "ws1", ["meta_ads", "stripe"], "24 hours", NOW);
    expect(freshness).toEqual({ target: "24 hours", asOf: null, stale: true });
  });

  it("omits freshness entirely on empty provider sets and on db failure", async () => {
    expect(await freshnessForProviders(providerRows([]), "ws1", [], "24 hours", NOW)).toBeUndefined();
    const broken = fakeDb(() => {
      throw new Error("boom");
    });
    expect(await freshnessForProviders(broken, "ws1", ["stripe"], "24 hours", NOW)).toBeUndefined();
  });
});

describe("freshnessForViews", () => {
  function metadataAndSourcesDb(options: {
    views: Array<{ id: string; freshness_target: string | null; source_tables: unknown }>;
    providers: Array<{ provider: string; as_of: string | null }>;
  }): InfiniteOsDb {
    return fakeDb((sql) => {
      if (sql.includes("from queryable_views")) {
        return options.views;
      }
      if (sql.includes("from sources")) {
        return options.providers;
      }
      throw new Error(`unexpected sql: ${sql}`);
    });
  }

  it("derives providers from the seeded source_tables prefixes and applies the view target", async () => {
    const db = metadataAndSourcesDb({
      views: [
        {
          id: "queryable.vw_revenue_by_source",
          freshness_target: "24 hours",
          source_tables: '["stripe_invoices"]'
        }
      ],
      providers: [{ provider: "stripe", as_of: "2026-07-10T09:00:00.000Z" }]
    });
    const freshness = await freshnessForViews(db, "ws1", ["queryable.vw_revenue_by_source"], NOW);
    expect(freshness).toEqual({
      target: "24 hours",
      asOf: "2026-07-10T09:00:00.000Z",
      stale: false
    });
  });

  it("unions providers across a multi-provider join view (meta↔stripe)", async () => {
    const db = metadataAndSourcesDb({
      views: [
        {
          id: "queryable.vw_meta_stripe_campaign_value_daily",
          freshness_target: "24 hours",
          source_tables: '["meta_ads_campaign_daily","stripe_invoices"]'
        }
      ],
      providers: [
        { provider: "meta_ads", as_of: "2026-07-10T11:30:00.000Z" },
        { provider: "stripe", as_of: "2026-07-10T02:00:00.000Z" }
      ]
    });
    const freshness = await freshnessForViews(
      db,
      "ws1",
      ["queryable.vw_meta_stripe_campaign_value_daily"],
      NOW
    );
    // The stalest of the two (stripe, 02:00) is reported; both within 24h.
    expect(freshness).toMatchObject({ asOf: "2026-07-10T02:00:00.000Z", stale: false });
  });

  it("uses the STRICTEST target across multiple views", async () => {
    const db = metadataAndSourcesDb({
      views: [
        {
          id: "queryable.vw_site_traffic",
          freshness_target: "24 hours",
          source_tables: '["ga4_report_snapshot_fact"]'
        },
        {
          id: "queryable.vw_recent_sync_status",
          freshness_target: "15 minutes",
          source_tables: '["ga4_report_snapshot_fact"]'
        }
      ],
      providers: [{ provider: "google_analytics_4", as_of: "2026-07-10T11:00:00.000Z" }]
    });
    const freshness = await freshnessForViews(
      db,
      "ws1",
      ["queryable.vw_site_traffic", "queryable.vw_recent_sync_status"],
      NOW
    );
    // 1h old against a 15-minute target ⇒ stale, and the strict target is reported.
    expect(freshness).toEqual({
      target: "15 minutes",
      asOf: "2026-07-10T11:00:00.000Z",
      stale: true
    });
  });

  it("returns undefined for non-queryable provenance and on metadata failure", async () => {
    const db = metadataAndSourcesDb({ views: [], providers: [] });
    expect(await freshnessForViews(db, "ws1", ["sources", "metric_definitions"], NOW)).toBeUndefined();
    const broken = fakeDb(() => {
      throw new Error("boom");
    });
    expect(
      await freshnessForViews(broken, "ws1", ["queryable.vw_site_traffic"], NOW)
    ).toBeUndefined();
  });

  it("falls back to the default 24-hour target when metadata has no usable target", async () => {
    const db = metadataAndSourcesDb({
      views: [
        {
          id: "queryable.vw_posthog_events",
          freshness_target: null,
          source_tables: '["posthog_event_truth"]'
        }
      ],
      providers: [{ provider: "posthog", as_of: "2026-07-10T11:00:00.000Z" }]
    });
    const freshness = await freshnessForViews(db, "ws1", ["queryable.vw_posthog_events"], NOW);
    expect(freshness).toEqual({
      target: "24 hours",
      asOf: "2026-07-10T11:00:00.000Z",
      stale: false
    });
  });
});
