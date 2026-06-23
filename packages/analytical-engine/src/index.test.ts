import { describe, expect, it, vi } from "vitest";
import {
  decryptCredentialPayload,
  encryptCredentialPayload,
  isEncryptedCredentialPayload
} from "@infinite-os/core";
import { type InfiniteOsDb } from "@infinite-os/db";
import { createInfiniteOsRegistry } from "@infinite-os/runtime";

import {
  aggregateExpression,
  analyticalBoot,
  caveatsForMetric,
  connectedSourceFromEnvelope,
  createActionHandlers,
  derivePriorRange,
  metricColumn,
  metricView,
  metricViewForGrain,
  queryabilityStatusFromSourceVerification,
  queuedSourceSyncFromEnvelope,
  requiresResultTypePartition,
  unsupportedReason
} from "./index.js";

describe("analytical engine smoke", () => {
  it("exports the analytical boot marker", () => {
    expect(analyticalBoot).toBe(true);
  });

  // DEDUP single-source-of-truth: apps/worker imports these four functions instead of
  // duplicating them. This test pins the public surface so an accidental un-export
  // (which would silently break the worker's saved-report routing) fails here.
  it("exports the metric-routing functions consumed by apps/worker", () => {
    expect(typeof metricView).toBe("function");
    expect(typeof metricColumn).toBe("function");
    expect(typeof aggregateExpression).toBe("function");
    expect(typeof caveatsForMetric).toBe("function");
    // Behavior the worker relies on for GA4 traffic metrics.
    expect(metricView("page_views")).toBe("queryable.vw_site_traffic");
    expect(metricColumn("page_views")).toBe("page_views");
    expect(aggregateExpression("page_views", metricColumn("page_views"))).toBe("sum(page_views)");
    expect(aggregateExpression("engagement_rate", metricColumn("engagement_rate"))).toBe(
      "case when sum(sessions) = 0 then null else sum(engagement_rate * sessions) / sum(sessions) end"
    );
  });

  describe("Meta Ads queryable metrics (Phase 0)", () => {
    it("routes impressions/reach/cpm/cpc/ctr to vw_meta_ads_campaign_daily", () => {
      for (const metric of ["impressions", "reach", "cpm", "cpc", "ctr"]) {
        expect(metricView(metric)).toBe("queryable.vw_meta_ads_campaign_daily");
      }
      // spend/clicks unchanged.
      expect(metricView("meta_ads_spend")).toBe("queryable.vw_meta_ads_campaign_daily");
      expect(metricView("meta_ads_clicks")).toBe("queryable.vw_meta_ads_campaign_daily");
    });

    it("sums the additive Meta metrics (impressions, reach)", () => {
      expect(aggregateExpression("impressions", metricColumn("impressions"))).toBe("sum(impressions)");
      expect(aggregateExpression("reach", metricColumn("reach"))).toBe("sum(reach)");
    });

    it("RECOMPUTES cpm/cpc/ctr from summed bases — never avg(per-row ratio)", () => {
      // LOAD-BEARING: these MUST divide summed numerator by summed denominator. If anyone
      // reverts to avg(cpm)/avg(cpc)/avg(ctr) (per-row ratio averaging) these assertions fail.
      const cpm = aggregateExpression("cpm", metricColumn("cpm"));
      expect(cpm).toBe("sum(meta_ads_spend) / nullif(sum(impressions), 0) * 1000");
      expect(cpm).not.toContain("avg(");

      const cpc = aggregateExpression("cpc", metricColumn("cpc"));
      expect(cpc).toBe("sum(meta_ads_spend) / nullif(sum(meta_ads_clicks), 0)");
      expect(cpc).not.toContain("avg(");

      const ctr = aggregateExpression("ctr", metricColumn("ctr"));
      expect(ctr).toBe("sum(meta_ads_clicks) / nullif(sum(impressions), 0)");
      expect(ctr).not.toContain("avg(");
    });

    it("flags reach as APPROXIMATE and keeps the read-only marketing-api caveat on all 5", () => {
      expect(caveatsForMetric("reach")).toContain(
        "reach_is_approximate_summed_daily_reach_overcounts_unique_people"
      );
      for (const metric of ["impressions", "reach", "cpm", "cpc", "ctr"]) {
        expect(caveatsForMetric(metric)).toContain("read_only_marketing_api_reporting");
      }
      // impressions is exact (additive) — must NOT carry the reach approximation flag.
      expect(caveatsForMetric("impressions")).not.toContain(
        "reach_is_approximate_summed_daily_reach_overcounts_unique_people"
      );
    });
  });

  // §9 — Phase-1 Meta conversions/value metrics read-path. These pin the load-bearing
  // invariants: (1) the conversion-family ratios are RECOMPUTED from summed bases (never
  // avg-of-per-row-ratios) — a revert is unrepresentable and throws; (2) result_type is a
  // REQUIRED partition — a query blending CPL+CPA across result_types is REFUSED, not
  // silently averaged; (3) roas/value carry the account-currency caveat; (4) link_clicks/
  // landing_page_views/frequency route + aggregate correctly.
  describe("Meta Ads conversions/value metrics (Phase 1 §6)", () => {
    const ctx = {
      workspaceId: "workspace",
      authority: "tool_agent" as const,
      surface: "mcp" as const,
      actorId: "founder",
      sessionId: "session"
    };

    it("routes the conversion-family metrics to the typed conversions view", () => {
      for (const metric of ["results", "cost_per_result", "conversion_value", "roas"]) {
        expect(metricView(metric)).toBe("queryable.vw_meta_ads_campaign_conversions_daily");
      }
      // link_clicks / landing_page_views / frequency are delivery-fact metrics.
      for (const metric of ["link_clicks", "landing_page_views", "frequency"]) {
        expect(metricView(metric)).toBe("queryable.vw_meta_ads_campaign_daily");
      }
      // roas_from_stripe is the §5 join view.
      expect(metricView("roas_from_stripe")).toBe("queryable.vw_meta_stripe_campaign_value_daily");
    });

    it("sums the additive conversion metrics (results, conversion_value, link_clicks, landing_page_views)", () => {
      expect(aggregateExpression("results", metricColumn("results"))).toBe("sum(results)");
      expect(aggregateExpression("conversion_value", metricColumn("conversion_value"))).toBe(
        "sum(conversion_value)"
      );
      expect(aggregateExpression("link_clicks", metricColumn("link_clicks"))).toBe("sum(link_clicks)");
      expect(aggregateExpression("landing_page_views", metricColumn("landing_page_views"))).toBe(
        "sum(landing_page_views)"
      );
    });

    it("RECOMPUTES cost_per_result / roas / frequency from summed bases — never avg(per-row ratio)", () => {
      // LOAD-BEARING (§9): a revert to avg(cost_per_result)/avg(roas)/avg(frequency) — i.e.
      // averaging per-row ratios — fails these. cost_per_result = spend/results,
      // roas = value/spend, frequency = impressions/reach, each divide summed numerator by
      // summed denominator with a nullif divide-by-zero guard.
      const cpr = aggregateExpression("cost_per_result", metricColumn("cost_per_result"));
      expect(cpr).toBe("sum(meta_ads_spend) / nullif(sum(results), 0)");
      expect(cpr).not.toContain("avg(");

      const roas = aggregateExpression("roas", metricColumn("roas"));
      expect(roas).toBe("sum(conversion_value) / nullif(sum(meta_ads_spend), 0)");
      expect(roas).not.toContain("avg(");

      const freq = aggregateExpression("frequency", metricColumn("frequency"));
      expect(freq).toBe("sum(impressions) / nullif(sum(reach), 0)");
      expect(freq).not.toContain("avg(");

      const stripeRoas = aggregateExpression("roas_from_stripe", metricColumn("roas_from_stripe"));
      expect(stripeRoas).toBe("sum(matched_revenue_major) / nullif(sum(matched_spend_major), 0)");
      expect(stripeRoas).not.toContain("avg(");
    });

    it("END-TO-END: a multi-result_type fixture proves cost_per_result is per-type, NOT a blended average", async () => {
      // Two result_types for one campaign-day with sharply different cost-per-result so a
      // blended (avg) number is unmistakably wrong:
      //   lead:     spend 600, results 60  -> CPL = 10
      //   purchase: spend 400, results  8  -> CPA = 50
      // A WRONG cross-type blend would be sum(spend)/sum(results) = 1000/68 ≈ 14.7, or the
      // avg-of-per-row-ratios (10+50)/2 = 30 — BOTH meaningless. The required-partition guard
      // forces a per-result_type group-by, so each type keeps its own correct ratio.
      const perType: Record<string, { spend: number; results: number }> = {
        lead: { spend: 600, results: 60 },
        purchase: { spend: 400, results: 8 }
      };
      const blendFakeDb = (): InfiniteOsDb => ({
        async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
          if (sql.includes("from queryable.vw_meta_ads_campaign_conversions_daily")) {
            // The emitted SQL groups by result_type (the REQUIRED partition) and computes
            // cost_per_result as the recompute-from-summed-bases expression WITHIN each
            // partition. Both must be present, and the expression must NOT be an avg/blend.
            expect(sql).toContain("group by");
            expect(sql).toContain("result_type");
            expect(sql).toContain("sum(meta_ads_spend) / nullif(sum(results), 0) as cost_per_result");
            expect(sql).not.toContain("avg(");
            return Object.entries(perType).map(([result_type, b]) => ({
              result_type,
              cost_per_result: b.spend / b.results
            })) as T[];
          }
          return [] as T[];
        },
        async one() {
          return null;
        },
        async close() {},
        async ensureWorkspace() {},
        async ensureFirstPhaseDatasets() {},
        async connectSource() {
          return null as never;
        },
        async updateSourceStatus() {},
        async createJob() {
          return {};
        },
        async claimNextJob() {
          return null;
        },
        async completeJob() {},
        async withTransaction(fn) {
          return fn(this);
        }
      });
      const registry = createInfiniteOsRegistry(createActionHandlers(blendFakeDb()));
      const result = await registry.execute(
        "run_breakdown_query",
        { metric: "cost_per_result", groupBy: ["result_type"] },
        ctx
      );
      expect(result.status).toBe("ok");
      const rows = (result.data as { rows: Array<{ result_type: string; cost_per_result: number }> }).rows;
      const byType = new Map(rows.map((row) => [row.result_type, row.cost_per_result]));
      // Each result_type keeps its OWN cost-per-result; they are never blended.
      expect(byType.get("lead")).toBeCloseTo(10, 9); // CPL
      expect(byType.get("purchase")).toBeCloseTo(50, 9); // CPA
      // Guard the guard: neither the cross-type blend (≈14.7) nor the avg-of-ratios (30)
      // appears as a row value.
      for (const value of byType.values()) {
        expect(Math.abs(value - 1000 / 68)).toBeGreaterThan(1e-6);
        expect(Math.abs(value - 30)).toBeGreaterThan(1e-6);
      }
    });

    it("REFUSES to aggregate cost_per_result/roas/results/conversion_value across mixed result_types", async () => {
      // §6: result_type is a REQUIRED partition. An ungrouped run_metric_query over a
      // conversion-family metric (which would blend CPL+CPA into one number) MUST be refused.
      const noopDb = (): InfiniteOsDb => ({
        async query() {
          // Should never be reached — the partition guard throws before any SQL runs.
          throw new Error("query_should_not_run_when_partition_is_missing");
        },
        async one() {
          return null;
        },
        async close() {},
        async ensureWorkspace() {},
        async ensureFirstPhaseDatasets() {},
        async connectSource() {
          return null as never;
        },
        async updateSourceStatus() {},
        async createJob() {
          return {};
        },
        async claimNextJob() {
          return null;
        },
        async completeJob() {},
        async withTransaction(fn) {
          return fn(this);
        }
      });
      const registry = createInfiniteOsRegistry(createActionHandlers(noopDb()));
      for (const metric of ["cost_per_result", "roas", "results", "conversion_value"] as const) {
        // Ungrouped run_metric_query — no result_type partition -> refused.
        await expect(
          registry.execute("run_metric_query", { metric }, ctx)
        ).rejects.toThrow(/unsupported_partition:result_type_required/);
        // A breakdown that groups by a DIFFERENT dimension (campaign_id) but NOT result_type
        // is still a cross-type blend within each campaign -> also refused.
        await expect(
          registry.execute("run_breakdown_query", { metric, groupBy: ["campaign_id"] }, ctx)
        ).rejects.toThrow(/unsupported_partition:result_type_required/);
      }
    });

    it("ALLOWS a conversion-family query when result_type is pinned to a single value", async () => {
      // The partition is satisfied either by grouping BY result_type OR by filtering to ONE
      // result_type (no blending possible). This proves the guard is not over-broad.
      const pinnedDb = (): InfiniteOsDb => ({
        async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
          if (sql.includes("from queryable.vw_meta_ads_campaign_conversions_daily")) {
            return [{ cost_per_result: 10 }] as T[];
          }
          return [] as T[];
        },
        async one() {
          return null;
        },
        async close() {},
        async ensureWorkspace() {},
        async ensureFirstPhaseDatasets() {},
        async connectSource() {
          return null as never;
        },
        async updateSourceStatus() {},
        async createJob() {
          return {};
        },
        async claimNextJob() {
          return null;
        },
        async completeJob() {},
        async withTransaction(fn) {
          return fn(this);
        }
      });
      const registry = createInfiniteOsRegistry(createActionHandlers(pinnedDb()));
      const result = await registry.execute(
        "run_metric_query",
        { metric: "cost_per_result", filters: [{ field: "result_type", operator: "equals", value: "lead" }] },
        ctx
      );
      expect(result.status).toBe("ok");
      const rows = (result.data as { rows: Array<{ cost_per_result: number }> }).rows;
      expect(rows[0]?.cost_per_result).toBeCloseTo(10, 9);
    });

    it("requiresResultTypePartition() flags exactly the conversion-family metrics", () => {
      for (const metric of ["results", "cost_per_result", "conversion_value", "roas"]) {
        expect(requiresResultTypePartition(metric)).toBe(true);
      }
      // Delivery-fact + non-conversion metrics are NOT partition-gated.
      for (const metric of [
        "link_clicks",
        "landing_page_views",
        "frequency",
        "meta_ads_spend",
        "impressions",
        "roas_from_stripe"
      ]) {
        expect(requiresResultTypePartition(metric)).toBe(false);
      }
    });

    it("attaches the account-currency + no-blend caveats to value/ratio metrics", () => {
      expect(caveatsForMetric("cost_per_result")).toEqual(
        expect.arrayContaining([
          "cost_per_result_must_not_blend_across_result_types",
          "value_in_account_currency",
          "ratio_recomputed_from_summed_bases"
        ])
      );
      expect(caveatsForMetric("roas")).toEqual(
        expect.arrayContaining([
          "value_in_account_currency",
          "roas_null_for_lead_gen_browser_attributed_floor",
          "cost_per_result_must_not_blend_across_result_types"
        ])
      );
      expect(caveatsForMetric("conversion_value")).toEqual(
        expect.arrayContaining(["conversion_value_purchase_only", "value_in_account_currency"])
      );
      // landing_page_views is the non-omni action.
      expect(caveatsForMetric("landing_page_views")).toContain("landing_page_views_non_omni");
      // frequency inherits reach's APPROXIMATE caveat.
      expect(caveatsForMetric("frequency")).toContain(
        "reach_is_approximate_summed_daily_reach_overcounts_unique_people"
      );
      // roas_from_stripe is mapping-dependent and currency-reconciled, and MUST carry the
      // loud source-level over-attribution + unmatched-revenue caveats (DEFECT 2): the map is
      // source-level so matched_revenue is an upper bound, and unmapped-source revenue surfaces
      // on campaign-NULL rows. Reverting either honesty caveat fails this assertion.
      expect(caveatsForMetric("roas_from_stripe")).toEqual(
        expect.arrayContaining([
          "stripe_attributed_roas_is_mapping_dependent",
          "excludes_unmatched_spend_and_unmatched_revenue",
          "unmatched_revenue_surfaced_on_campaign_null_rows",
          "stripe_revenue_is_source_level_may_over_attribute",
          "currency_reconciled_to_account_currency_before_dividing"
        ])
      );
    });
  });

  // FIX 2 — catalog regression guard. The 0029 migration SEEDS metric_definitions
  // rows for the 5 new Meta Ads metrics so describe_metric / list_metrics return
  // full authority+provenance metadata. This test proves those handlers return a
  // POPULATED row for EACH of the 5 — so the catalog gap (engine routed/aggregated
  // them but the DB catalog had no rows) can't silently recur.
  describe("metric_definitions catalog rows for the 5 new Meta Ads metrics (Phase 0)", () => {
    // Mirror what migration 0029 inserts — the rows the catalog must return.
    const seededRows: Record<string, Record<string, unknown>> = {
      impressions: {
        id: "impressions",
        name: "Meta Ads impressions",
        description: "Daily Meta Ads impressions from campaign insights",
        source_view: "queryable.vw_meta_ads_campaign_daily",
        metric_type: "count",
        aggregation: "sum",
        default_time_column: "occurred_on",
        allowed_dimensions: ["ad_account_id", "campaign_id", "campaign_name"],
        caveats: "read_only_marketing_api_reporting"
      },
      reach: {
        id: "reach",
        name: "Meta Ads reach (approximate)",
        description:
          "Daily Meta Ads reach summed across campaign×day. APPROXIMATE: summing daily reach overcounts unique people.",
        source_view: "queryable.vw_meta_ads_campaign_daily",
        metric_type: "count",
        aggregation: "sum",
        default_time_column: "occurred_on",
        allowed_dimensions: ["ad_account_id", "campaign_id", "campaign_name"],
        caveats:
          "read_only_marketing_api_reporting; reach_is_approximate_summed_daily_reach_overcounts_unique_people"
      },
      cpm: {
        id: "cpm",
        name: "Meta Ads CPM",
        description:
          "Meta Ads cost per 1,000 impressions, recomputed from summed bases: sum(meta_ads_spend)/nullif(sum(impressions),0)*1000.",
        source_view: "queryable.vw_meta_ads_campaign_daily",
        metric_type: "ratio",
        aggregation: "recomputed_ratio",
        default_time_column: "occurred_on",
        allowed_dimensions: ["ad_account_id", "campaign_id", "campaign_name"],
        caveats: "read_only_marketing_api_reporting; ratio_recomputed_from_summed_bases"
      },
      cpc: {
        id: "cpc",
        name: "Meta Ads CPC",
        description:
          "Meta Ads cost per click, recomputed from summed bases: sum(meta_ads_spend)/nullif(sum(meta_ads_clicks),0).",
        source_view: "queryable.vw_meta_ads_campaign_daily",
        metric_type: "ratio",
        aggregation: "recomputed_ratio",
        default_time_column: "occurred_on",
        allowed_dimensions: ["ad_account_id", "campaign_id", "campaign_name"],
        caveats: "read_only_marketing_api_reporting; ratio_recomputed_from_summed_bases"
      },
      ctr: {
        id: "ctr",
        name: "Meta Ads CTR",
        description:
          "Meta Ads click-through rate, recomputed from summed bases: sum(meta_ads_clicks)/nullif(sum(impressions),0).",
        source_view: "queryable.vw_meta_ads_campaign_daily",
        metric_type: "ratio",
        aggregation: "recomputed_ratio",
        default_time_column: "occurred_on",
        allowed_dimensions: ["ad_account_id", "campaign_id", "campaign_name"],
        caveats: "read_only_marketing_api_reporting; ratio_recomputed_from_summed_bases"
      }
    };

    function catalogFakeDb(): InfiniteOsDb {
      return {
        // list_metrics reads via query(); describe_metric reads via one().
        async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
          if (sql.includes("from metric_definitions")) {
            return Object.values(seededRows) as T[];
          }
          return [] as T[];
        },
        async one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
          if (sql.includes("from metric_definitions")) {
            const id = (params?.[0] as string) ?? "";
            return (seededRows[id] as T) ?? null;
          }
          return null;
        },
        async close() {},
        async ensureWorkspace() {},
        async ensureFirstPhaseDatasets() {},
        async connectSource() {
          return null as never;
        },
        async updateSourceStatus() {},
        async createJob() {
          return {};
        },
        async claimNextJob() {
          return null;
        },
        async completeJob() {},
        async withTransaction(fn) {
          return fn(this);
        }
      };
    }

    const ctx = {
      workspaceId: "workspace",
      authority: "tool_agent" as const,
      surface: "api" as const,
      actorId: "operator",
      sessionId: "session"
    };

    it("describe_metric returns a populated catalog row for EACH of the 5 new metrics", async () => {
      const handlers = createActionHandlers(catalogFakeDb());
      for (const metricId of ["impressions", "reach", "cpm", "cpc", "ctr"] as const) {
        const result = await handlers.describe_metric?.({ metricId }, ctx);
        expect(result?.status).not.toBe("unsupported");
        const metric = (result?.data as { metric: Record<string, unknown> }).metric;
        // Populated — not an empty {} (which hydrateMetricMetadata returns for a null row).
        expect(metric.id).toBe(metricId);
        expect(typeof metric.name).toBe("string");
        expect(metric.name).not.toBe("");
        expect(metric.description).toBeTruthy();
        expect(metric.source_view).toBe("queryable.vw_meta_ads_campaign_daily");
        // Authority/provenance metadata is present.
        expect(metric.caveats).toContain("read_only_marketing_api_reporting");
        // The catalog row is sourced from metric_definitions provenance.
        expect(result?.provenance).toContain("metric_definitions");
      }
    });

    it("ratio rows carry recompute provenance and reach is flagged approximate", async () => {
      const handlers = createActionHandlers(catalogFakeDb());
      for (const metricId of ["cpm", "cpc", "ctr"] as const) {
        const result = await handlers.describe_metric?.({ metricId }, ctx);
        const metric = (result?.data as { metric: Record<string, unknown> }).metric;
        expect(metric.caveats).toContain("ratio_recomputed_from_summed_bases");
        expect(metric.metric_type).toBe("ratio");
      }
      const reach = await handlers.describe_metric?.({ metricId: "reach" }, ctx);
      const reachMetric = (reach?.data as { metric: Record<string, unknown> }).metric;
      expect(reachMetric.caveats).toContain(
        "reach_is_approximate_summed_daily_reach_overcounts_unique_people"
      );
    });

    it("list_metrics includes a populated row for all 5 new metrics", async () => {
      const handlers = createActionHandlers(catalogFakeDb());
      const result = await handlers.list_metrics?.({}, ctx);
      const metrics = (result?.data as { metrics: Array<Record<string, unknown>> }).metrics;
      const byId = new Map(metrics.map((metric) => [metric.id as string, metric]));
      for (const metricId of ["impressions", "reach", "cpm", "cpc", "ctr"] as const) {
        const metric = byId.get(metricId);
        expect(metric, `list_metrics is missing catalog row for ${metricId}`).toBeTruthy();
        expect(metric?.source_view).toBe("queryable.vw_meta_ads_campaign_daily");
        expect(metric?.name).toBeTruthy();
      }
    });
  });

  it("does not export the deterministic question resolver as a public surface", async () => {
    const module = await import("./index.js");
    expect("resolveQuestion" in module).toBe(false);
  });

  it("does not resolve out-of-phase questions and classifies handoff reasons", () => {
    const cases = [
      ["What content drove the most traffic this week?", "content_linkage_not_implemented"],
      ["What's my most popular content this week?", "content_linkage_not_implemented"],
      ["Which posts led to revenue?", "content_linkage_not_implemented"],
      [
        "How do Meta Ads, Meta CAPI, and billing data compare for this campaign?",
        "attribution_model_not_implemented"
      ],
      [
        "Where is MRR growth coming from this month: new business, expansion, reactivation, or reduced churn?",
        "provider_not_in_first_phase"
      ],
      ["Which trials look likely to convert this week, and which ones are stalling?", "attribution_model_not_implemented"],
      ["Which paid campaigns are paying back fast enough by channel and segment?", "attribution_model_not_implemented"],
      ["Which customer segments have the best 90-day retention?", "provider_not_in_first_phase"],
      ["How much did Shopify gross this week?", "content_linkage_not_implemented"],
      [
        "Where are users dropping off between visit, signup, checkout, and purchase?",
        "attribution_model_not_implemented"
      ]
    ] as const;

    for (const [question, reason] of cases) {
      expect(unsupportedReason(question)).toBe(reason);
    }
  });

  it("runs an end-to-end Meta journey query through the action registry", async () => {
    const registry = createInfiniteOsRegistry(createActionHandlers(journeyTestDb()));
    const context = {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "mcp",
      actorId: "founder",
      sessionId: "session"
    } as const;
    const plan = {
      intent: "rank_entities_by_outcome",
      actor: { grain: "person" },
      journeyTemplateId: "touchpoint_to_paid_conversion",
      entity: { type: "campaign" },
      outcome: { id: "meta_ads_clicks", window: "30d" },
      timeRange: { start: "2026-05-01", end: "2026-06-07" },
      ranking: { metric: "meta_ads_clicks", direction: "desc" },
      limit: 2
    };

    const search = await registry.execute(
      "search_context",
      { query: "Meta campaign performance", kinds: ["metric", "source", "journey_template"], limit: 5 },
      context
    );
    const resolved = await registry.execute(
      "resolve_entity",
      { entityType: "campaign", query: "launch" },
      context
    );
    const validation = await registry.execute(
      "validate_journey_plan",
      { plan },
      context
    );
    const result = await registry.execute(
      "run_journey_query",
      { plan, validationId: "validation_meta", limit: 2 },
      context
    );

    expect(search.status).toBe("ok");
    expect(JSON.stringify(search.data)).toContain("meta_ads_clicks");
    expect(resolved.status).toBe("resolved");
    expect(resolved.data).toMatchObject({
      candidates: expect.arrayContaining([expect.objectContaining({ entityType: "campaign" })])
    });
    expect(validation.status).toBe("ok");
    expect(result.status).toBe("resolved");
    expect(result.data).toMatchObject({
      answer: expect.stringContaining("Meta Ads"),
      rows: expect.arrayContaining([
        expect.objectContaining({
          campaign_id: "cmp_launch",
          meta_ads_clicks: "42"
        })
      ])
    });
    expect(result.evidence?.[0]).toMatchObject({
      id: "evidence:journey:meta_ads_clicks:campaign",
      kind: "query_result"
    });
  });

  it("resolve_entity falls back to tokenized near-candidates when the exact substring misses", async () => {
    // Fake db that HONORS the ilike substring pass (which the real SQL does) so the relaxed
    // second pass is observable: the exact `%sales campaign%` substring matches no campaign_name,
    // but tokenizing to "sales" (campaign is a stop-word) surfaces "Sales — Summer Sale".
    const campaigns = [
      { source_id: "src_meta", campaign_id: "cmp_summer", campaign_name: "Sales — Summer Sale" },
      { source_id: "src_meta", campaign_id: "cmp_brand", campaign_name: "Brand Awareness" }
    ];
    const fakeDb = {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        if (sql.includes("from queryable.vw_meta_ads_campaign_daily")) {
          // params: [workspaceId, ...%token% patterns, limit]. Emulate the OR-of-ilike WHERE.
          const patterns = params
            .slice(1, -1)
            .map((value) => String(value).replace(/%/g, "").toLowerCase());
          const matched = campaigns.filter((campaign) =>
            patterns.some(
              (pattern) =>
                campaign.campaign_id.toLowerCase().includes(pattern) ||
                campaign.campaign_name.toLowerCase().includes(pattern)
            )
          );
          return matched.map((campaign) => ({
            ...campaign,
            meta_ads_clicks: "10",
            meta_ads_spend: "5",
            impressions: "100",
            last_seen_on: "2026-06-07"
          })) as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn: (db: InfiniteOsDb) => unknown) {
        return fn(this as unknown as InfiniteOsDb);
      }
    } as unknown as InfiniteOsDb;

    const registry = createInfiniteOsRegistry(createActionHandlers(fakeDb));
    const context = {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "mcp",
      actorId: "founder",
      sessionId: "session"
    } as const;

    const resolved = await registry.execute(
      "resolve_entity",
      { entityType: "campaign", query: "sales campaign" },
      context
    );

    expect(resolved.status).toBe("resolved");
    expect(resolved.data).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({ entityType: "campaign", label: "Sales — Summer Sale" })
      ])
    });
    // The stop-word-only / unrelated campaign must NOT be dragged in by the relaxed pass.
    const labels = (resolved.data as { candidates: Array<{ label: string }> }).candidates.map(
      (candidate) => candidate.label
    );
    expect(labels).not.toContain("Brand Awareness");
  });

  it("resolve_entity returns no candidates when even the relaxed token pass misses", async () => {
    const fakeDb = {
      async query<T = Record<string, unknown>>(): Promise<T[]> {
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn: (db: InfiniteOsDb) => unknown) {
        return fn(this as unknown as InfiniteOsDb);
      }
    } as unknown as InfiniteOsDb;

    const registry = createInfiniteOsRegistry(createActionHandlers(fakeDb));
    const context = {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "mcp",
      actorId: "founder",
      sessionId: "session"
    } as const;

    const resolved = await registry.execute(
      "resolve_entity",
      { entityType: "campaign", query: "nonexistent campaign" },
      context
    );

    expect(resolved.status).toBe("needs_clarification");
    expect(resolved.caveats).toContain("no_matching_entity");
  });

  // Slice 1b §7 — resolve_entity by name at the new adset/ad grains. The dispatch must route
  // entityType "adset" → vw_meta_ads_adset_daily and "ad" → vw_meta_ads_ad_daily, mirror the
  // campaign resolver's exact-then-tokenized passes, carry the parent ids (campaign/adset), and
  // tolerate an ORPHAN ad (null adset_id). The same enum split must keep run_journey_query
  // REJECTING adset/ad so the journey surface never widens.
  describe("resolve_entity at adset/ad grain (slice 1b §7)", () => {
    // A fake db that emulates the OR-of-ilike WHERE for BOTH the adset and ad views, so both the
    // exact `%query%` pass and the relaxed tokenized fallback are observable per grain.
    const adsetFixture = [
      {
        source_id: "src_meta",
        campaign_id: "cmp_launch",
        adset_id: "ads_video",
        adset_name: "Video — Broad",
        meta_ads_clicks: "30",
        meta_ads_spend: "12",
        impressions: "900",
        last_seen_on: "2026-06-07"
      },
      {
        source_id: "src_meta",
        campaign_id: "cmp_launch",
        adset_id: "ads_retarget",
        adset_name: "Retargeting — 30d",
        meta_ads_clicks: "10",
        meta_ads_spend: "4",
        impressions: "200",
        last_seen_on: "2026-06-06"
      }
    ];
    const adFixture = [
      {
        source_id: "src_meta",
        campaign_id: "cmp_launch",
        adset_id: "ads_video",
        ad_id: "ad_hero",
        ad_name: "Hero Reel v3",
        meta_ads_clicks: "20",
        meta_ads_spend: "8",
        impressions: "600",
        last_seen_on: "2026-06-07"
      },
      {
        // Orphan ad — no parent adset (null adset_id). Must resolve without failing (§7a).
        source_id: "src_meta",
        campaign_id: "cmp_launch",
        adset_id: null,
        ad_id: "ad_orphan",
        ad_name: "Hero Static",
        meta_ads_clicks: "5",
        meta_ads_spend: "2",
        impressions: "120",
        last_seen_on: "2026-06-05"
      }
    ];
    const matchView = (
      sql: string,
      params: unknown[],
      view: string,
      fixture: Array<Record<string, unknown>>,
      idKey: string,
      nameKey: string
    ): Record<string, unknown>[] | null => {
      if (!sql.includes(`from queryable.${view}`)) {
        return null;
      }
      const patterns = params
        .slice(1, -1)
        .map((value) => String(value).replace(/%/g, "").toLowerCase());
      return fixture.filter((row) =>
        patterns.some(
          (pattern) =>
            String(row[idKey] ?? "").toLowerCase().includes(pattern) ||
            String(row[nameKey] ?? "").toLowerCase().includes(pattern)
        )
      );
    };
    const makeFakeDb = () =>
      ({
        async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
          const adset = matchView(
            sql,
            params,
            "vw_meta_ads_adset_daily",
            adsetFixture,
            "adset_id",
            "adset_name"
          );
          if (adset) return adset as T[];
          const ad = matchView(sql, params, "vw_meta_ads_ad_daily", adFixture, "ad_id", "ad_name");
          if (ad) return ad as T[];
          return [] as T[];
        },
        async one() {
          return null;
        },
        async close() {},
        async ensureWorkspace() {},
        async ensureFirstPhaseDatasets() {},
        async connectSource() {
          return null as never;
        },
        async updateSourceStatus() {},
        async createJob() {
          return {};
        },
        async claimNextJob() {
          return null;
        },
        async completeJob() {},
        async withTransaction(fn: (db: InfiniteOsDb) => unknown) {
          return fn(this as unknown as InfiniteOsDb);
        }
      }) as unknown as InfiniteOsDb;
    const context = {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "mcp",
      actorId: "founder",
      sessionId: "session"
    } as const;

    it("resolves an adset by exact name and carries its campaign id", async () => {
      const registry = createInfiniteOsRegistry(createActionHandlers(makeFakeDb()));
      const resolved = await registry.execute(
        "resolve_entity",
        { entityType: "adset", query: "Video" },
        context
      );
      expect(resolved.status).toBe("resolved");
      expect(resolved.provenance).toContain("queryable.vw_meta_ads_adset_daily");
      expect(resolved.data).toMatchObject({
        candidates: expect.arrayContaining([
          expect.objectContaining({
            entityType: "adset",
            entityKey: "ads_video",
            label: "Video — Broad",
            campaignId: "cmp_launch"
          })
        ])
      });
    });

    it("resolves an ad by exact name, carrying adset + campaign ids", async () => {
      const registry = createInfiniteOsRegistry(createActionHandlers(makeFakeDb()));
      const resolved = await registry.execute(
        "resolve_entity",
        { entityType: "ad", query: "Hero Reel" },
        context
      );
      expect(resolved.status).toBe("resolved");
      expect(resolved.provenance).toContain("queryable.vw_meta_ads_ad_daily");
      expect(resolved.data).toMatchObject({
        candidates: expect.arrayContaining([
          expect.objectContaining({
            entityType: "ad",
            entityKey: "ad_hero",
            label: "Hero Reel v3",
            adsetId: "ads_video",
            campaignId: "cmp_launch"
          })
        ])
      });
    });

    it("resolves an ORPHAN ad (null adset_id) without failing (§7a)", async () => {
      const registry = createInfiniteOsRegistry(createActionHandlers(makeFakeDb()));
      const resolved = await registry.execute(
        "resolve_entity",
        { entityType: "ad", query: "Hero Static" },
        context
      );
      expect(resolved.status).toBe("resolved");
      const candidate = (resolved.data as { candidates: Array<Record<string, unknown>> })
        .candidates.find((row) => row.entityKey === "ad_orphan");
      expect(candidate).toBeDefined();
      // adset_id is a carry, NOT a grain signal: a null parent surfaces as null, not an error.
      expect(candidate?.adsetId).toBeNull();
      expect(candidate?.campaignId).toBe("cmp_launch");
    });

    it("falls back to tokenized near-candidates at ad grain", async () => {
      const registry = createInfiniteOsRegistry(createActionHandlers(makeFakeDb()));
      // Exact "%hero ad%" misses (no ad name contains that substring); tokenizing drops the
      // "ad" stop-word and ORs "hero", surfacing both Hero ads.
      const resolved = await registry.execute(
        "resolve_entity",
        { entityType: "ad", query: "hero ad" },
        context
      );
      expect(resolved.status).toBe("resolved");
      const labels = (resolved.data as { candidates: Array<{ label: string }> }).candidates.map(
        (candidate) => candidate.label
      );
      expect(labels).toEqual(expect.arrayContaining(["Hero Reel v3", "Hero Static"]));
    });

    it("returns needs_clarification when no adset/ad matches", async () => {
      const registry = createInfiniteOsRegistry(createActionHandlers(makeFakeDb()));
      const resolved = await registry.execute(
        "resolve_entity",
        { entityType: "ad", query: "nonexistent creative xyz" },
        context
      );
      expect(resolved.status).toBe("needs_clarification");
      expect(resolved.caveats).toContain("no_matching_entity");
    });

    it("run_journey_query schema still REJECTS adset/ad (the enum split held)", () => {
      // The journey-plan schema (shared by validate_journey_plan AND run_journey_query) stays
      // bound to JOURNEY_ENTITY_TYPES, so the entity.type enum admits campaign but NOT adset/ad.
      // resolve_entity widened to RESOLVABLE_ENTITY_TYPES; the journey surface did not.
      const registry = createInfiniteOsRegistry(createActionHandlers(makeFakeDb()));
      const runJourneySchema = registry.get("run_journey_query")
        ?.inputSchema as Record<string, any>;
      const journeyEntityEnum =
        runJourneySchema.properties.plan.properties.entity.properties.type.enum as string[];
      expect(journeyEntityEnum).toContain("campaign");
      expect(journeyEntityEnum).not.toContain("adset");
      expect(journeyEntityEnum).not.toContain("ad");

      // And the resolve_entity schema DID widen — the two surfaces are decoupled.
      const resolveSchema = registry.get("resolve_entity")?.inputSchema as Record<string, any>;
      expect(resolveSchema.properties.entityType.enum).toEqual(
        expect.arrayContaining(["adset", "ad"])
      );
    });

    it("run_journey_query with an adset/ad entity.type compiles to an unsupported envelope (not a campaign roll-up)", async () => {
      // Defense-in-depth: even if a hand-built plan smuggles entity.type "ad" past the schema, the
      // engine's compileJourneyPlan has no ad/adset branch, so it returns an `unsupported` envelope
      // rather than silently rolling the ad up into a campaign journey. (Uses a non-meta metric so
      // the metric-based campaign fallback in compileJourneyPlan does not fire.)
      const registry = createInfiniteOsRegistry(createActionHandlers(makeFakeDb()));
      const plan = {
        intent: "rank_entities_by_outcome",
        actor: { grain: "account" },
        journeyTemplateId: "meta_ads_basic",
        entity: { type: "ad" },
        ranking: { metric: "roas" },
        timeRange: { start: "2026-06-01", end: "2026-06-07" }
      };
      const result = await registry.execute(
        "run_journey_query",
        { plan, validationId: "v", limit: 2 },
        context
      );
      expect(result.status).toBe("unsupported");
      expect(result.caveats).toContain("journey_template_not_supported");
    });
  });

  // FIX 5 — journey-path recompute guard, mirroring the run_metric_query Phase-0 test.
  // metaCampaignJourneyRows() emits cpm/cpc/ctr in its SELECT. They MUST be recomputed
  // from summed bases (the same expressions aggregateExpression() uses), never avg(cpm)/
  // avg(cpc)/avg(ctr). This fake-db EVALUATES the emitted SELECT over a multi-day fixture
  // where avg-of-per-row-ratios differs sharply from the recomputed ratio. A revert to
  // avg() yields an UNRECOGNIZED SELECT expression here and THROWS — so the test fails.
  describe("journey path recomputes cpm/cpc/ctr from summed bases (Phase 0)", () => {
    // Two campaign×day rows for one campaign — bases chosen so sum-then-divide differs
    // sharply from avg-of-per-row-ratios:
    //   day1: spend 100, clicks 10,  impressions 1000, reach 3000
    //   day2: spend  20, clicks 80,  impressions 9000, reach 2000
    // Recomputed (correct) totals over sums:
    //   sum spend 120, sum clicks 90, sum impressions 10000, sum reach 5000
    //   cpm = 120 / 10000 * 1000 = 12 ; cpc = 120 / 90 = 1.3333... ; ctr = 90 / 10000 = 0.009
    const fixture = [
      { spend: 100, clicks: 10, impressions: 1000, reach: 3000, cpm: 100, cpc: 10, ctr: 0.01 },
      { spend: 20, clicks: 80, impressions: 9000, reach: 2000, cpm: 2.222, cpc: 0.25, ctr: 0.0088888 }
    ];
    const sums = {
      spend: fixture.reduce((acc, row) => acc + row.spend, 0),
      clicks: fixture.reduce((acc, row) => acc + row.clicks, 0),
      impressions: fixture.reduce((acc, row) => acc + row.impressions, 0),
      reach: fixture.reduce((acc, row) => acc + row.reach, 0)
    };
    const recomputed = {
      cpm: (sums.spend / sums.impressions) * 1000, // 12
      cpc: sums.spend / sums.clicks, // 1.3333...
      ctr: sums.clicks / sums.impressions // 0.009
    };
    const avgPerRow = {
      cpm: (fixture[0]!.cpm + fixture[1]!.cpm) / 2,
      cpc: (fixture[0]!.cpc + fixture[1]!.cpc) / 2,
      ctr: (fixture[0]!.ctr + fixture[1]!.ctr) / 2
    };

    // Resolve the SELECT expression for a given output alias in the journey SQL, then
    // evaluate it over the summed fixture. ONLY the exact recompute expressions Change 1
    // emits are recognized — a revert to avg(cpm)/avg(cpc)/avg(ctr) is unrecognized and
    // throws, so a wrong SQL can never silently pass by returning a coincidental number.
    function evalSelect(sql: string, alias: string): number {
      // Each journey measure is on its own SELECT line: "<expr> as <alias>[,]". Match the
      // line so internal commas (e.g. nullif(sum(impressions), 0)) stay inside <expr>.
      const re = new RegExp(`(?:^|\\n)\\s*(.+?)\\s+as\\s+${alias}\\s*,?\\s*(?=\\n)`);
      const expr = sql.match(re)?.[1]?.trim() ?? "";
      switch (expr) {
        case "sum(meta_ads_clicks)":
          return sums.clicks;
        case "sum(meta_ads_spend)":
          return sums.spend;
        case "sum(impressions)":
          return sums.impressions;
        case "sum(reach)":
          return sums.reach;
        case "sum(meta_ads_spend) / nullif(sum(impressions), 0) * 1000":
          return (sums.spend / sums.impressions) * 1000;
        case "sum(meta_ads_spend) / nullif(sum(meta_ads_clicks), 0)":
          return sums.spend / sums.clicks;
        case "sum(meta_ads_clicks) / nullif(sum(impressions), 0)":
          return sums.clicks / sums.impressions;
        default:
          throw new Error(`unexpected_journey_select_for_${alias}:${expr}`);
      }
    }

    function journeyRecomputeFakeDb(): InfiniteOsDb {
      return {
        async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
          if (sql.includes("from sources")) {
            return [
              { id: "src_meta", provider: "meta_ads", connection_name: "Meta Ads", status: "connected", last_synced_at: "2026-06-07T00:00:00.000Z" }
            ] as T[];
          }
          if (sql.includes("from metric_definitions")) {
            return [
              { id: "meta_ads_clicks", name: "Meta Ads clicks", source_view: "queryable.vw_meta_ads_campaign_daily", description: "Daily Meta Ads clicks" }
            ] as T[];
          }
          if (sql.includes("from queryable.vw_meta_ads_campaign_daily")) {
            // Evaluate the emitted journey aggregate SELECT for the single fixture campaign.
            return [
              {
                source_id: "src_meta",
                campaign_id: "cmp_launch",
                campaign_name: "Launch Demo Requests",
                first_seen_on: "2026-06-01",
                last_seen_on: "2026-06-02",
                meta_ads_clicks: evalSelect(sql, "meta_ads_clicks"),
                meta_ads_spend: evalSelect(sql, "meta_ads_spend"),
                impressions: evalSelect(sql, "impressions"),
                reach: evalSelect(sql, "reach"),
                cpm: evalSelect(sql, "cpm"),
                cpc: evalSelect(sql, "cpc"),
                ctr: evalSelect(sql, "ctr")
              }
            ] as T[];
          }
          return [] as T[];
        },
        async one() {
          return null;
        },
        async close() {},
        async ensureWorkspace() {},
        async ensureFirstPhaseDatasets() {},
        async connectSource() {
          return null as never;
        },
        async updateSourceStatus() {},
        async createJob() {
          return {};
        },
        async claimNextJob() {
          return null;
        },
        async completeJob() {},
        async withTransaction(fn) {
          return fn(this);
        }
      };
    }

    const context = {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "mcp",
      actorId: "founder",
      sessionId: "session"
    } as const;

    it("returns recomputed cpm/cpc/ctr (NOT avg-of-ratios) and matches run_metric_query", async () => {
      // Sanity: the recomputed answer and the averaged answer are genuinely distinct, so
      // the equality assertions below actually reject the averaged value.
      for (const metric of ["cpm", "cpc", "ctr"] as const) {
        expect(Math.abs(recomputed[metric] - avgPerRow[metric])).toBeGreaterThan(1e-6);
      }

      const registry = createInfiniteOsRegistry(createActionHandlers(journeyRecomputeFakeDb()));
      const plan = {
        intent: "rank_entities_by_outcome",
        actor: { grain: "person" },
        journeyTemplateId: "touchpoint_to_paid_conversion",
        entity: { type: "campaign" },
        outcome: { id: "meta_ads_clicks", window: "30d" },
        timeRange: { start: "2026-06-01", end: "2026-06-02" },
        ranking: { metric: "ctr", direction: "desc" },
        limit: 5
      };

      const result = await registry.execute(
        "run_journey_query",
        { plan, validationId: "validation_meta_recompute", limit: 5 },
        context
      );

      expect(result.status).toBe("resolved");
      const rows = (result.data as { rows: Array<Record<string, number>> }).rows;
      const row = rows[0]!;
      // Journey path agrees with run_metric_query's recomputed-from-sums values.
      expect(row.cpm).toBeCloseTo(recomputed.cpm, 9);
      expect(row.cpc).toBeCloseTo(recomputed.cpc, 9);
      expect(row.ctr).toBeCloseTo(recomputed.ctr, 9);
      // Additive bases still sum.
      expect(row.impressions).toBe(sums.impressions);
      expect(row.reach).toBe(sums.reach);
      expect(row.meta_ads_clicks).toBe(sums.clicks);
      expect(row.meta_ads_spend).toBe(sums.spend);
      // Guard the guard: the recomputed value must NOT equal the averaged value.
      expect(Math.abs(row.cpm - avgPerRow.cpm)).toBeGreaterThan(1e-6);
      expect(Math.abs(row.cpc - avgPerRow.cpc)).toBeGreaterThan(1e-6);
      expect(Math.abs(row.ctr - avgPerRow.ctr)).toBeGreaterThan(1e-6);
    });
  });

  it("runs an end-to-end X content journey query with bounded post evidence", async () => {
    const registry = createInfiniteOsRegistry(createActionHandlers(journeyTestDb()));
    const context = {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "mcp",
      actorId: "founder",
      sessionId: "session"
    } as const;
    const plan = {
      intent: "rank_entities_by_outcome",
      actor: { grain: "person" },
      journeyTemplateId: "entity_to_downstream_outcome",
      entity: { type: "content_item" },
      outcome: { id: "x_public_engagement", window: "30d" },
      timeRange: { start: "2026-05-01", end: "2026-06-07" },
      ranking: { metric: "x_public_engagement", direction: "desc" },
      limit: 2
    };

    const result = await registry.execute(
      "run_journey_query",
      { plan, validationId: "validation_x", limit: 2 },
      context
    );

    expect(result.status).toBe("resolved");
    expect(result.data).toMatchObject({
      answer: expect.stringContaining("X"),
      rows: expect.arrayContaining([
        expect.objectContaining({
          x_post_id: "x_1",
          body_text: "Demo request launch thread",
          x_public_engagement: "80"
        })
      ])
    });
    expect(JSON.stringify(result.data)).not.toContain("secret");
  });

  it("fetches evidence and verifies claims from journey evidence handles", async () => {
    const registry = createInfiniteOsRegistry(createActionHandlers(journeyTestDb()));
    const context = {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "mcp",
      actorId: "founder",
      sessionId: "session"
    } as const;

    const evidence = await registry.execute(
      "fetch_evidence",
      { evidenceHandleId: "evidence:journey:meta_ads_clicks:campaign", limit: 2 },
      context
    );
    const verification = await registry.execute(
      "verify_claims",
      {
        claims: ["Meta campaign evidence is available"],
        evidenceHandleIds: ["evidence:journey:meta_ads_clicks:campaign"]
      },
      context
    );

    expect(evidence.status).toBe("ok");
    expect(evidence.data).toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({ campaign_id: "cmp_launch" })])
    });
    expect(verification.status).toBe("resolved");
    expect(verification.data).toMatchObject({
      claims: [
        {
          claim: "Meta campaign evidence is available",
          status: "verified"
        }
      ]
    });
  });

  it("stores live source credentials as encrypted envelopes and omits secrets from output", async () => {
    process.env.GROWTH_OS_ENCRYPTION_KEY = "analytical-test-encryption-key";
    const stored: { credential_kind?: string; encrypted_payload?: string } = {};
    // FIX 4: vi.stubGlobal/unstubAllGlobals — deterministic under parallel CI.
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ data: [], has_more: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })) as typeof fetch
    );
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("connection_credentials")) {
          return stored as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource(input) {
        stored.credential_kind = input.credentialKind;
        stored.encrypted_payload = input.encryptedPayload;
        return {
          id: "src_stripe_live",
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: input.accountExternalId,
          status: "connected"
        };
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    try {
      const handlers = createActionHandlers(db);
      const result = await handlers.connect_source?.(
        {
          provider: "stripe",
          connectionName: "Stripe Live",
          credentialPayload: {
            mode: "live",
            secretKey: "sk_test_secret",
            accountId: "acct_123",
            apiBaseUrl: "https://stripe.test"
          }
        },
        {
          workspaceId: "workspace",
          authority: "operator",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      );

      expect(stored.credential_kind).toBe("api_key");
      expect(isEncryptedCredentialPayload(String(stored.encrypted_payload))).toBe(true);
      expect(stored.encrypted_payload).not.toContain("sk_test_secret");
      expect(JSON.stringify(result)).not.toContain("sk_test_secret");
      expect(result?.data).toMatchObject({
        connectionTest: { ok: true, mode: "live", provider: "stripe" }
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("links OAuth sources to oauth_tokens and stores only non-secret metadata", async () => {
    process.env.GROWTH_OS_ENCRYPTION_KEY = "analytical-test-encryption-key";
    const stored: {
      credential_kind?: string;
      encrypted_payload?: string;
      oauth_token_id?: string | null;
    } = {};
    // FIX 4: vi.stubGlobal/unstubAllGlobals — deterministic under parallel CI.
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ rows: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })) as typeof fetch
    );
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("connection_credentials")) {
          return stored as T;
        }
        // The connector dual-reads oauth_tokens for the live token during the connection test.
        if (sql.includes("from oauth_tokens")) {
          return {
            encrypted_payload: encryptForTest({
              accessToken: "ga4-access-token",
              refreshToken: "ga4-refresh-token",
              expiresAt: new Date(Date.now() + 3600_000).toISOString()
            }),
            expires_at: new Date(Date.now() + 3600_000).toISOString()
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource(input) {
        stored.credential_kind = input.credentialKind;
        stored.encrypted_payload = input.encryptedPayload;
        stored.oauth_token_id = input.oauthTokenId ?? null;
        return {
          id: "src_ga4_live",
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: input.accountExternalId,
          status: "connected"
        };
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    try {
      const handlers = createActionHandlers(db);
      const result = await handlers.connect_source?.(
        {
          provider: "google_analytics_4",
          connectionName: "Google Analytics 4",
          oauthTokenId: "oauth_token_ga4",
          credentialPayload: {
            mode: "live",
            propertyId: "properties/555",
            accessToken: "ga4-access-token",
            refreshToken: "ga4-refresh-token",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            apiBaseUrl: "https://ga4.test"
          }
        },
        {
          workspaceId: "workspace",
          authority: "operator",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      );

      expect(stored.credential_kind).toBe("oauth_access_token");
      expect(stored.oauth_token_id).toBe("oauth_token_ga4");
      expect(isEncryptedCredentialPayload(String(stored.encrypted_payload))).toBe(true);
      // Tokens must NOT be copied into connection_credentials.
      expect(stored.encrypted_payload).not.toContain("ga4-access-token");
      expect(stored.encrypted_payload).not.toContain("ga4-refresh-token");
      const metadata = decryptCredentialPayload<Record<string, unknown>>(
        String(stored.encrypted_payload),
        "analytical-test-encryption-key"
      );
      expect(metadata).toEqual({
        mode: "live",
        propertyId: "properties/555",
        apiBaseUrl: "https://ga4.test"
      });
      expect(metadata.accessToken).toBeUndefined();
      expect(metadata.expiresAt).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("ga4-refresh-token");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stores non-OAuth credentials directly with a NULL oauth_token_id", async () => {
    process.env.GROWTH_OS_ENCRYPTION_KEY = "analytical-test-encryption-key";
    const stored: {
      credential_kind?: string;
      encrypted_payload?: string;
      oauth_token_id?: string | null;
    } = {};
    // FIX 4: vi.stubGlobal/unstubAllGlobals — deterministic under parallel CI.
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })) as typeof fetch
    );
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("connection_credentials")) {
          return stored as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource(input) {
        stored.credential_kind = input.credentialKind;
        stored.encrypted_payload = input.encryptedPayload;
        stored.oauth_token_id = input.oauthTokenId ?? null;
        return {
          id: "src_posthog_live",
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: input.accountExternalId,
          status: "connected"
        };
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    try {
      const handlers = createActionHandlers(db);
      await handlers.connect_source?.(
        {
          provider: "posthog",
          connectionName: "PostHog",
          credentialPayload: {
            mode: "live",
            projectId: "42",
            personalApiKey: "ph-personal-key",
            apiHost: "https://posthog.test"
          }
        },
        {
          workspaceId: "workspace",
          authority: "operator",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      );

      expect(stored.credential_kind).toBe("personal_api_key");
      expect(stored.oauth_token_id).toBeNull();
      // The credential itself is stored in encrypted_payload for non-OAuth providers.
      const payload = decryptCredentialPayload<Record<string, unknown>>(
        String(stored.encrypted_payload),
        "analytical-test-encryption-key"
      );
      expect(payload).toMatchObject({ personalApiKey: "ph-personal-key", projectId: "42" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("derives Shopify and Meta Ads source identities from credential payloads", async () => {
    const stored: { credential_kind?: string; encrypted_payload?: string } = {};
    const connected: Array<{ provider: string; accountExternalId?: string }> = [];
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("connection_credentials")) {
          return stored as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource(input) {
        stored.credential_kind = input.credentialKind;
        stored.encrypted_payload = input.encryptedPayload;
        connected.push({
          provider: input.provider,
          accountExternalId: input.accountExternalId
        });
        return {
          id: `src_${input.provider}`,
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: input.accountExternalId,
          status: "connected"
        };
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);
    const context = {
      workspaceId: "workspace",
      authority: "operator",
      surface: "api",
      actorId: "operator",
      sessionId: "session"
    } as const;

    await handlers.connect_source?.(
      {
        provider: "shopify",
        credentialKind: "fixture",
        connectionName: "Shopify",
        credentialPayload: {
          storeDomain: "HTTPS://Scale-Growth.myshopify.com/admin",
          adminAccessToken: "shpat_secret"
        }
      },
      context
    );
    await handlers.connect_source?.(
      {
        provider: "meta_ads",
        credentialKind: "fixture",
        connectionName: "Meta Ads",
        credentialPayload: {
          adAccountId: "1234567890",
          accessToken: "meta-secret"
        }
      },
      context
    );

    expect(connected).toEqual([
      { provider: "shopify", accountExternalId: "scale-growth.myshopify.com" },
      { provider: "meta_ads", accountExternalId: "act_1234567890" }
    ]);
  });

  it("auto-queues an incremental sync when connecting an X source whose connection test passes", async () => {
    const jobs: Array<{ workspaceId: string; jobType: string; payload: Record<string, unknown> }> = [];
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("connection_credentials")) {
          return { credential_kind: "fixture", encrypted_payload: "fixture-encrypted" } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource(input) {
        return {
          id: "src_x",
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: input.accountExternalId,
          status: "connected"
        };
      },
      async updateSourceStatus() {},
      async createJob(input) {
        jobs.push(input as { workspaceId: string; jobType: string; payload: Record<string, unknown> });
        return { id: "job_initial_sync", ...input };
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);
    const result = await handlers.connect_source?.(
      {
        provider: "x",
        credentialKind: "fixture",
        connectionName: "X Public Metrics",
        credentialPayload: { username: "XDevelopers" }
      },
      {
        workspaceId: "workspace",
        authority: "operator",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(jobs).toEqual([
      {
        workspaceId: "workspace",
        jobType: "source_sync",
        payload: { sourceId: "src_x", mode: "incremental" }
      }
    ]);
    expect(result?.data).toMatchObject({
      initialSync: { queued: true, sourceId: "src_x", mode: "incremental" }
    });
  });

  it("auto-queues an incremental sync when reconnecting an X source whose connection test passes", async () => {
    const jobs: Array<{ workspaceId: string; jobType: string; payload: Record<string, unknown> }> = [];
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("connection_credentials")) {
          return { credential_kind: "fixture", encrypted_payload: "fixture-encrypted" } as T;
        }
        if (sql.includes("provider from sources")) {
          return { provider: "x" } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob(input) {
        jobs.push(input as { workspaceId: string; jobType: string; payload: Record<string, unknown> });
        return { id: "job_initial_sync", ...input };
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);
    const result = await handlers.reconnect_source?.(
      { sourceId: "src_x" },
      {
        workspaceId: "workspace",
        authority: "operator",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(jobs).toEqual([
      {
        workspaceId: "workspace",
        jobType: "source_sync",
        payload: { sourceId: "src_x", mode: "incremental" }
      }
    ]);
    expect(result?.data).toMatchObject({
      initialSync: { queued: true, sourceId: "src_x", mode: "incremental" }
    });
  });

  it("does not auto-queue a sync when an X connection test fails", async () => {
    const jobs: Array<{ workspaceId: string; jobType: string; payload: Record<string, unknown> }> = [];
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(): Promise<T | null> {
        // No credential row -> the X connector's testConnection throws provider_auth_failed.
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource(input) {
        return {
          id: "src_x",
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: input.accountExternalId,
          status: "connected"
        };
      },
      async updateSourceStatus() {},
      async createJob(input) {
        jobs.push(input as { workspaceId: string; jobType: string; payload: Record<string, unknown> });
        return { id: "job_initial_sync", ...input };
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);

    await expect(
      handlers.connect_source?.(
        {
          provider: "x",
          credentialKind: "fixture",
          connectionName: "X Public Metrics",
          credentialPayload: { username: "XDevelopers" }
        },
        {
          workspaceId: "workspace",
          authority: "operator",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      )
    ).rejects.toThrow();

    expect(jobs).toEqual([]);
  });

  it("does not auto-queue a sync for non-X providers on connect", async () => {
    const jobs: Array<{ workspaceId: string; jobType: string; payload: Record<string, unknown> }> = [];
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("connection_credentials")) {
          return { credential_kind: "fixture", encrypted_payload: "fixture-encrypted" } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource(input) {
        return {
          id: "src_posthog",
          workspace_id: input.workspaceId,
          provider: input.provider,
          connection_name: input.connectionName,
          account_external_id: input.accountExternalId,
          status: "connected"
        };
      },
      async updateSourceStatus() {},
      async createJob(input) {
        jobs.push(input as { workspaceId: string; jobType: string; payload: Record<string, unknown> });
        return { id: "job_initial_sync", ...input };
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);
    const result = await handlers.connect_source?.(
      {
        provider: "posthog",
        credentialKind: "fixture",
        connectionName: "PostHog",
        credentialPayload: { projectId: "42" }
      },
      {
        workspaceId: "workspace",
        authority: "operator",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(jobs).toEqual([]);
    expect(result?.data).toMatchObject({ initialSync: undefined });
  });

  it("queues source backfills with the selected refresh window payload", async () => {
    const jobs: Array<{ workspaceId: string; jobType: string; payload: Record<string, unknown> }> = [];
    const db: InfiniteOsDb = {
      async query() {
        return [];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob(input) {
        jobs.push(input as { workspaceId: string; jobType: string; payload: Record<string, unknown> });
        return { id: "job_backfill", ...input };
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);
    const result = await handlers.start_source_sync?.(
      {
        sourceId: "src_meta_ads",
        mode: "backfill",
        backfillWindow: "6_months",
        refreshWindowDays: 180
      },
      {
        workspaceId: "workspace",
        authority: "operator",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(jobs).toEqual([
      {
        workspaceId: "workspace",
        jobType: "source_backfill",
        payload: {
          sourceId: "src_meta_ads",
          mode: "backfill",
          backfillWindow: "6_months",
          refreshWindowDays: 180
        }
      }
    ]);
    expect(result?.status).toBe("queued");
  });

  it("honors large immediate X sync windows for first-post coverage refreshes", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const statuses: Array<{ sourceId: string; status: string; lastSyncedAt?: string }> = [];
    let rawRecordIndex = 0;
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        return [];
      },
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("provider from sources")) {
          return { provider: "x" } as T;
        }
        if (sql.includes("connection_credentials")) {
          return { credential_kind: "fixture", encrypted_payload: "fixture-encrypted" } as T;
        }
        if (sql.includes("sync_cursors")) {
          return null;
        }
        if (sql.includes("insert into raw_records")) {
          rawRecordIndex += 1;
          return { id: `raw_${rawRecordIndex}` } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus(sourceId, status, lastSyncedAt) {
        statuses.push({ sourceId, status, ...(lastSyncedAt ? { lastSyncedAt } : {}) });
      },
      async createJob() {
        throw new Error("sync_source_now should not queue jobs");
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);

    const result = await handlers.sync_source_now?.(
      { sourceId: "src_x", refreshWindowDays: 3650, reason: "first X answer" },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "agent",
        sessionId: "session"
      }
    );

    expect(result?.status).toBe("ok");
    expect(result?.data).toMatchObject({
      sourceId: "src_x",
      provider: "x",
      refreshWindowDays: 3650,
      recordsExtracted: 1,
      recordsLoaded: 1
    });
    expect(statuses.map((entry) => entry.status)).toEqual(["syncing", "connected"]);
    expect(queries.some((entry) => entry.sql.includes("insert into sync_runs"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("insert into x_post"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("insert into tool_execution_log"))).toBe(true);
  });

  it("supports occurred_on range filters for analytical queries", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_revenue_by_source")) {
          return [{ recognized_revenue: "12000" }] as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-04" }
        ]
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(result?.data).toMatchObject({
      rows: [{ recognized_revenue: "12000" }],
      metric: "recognized_revenue",
      view: "queryable.vw_revenue_by_source"
    });
    const aggregateQuery = queries.find((entry) => entry.sql.includes("from queryable.vw_revenue_by_source"));
    expect(aggregateQuery?.sql).toContain("occurred_on >= $2");
    expect(aggregateQuery?.sql).toContain("occurred_on <= $3");
    expect(aggregateQuery?.params).toEqual(["workspace", "2026-06-01", "2026-06-04", 500]);
  });

  it("supports ordered X post breakdowns by published_at for recency questions", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_x_post_public_metrics")) {
          return [{ x_post_id: "1", body_text: "latest", published_at: "2026-06-04T10:00:00.000Z", x_public_engagement: "4" }] as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const result = await handlers.run_breakdown_query?.(
      {
        metric: "x_public_engagement",
        view: "queryable.vw_x_post_public_metrics",
        groupBy: ["x_post_id", "post_url", "body_text", "published_at"],
        orderBy: { field: "published_at", direction: "desc" },
        filters: [{ field: "source_id", operator: "equals", value: "src_x_1" }],
        limit: 1
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(result?.data).toMatchObject({
      metric: "x_public_engagement",
      view: "queryable.vw_x_post_public_metrics",
      groupBy: ["x_post_id", "post_url", "body_text", "published_at"],
      orderBy: { field: "published_at", direction: "desc" }
    });
    const aggregateQuery = queries.find((entry) => entry.sql.includes("from queryable.vw_x_post_public_metrics"));
    expect(aggregateQuery?.sql).toContain("group by x_post_id, post_url, body_text, published_at");
    expect(aggregateQuery?.sql).toContain("order by published_at desc");
    expect(aggregateQuery?.sql).toContain("source_id = $2");
  });

  it("drills down x_post_count to authored x_post rows so the latest tweet content is retrievable", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from x_post")) {
          return [
            {
              post_row_id: "xp_1",
              source_id: "src_x_1",
              x_post_id: "2063231313730306485",
              author_id: "founder",
              conversation_id: "2063231313730306485",
              post_url: "https://x.com/YourHandle/status/2063231313730306485",
              body_text: "latest authored tweet",
              published_at: "2026-06-06T12:07:32.000Z",
              x_post_count: 1,
              x_comment_count: 0
            }
          ] as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const result = await handlers.drilldown_result?.(
      {
        metric: "x_post_count",
        limit: 1
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    const drilldownQuery = queries.find((entry) => entry.sql.includes("from x_post"));
    expect(drilldownQuery?.sql).toBeDefined();
    expect(drilldownQuery?.sql).toContain("order by published_at desc");
    expect(queries.some((entry) => entry.sql.includes("from posthog_event_truth"))).toBe(false);
    const data = result?.data as { rows?: Array<Record<string, unknown>> } | undefined;
    expect(data?.rows?.[0]).toMatchObject({
      x_post_id: "2063231313730306485",
      body_text: "latest authored tweet",
      post_url: "https://x.com/YourHandle/status/2063231313730306485"
    });
    expect(result?.provenance).toContain("drilldown.x_authored_post_rows");
  });

  // §9 regression (findings #1/#5) — drilldown for the Phase-1 conversion/value metrics MUST
  // hit the Meta tables, never the posthog_event_truth default fallthrough. Before this guard,
  // providerTruthRows had no branch for results/cost_per_result/conversion_value/roas/
  // roas_from_stripe (or the delivery metrics link_clicks/landing_page_views/frequency), so
  // drilldown_result served UNRELATED PostHog event rows behind a
  // drilldown.meta_ads_campaign_conversion_rows / drilldown.meta_stripe_campaign_value_rows
  // provenance envelope — a provenance/data mismatch. This is the identical guard the GA4 work
  // added after its 6 metrics fell through to the wrong branch.
  it("drills down Phase-1 Meta conversion/value metrics to the Meta tables, never posthog_event_truth", async () => {
    const cases: Array<{
      metric: string;
      table: string;
      provenance: string;
      filters?: Array<{ field: string; operator: string; value: string }>;
    }> = [
      // Conversion-family -> typed conversions fact (result_type pinned to satisfy the partition).
      {
        metric: "cost_per_result",
        table: "from meta_ads_campaign_conversions_daily",
        provenance: "drilldown.meta_ads_campaign_conversion_rows",
        filters: [{ field: "result_type", operator: "equals", value: "lead" }]
      },
      {
        metric: "results",
        table: "from meta_ads_campaign_conversions_daily",
        provenance: "drilldown.meta_ads_campaign_conversion_rows",
        filters: [{ field: "result_type", operator: "equals", value: "lead" }]
      },
      {
        metric: "roas",
        table: "from meta_ads_campaign_conversions_daily",
        provenance: "drilldown.meta_ads_campaign_conversion_rows",
        filters: [{ field: "result_type", operator: "equals", value: "offsite_conversion.fb_pixel_purchase" }]
      },
      // Stripe-attributed ROAS -> the Meta↔Stripe join view.
      {
        metric: "roas_from_stripe",
        table: "from queryable.vw_meta_stripe_campaign_value_daily",
        provenance: "drilldown.meta_stripe_campaign_value_rows"
      },
      // Delivery-fact metrics -> the delivery fact.
      {
        metric: "link_clicks",
        table: "from meta_ads_campaign_daily",
        provenance: "drilldown.meta_ads_campaign_rows"
      },
      {
        metric: "frequency",
        table: "from meta_ads_campaign_daily",
        provenance: "drilldown.meta_ads_campaign_rows"
      }
    ];

    for (const testCase of cases) {
      const queries: string[] = [];
      const db: InfiniteOsDb = {
        async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
          queries.push(sql);
          return [] as T[];
        },
        async one() {
          return null;
        },
        async close() {},
        async ensureWorkspace() {},
        async ensureFirstPhaseDatasets() {},
        async connectSource() {
          return null as never;
        },
        async updateSourceStatus() {},
        async createJob() {
          return {};
        },
        async claimNextJob() {
          return null;
        },
        async completeJob() {},
        async withTransaction(fn) {
          return fn(this);
        }
      };

      const handlers = createActionHandlers(db);
      const result = await handlers.drilldown_result?.(
        { metric: testCase.metric, limit: 5, ...(testCase.filters ? { filters: testCase.filters } : {}) },
        {
          workspaceId: "workspace",
          authority: "tool_agent",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      );

      // The drilldown SQL hits the correct Meta table...
      expect(queries.some((sql) => sql.includes(testCase.table))).toBe(true);
      // ...and NEVER falls through to the posthog_event_truth default branch.
      expect(queries.some((sql) => sql.includes("from posthog_event_truth"))).toBe(false);
      // ...behind the matching provenance envelope (no advertise/serve mismatch).
      expect(result?.provenance).toContain(testCase.provenance);
    }
  });

  // DEFECT 1 REGRESSION GUARD — the drilldown for the delivery metrics (link_clicks /
  // landing_page_views / frequency) selects FROM meta_ads_campaign_daily. The original test above
  // only asserts the SQL string CONTAINS the table name, so it happily passed while the projection
  // selected a bare `frequency` column that DOES NOT EXIST on meta_ads_campaign_daily (frequency
  // is a recomputed impressions/reach ratio — never stored; see migration 0032). At runtime that
  // threw `column "frequency" does not exist`. This guard cross-checks every column the projection
  // references against the KNOWN column set of meta_ads_campaign_daily (migrations 0015 + 0032),
  // allowing computed `<expr> as <alias>` projections. Reverting the fix (selecting a bare
  // `frequency`) makes `frequency` a referenced-but-nonexistent column -> this test FAILS.
  it("only selects columns that exist on meta_ads_campaign_daily for the delivery-fact drilldown", async () => {
    // The real columns of meta_ads_campaign_daily: 0015 (create table) + 0032 (additive alter).
    const KNOWN_DELIVERY_COLUMNS = new Set([
      // 0015 create table meta_ads_campaign_daily
      "id",
      "workspace_id",
      "source_id",
      "raw_record_id",
      "ad_account_id",
      "campaign_id",
      "campaign_name",
      "occurred_on",
      "spend",
      "clicks",
      "impressions",
      "reach",
      "cpm",
      "cpc",
      "ctr",
      "created_at",
      "updated_at",
      // 0032 add columns
      "currency",
      "inline_link_clicks",
      "landing_page_views",
      "attribution_setting",
      "actions_raw",
      "api_version"
    ]);

    for (const metric of ["link_clicks", "landing_page_views", "frequency"] as const) {
      const queries: string[] = [];
      const db: InfiniteOsDb = {
        async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
          queries.push(sql);
          return [] as T[];
        },
        async one() {
          return null;
        },
        async close() {},
        async ensureWorkspace() {},
        async ensureFirstPhaseDatasets() {},
        async connectSource() {
          return null as never;
        },
        async updateSourceStatus() {},
        async createJob() {
          return {};
        },
        async claimNextJob() {
          return null;
        },
        async completeJob() {},
        async withTransaction(fn) {
          return fn(this);
        }
      };

      const handlers = createActionHandlers(db);
      await handlers.drilldown_result?.(
        { metric, limit: 5 },
        {
          workspaceId: "workspace",
          authority: "tool_agent",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      );

      const sql = queries.find((q) => q.includes("from meta_ads_campaign_daily"));
      expect(sql).toBeDefined();

      // Isolate the projection list: everything between `select` and `from`. STRIP `--` line
      // comments FIRST (per line, before splitting) — an inline comment can itself contain commas
      // and would otherwise be mis-split into bogus "columns".
      const projection = sql!
        .slice(sql!.toLowerCase().indexOf("select") + "select".length, sql!.toLowerCase().indexOf("from "))
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n");

      // Split on TOP-LEVEL commas only — a computed item like `impressions::numeric /
      // nullif(reach, 0) as frequency` carries a comma INSIDE its parens that must not split it.
      const items: string[] = [];
      let depth = 0;
      let buf = "";
      for (const ch of projection) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
          items.push(buf.trim());
          buf = "";
        } else {
          buf += ch;
        }
      }
      if (buf.trim()) items.push(buf.trim());

      for (const item of items) {
        // A computed projection (`<expr> as <alias>`) is allowed regardless of the alias — the
        // alias is an output name, not a referenced table column. We only validate bare column
        // references (the kind that can be a phantom). Detect computed items by the presence of
        // an operator / function call / `as` keyword.
        const isComputed = / as | as$|[()/*+:-]/i.test(` ${item} `);
        if (isComputed) {
          // Every bare identifier referenced inside the expression must still exist on the table.
          const identifiers = item.match(/[a-z_][a-z0-9_]*/gi) ?? [];
          for (const ident of identifiers) {
            const lower = ident.toLowerCase();
            // skip the alias keyword, the alias itself (token after `as`), and numeric/cast noise.
            if (lower === "as" || lower === "numeric" || lower === "nullif") continue;
            // The alias (last identifier after `as`) is an output name; allow it.
            const afterAs = / as +([a-z_][a-z0-9_]*)/i.exec(item)?.[1]?.toLowerCase();
            if (lower === afterAs) continue;
            expect(
              KNOWN_DELIVERY_COLUMNS.has(lower),
              `computed projection "${item}" references nonexistent column "${ident}" on meta_ads_campaign_daily`
            ).toBe(true);
          }
          continue;
        }
        // A bare column reference (strip any table qualifier) must exist on the table.
        const column = item.replace(/^[a-z_][a-z0-9_]*\./i, "").toLowerCase();
        expect(
          KNOWN_DELIVERY_COLUMNS.has(column),
          `drilldown for "${metric}" selects nonexistent column "${column}" on meta_ads_campaign_daily`
        ).toBe(true);
      }
    }
  });

  it("rejects metric and view mismatches before executing SQL", async () => {
    const queries: string[] = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
        queries.push(sql);
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    await expect(
      handlers.run_metric_query?.(
        {
          metric: "x_post_count",
          view: "queryable.vw_x_post_public_metrics"
        },
        {
          workspaceId: "workspace",
          authority: "tool_agent",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      )
    ).rejects.toThrow("unsupported_view_for_metric:x_post_count:queryable.vw_x_post_public_metrics");
    expect(queries).toHaveLength(0);
  });

  it("maps X recency aliases like post_created_at to published_at", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_x_authored_activity")) {
          return [{ x_post_id: "1", body_text: "latest", published_at: "2026-06-04T10:00:00.000Z", x_post_count: "1" }] as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    await handlers.run_breakdown_query?.(
      {
        metric: "x_post_count",
        view: "queryable.vw_x_authored_activity",
        groupBy: ["x_post_id", "body_text", "published_at"],
        orderBy: { field: "post_created_at", direction: "desc" },
        filters: [{ field: "source_id", operator: "equals", value: "src_x_1" }],
        limit: 1
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    const aggregateQuery = queries.find((entry) => entry.sql.includes("from queryable.vw_x_authored_activity"));
    expect(aggregateQuery?.sql).toContain("order by published_at desc");
  });

  it("supports X hour-of-day breakdowns via derived published_at buckets", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_x_post_public_metrics")) {
          return [{ published_hour_utc: 9, x_public_engagement: "42" }] as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const result = await handlers.run_breakdown_query?.(
      {
        metric: "x_public_engagement",
        view: "queryable.vw_x_post_public_metrics",
        groupBy: ["published_hour_utc"],
        orderBy: { field: "x_public_engagement", direction: "desc" },
        filters: [{ field: "source_id", operator: "equals", value: "src_x_1" }],
        limit: 24
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(result?.data).toMatchObject({
      groupBy: ["published_hour_utc"],
      orderBy: { field: "x_public_engagement", direction: "desc" }
    });
    const aggregateQuery = queries.find((entry) => entry.sql.includes("from queryable.vw_x_post_public_metrics"));
    expect(aggregateQuery?.sql).toContain("extract(hour from published_at at time zone 'utc')::int as published_hour_utc");
    expect(aggregateQuery?.sql).toContain("group by extract(hour from published_at at time zone 'utc')::int");
  });

  it("supports natural X aliases for text, content type, and engaged-with handle breakdowns", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const context = {
      workspaceId: "workspace",
      authority: "tool_agent" as const,
      surface: "api" as const,
      actorId: "operator",
      sessionId: "session"
    };

    await handlers.run_breakdown_query?.(
      {
        metric: "x_public_engagement",
        view: "queryable.vw_x_post_public_metrics",
        groupBy: ["post_text", "published_at"],
        orderBy: { field: "published_at", direction: "desc" },
        filters: [{ field: "source_id", operator: "equals", value: "src_x_1" }],
        limit: 1
      },
      context
    );
    await handlers.run_breakdown_query?.(
      {
        metric: "x_public_engagement",
        view: "queryable.vw_x_post_public_metrics",
        groupBy: ["post_type"],
        orderBy: { field: "x_public_engagement", direction: "desc" },
        filters: [{ field: "source_id", operator: "equals", value: "src_x_1" }],
        limit: 5
      },
      context
    );
    await handlers.run_breakdown_query?.(
      {
        metric: "x_comment_count",
        view: "queryable.vw_x_authored_activity",
        groupBy: ["engaged_with"],
        orderBy: { field: "x_comment_count", direction: "desc" },
        filters: [{ field: "source_id", operator: "equals", value: "src_x_1" }],
        limit: 3
      },
      context
    );

    const aggregateQueries = queries.filter((entry) => entry.sql.includes("from queryable.vw_x_"));
    expect(aggregateQueries[0]?.sql).toContain("body_text as body_text");
    expect(aggregateQueries[0]?.sql).toContain("order by published_at desc");
    expect(aggregateQueries[1]?.sql).toContain("as content_type");
    expect(aggregateQueries[1]?.sql).toContain("conversation_id is not null and conversation_id <> x_post_id");
    expect(aggregateQueries[1]?.sql).toContain("coalesce(body_text, '') ~* '(https?://|t\\.co/)'");
    expect(aggregateQueries[2]?.sql).toContain("as mentioned_handle");
    expect(aggregateQueries[2]?.sql).toContain("regexp_match(coalesce(body_text, ''), '@([A-Za-z0-9_]{1,15})')");
  });

  it("hydrates published_at into X view and metric metadata", async () => {
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
        if (sql.includes("from queryable_views")) {
          return [{
            id: "queryable.vw_x_post_public_metrics",
            view_name: "vw_x_post_public_metrics",
            allowed_dimensions: ["x_post_id", "author_id", "post_url", "body_text"],
            default_time_column: "published_at"
          }] as T[];
        }
        if (sql.includes("from metric_definitions")) {
          return [{
            id: "x_public_engagement",
            source_view: "queryable.vw_x_post_public_metrics",
            allowed_dimensions: ["x_post_id", "author_id", "post_url", "body_text"],
            default_time_column: "published_at"
          }] as T[];
        }
        return [] as T[];
      },
      async one<T = Record<string, unknown>>(sql: string): Promise<T | null> {
        if (sql.includes("from queryable_views")) {
          return {
            id: "queryable.vw_x_post_public_metrics",
            view_name: "vw_x_post_public_metrics",
            allowed_dimensions: ["x_post_id", "author_id", "post_url", "body_text"],
            default_time_column: "published_at"
          } as T;
        }
        if (sql.includes("from metric_definitions")) {
          return {
            id: "x_public_engagement",
            source_view: "queryable.vw_x_post_public_metrics",
            allowed_dimensions: ["x_post_id", "author_id", "post_url", "body_text"],
            default_time_column: "published_at"
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const viewsResult = await handlers.list_queryable_views?.({}, {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "api",
      actorId: "operator",
      sessionId: "session"
    });
    const metricResult = await handlers.describe_metric?.({ metricId: "x_public_engagement" }, {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "api",
      actorId: "operator",
      sessionId: "session"
    });

    expect((viewsResult?.data as { views: Array<{ allowed_dimensions: string[] }> }).views[0]?.allowed_dimensions).toContain("published_at");
    expect((viewsResult?.data as { views: Array<{ allowed_dimensions: string[] }> }).views[0]?.allowed_dimensions).toContain("published_hour_utc");
    expect((viewsResult?.data as { views: Array<{ allowed_dimensions: string[] }> }).views[0]?.allowed_dimensions).toContain("content_type");
    expect((viewsResult?.data as { views: Array<{ allowed_dimensions: string[] }> }).views[0]?.allowed_dimensions).toContain("mentioned_handle");
    expect((metricResult?.data as { metric: { allowed_dimensions: string[] } }).metric.allowed_dimensions).toContain("published_at");
    expect((metricResult?.data as { metric: { allowed_dimensions: string[] } }).metric.allowed_dimensions).toContain("published_hour_utc");
    expect((metricResult?.data as { metric: { allowed_dimensions: string[] } }).metric.allowed_dimensions).toContain("content_type");
    expect((metricResult?.data as { metric: { allowed_dimensions: string[] } }).metric.allowed_dimensions).toContain("mentioned_handle");
  });

  it("uses Shopify and Meta Ads authority and drilldown metadata for new metrics", async () => {
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(): Promise<T[]> {
        return [] as T[];
      },
      async one<T = Record<string, unknown>>(sql: string): Promise<T | null> {
        if (sql.includes("from metric_definitions") && sql.includes("shopify_gross_sales")) {
          return {
            id: "shopify_gross_sales",
            source_view: "queryable.vw_shopify_orders",
            allowed_dimensions: ["currency", "customer_email"],
            default_time_column: "occurred_on"
          } as T;
        }
        if (sql.includes("from metric_definitions") && sql.includes("meta_ads_spend")) {
          return {
            id: "meta_ads_spend",
            source_view: "queryable.vw_meta_ads_campaign_daily",
            allowed_dimensions: ["ad_account_id", "campaign_id", "campaign_name"],
            default_time_column: "occurred_on"
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const shopify = await handlers.explain_answer?.({ metric: "shopify_gross_sales" }, {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "api",
      actorId: "operator",
      sessionId: "session"
    });
    const metaAds = await handlers.explain_answer?.({ metric: "meta_ads_spend" }, {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "api",
      actorId: "operator",
      sessionId: "session"
    });

    expect(shopify?.data).toMatchObject({
      metric: "shopify_gross_sales",
      sourceAuthority: "Shopify order records are the first-phase commerce authority",
      drilldownAction: "drilldown.shopify_order_rows"
    });
    expect(shopify?.caveats).toContain("order_level_shopify_commerce_authority");
    expect(metaAds?.data).toMatchObject({
      metric: "meta_ads_spend",
      sourceAuthority: "Meta Ads campaign insights are the first-phase paid media authority",
      drilldownAction: "drilldown.meta_ads_campaign_rows"
    });
    expect(metaAds?.caveats).toContain("read_only_marketing_api_reporting");
  });

  it("uses PostHog event authority and drilldown metadata for event-count metrics", async () => {
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(): Promise<T[]> {
        return [] as T[];
      },
      async one<T = Record<string, unknown>>(sql: string): Promise<T | null> {
        if (sql.includes("from metric_definitions") && sql.includes("posthog_event_count")) {
          return {
            id: "posthog_event_count",
            source_view: "queryable.vw_posthog_events",
            allowed_dimensions: ["event_name", "landing_page", "referrer", "utm_source", "utm_medium", "utm_campaign"],
            default_time_column: "occurred_on"
          } as T;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    const posthog = await handlers.explain_answer?.({ metric: "posthog_event_count" }, {
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "api",
      actorId: "operator",
      sessionId: "session"
    });

    expect(posthog?.data).toMatchObject({
      metric: "posthog_event_count",
      sourceAuthority: "PostHog event records are the first-phase event authority",
      drilldownAction: "drilldown.posthog_event_provider_rows"
    });
    expect(posthog?.caveats).toContain("source_native_event_counts");
  });

  it("accepts breakdown dimensions for Shopify and Meta Ads queryable views", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_shopify_orders")) {
          return [{ currency: "USD", shopify_order_count: "4" }] as T[];
        }
        if (sql.includes("from queryable.vw_meta_ads_campaign_daily")) {
          return [{ campaign_id: "1200000001", meta_ads_spend: "123.45" }] as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    await handlers.run_breakdown_query?.(
      {
        metric: "shopify_order_count",
        view: "queryable.vw_shopify_orders",
        groupBy: ["currency"],
        orderBy: { field: "shopify_order_count", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );
    await handlers.run_breakdown_query?.(
      {
        metric: "meta_ads_spend",
        view: "queryable.vw_meta_ads_campaign_daily",
        groupBy: ["campaign_id"],
        orderBy: { field: "meta_ads_spend", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );
    await handlers.run_breakdown_query?.(
      {
        metric: "meta_ads_clicks",
        view: "queryable.vw_meta_ads_campaign_daily",
        groupBy: ["campaign", "date"],
        orderBy: { field: "meta_ads_clicks", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(queries.some((entry) => entry.sql.includes("from queryable.vw_shopify_orders") && entry.sql.includes("currency as currency"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("from queryable.vw_meta_ads_campaign_daily") && entry.sql.includes("campaign_id as campaign_id"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("from queryable.vw_meta_ads_campaign_daily") && entry.sql.includes("campaign_name as campaign_name"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("from queryable.vw_meta_ads_campaign_daily") && entry.sql.includes("occurred_on as occurred_on"))).toBe(true);
  });

  // Phase 0 Change 1 end-to-end: these run the full run_metric_query handler against a
  // fake-db that EVALUATES the emitted aggregate SQL over a fixed campaign×day fixture.
  // Because the fixture's per-row ratios differ from the true volume-weighted ratio, a
  // revert to avg(per-row cpm/cpc/ctr) would return a DIFFERENT number and fail these.
  describe("run_metric_query for Meta Ads queryable metrics (Phase 0)", () => {
    // Two campaign×day rows for one campaign. Bases chosen so sum-then-divide differs
    // sharply from avg-of-per-row-ratios:
    //   day1: spend 100, clicks 10,  impressions 1000  -> cpm 100, cpc 10,   ctr 0.01
    //   day2: spend  20, clicks 80,  impressions 9000  -> cpm  2.222, cpc 0.25, ctr 0.00889
    // Correct (recomputed) totals over sums:
    //   sum spend 120, sum clicks 90, sum impressions 10000
    //   cpm = 120 / 10000 * 1000 = 12
    //   cpc = 120 / 90            = 1.3333...
    //   ctr = 90 / 10000          = 0.009
    //   impressions = 10000 ; reach (sum) = 5000
    const fixture = [
      { spend: 100, clicks: 10, impressions: 1000, reach: 3000, cpm: 100, cpc: 10, ctr: 0.01 },
      { spend: 20, clicks: 80, impressions: 9000, reach: 2000, cpm: 2.222, cpc: 0.25, ctr: 0.0088888 }
    ];
    const sums = {
      spend: fixture.reduce((acc, row) => acc + row.spend, 0),
      clicks: fixture.reduce((acc, row) => acc + row.clicks, 0),
      impressions: fixture.reduce((acc, row) => acc + row.impressions, 0),
      reach: fixture.reduce((acc, row) => acc + row.reach, 0)
    };

    // Evaluate ONLY the exact aggregate expressions Change 1 registers. Any other shape
    // (e.g. an avg(cpm) revert) is unrecognized and throws — so a wrong SQL can never
    // silently pass by returning a coincidentally-right number.
    function evalAggregate(metric: string, sql: string): number {
      const measure = sql.slice(sql.indexOf("select ") + "select ".length, sql.indexOf(` as ${metric}`)).trim();
      if (measure === "sum(impressions)") return sums.impressions;
      if (measure === "sum(reach)") return sums.reach;
      if (measure === "sum(meta_ads_spend) / nullif(sum(impressions), 0) * 1000") {
        return sums.spend / sums.impressions * 1000;
      }
      if (measure === "sum(meta_ads_spend) / nullif(sum(meta_ads_clicks), 0)") {
        return sums.spend / sums.clicks;
      }
      if (measure === "sum(meta_ads_clicks) / nullif(sum(impressions), 0)") {
        return sums.clicks / sums.impressions;
      }
      throw new Error(`unexpected_aggregate_for_${metric}:${measure}`);
    }

    function metaAggregateFakeDb(metric: string, queries: Array<{ sql: string }>): InfiniteOsDb {
      return {
        async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
          queries.push({ sql });
          if (sql.includes("from queryable.vw_meta_ads_campaign_daily")) {
            return [{ [metric]: evalAggregate(metric, sql) }] as T[];
          }
          return [] as T[];
        },
        async one() {
          return null;
        },
        async close() {},
        async ensureWorkspace() {},
        async ensureFirstPhaseDatasets() {},
        async connectSource() {
          return null as never;
        },
        async updateSourceStatus() {},
        async createJob() {
          return {};
        },
        async claimNextJob() {
          return null;
        },
        async completeJob() {},
        async withTransaction(fn) {
          return fn(this);
        }
      };
    }

    const ctx = {
      workspaceId: "workspace",
      authority: "tool_agent" as const,
      surface: "api" as const,
      actorId: "operator",
      sessionId: "session"
    };

    it("sums impressions and reach over the campaign×day grain", async () => {
      for (const metric of ["impressions", "reach"] as const) {
        const queries: Array<{ sql: string }> = [];
        const handlers = createActionHandlers(metaAggregateFakeDb(metric, queries));
        const result = await handlers.run_metric_query?.({ metric }, ctx);
        const sql = queries.find((entry) => entry.sql.includes("from queryable.vw_meta_ads_campaign_daily"))?.sql;
        expect(sql).toContain(`sum(${metric}) as ${metric}`);
        expect(result?.data).toMatchObject({ metric, view: "queryable.vw_meta_ads_campaign_daily" });
        const rows = (result?.data as { rows: Array<Record<string, number>> }).rows;
        expect(rows[0]?.[metric]).toBe(sums[metric]);
      }
    });

    it("recomputes cpm/cpc/ctr from summed bases (avg-per-row would be wrong)", async () => {
      const expected: Record<string, number> = {
        cpm: (sums.spend / sums.impressions) * 1000, // 12
        cpc: sums.spend / sums.clicks, // 1.3333...
        ctr: sums.clicks / sums.impressions // 0.009
      };
      // The avg-of-per-row-ratio answer the revert would produce — proven DISTINCT here so
      // the equality assertion below genuinely rejects the averaged value.
      const avgPerRow: Record<string, number> = {
        cpm: (fixture[0]!.cpm + fixture[1]!.cpm) / 2,
        cpc: (fixture[0]!.cpc + fixture[1]!.cpc) / 2,
        ctr: (fixture[0]!.ctr + fixture[1]!.ctr) / 2
      };
      for (const metric of ["cpm", "cpc", "ctr"] as const) {
        const queries: Array<{ sql: string }> = [];
        const handlers = createActionHandlers(metaAggregateFakeDb(metric, queries));
        const result = await handlers.run_metric_query?.({ metric }, ctx);
        const sql = queries.find((entry) => entry.sql.includes("from queryable.vw_meta_ads_campaign_daily"))?.sql;
        expect(sql).not.toContain(`avg(${metric})`);
        const rows = (result?.data as { rows: Array<Record<string, number>> }).rows;
        expect(rows[0]?.[metric]).toBeCloseTo(expected[metric]!, 9);
        // Guard the guard: the recomputed value must NOT equal the averaged value.
        expect(Math.abs(rows[0]![metric]! - avgPerRow[metric]!)).toBeGreaterThan(1e-6);
      }
    });

    it("flags reach as approximate on the run_metric_query envelope", async () => {
      const queries: Array<{ sql: string }> = [];
      const handlers = createActionHandlers(metaAggregateFakeDb("reach", queries));
      const result = await handlers.run_metric_query?.({ metric: "reach" }, ctx);
      expect(result?.caveats).toContain(
        "reach_is_approximate_summed_daily_reach_overcounts_unique_people"
      );
      expect(result?.caveats).toContain("read_only_marketing_api_reporting");
    });
  });

  it("accepts event and channel breakdown dimensions for PostHog event counts", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes("from queryable.vw_posthog_events")) {
          return [{ event_name: "signup", utm_source: "linkedin", posthog_event_count: "4" }] as T[];
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };

    const handlers = createActionHandlers(db);
    await handlers.run_breakdown_query?.(
      {
        metric: "posthog_event_count",
        view: "queryable.vw_posthog_events",
        groupBy: ["event_name", "utm_source", "date"],
        filters: [{ field: "event_date", operator: "gte", value: "2026-06-01" }],
        orderBy: { field: "posthog_event_count", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(queries.some((entry) => entry.sql.includes("from queryable.vw_posthog_events") && entry.sql.includes("event_name as event_name"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("from queryable.vw_posthog_events") && entry.sql.includes("utm_source as utm_source"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("from queryable.vw_posthog_events") && entry.sql.includes("occurred_on as occurred_on"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("occurred_on >= $2"))).toBe(true);
  });

  it("routes GA4 traffic count metrics to vw_site_traffic with sum aggregates", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4TrafficFakeDb(queries);
    const handlers = createActionHandlers(db);

    for (const metric of ["page_views", "new_users", "key_events"]) {
      const result = await handlers.run_metric_query?.(
        { metric, view: "queryable.vw_site_traffic" },
        {
          workspaceId: "workspace",
          authority: "tool_agent",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      );
      const aggregateQuery = queries.find(
        (entry) => entry.sql.includes("from queryable.vw_site_traffic") && entry.sql.includes(`sum(${metric})`)
      );
      expect(aggregateQuery?.sql).toBeDefined();
      expect(aggregateQuery?.sql).toContain(`sum(${metric}) as ${metric}`);
      expect(aggregateQuery?.params).toEqual(["workspace", 500]);
      expect(result?.caveats).toContain("source_native_attribution_only");
    }
  });

  it("uses session-weighted SQL for GA4 rate metrics (never sum/avg alone)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4TrafficFakeDb(queries);
    const handlers = createActionHandlers(db);

    await handlers.run_metric_query?.(
      { metric: "engagement_rate", view: "queryable.vw_site_traffic" },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );
    await handlers.run_metric_query?.(
      { metric: "average_session_duration", view: "queryable.vw_site_traffic" },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    const engagementSql = queries.find(
      (entry) => entry.sql.includes("from queryable.vw_site_traffic") && entry.sql.includes("engagement_rate * sessions")
    )?.sql;
    expect(engagementSql).toBeDefined();
    expect(engagementSql).toContain("sum(engagement_rate * sessions) / sum(sessions)");
    expect(engagementSql).not.toContain("sum(engagement_rate) as");

    const durationSql = queries.find(
      (entry) => entry.sql.includes("from queryable.vw_site_traffic") && entry.sql.includes("average_session_duration * sessions")
    )?.sql;
    expect(durationSql).toBeDefined();
    expect(durationSql).toContain("sum(average_session_duration * sessions) / sum(sessions)");
    expect(durationSql).not.toContain("sum(average_session_duration) as");
  });

  it("breaks GA4 traffic down by channel group and device category", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4TrafficFakeDb(queries);
    const handlers = createActionHandlers(db);

    await handlers.run_breakdown_query?.(
      {
        metric: "page_views",
        view: "queryable.vw_site_traffic",
        groupBy: ["session_default_channel_group"],
        orderBy: { field: "page_views", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );
    await handlers.run_breakdown_query?.(
      {
        metric: "engaged_sessions",
        view: "queryable.vw_site_traffic",
        groupBy: ["device_category"],
        orderBy: { field: "engaged_sessions", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(
      queries.some(
        (entry) =>
          entry.sql.includes("from queryable.vw_site_traffic") &&
          entry.sql.includes("group by session_default_channel_group")
      )
    ).toBe(true);
    expect(
      queries.some(
        (entry) => entry.sql.includes("from queryable.vw_site_traffic") && entry.sql.includes("group by device_category")
      )
    ).toBe(true);
  });

  it("uses session-weighted SQL for a GA4 rate breakdown grouped by channel group", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4TrafficFakeDb(queries);
    const handlers = createActionHandlers(db);

    const result = await handlers.run_breakdown_query?.(
      {
        metric: "engagement_rate",
        view: "queryable.vw_site_traffic",
        groupBy: ["session_default_channel_group"],
        orderBy: { field: "engagement_rate", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    expect(result?.data).toMatchObject({
      metric: "engagement_rate",
      view: "queryable.vw_site_traffic",
      groupBy: ["session_default_channel_group"],
      orderBy: { field: "engagement_rate", direction: "desc" }
    });
    const breakdownSql = queries.find(
      (entry) =>
        entry.sql.includes("from queryable.vw_site_traffic") &&
        entry.sql.includes("engagement_rate * sessions")
    )?.sql;
    expect(breakdownSql).toBeDefined();
    // Session-weighted rate, never sum/avg alone.
    expect(breakdownSql).toContain("sum(engagement_rate * sessions) / sum(sessions)");
    // ORDER BY references the aliased CASE output column, not the raw expression.
    expect(breakdownSql).toContain("order by engagement_rate desc");
    expect(breakdownSql).toContain("group by session_default_channel_group");
  });

  it("rejects page-only dimensions on the GA4 traffic view", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4TrafficFakeDb(queries);
    const handlers = createActionHandlers(db);

    await expect(
      handlers.run_breakdown_query?.(
        {
          metric: "page_views",
          view: "queryable.vw_site_traffic",
          groupBy: ["page_path"]
        },
        {
          workspaceId: "workspace",
          authority: "tool_agent",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      )
    ).rejects.toThrow("unsupported_dimension:page_path");
  });

  it("routes page_views_by_page to the GA4 page view for top-page metric queries", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4PageFakeDb(queries);
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.(
      { metric: "page_views_by_page", view: "queryable.vw_site_pages" },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    const aggregateQuery = queries.find(
      (entry) => entry.sql.includes("from queryable.vw_site_pages") && entry.sql.includes("sum(page_views)")
    );
    expect(aggregateQuery?.sql).toBeDefined();
    // page_views_by_page is a count aliased to page_views in the view (identity).
    expect(aggregateQuery?.sql).toContain("sum(page_views) as page_views_by_page");
    expect(aggregateQuery?.params).toEqual(["workspace", 500]);
    expect(result?.caveats).toContain("source_native_attribution_only");
  });

  it("breaks page_views_by_page down by host and page path against vw_site_pages", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4PageFakeDb(queries);
    const handlers = createActionHandlers(db);

    await handlers.run_breakdown_query?.(
      {
        metric: "page_views_by_page",
        view: "queryable.vw_site_pages",
        groupBy: ["page_path", "page_title"],
        orderBy: { field: "page_views_by_page", direction: "desc" }
      },
      {
        workspaceId: "workspace",
        authority: "tool_agent",
        surface: "api",
        actorId: "operator",
        sessionId: "session"
      }
    );

    const breakdownSql = queries.find(
      (entry) => entry.sql.includes("from queryable.vw_site_pages") && entry.sql.includes("group by")
    )?.sql;
    expect(breakdownSql).toBeDefined();
    expect(breakdownSql).toContain("group by page_path, page_title");
    expect(breakdownSql).toContain("order by page_views_by_page desc");
  });

  it("rejects traffic-only dimensions on the GA4 page view", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4PageFakeDb(queries);
    const handlers = createActionHandlers(db);

    await expect(
      handlers.run_breakdown_query?.(
        {
          metric: "page_views_by_page",
          view: "queryable.vw_site_pages",
          groupBy: ["device_category"]
        },
        {
          workspaceId: "workspace",
          authority: "tool_agent",
          surface: "api",
          actorId: "operator",
          sessionId: "session"
        }
      )
    ).rejects.toThrow("unsupported_dimension:device_category");
  });

  // PR3 Step 12 — drilldown source-isolation FIX (regression guard for the cross-site leak).
  it("isolates the site_visitors drilldown to the requested source_id", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { factHasRows: true });
    const handlers = createActionHandlers(db);

    await handlers.drilldown_result?.(
      {
        metric: "site_visitors",
        filters: [{ field: "source_id", operator: "equals", value: "src_ga4_rtk" }]
      },
      ga4Context()
    );

    const drilldownQuery = queries.find((entry) => entry.sql.includes("from ga4_report_snapshot_fact"));
    expect(drilldownQuery?.sql).toBeDefined();
    // The leak fix: source filter is now present (was workspace_id only).
    expect(drilldownQuery?.sql).toContain("($2::text is null or source_id = $2)");
    // Param bind order: [workspaceId, sourceIdFilter, limit].
    expect(drilldownQuery?.params?.[0]).toBe("workspace");
    expect(drilldownQuery?.params?.[1]).toBe("src_ga4_rtk");
  });

  // PR3 review FIX — the 6 GA4 daily-traffic metrics added in PR1 route their drilldown to
  // ga4_traffic_provider_rows (same as site_visitors), so providerTruthRows must hit the
  // source-isolated ga4_report_snapshot_fact query, NOT fall through to the posthog default.
  it("routes GA4 traffic-metric drilldowns to the source-isolated ga4_report_snapshot_fact query", async () => {
    for (const metric of ["page_views", "engagement_rate"]) {
      const queries: Array<{ sql: string; params?: unknown[] }> = [];
      const db = ga4ProbeFakeDb(queries, { factHasRows: true });
      const handlers = createActionHandlers(db);

      await handlers.drilldown_result?.(
        {
          metric,
          filters: [{ field: "source_id", operator: "equals", value: "src_ga4_rtk" }]
        },
        ga4Context()
      );

      const drilldownQuery = queries.find((entry) => entry.sql.includes("from ga4_report_snapshot_fact"));
      expect(drilldownQuery?.sql, `${metric} should drill into ga4_report_snapshot_fact`).toBeDefined();
      // Source isolation is preserved for the widened metric set.
      expect(drilldownQuery?.sql).toContain("($2::text is null or source_id = $2)");
      expect(drilldownQuery?.params?.[0]).toBe("workspace");
      expect(drilldownQuery?.params?.[1]).toBe("src_ga4_rtk");
      // Must NOT fall through to the posthog default provider-truth branch.
      expect(queries.some((entry) => entry.sql.includes("from posthog_event_truth"))).toBe(false);
    }
  });

  // PR3 Step 14 — per-site resolver maps {site} -> source_id filter on the aggregate.
  it("resolves a per-site metric query to the linked GA4 source_id", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4SiteResolverFakeDb(queries, {
      siteUrl: "rtk.dev",
      ga4SourceId: "src_ga4_rtk"
    });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.(
      { metric: "page_views", site: "rtk.dev" },
      ga4Context()
    );

    const aggregateQuery = queries.find((entry) =>
      entry.sql.includes("from queryable.vw_site_traffic")
    );
    expect(aggregateQuery?.sql).toBeDefined();
    // source_id is exempt from the dimension gate and emitted as `source_id = $N`.
    expect(aggregateQuery?.sql).toContain("source_id = $2");
    expect(aggregateQuery?.params).toEqual(["workspace", "src_ga4_rtk", 500]);
    // A resolved single site must NOT be flagged as a cross-site aggregate.
    expect(result?.caveats).not.toContain("multi_site_aggregate");
  });

  it("resolves a per-site breakdown query to the linked GA4 source_id", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4SiteResolverFakeDb(queries, {
      siteUrl: "rtk.dev",
      ga4SourceId: "src_ga4_rtk"
    });
    const handlers = createActionHandlers(db);

    await handlers.run_breakdown_query?.(
      {
        metric: "page_views",
        site: "rtk.dev",
        groupBy: ["device_category"]
      },
      ga4Context()
    );

    const aggregateQuery = queries.find((entry) =>
      entry.sql.includes("from queryable.vw_site_traffic")
    );
    expect(aggregateQuery?.sql).toBeDefined();
    expect(aggregateQuery?.sql).toContain("group by device_category");
    expect(aggregateQuery?.sql).toContain("source_id = $2");
    expect(aggregateQuery?.params?.[1]).toBe("src_ga4_rtk");
  });

  it("falls back to the lone connected GA4 source when no site link exists", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4SiteResolverFakeDb(queries, {
      siteUrl: "rtk.dev",
      ga4SourceId: null, // no FK link
      loneSources: ["src_ga4_only"]
    });
    const handlers = createActionHandlers(db);

    await handlers.run_metric_query?.({ metric: "page_views", site: "rtk.dev" }, ga4Context());

    const aggregateQuery = queries.find((entry) =>
      entry.sql.includes("from queryable.vw_site_traffic")
    );
    expect(aggregateQuery?.params?.[1]).toBe("src_ga4_only");
  });

  it("throws site_ambiguous when a requested site cannot be resolved to a source", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4SiteResolverFakeDb(queries, {
      siteUrl: "rtk.dev",
      ga4SourceId: null,
      loneSources: ["src_ga4_a", "src_ga4_b"] // two sources -> not lone
    });
    const handlers = createActionHandlers(db);

    await expect(
      handlers.run_metric_query?.({ metric: "page_views", site: "rtk.dev" }, ga4Context())
    ).rejects.toThrow("site_ambiguous");
  });

  // PR3 Step 14 — never silently sum across GA4 properties.
  it("flags an un-scoped multi-site GA4 aggregate with the multi_site_aggregate caveat", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { factHasRows: true, ga4SourceCount: 2 });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.({ metric: "page_views" }, ga4Context());

    expect(result?.caveats).toContain("multi_site_aggregate");
  });

  it("does not flag multi_site_aggregate when only one GA4 source exists", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { factHasRows: true, ga4SourceCount: 1 });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.({ metric: "page_views" }, ga4Context());

    expect(result?.caveats).not.toContain("multi_site_aggregate");
  });

  // PR3 Step 13 — no-data honesty (metric handler).
  it("reports no_data_synced when the GA4 fact table is empty (metric query)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { aggregateRows: [{ page_views: null }], probeHasRows: false });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.({ metric: "page_views" }, ga4Context());

    expect(result?.caveats).toContain("no_data_synced");
    expect((result?.data as Record<string, unknown>)?.noData).toMatchObject({ reason: "not_synced" });
  });

  it("reports no_data_for_range when the fact has rows but the range is empty (metric query)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { aggregateRows: [{ page_views: null }], probeHasRows: true });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.(
      {
        metric: "page_views",
        // Old range end so the freshness lag does NOT fire (deterministic assertion).
        filters: [{ field: "occurred_on", operator: "lte", value: "2020-01-01" }]
      },
      ga4Context()
    );

    expect(result?.caveats).toContain("no_data_for_range");
    expect(result?.caveats).not.toContain("ga4_freshness_lag");
    expect((result?.data as Record<string, unknown>)?.noData).toMatchObject({ reason: "no_data_for_range" });
  });

  it("adds ga4_freshness_lag when an empty range ends within the GA4 mutation window", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { aggregateRows: [{ page_views: null }], probeHasRows: true });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.(
      {
        metric: "page_views",
        filters: [{ field: "occurred_on", operator: "lte", value: new Date().toISOString().slice(0, 10) }]
      },
      ga4Context()
    );

    expect(result?.caveats).toContain("no_data_for_range");
    expect(result?.caveats).toContain("ga4_freshness_lag");
    expect((result?.data as Record<string, unknown>)?.freshness).toMatchObject({ ga4FreshnessLag: true });
  });

  // PR3 Step 13 — the SAME classifier must fire for breakdown queries (empty groups -> []).
  it("reports no_data_synced for an empty breakdown query (breakdown handler)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { aggregateRows: [], probeHasRows: false });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_breakdown_query?.(
      { metric: "page_views", groupBy: ["device_category"] },
      ga4Context()
    );

    expect(result?.caveats).toContain("no_data_synced");
  });

  it("reports no_data_for_range for an empty breakdown over a populated fact (breakdown handler)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, { aggregateRows: [], probeHasRows: true });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_breakdown_query?.(
      {
        metric: "page_views",
        groupBy: ["device_category"],
        filters: [{ field: "occurred_on", operator: "lte", value: "2020-01-01" }]
      },
      ga4Context()
    );

    expect(result?.caveats).toContain("no_data_for_range");
  });

  // PR3 Step 13 — key_events specifically: a returned 0 with a populated fact and NO
  // historical key_events > 0 means the key event is unconfigured, not a genuine zero.
  it("reports key_events_unconfigured when key_events is 0 and never configured", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, {
      aggregateRows: [{ key_events: "0" }],
      keyEventsEverConfigured: false
    });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.({ metric: "key_events" }, ga4Context());

    expect(result?.caveats).toContain("key_events_unconfigured");
  });

  it("does not report key_events_unconfigured when key_events was historically configured", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = ga4ProbeFakeDb(queries, {
      aggregateRows: [{ key_events: "0" }],
      keyEventsEverConfigured: true
    });
    const handlers = createActionHandlers(db);

    const result = await handlers.run_metric_query?.({ metric: "key_events" }, ga4Context());

    expect(result?.caveats).not.toContain("key_events_unconfigured");
  });
});

function ga4Context() {
  return {
    workspaceId: "workspace",
    authority: "tool_agent" as const,
    surface: "api" as const,
    actorId: "operator",
    sessionId: "session"
  };
}

// Fake DB for the per-site resolver: serves workspace_sites + sources lookups via `one`/
// `query`, captures aggregate SQL, and returns a non-empty aggregate row (so the no-data
// classifier does not fire on the resolution-path tests).
function ga4SiteResolverFakeDb(
  queries: Array<{ sql: string; params?: unknown[] }>,
  config: { siteUrl: string; ga4SourceId: string | null; loneSources?: string[] }
): InfiniteOsDb {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      queries.push({ sql, params });
      if (sql.includes("from sources") && sql.includes("google_analytics_4")) {
        return (config.loneSources ?? []).map((id) => ({ id })) as T[];
      }
      if (sql.includes("from queryable.vw_site_traffic")) {
        return [{ page_views: "120" }] as T[];
      }
      // Existence probe / key_events probe — say data exists so no no-data caveat fires.
      if (sql.includes("from ga4_report_snapshot_fact")) {
        return [{ "?column?": 1 }] as T[];
      }
      return [] as T[];
    },
    async one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
      // The url/id match query binds siteUrlOrId as $2; assert it so a wrong param bind
      // (e.g. resolver passing the metric instead of the site) fails the test. Only the
      // requested site resolves — any other lookup value misses, mirroring real SQL.
      if (sql.includes("from workspace_sites") && sql.includes("(url = $2 or id = $2)")) {
        return params?.[1] === config.siteUrl ? ({ ga4_source_id: config.ga4SourceId } as T) : null;
      }
      // The primary-site fallback query binds only workspaceId ($1) and selects on
      // is_primary; the resolver tests do not exercise a separate primary row, so it misses.
      if (sql.includes("from workspace_sites")) {
        return null;
      }
      return null;
    },
    async close() {},
    async ensureWorkspace() {},
    async ensureFirstPhaseDatasets() {},
    async connectSource() {
      return null as never;
    },
    async updateSourceStatus() {},
    async createJob() {
      return {};
    },
    async claimNextJob() {
      return null;
    },
    async completeJob() {},
    async withTransaction(fn) {
      return fn(this);
    }
  };
}

// Fake DB for no-data / multi-site classification: drives the aggregate result, the
// existence probe, the key_events historical probe, and the GA4-source count.
function ga4ProbeFakeDb(
  queries: Array<{ sql: string; params?: unknown[] }>,
  config: {
    aggregateRows?: Record<string, unknown>[];
    factHasRows?: boolean;
    probeHasRows?: boolean;
    ga4SourceCount?: number;
    keyEventsEverConfigured?: boolean;
  }
): InfiniteOsDb {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      queries.push({ sql, params });
      if (sql.includes("from sources") && sql.includes("google_analytics_4")) {
        const count = config.ga4SourceCount ?? 1;
        return Array.from({ length: count }, (_, i) => ({ id: `src_ga4_${i}` })) as T[];
      }
      // key_events historical probe.
      if (sql.includes("key_events > 0")) {
        return (config.keyEventsEverConfigured ? [{ "?column?": 1 }] : []) as T[];
      }
      // Existence probe (select 1 ... limit 1) against either GA4 fact table.
      if (
        (sql.includes("from ga4_report_snapshot_fact") || sql.includes("from ga4_page_report_fact")) &&
        sql.includes("select 1")
      ) {
        const hasRows = config.probeHasRows ?? config.factHasRows ?? false;
        return (hasRows ? [{ "?column?": 1 }] : []) as T[];
      }
      // Drilldown rows (richer select) — return whatever; presence is enough.
      if (sql.includes("from ga4_report_snapshot_fact") || sql.includes("from ga4_page_report_fact")) {
        return [] as T[];
      }
      // Aggregate against the queryable view.
      if (sql.includes("from queryable.vw_site_traffic") || sql.includes("from queryable.vw_site_pages")) {
        return (config.aggregateRows ?? [{ page_views: "120" }]) as T[];
      }
      return [] as T[];
    },
    async one() {
      return null;
    },
    async close() {},
    async ensureWorkspace() {},
    async ensureFirstPhaseDatasets() {},
    async connectSource() {
      return null as never;
    },
    async updateSourceStatus() {},
    async createJob() {
      return {};
    },
    async claimNextJob() {
      return null;
    },
    async completeJob() {},
    async withTransaction(fn) {
      return fn(this);
    }
  };
}

function ga4PageFakeDb(queries: Array<{ sql: string; params?: unknown[] }>): InfiniteOsDb {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      queries.push({ sql, params });
      if (sql.includes("from queryable.vw_site_pages")) {
        return [{ page_views_by_page: "180" }] as T[];
      }
      return [] as T[];
    },
    async one() {
      return null;
    },
    async close() {},
    async ensureWorkspace() {},
    async ensureFirstPhaseDatasets() {},
    async connectSource() {
      return null as never;
    },
    async updateSourceStatus() {},
    async createJob() {
      return {};
    },
    async claimNextJob() {
      return null;
    },
    async completeJob() {},
    async withTransaction(fn) {
      return fn(this);
    }
  };
}

function ga4TrafficFakeDb(queries: Array<{ sql: string; params?: unknown[] }>): InfiniteOsDb {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      queries.push({ sql, params });
      if (sql.includes("from queryable.vw_site_traffic")) {
        return [{ page_views: "120" }] as T[];
      }
      return [] as T[];
    },
    async one() {
      return null;
    },
    async close() {},
    async ensureWorkspace() {},
    async ensureFirstPhaseDatasets() {},
    async connectSource() {
      return null as never;
    },
    async updateSourceStatus() {},
    async createJob() {
      return {};
    },
    async claimNextJob() {
      return null;
    },
    async completeJob() {},
    async withTransaction(fn) {
      return fn(this);
    }
  };
}

// COMPARISON — a db that returns metric values keyed by the inclusive date range present
// in the SQL params, so the primary and prior-range runAggregate calls can be told apart.
function comparisonFakeDb(
  view: string,
  metric: string,
  byRange: Record<string, Record<string, unknown> | null>,
  queries: Array<{ sql: string; params?: unknown[] }>
): InfiniteOsDb {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      queries.push({ sql, params });
      if (sql.includes(`from ${view}`)) {
        // Params for an ungrouped query: [workspace, ...filterValues, limit]. The two
        // date bounds (gte then lte) are the filter values; key by "gte..lte".
        const values = (params ?? []).slice(1, -1).map((value) => String(value));
        const gte = values.find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
        const lte = [...values].reverse().find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
        const key = `${gte}..${lte}`;
        const row = byRange[key];
        return (row ? [row] : []) as T[];
      }
      return [] as T[];
    },
    async one() {
      return null;
    },
    async close() {},
    async ensureWorkspace() {},
    async ensureFirstPhaseDatasets() {},
    async connectSource() {
      return null as never;
    },
    async updateSourceStatus() {},
    async createJob() {
      return {};
    },
    async claimNextJob() {
      return null;
    },
    async completeJob() {},
    async withTransaction(fn) {
      return fn(this);
    }
  };
}

const COMPARISON_CONTEXT = {
  workspaceId: "workspace",
  authority: "tool_agent",
  surface: "api",
  actorId: "operator",
  sessionId: "session"
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────
// Phase-2 slice-1a Stage-1 — the grain-aware view resolver (spec §5, the keystone).
//
// This stage adds the CAPABILITY (metric→view selection now depends on grain) with NO behavior
// change: the adset views do not exist on disk yet, so every existing query must keep resolving
// to its campaign view byte-for-byte. These tests are the keystone REGRESSION GATE:
//   (1) metricViewForGrain defaults to campaign for every metric when no adset dim is present;
//   (2) the loosened metric/view guard accepts the campaign view AND the adset sibling, and
//       still rejects an unrelated view;
//   (3) an adset_id/adset_name group-by (or filter — §5e) flips view selection to the adset
//       sibling, while a campaign-only group-by stays campaign;
//   (4) roas_from_stripe is forced campaign-grain even with an adset dim present (§5e/§10);
//   (5) the worker's no-group-by entry point (metricView) is unchanged (§5d — pinned here so a
//       regression in the campaign-default shim fails in this suite, not just the worker suite).
// ─────────────────────────────────────────────────────────────────────────────────────────
describe("Phase-2 §5 grain-aware view resolver (Stage-1 keystone)", () => {
  const ctx = {
    workspaceId: "workspace",
    authority: "tool_agent" as const,
    surface: "api" as const,
    actorId: "operator",
    sessionId: "session"
  };

  // The Meta metric families that have an adset sibling view this slice.
  const META_DELIVERY_METRICS = [
    "meta_ads_spend",
    "meta_ads_clicks",
    "impressions",
    "reach",
    "cpm",
    "cpc",
    "ctr",
    "link_clicks",
    "landing_page_views",
    "frequency"
  ] as const;
  const META_CONVERSION_METRICS = ["results", "cost_per_result", "conversion_value", "roas"] as const;
  // Every first-phase metric id (so the regression test proves the campaign default is total).
  const ALL_METRICS = [
    "site_visitors",
    "page_views",
    "new_users",
    "engaged_sessions",
    "key_events",
    "engagement_rate",
    "average_session_duration",
    "page_views_by_page",
    "posthog_event_count",
    "recognized_revenue",
    "shopify_gross_sales",
    "shopify_order_count",
    "roas_from_stripe",
    "x_public_engagement",
    "x_post_count",
    "x_comment_count",
    "x_follower_count",
    ...META_DELIVERY_METRICS,
    ...META_CONVERSION_METRICS
  ] as const;

  describe("REGRESSION: campaign default (no adset dim → metricView byte-for-byte)", () => {
    it("metricViewForGrain(metric, [], []) === metricView(metric) for EVERY metric", () => {
      // The no-regression contract: with no group-by and no filters, the resolver MUST return
      // exactly today's campaign default for every metric (no view ever changes).
      for (const metric of ALL_METRICS) {
        expect(metricViewForGrain(metric, [], [])).toBe(metricView(metric));
      }
    });

    it("a campaign-only group-by/filter still resolves to the campaign view", () => {
      // Campaign-grain breakdowns (campaign_id / campaign_name / occurred_on / result_type)
      // must NOT flip to the adset view — only an adset_id/adset_name dim does.
      for (const metric of META_DELIVERY_METRICS) {
        expect(metricViewForGrain(metric, ["campaign_id"], [])).toBe("queryable.vw_meta_ads_campaign_daily");
        expect(metricViewForGrain(metric, ["campaign_name", "occurred_on"], [])).toBe(
          "queryable.vw_meta_ads_campaign_daily"
        );
        expect(metricViewForGrain(metric, [], [{ field: "campaign_id" }])).toBe(
          "queryable.vw_meta_ads_campaign_daily"
        );
      }
      for (const metric of META_CONVERSION_METRICS) {
        expect(metricViewForGrain(metric, ["campaign_id", "result_type"], [])).toBe(
          "queryable.vw_meta_ads_campaign_conversions_daily"
        );
      }
    });

    it("metricView is UNCHANGED (§5d — the worker's no-group-by campaign shim)", () => {
      // The worker calls metricView(metric) with no group-by; pinning these here means a
      // regression in the campaign-default shim fails in the engine suite directly.
      for (const metric of META_DELIVERY_METRICS) {
        expect(metricView(metric)).toBe("queryable.vw_meta_ads_campaign_daily");
      }
      for (const metric of META_CONVERSION_METRICS) {
        expect(metricView(metric)).toBe("queryable.vw_meta_ads_campaign_conversions_daily");
      }
      expect(metricView("roas_from_stripe")).toBe("queryable.vw_meta_stripe_campaign_value_daily");
    });
  });

  describe("§5a: an adset dim flips view selection to the adset sibling", () => {
    it("an adset_id/adset_name group-by routes Meta delivery metrics to vw_meta_ads_adset_daily", () => {
      for (const metric of META_DELIVERY_METRICS) {
        expect(metricViewForGrain(metric, ["adset_id"], [])).toBe("queryable.vw_meta_ads_adset_daily");
        expect(metricViewForGrain(metric, ["adset_name"], [])).toBe("queryable.vw_meta_ads_adset_daily");
        // alias forms (adset / ad_set) normalize to adset_name and still flip.
        expect(metricViewForGrain(metric, ["adset"], [])).toBe("queryable.vw_meta_ads_adset_daily");
      }
    });

    it("an adset_id group-by routes the conversion family to vw_meta_ads_adset_conversions_daily", () => {
      for (const metric of META_CONVERSION_METRICS) {
        expect(metricViewForGrain(metric, ["adset_id", "result_type"], [])).toBe(
          "queryable.vw_meta_ads_adset_conversions_daily"
        );
      }
    });

    it("§5e: an adset dim in a FILTER (no group-by) also flips to the adset view", () => {
      // run_metric_query has no group-by; a filter like effective_status=ACTIVE pinned with an
      // adset_id filter must still select the adset view so the status/adset dims are queryable.
      expect(metricViewForGrain("cost_per_result", [], [{ field: "adset_id" }])).toBe(
        "queryable.vw_meta_ads_adset_conversions_daily"
      );
      expect(metricViewForGrain("meta_ads_spend", [], [{ field: "adset_name" }])).toBe(
        "queryable.vw_meta_ads_adset_daily"
      );
    });

    it("§5e: coarser campaign_id FILTER + finer adset_id GROUP-BY resolves to the adset view", () => {
      // "spend per adset within campaign X": the group-by drives the grain to adset; campaign_id
      // is a carry dim on the adset view, so the filter still applies there.
      expect(metricViewForGrain("meta_ads_spend", ["adset_id"], [{ field: "campaign_id" }])).toBe(
        "queryable.vw_meta_ads_adset_daily"
      );
    });

    it("§5e/§10: roas_from_stripe stays campaign-grain even with an adset dim (no adset sibling)", () => {
      // Its view (vw_meta_stripe_campaign_value_daily) has no adset sibling; swapping would 404.
      expect(metricViewForGrain("roas_from_stripe", ["adset_id"], [])).toBe(
        "queryable.vw_meta_stripe_campaign_value_daily"
      );
      expect(metricViewForGrain("roas_from_stripe", [], [{ field: "adset_id" }])).toBe(
        "queryable.vw_meta_stripe_campaign_value_daily"
      );
    });

    it("non-Meta metrics never flip even if an adset_id dim is (nonsensically) passed", () => {
      // A non-Meta metric has no adset sibling, so its family is a single view — stays put.
      expect(metricViewForGrain("page_views", ["adset_id"], [])).toBe("queryable.vw_site_traffic");
      expect(metricViewForGrain("shopify_order_count", ["adset_id"], [])).toBe("queryable.vw_shopify_orders");
    });
  });

  // Phase-2 slice-1b §5 — the AD grain (the finest, third grain). The resolver now picks
  // ad > adset > campaign (finest-grain-wins). These tests pin: (a) an ad_id/ad_name dim routes
  // Meta metrics to the ad view; (b) PRECEDENCE — adset_id + ad_id resolves to ad, and a coarser
  // campaign_id/adset_id FILTER + finer ad_id GROUP-BY resolves to ad (the coarse dims are
  // carries at ad grain); (c) the grain family now spans up to 3 views; (d) roas_from_stripe
  // and non-Meta metrics still never flip to an ad view.
  describe("§5 slice-1b: an ad dim flips view selection to the ad sibling (finest grain wins)", () => {
    it("an ad_id/ad_name group-by routes Meta delivery metrics to vw_meta_ads_ad_daily", () => {
      for (const metric of META_DELIVERY_METRICS) {
        expect(metricViewForGrain(metric, ["ad_id"], [])).toBe("queryable.vw_meta_ads_ad_daily");
        expect(metricViewForGrain(metric, ["ad_name"], [])).toBe("queryable.vw_meta_ads_ad_daily");
        // alias forms (ad / creative / creative_name) normalize to ad_name and still flip.
        expect(metricViewForGrain(metric, ["ad"], [])).toBe("queryable.vw_meta_ads_ad_daily");
        expect(metricViewForGrain(metric, ["creative_name"], [])).toBe("queryable.vw_meta_ads_ad_daily");
      }
    });

    it("an ad_id group-by routes the conversion family to vw_meta_ads_ad_conversions_daily", () => {
      for (const metric of META_CONVERSION_METRICS) {
        expect(metricViewForGrain(metric, ["ad_id", "result_type"], [])).toBe(
          "queryable.vw_meta_ads_ad_conversions_daily"
        );
      }
    });

    it("§5e: an ad dim in a FILTER (no group-by) also flips to the ad view", () => {
      expect(metricViewForGrain("cost_per_result", [], [{ field: "ad_id" }])).toBe(
        "queryable.vw_meta_ads_ad_conversions_daily"
      );
      expect(metricViewForGrain("meta_ads_spend", [], [{ field: "ad_name" }])).toBe(
        "queryable.vw_meta_ads_ad_daily"
      );
    });

    it("§5e PRECEDENCE: adset_id + ad_id co-occur → AD view (finest wins, adset_id is a carry)", () => {
      // The ad-dim check runs FIRST and returns early; adset_id never re-flips the picker.
      expect(metricViewForGrain("meta_ads_spend", ["adset_id", "ad_id"], [])).toBe(
        "queryable.vw_meta_ads_ad_daily"
      );
      expect(metricViewForGrain("cost_per_result", ["adset_id", "ad_id", "result_type"], [])).toBe(
        "queryable.vw_meta_ads_ad_conversions_daily"
      );
    });

    it("§5e PRECEDENCE: coarser campaign_id/adset_id FILTER + finer ad_id GROUP-BY → AD view", () => {
      // "spend per ad within campaign X" / "within adset Y": the group-by drives the grain to ad;
      // campaign_id/adset_id are carry dims on the ad view, so the filters still apply there.
      expect(metricViewForGrain("meta_ads_spend", ["ad_id"], [{ field: "campaign_id" }])).toBe(
        "queryable.vw_meta_ads_ad_daily"
      );
      expect(metricViewForGrain("meta_ads_spend", ["ad_id"], [{ field: "adset_id" }])).toBe(
        "queryable.vw_meta_ads_ad_daily"
      );
    });

    it("§5e/§10: roas_from_stripe stays campaign-grain even with an ad dim (no ad sibling)", () => {
      expect(metricViewForGrain("roas_from_stripe", ["ad_id"], [])).toBe(
        "queryable.vw_meta_stripe_campaign_value_daily"
      );
      expect(metricViewForGrain("roas_from_stripe", [], [{ field: "ad_id" }])).toBe(
        "queryable.vw_meta_stripe_campaign_value_daily"
      );
    });

    it("non-Meta metrics never flip even if an ad_id dim is (nonsensically) passed", () => {
      expect(metricViewForGrain("page_views", ["ad_id"], [])).toBe("queryable.vw_site_traffic");
      expect(metricViewForGrain("shopify_order_count", ["ad_id"], [])).toBe("queryable.vw_shopify_orders");
    });

    it("REGRESSION: adset routing is unchanged when no ad dim is present (finest-wins is layered)", () => {
      // The slice-1a adset behavior must survive the slice-1b layering: an adset_id alone still
      // routes to the adset view (the ad branch is skipped because no ad dim is present).
      for (const metric of META_DELIVERY_METRICS) {
        expect(metricViewForGrain(metric, ["adset_id"], [])).toBe("queryable.vw_meta_ads_adset_daily");
      }
      for (const metric of META_CONVERSION_METRICS) {
        expect(metricViewForGrain(metric, ["adset_id", "result_type"], [])).toBe(
          "queryable.vw_meta_ads_adset_conversions_daily"
        );
      }
    });
  });

  describe("§5b: the grain-FAMILY guard (rejectMetricViewMismatch via the handlers)", () => {
    // rejectMetricViewMismatch is internal; we exercise it through run_metric_query's `view`
    // override, which calls it directly. A view IN the metric's grain family is accepted; an
    // unrelated view is rejected with unsupported_view_for_metric:*.
    function passthroughDb(): InfiniteOsDb {
      return {
        async query() {
          return [];
        },
        async one() {
          return null;
        },
        async close() {},
        async ensureWorkspace() {},
        async ensureFirstPhaseDatasets() {},
        async connectSource() {
          return null as never;
        },
        async updateSourceStatus() {},
        async createJob() {
          return {};
        },
        async claimNextJob() {
          return null;
        },
        async completeJob() {},
        async withTransaction(fn) {
          return fn(this);
        }
      };
    }

    it("accepts the CAMPAIGN view for a Meta conversion metric (the family base)", async () => {
      const handlers = createActionHandlers(passthroughDb());
      const result = await handlers.run_metric_query?.(
        {
          metric: "results",
          view: "queryable.vw_meta_ads_campaign_conversions_daily",
          filters: [{ field: "result_type", operator: "equals", value: "lead" }]
        },
        ctx
      );
      expect(result?.data).toMatchObject({ view: "queryable.vw_meta_ads_campaign_conversions_daily" });
    });

    it("accepts the ADSET SIBLING view for the same metric (the loosened family check)", async () => {
      const handlers = createActionHandlers(passthroughDb());
      const result = await handlers.run_metric_query?.(
        {
          metric: "results",
          view: "queryable.vw_meta_ads_adset_conversions_daily",
          filters: [{ field: "result_type", operator: "equals", value: "lead" }]
        },
        ctx
      );
      expect(result?.data).toMatchObject({ view: "queryable.vw_meta_ads_adset_conversions_daily" });
    });

    it("REJECTS a view outside the metric's grain family", async () => {
      const handlers = createActionHandlers(passthroughDb());
      // results belongs to the conversions family; the delivery adset view is NOT in it.
      await expect(
        handlers.run_metric_query?.(
          {
            metric: "results",
            view: "queryable.vw_meta_ads_adset_daily",
            filters: [{ field: "result_type", operator: "equals", value: "lead" }]
          },
          ctx
        )
      ).rejects.toThrow(/unsupported_view_for_metric:results:queryable\.vw_meta_ads_adset_daily/);
    });

    it("REJECTS the adset view for roas_from_stripe (campaign-only family)", async () => {
      const handlers = createActionHandlers(passthroughDb());
      await expect(
        handlers.run_metric_query?.(
          { metric: "roas_from_stripe", view: "queryable.vw_meta_ads_adset_conversions_daily" },
          ctx
        )
      ).rejects.toThrow(/unsupported_view_for_metric:roas_from_stripe/);
    });

    it("§5b slice-1b: accepts the AD SIBLING view for the same metric (family now spans 3)", async () => {
      // The grain family loosened one more notch: the ad conversions view is in `results`' family.
      const handlers = createActionHandlers(passthroughDb());
      const result = await handlers.run_metric_query?.(
        {
          metric: "results",
          view: "queryable.vw_meta_ads_ad_conversions_daily",
          filters: [{ field: "result_type", operator: "equals", value: "lead" }]
        },
        ctx
      );
      expect(result?.data).toMatchObject({ view: "queryable.vw_meta_ads_ad_conversions_daily" });
    });

    it("§5b slice-1b: REJECTS the AD DELIVERY view for a conversion metric (cross-family)", async () => {
      // results belongs to the conversions family; the ad DELIVERY view is NOT in it (same guard
      // that rejects the adset delivery view, extended to ad grain).
      const handlers = createActionHandlers(passthroughDb());
      await expect(
        handlers.run_metric_query?.(
          {
            metric: "results",
            view: "queryable.vw_meta_ads_ad_daily",
            filters: [{ field: "result_type", operator: "equals", value: "lead" }]
          },
          ctx
        )
      ).rejects.toThrow(/unsupported_view_for_metric:results:queryable\.vw_meta_ads_ad_daily/);
    });

    it("§5b slice-1b: REJECTS the ad view for roas_from_stripe (campaign-only family)", async () => {
      const handlers = createActionHandlers(passthroughDb());
      await expect(
        handlers.run_metric_query?.(
          { metric: "roas_from_stripe", view: "queryable.vw_meta_ads_ad_conversions_daily" },
          ctx
        )
      ).rejects.toThrow(/unsupported_view_for_metric:roas_from_stripe/);
    });
  });

  describe("§5a end-to-end: run_breakdown_query routes by group-by grain", () => {
    function routingFakeDb(queries: Array<{ sql: string }>): InfiniteOsDb {
      return {
        async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
          queries.push({ sql });
          return [] as T[];
        },
        async one() {
          return null;
        },
        async close() {},
        async ensureWorkspace() {},
        async ensureFirstPhaseDatasets() {},
        async connectSource() {
          return null as never;
        },
        async updateSourceStatus() {},
        async createJob() {
          return {};
        },
        async claimNextJob() {
          return null;
        },
        async completeJob() {},
        async withTransaction(fn) {
          return fn(this);
        }
      };
    }

    it("groupBy=[campaign_id] queries the CAMPAIGN delivery view", async () => {
      const queries: Array<{ sql: string }> = [];
      const handlers = createActionHandlers(routingFakeDb(queries));
      const result = await handlers.run_breakdown_query?.(
        { metric: "meta_ads_spend", groupBy: ["campaign_id"] },
        ctx
      );
      expect(result?.data).toMatchObject({ view: "queryable.vw_meta_ads_campaign_daily" });
      expect(queries.some((q) => q.sql.includes("from queryable.vw_meta_ads_campaign_daily"))).toBe(true);
      expect(queries.every((q) => !q.sql.includes("from queryable.vw_meta_ads_adset_daily"))).toBe(true);
    });

    it("groupBy=[adset_id] queries the ADSET delivery view (the primary grain seam)", async () => {
      const queries: Array<{ sql: string }> = [];
      const handlers = createActionHandlers(routingFakeDb(queries));
      const result = await handlers.run_breakdown_query?.(
        { metric: "meta_ads_spend", groupBy: ["adset_id"] },
        ctx
      );
      expect(result?.data).toMatchObject({ view: "queryable.vw_meta_ads_adset_daily" });
      const sql = queries.find((q) => q.sql.includes("from queryable.vw_meta_ads_adset_daily"))?.sql;
      expect(sql).toBeDefined();
      // adset_id is in the adset view's allowed dims, so the group column is emitted (not
      // rejected as unsupported_dimension).
      expect(sql).toContain("adset_id as adset_id");
    });

    it("groupBy=[adset_id, result_type] queries the ADSET conversions view (partition satisfied)", async () => {
      const queries: Array<{ sql: string }> = [];
      const handlers = createActionHandlers(routingFakeDb(queries));
      const result = await handlers.run_breakdown_query?.(
        { metric: "cost_per_result", groupBy: ["adset_id", "result_type"] },
        ctx
      );
      expect(result?.data).toMatchObject({ view: "queryable.vw_meta_ads_adset_conversions_daily" });
      const sql = queries.find((q) => q.sql.includes("from queryable.vw_meta_ads_adset_conversions_daily"))?.sql;
      expect(sql).toBeDefined();
      // the recompute-from-summed-bases expression is byte-identical at adset grain (only the
      // view name swapped) — the no-rewrite-of-expressions guarantee.
      expect(sql).toContain("sum(meta_ads_spend) / nullif(sum(results), 0) as cost_per_result");
      expect(sql).toContain("group by");
      expect(sql).toContain("result_type");
    });

    it("a status group-by on the adset view is allowed (on/off as a dimension, §6/§7)", async () => {
      const queries: Array<{ sql: string }> = [];
      const handlers = createActionHandlers(routingFakeDb(queries));
      const result = await handlers.run_breakdown_query?.(
        { metric: "meta_ads_spend", groupBy: ["adset_id", "effective_status"] },
        ctx
      );
      expect(result?.data).toMatchObject({ view: "queryable.vw_meta_ads_adset_daily" });
      const sql = queries.find((q) => q.sql.includes("from queryable.vw_meta_ads_adset_daily"))?.sql;
      expect(sql).toContain("effective_status as effective_status");
    });

    it("an effective_status FILTER on the adset view passes runAggregate's gate (\"ACTIVE adsets\")", async () => {
      const queries: Array<{ sql: string }> = [];
      const handlers = createActionHandlers(routingFakeDb(queries));
      // "CPL for my ACTIVE adsets": group adset_id+result_type, filter effective_status=ACTIVE.
      const result = await handlers.run_breakdown_query?.(
        {
          metric: "cost_per_result",
          groupBy: ["adset_id", "result_type"],
          filters: [{ field: "effective_status", operator: "equals", value: "ACTIVE" }]
        },
        ctx
      );
      expect(result?.data).toMatchObject({ view: "queryable.vw_meta_ads_adset_conversions_daily" });
      const sql = queries.find((q) => q.sql.includes("from queryable.vw_meta_ads_adset_conversions_daily"))?.sql;
      // the status filter is rendered into the WHERE clause (not rejected as unsupported).
      expect(sql).toContain("effective_status =");
    });
  });
});

// Phase-2 slice-1a Stage-3 — §9 ACCEPTANCE (the validation gate).
//
// Stage-1 proved the resolver CAPABILITY (view selection depends on grain) and Stage-2 proved
// the connector populates the adset grain + status. This block is the spec §9 acceptance suite
// that pins the END-TO-END contracts the slice promises, exercised through the action registry
// (run_metric_query / run_breakdown_query) so a regression in routing, the partition guard, the
// recompute-from-sums expression, or status surfacing fails HERE:
//   (1) Routing — run_breakdown_query(roas, groupBy=[adset_id, result_type]) hits the ADSET
//       conversions view; groupBy=[campaign_id] stays campaign; the worker saved-report stays
//       campaign-grain (§5d, asserted in apps/worker — pinned here via metricView).
//   (2) Divergence fixture (§1/§9) — an adset query reads the adset view and a campaign query
//       reads the campaign view; the engine NEVER unions/joins the two grains, so adset-summed
//       results can legitimately diverge from the campaign total without the engine deriving one
//       from the other.
//   (3) result_type partition still enforced AT ADSET GRAIN — cost_per_result/roas grouped by
//       adset_id (but NOT result_type) is REFUSED (cross-type blend never happens at any grain).
//   (4) Ratio-revert guard still holds at adset grain — the recompute-from-summed-bases SQL is
//       byte-identical on the adset view (only the view NAME swapped); no avg-of-ratios revert.
//   (5) Status surfacing (§6/§7) — effective_status is a queryable filter AND a returned column
//       so the controller can scope to ACTIVE adsets AND label a paused adset as paused (its
//       status rides back in the row), rather than calling its low spend "underperformance."
// ─────────────────────────────────────────────────────────────────────────────────────────
describe("Phase-2 §9 acceptance — adset grain + on/off status (Stage-3)", () => {
  const ctx = {
    workspaceId: "workspace",
    authority: "tool_agent" as const,
    surface: "api" as const,
    actorId: "operator",
    sessionId: "session"
  };

  // A db stub that records every emitted SQL and returns canned rows for a view predicate. The
  // predicate→rows map lets one db answer BOTH a campaign and an adset query distinctly so the
  // divergence fixture can prove the two grains are read from SEPARATE views.
  function recordingDb(
    queries: Array<{ sql: string; params: unknown[] }>,
    rowsByViewPredicate: Array<{ match: string; rows: Record<string, unknown>[] }> = []
  ): InfiniteOsDb {
    return {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        queries.push({ sql, params });
        for (const entry of rowsByViewPredicate) {
          if (sql.includes(entry.match)) {
            return entry.rows as T[];
          }
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
  }

  describe("(1) routing — the §9 named cases", () => {
    it("run_breakdown_query(roas, groupBy=[adset_id, result_type]) hits vw_meta_ads_adset_conversions_daily", async () => {
      // The spec names roas explicitly. result_type is its required partition, so the acceptance
      // query groups by it too; the routing is driven by the adset_id group-by.
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      const registry = createInfiniteOsRegistry(createActionHandlers(recordingDb(queries)));
      const result = await registry.execute(
        "run_breakdown_query",
        { metric: "roas", groupBy: ["adset_id", "result_type"] },
        ctx
      );
      expect(result.status).toBe("ok");
      expect((result.data as { view: string }).view).toBe("queryable.vw_meta_ads_adset_conversions_daily");
      const sql = queries.find((q) => q.sql.includes("from queryable.vw_meta_ads_adset_conversions_daily"))?.sql;
      expect(sql).toBeDefined();
      // The roas expression is the recompute-from-summed-bases ratio, byte-identical at adset grain.
      expect(sql).toContain("sum(conversion_value) / nullif(sum(meta_ads_spend), 0) as roas");
      // It never touches the campaign conversions view.
      expect(queries.every((q) => !q.sql.includes("from queryable.vw_meta_ads_campaign_conversions_daily"))).toBe(
        true
      );
    });

    it("run_breakdown_query(roas, groupBy=[campaign_id, result_type]) STAYS on the campaign view", async () => {
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      const registry = createInfiniteOsRegistry(createActionHandlers(recordingDb(queries)));
      const result = await registry.execute(
        "run_breakdown_query",
        { metric: "roas", groupBy: ["campaign_id", "result_type"] },
        ctx
      );
      expect(result.status).toBe("ok");
      expect((result.data as { view: string }).view).toBe("queryable.vw_meta_ads_campaign_conversions_daily");
      expect(queries.every((q) => !q.sql.includes("from queryable.vw_meta_ads_adset_conversions_daily"))).toBe(true);
    });

    it("§5d — the worker saved-report entry point (metricView, no group-by) stays campaign-grain for Meta metrics", () => {
      // runSavedReport calls metricView(metric) with no group-by; the adset views are NEVER
      // reachable from there. Pinning the campaign default here means a regression that lets a
      // Meta saved report drift to the adset view fails in the engine suite, not only the worker.
      for (const metric of ["meta_ads_spend", "impressions", "cpm", "link_clicks", "frequency"]) {
        expect(metricView(metric)).toBe("queryable.vw_meta_ads_campaign_daily");
      }
      for (const metric of ["results", "cost_per_result", "conversion_value", "roas"]) {
        expect(metricView(metric)).toBe("queryable.vw_meta_ads_campaign_conversions_daily");
      }
    });
  });

  describe("(2) divergence fixture — engine reads separate grains, never derives one from the other", () => {
    it("adset-summed results CAN diverge from the campaign total; the two are read from SEPARATE views", async () => {
      // §1: Meta dedups conversions only WITHIN an ad set, so adset sums can exceed the campaign
      // total. Fixture for one campaign/day, result_type=lead:
      //   campaign view reports  results = 5  (Meta-deduped at campaign grain)
      //   adset A reports         results = 4
      //   adset B reports         results = 4   -> adset sum = 8 ≠ campaign 5
      // The engine must answer a campaign query from the campaign view (5) and an adset breakdown
      // from the adset view (4 + 4), and must NEVER union/join the two grains to reconcile them.
      const campaignRows = [{ result_type: "lead", results: 5 }];
      const adsetRows = [
        { adset_id: "as_A", result_type: "lead", results: 4 },
        { adset_id: "as_B", result_type: "lead", results: 4 }
      ];
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      const registry = createInfiniteOsRegistry(
        createActionHandlers(
          recordingDb(queries, [
            { match: "from queryable.vw_meta_ads_adset_conversions_daily", rows: adsetRows },
            { match: "from queryable.vw_meta_ads_campaign_conversions_daily", rows: campaignRows }
          ])
        )
      );

      // (a) campaign breakdown -> campaign view, total = 5.
      const campaignResult = await registry.execute(
        "run_breakdown_query",
        { metric: "results", groupBy: ["campaign_id", "result_type"] },
        ctx
      );
      expect((campaignResult.data as { view: string }).view).toBe(
        "queryable.vw_meta_ads_campaign_conversions_daily"
      );
      const campaignResultRows = (campaignResult.data as { rows: Array<{ results: number }> }).rows;
      expect(campaignResultRows.reduce((sum, r) => sum + r.results, 0)).toBe(5);

      // (b) adset breakdown -> adset view, summed = 8 (≠ 5).
      const adsetResult = await registry.execute(
        "run_breakdown_query",
        { metric: "results", groupBy: ["adset_id", "result_type"] },
        ctx
      );
      expect((adsetResult.data as { view: string }).view).toBe(
        "queryable.vw_meta_ads_adset_conversions_daily"
      );
      const adsetResultRows = (adsetResult.data as { rows: Array<{ results: number }> }).rows;
      const adsetSum = adsetResultRows.reduce((sum, r) => sum + r.results, 0);
      expect(adsetSum).toBe(8);

      // The divergence is REAL and PRESERVED — the engine never reconciled adset->campaign.
      expect(adsetSum).not.toBe(5);

      // STRUCTURAL no-derivation proof: each query's SQL reads EXACTLY ONE grain view and never
      // joins/unions the other. No emitted statement reads both grain tables at once.
      for (const q of queries) {
        const readsCampaign = q.sql.includes("from queryable.vw_meta_ads_campaign_conversions_daily");
        const readsAdset = q.sql.includes("from queryable.vw_meta_ads_adset_conversions_daily");
        expect(readsCampaign && readsAdset).toBe(false);
        // No cross-grain join/union sneaks the other grain's table in either.
        if (readsAdset) {
          expect(q.sql).not.toContain("meta_ads_campaign_conversions_daily");
        }
        if (readsCampaign) {
          expect(q.sql).not.toContain("meta_ads_adset_conversions_daily");
        }
      }
    });
  });

  describe("(3) result_type partition is STILL enforced at adset grain (cross-type blend never happens)", () => {
    it("REFUSES cost_per_result/roas/results/conversion_value grouped by adset_id WITHOUT result_type", async () => {
      // The partition guard is metric-keyed and view-agnostic, so it carries over to adset grain
      // unchanged: grouping by adset_id but not result_type would blend CPL+CPA within each adset
      // -> refused with the same unsupported_partition error, before any SQL runs.
      const noopDb = (): InfiniteOsDb => ({
        async query() {
          throw new Error("query_should_not_run_when_partition_is_missing");
        },
        async one() {
          return null;
        },
        async close() {},
        async ensureWorkspace() {},
        async ensureFirstPhaseDatasets() {},
        async connectSource() {
          return null as never;
        },
        async updateSourceStatus() {},
        async createJob() {
          return {};
        },
        async claimNextJob() {
          return null;
        },
        async completeJob() {},
        async withTransaction(fn) {
          return fn(this);
        }
      });
      const registry = createInfiniteOsRegistry(createActionHandlers(noopDb()));
      for (const metric of ["cost_per_result", "roas", "results", "conversion_value"] as const) {
        await expect(
          registry.execute("run_breakdown_query", { metric, groupBy: ["adset_id"] }, ctx)
        ).rejects.toThrow(/unsupported_partition:result_type_required/);
      }
    });

    it("ALLOWS the adset query when result_type is pinned to a single value (no blend possible)", async () => {
      // "CPL by adset" satisfies the partition by filtering result_type=lead; routes to the adset
      // conversions view and computes the per-type ratio.
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      const registry = createInfiniteOsRegistry(
        createActionHandlers(
          recordingDb(queries, [
            {
              match: "from queryable.vw_meta_ads_adset_conversions_daily",
              rows: [
                { adset_id: "as_A", cost_per_result: 8 },
                { adset_id: "as_B", cost_per_result: 12 }
              ]
            }
          ])
        )
      );
      const result = await registry.execute(
        "run_breakdown_query",
        {
          metric: "cost_per_result",
          groupBy: ["adset_id"],
          filters: [{ field: "result_type", operator: "equals", value: "lead" }]
        },
        ctx
      );
      expect(result.status).toBe("ok");
      expect((result.data as { view: string }).view).toBe("queryable.vw_meta_ads_adset_conversions_daily");
    });
  });

  describe("(4) ratio-revert guard — recompute-from-sums is byte-identical at adset grain", () => {
    it("cpm/cpc/ctr/cost_per_result/roas/frequency emit the SAME SQL on the adset view (no avg-of-ratios)", async () => {
      // The whole no-rewrite-of-expressions guarantee depends on the adset views aliasing columns
      // identically; aggregateExpression is view-agnostic, so the emitted ratio SQL on the adset
      // view must be the exact recompute-from-summed-bases expression — never an avg(per-row).
      const cases: Array<{ metric: string; groupBy: string[]; view: string; expr: string }> = [
        {
          metric: "cpm",
          groupBy: ["adset_id"],
          view: "queryable.vw_meta_ads_adset_daily",
          expr: "sum(meta_ads_spend) / nullif(sum(impressions), 0) * 1000 as cpm"
        },
        {
          metric: "cpc",
          groupBy: ["adset_id"],
          view: "queryable.vw_meta_ads_adset_daily",
          expr: "sum(meta_ads_spend) / nullif(sum(meta_ads_clicks), 0) as cpc"
        },
        {
          metric: "ctr",
          groupBy: ["adset_id"],
          view: "queryable.vw_meta_ads_adset_daily",
          expr: "sum(meta_ads_clicks) / nullif(sum(impressions), 0) as ctr"
        },
        {
          metric: "frequency",
          groupBy: ["adset_id"],
          view: "queryable.vw_meta_ads_adset_daily",
          expr: "sum(impressions) / nullif(sum(reach), 0) as frequency"
        },
        {
          metric: "cost_per_result",
          groupBy: ["adset_id", "result_type"],
          view: "queryable.vw_meta_ads_adset_conversions_daily",
          expr: "sum(meta_ads_spend) / nullif(sum(results), 0) as cost_per_result"
        },
        {
          metric: "roas",
          groupBy: ["adset_id", "result_type"],
          view: "queryable.vw_meta_ads_adset_conversions_daily",
          expr: "sum(conversion_value) / nullif(sum(meta_ads_spend), 0) as roas"
        }
      ];
      for (const c of cases) {
        const queries: Array<{ sql: string; params: unknown[] }> = [];
        const registry = createInfiniteOsRegistry(createActionHandlers(recordingDb(queries)));
        const result = await registry.execute(
          "run_breakdown_query",
          { metric: c.metric, groupBy: c.groupBy },
          ctx
        );
        expect((result.data as { view: string }).view).toBe(c.view);
        const sql = queries.find((q) => q.sql.includes(`from ${c.view}`))?.sql;
        expect(sql, `${c.metric} should read ${c.view}`).toBeDefined();
        // The recompute-from-summed-bases expression is present verbatim on the adset view.
        expect(sql).toContain(c.expr);
        // No avg-of-ratios revert.
        expect(sql).not.toContain(`avg(${c.metric})`);
        // It matches the engine's own (view-agnostic) aggregateExpression for that metric.
        expect(sql).toContain(`${aggregateExpression(c.metric, metricColumn(c.metric))} as ${c.metric}`);
      }
    });
  });

  describe("(5) status surfacing (§6/§7) — filter to ACTIVE + label a paused adset as paused", () => {
    it('"CPL for my ACTIVE adsets" filters effective_status=ACTIVE and routes to the adset view', async () => {
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      const registry = createInfiniteOsRegistry(
        createActionHandlers(
          recordingDb(queries, [
            {
              match: "from queryable.vw_meta_ads_adset_conversions_daily",
              rows: [{ adset_id: "as_A", effective_status: "ACTIVE", result_type: "lead", cost_per_result: 9 }]
            }
          ])
        )
      );
      const result = await registry.execute(
        "run_breakdown_query",
        {
          metric: "cost_per_result",
          groupBy: ["adset_id", "result_type"],
          filters: [{ field: "effective_status", operator: "equals", value: "ACTIVE" }]
        },
        ctx
      );
      expect(result.status).toBe("ok");
      expect((result.data as { view: string }).view).toBe("queryable.vw_meta_ads_adset_conversions_daily");
      const sql = queries.find((q) => q.sql.includes("from queryable.vw_meta_ads_adset_conversions_daily"))?.sql;
      // The status filter renders into the WHERE clause (not rejected as unsupported_dimension),
      // and the filter value is bound as a parameter.
      expect(sql).toContain("effective_status =");
      const statusQuery = queries.find((q) => q.params.includes("ACTIVE"));
      expect(statusQuery).toBeDefined();
    });

    it("a status group-by RETURNS effective_status in the row so a paused adset is LABELED, not flagged a loser", async () => {
      // §7: the controller must be able to tell a paused adset from an underperforming one. The
      // engine surfaces effective_status as a returned column on the breakdown rows, so an adset
      // with low spend carries its PAUSED label back to the controller (which then labels it as
      // off rather than calling it "underperformance").
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      const registry = createInfiniteOsRegistry(
        createActionHandlers(
          recordingDb(queries, [
            {
              match: "from queryable.vw_meta_ads_adset_daily",
              rows: [
                { adset_id: "as_live", effective_status: "ACTIVE", meta_ads_spend: 1200 },
                { adset_id: "as_paused", effective_status: "PAUSED", meta_ads_spend: 3 }
              ]
            }
          ])
        )
      );
      const result = await registry.execute(
        "run_breakdown_query",
        { metric: "meta_ads_spend", groupBy: ["adset_id", "effective_status"] },
        ctx
      );
      expect(result.status).toBe("ok");
      expect((result.data as { view: string }).view).toBe("queryable.vw_meta_ads_adset_daily");
      const sql = queries.find((q) => q.sql.includes("from queryable.vw_meta_ads_adset_daily"))?.sql;
      // effective_status is selected as a grouped column so it rides back on every row.
      expect(sql).toContain("effective_status as effective_status");
      const rows = (result.data as { rows: Array<{ adset_id: string; effective_status: string }> }).rows;
      const paused = rows.find((r) => r.adset_id === "as_paused");
      // The low-spend adset is identifiable as PAUSED (a label), not just a low number.
      expect(paused?.effective_status).toBe("PAUSED");
    });
  });
});

describe("run_metric_query comparison (compareTo)", () => {
  describe("derivePriorRange", () => {
    it("derives the immediately preceding equal-length inclusive range (prior_period)", () => {
      // 2026-06-01..2026-06-07 is 7 inclusive days -> prior is 2026-05-25..2026-05-31.
      expect(derivePriorRange("2026-06-01", "2026-06-07", "prior_period")).toEqual({
        gte: "2026-05-25",
        lte: "2026-05-31"
      });
    });

    it("treats a single-day range as length 1 (prior_period)", () => {
      expect(derivePriorRange("2026-06-04", "2026-06-04", "prior_period")).toEqual({
        gte: "2026-06-03",
        lte: "2026-06-03"
      });
    });

    it("never overlaps or gaps the current range (prior_period is contiguous)", () => {
      const current = { gte: "2026-06-01", lte: "2026-06-30" };
      const prior = derivePriorRange(current.gte, current.lte, "prior_period");
      // prior.lte is exactly the day before current.gte; no overlap, no gap.
      expect(prior?.lte).toBe("2026-05-31");
      // inclusive length is preserved (30 days).
      const len = (Date.parse(`${prior?.lte}T00:00:00Z`) - Date.parse(`${prior?.gte}T00:00:00Z`)) / 86_400_000 + 1;
      expect(len).toBe(30);
    });

    it("shifts both bounds back one calendar year (prior_year), no leap-day drift", () => {
      expect(derivePriorRange("2026-02-01", "2026-02-28", "prior_year")).toEqual({
        gte: "2025-02-01",
        lte: "2025-02-28"
      });
    });

    it("clamps a leap-day bound to Feb-28 in a non-leap prior year (real SQL date, never '2023-02-29')", () => {
      // 2024-02-29 shifted to 2023 must NOT yield the literal "2023-02-29" (not a real date;
      // Postgres rejects it and the whole prior re-run throws). Clamp to 2023-02-28.
      expect(derivePriorRange("2024-02-29", "2024-02-29", "prior_year")).toEqual({
        gte: "2023-02-28",
        lte: "2023-02-28"
      });
      // A leap -> leap shift (2024 -> 2020) keeps Feb-29 intact.
      expect(derivePriorRange("2024-02-29", "2024-02-29", "prior_year")).not.toBeNull();
      expect(derivePriorRange("2028-02-29", "2028-02-29", "prior_year")).toEqual({
        gte: "2027-02-28",
        lte: "2027-02-28"
      });
    });

    it("rejects an inverted or malformed range", () => {
      expect(derivePriorRange("2026-06-07", "2026-06-01", "prior_period")).toBeNull();
      expect(derivePriorRange("not-a-date", "2026-06-07", "prior_period")).toBeNull();
      expect(derivePriorRange("not-a-date", "2026-06-07", "prior_year")).toBeNull();
    });
  });

  it("attaches a comparison block re-running the aggregate over the prior period", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      {
        "2026-06-01..2026-06-07": { recognized_revenue: "12000" }, // current
        "2026-05-25..2026-05-31": { recognized_revenue: "10000" } // prior
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );

    // Primary rows unchanged (envelope stays additive).
    expect((result?.data as { rows: unknown }).rows).toEqual([{ recognized_revenue: "12000" }]);
    const comparison = (result?.data as { comparison?: Record<string, unknown> }).comparison;
    expect(comparison).toMatchObject({
      mode: "prior_period",
      current: 12000,
      previous: 10000,
      absoluteDelta: 2000,
      percentDelta: 20,
      direction: "up",
      range: {
        current: { gte: "2026-06-01", lte: "2026-06-07" },
        previous: { gte: "2026-05-25", lte: "2026-05-31" }
      }
    });
    // Exactly two aggregate round-trips (primary + prior), both scoped to the same view.
    const aggregateRuns = queries.filter((entry) => entry.sql.includes("from queryable.vw_revenue_by_source"));
    expect(aggregateRuns).toHaveLength(2);
    // The prior query carries the derived prior bounds, not the current ones.
    expect(aggregateRuns[1]?.params).toEqual(["workspace", "2026-05-25", "2026-05-31", 500]);
    expect(result?.caveats).not.toContain("no_prior_baseline");
  });

  it("supports prior_year by shifting the year on both bounds", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      {
        "2026-06-01..2026-06-30": { recognized_revenue: "30000" },
        "2025-06-01..2025-06-30": { recognized_revenue: "25000" }
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        compareTo: "prior_year",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-30" }
        ]
      },
      COMPARISON_CONTEXT
    );
    expect((result?.data as { comparison?: Record<string, unknown> }).comparison).toMatchObject({
      mode: "prior_year",
      current: 30000,
      previous: 25000,
      absoluteDelta: 5000,
      percentDelta: 20,
      direction: "up",
      range: {
        previous: { gte: "2025-06-01", lte: "2025-06-30" }
      }
    });
  });

  it("guards a zero/empty previous baseline (no divide-by-zero; percentDelta null + no_prior_baseline)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      {
        "2026-06-01..2026-06-07": { recognized_revenue: "5000" } // current only; prior absent -> []
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    const comparison = (result?.data as { comparison?: Record<string, unknown> }).comparison;
    expect(comparison).toMatchObject({
      mode: "prior_period",
      current: 5000,
      previous: null,
      percentDelta: null,
      direction: "new"
    });
    // Never Infinity/NaN that the LLM could verbalize as a real percentage.
    expect((comparison as { percentDelta: unknown }).percentDelta).toBeNull();
    expect(result?.caveats).toContain("no_prior_baseline");
  });

  it("reports previous=0 as new (not -100% or Infinity)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      {
        "2026-06-01..2026-06-07": { recognized_revenue: "8000" },
        "2026-05-25..2026-05-31": { recognized_revenue: "0" }
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    const comparison = (result?.data as { comparison?: Record<string, unknown> }).comparison;
    expect(comparison).toMatchObject({
      current: 8000,
      previous: 0,
      absoluteDelta: 8000,
      percentDelta: null,
      direction: "new"
    });
    expect(result?.caveats).toContain("no_prior_baseline");
  });

  it("passes a null rate metric through honestly instead of zeroing it", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_site_traffic",
      "engagement_rate",
      {
        "2026-06-01..2026-06-07": { engagement_rate: "0.62" },
        "2026-05-25..2026-05-31": { engagement_rate: null } // legitimately null (zero sessions)
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "engagement_rate",
        view: "queryable.vw_site_traffic",
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    const comparison = (result?.data as { comparison?: Record<string, unknown> }).comparison;
    expect(comparison).toMatchObject({
      current: 0.62,
      previous: null, // NOT 0
      percentDelta: null,
      direction: "new"
    });
    expect(result?.caveats).toContain("no_prior_baseline");
  });

  it("reads X date bounds from published_at (not occurred_on) for the prior re-run", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_x_authored_activity",
      "x_post_count",
      {
        "2026-06-01..2026-06-07": { x_post_count: "14" },
        "2026-05-25..2026-05-31": { x_post_count: "10" }
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "x_post_count",
        view: "queryable.vw_x_authored_activity",
        compareTo: "prior_period",
        // The model expresses the range with the generic `date` alias; the engine
        // normalizes it to published_at for X views — comparison must follow that.
        filters: [
          { field: "date", operator: "gte", value: "2026-06-01" },
          { field: "date", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    expect((result?.data as { comparison?: Record<string, unknown> }).comparison).toMatchObject({
      current: 14,
      previous: 10,
      absoluteDelta: 4,
      direction: "up"
    });
    const aggregateRuns = queries.filter((entry) => entry.sql.includes("from queryable.vw_x_authored_activity"));
    expect(aggregateRuns).toHaveLength(2);
    expect(aggregateRuns[0]?.sql).toContain("published_at >=");
    expect(aggregateRuns[1]?.params).toEqual(["workspace", "2026-05-25", "2026-05-31", 500]);
  });

  it("omits the comparison block and adds comparison_requires_date_range when date bounds are missing", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      { "undefined..undefined": { recognized_revenue: "5000" } },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      { metric: "recognized_revenue", view: "queryable.vw_revenue_by_source", compareTo: "prior_period" },
      COMPARISON_CONTEXT
    );
    expect((result?.data as { comparison?: unknown }).comparison).toBeUndefined();
    expect(result?.caveats).toContain("comparison_requires_date_range");
    // Only the primary query ran — no second round-trip without a date range.
    expect(queries.filter((entry) => entry.sql.includes("from queryable.vw_revenue_by_source"))).toHaveLength(1);
  });

  it("is a no-op without compareTo (byte-identical to a plain query)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      { "2026-06-01..2026-06-07": { recognized_revenue: "12000" } },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    expect((result?.data as { comparison?: unknown }).comparison).toBeUndefined();
    expect(result?.caveats).not.toContain("comparison_requires_date_range");
    expect(result?.caveats).not.toContain("no_prior_baseline");
    expect(queries.filter((entry) => entry.sql.includes("from queryable.vw_revenue_by_source"))).toHaveLength(1);
  });

  it("runs the prior_year leap-day re-run end-to-end through the SQL handler (clamped bound, no crash)", async () => {
    // Regression for the major defect: the prior bound must be a REAL date the handler can
    // execute. 2024-02-29 -> 2023-02-28 (clamped); the prior aggregate runs with that bound.
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      {
        "2024-02-29..2024-02-29": { recognized_revenue: "4000" },
        "2023-02-28..2023-02-28": { recognized_revenue: "3000" }
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        compareTo: "prior_year",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2024-02-29" },
          { field: "occurred_on", operator: "lte", value: "2024-02-29" }
        ]
      },
      COMPARISON_CONTEXT
    );
    const comparison = (result?.data as { comparison?: Record<string, unknown> }).comparison;
    expect(comparison).toMatchObject({
      mode: "prior_year",
      current: 4000,
      previous: 3000,
      absoluteDelta: 1000,
      direction: "up",
      range: { previous: { gte: "2023-02-28", lte: "2023-02-28" } }
    });
    // The prior re-run actually executed and carried the CLAMPED bounds, not "2023-02-29".
    const aggregateRuns = queries.filter((entry) => entry.sql.includes("from queryable.vw_revenue_by_source"));
    expect(aggregateRuns).toHaveLength(2);
    expect(aggregateRuns[1]?.params).toEqual(["workspace", "2023-02-28", "2023-02-28", 500]);
    expect(result?.caveats).not.toContain("comparison_failed");
  });

  it("reports direction:flat when current equals a non-zero previous", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      {
        "2026-06-01..2026-06-07": { recognized_revenue: "12000" },
        "2026-05-25..2026-05-31": { recognized_revenue: "12000" }
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    const comparison = (result?.data as { comparison?: Record<string, unknown> }).comparison;
    expect(comparison).toMatchObject({
      current: 12000,
      previous: 12000,
      absoluteDelta: 0,
      percentDelta: 0,
      direction: "flat"
    });
    expect(result?.caveats).not.toContain("no_prior_baseline");
  });

  it("treats flat-at-zero (current=0, previous=0) as flat WITHOUT a no_prior_baseline caveat", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      {
        "2026-06-01..2026-06-07": { recognized_revenue: "0" },
        "2026-05-25..2026-05-31": { recognized_revenue: "0" }
      },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    const comparison = (result?.data as { comparison?: Record<string, unknown> }).comparison;
    expect(comparison).toMatchObject({
      current: 0,
      previous: 0,
      absoluteDelta: 0,
      percentDelta: null,
      direction: "flat"
    });
    // Flat-at-zero is genuinely flat — not a missing baseline.
    expect(result?.caveats).not.toContain("no_prior_baseline");
  });

  it("degrades to comparison_failed (keeps the primary rows) when the prior re-run throws", async () => {
    // The prior aggregate throwing — invalid date, transient DB error, unsupported_dimension
    // on a malformed prior filter — must NOT discard the already-successful primary answer.
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    let aggregateCalls = 0;
    const view = "queryable.vw_revenue_by_source";
    const db: InfiniteOsDb = {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        queries.push({ sql, params });
        if (sql.includes(`from ${view}`)) {
          aggregateCalls += 1;
          if (aggregateCalls === 1) {
            return [{ recognized_revenue: "9000" }] as T[]; // primary succeeds
          }
          throw new Error("date/time field value out of range"); // prior re-run fails
        }
        return [] as T[];
      },
      async one() {
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return null as never;
      },
      async updateSourceStatus() {},
      async createJob() {
        return {};
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
    const handlers = createActionHandlers(db);
    const result = await handlers.run_metric_query?.(
      {
        metric: "recognized_revenue",
        view,
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    // Primary answer is preserved; the whole query did NOT crash.
    expect((result?.data as { rows: unknown }).rows).toEqual([{ recognized_revenue: "9000" }]);
    expect((result?.data as { comparison?: unknown }).comparison).toBeUndefined();
    expect(result?.caveats).toContain("comparison_failed");
  });

  it("does NOT attach a comparison block on run_breakdown_query (compareTo is run_metric_query-only)", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const db = comparisonFakeDb(
      "queryable.vw_revenue_by_source",
      "recognized_revenue",
      { "2026-06-01..2026-06-07": { recognized_revenue: "12000", provider: "stripe" } },
      queries
    );
    const handlers = createActionHandlers(db);
    const result = await handlers.run_breakdown_query?.(
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        groupBy: ["provider"],
        compareTo: "prior_period",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-07" }
        ]
      },
      COMPARISON_CONTEXT
    );
    expect((result?.data as { comparison?: unknown }).comparison).toBeUndefined();
    expect(result?.caveats).not.toContain("comparison_requires_date_range");
    // breakdown ran only its single primary aggregate — no prior re-run.
    expect(queries.filter((entry) => entry.sql.includes("from queryable.vw_revenue_by_source"))).toHaveLength(1);
  });
});

describe("setup action helpers", () => {
  it("derives queryability status from connection or sync verification separately from install state", () => {
    expect(queryabilityStatusFromSourceVerification({})).toBe("pending");
    expect(queryabilityStatusFromSourceVerification({ connectionTest: { ok: true } })).toBe("verified");
    expect(queryabilityStatusFromSourceVerification({ syncStatus: "succeeded" })).toBe("verified");
    expect(queryabilityStatusFromSourceVerification({ connectionTest: { ok: false } })).toBe("failed");
    expect(queryabilityStatusFromSourceVerification({ syncStatus: "failed" })).toBe("failed");
  });

  it("reads connect_source and start_source_sync envelopes without exposing secrets", () => {
    const connected = connectedSourceFromEnvelope({
      ok: true,
      actionId: "connect_source",
      authority: "operator",
      status: "queued",
      data: {
        source: { id: "src_ga4", provider: "google_analytics_4" },
        connectionTest: { ok: true, mode: "live", provider: "google_analytics_4", accountExternalId: "properties/123" },
        initialSync: { queued: true, sourceId: "src_ga4", mode: "incremental" }
      },
      provenance: ["sources"],
      caveats: [],
      truncated: false,
      nextActions: []
    });
    const queued = queuedSourceSyncFromEnvelope({
      ok: true,
      actionId: "start_source_sync",
      authority: "operator",
      status: "queued",
      data: {
        job: { id: "job_sync_1", jobType: "source_sync" }
      },
      provenance: ["job_runs"],
      caveats: [],
      truncated: false,
      nextActions: []
    });

    expect(connected).toMatchObject({
      sourceId: "src_ga4",
      connectionTest: { ok: true, accountExternalId: "properties/123" },
      initialSync: { queued: true, mode: "incremental" }
    });
    expect(queued).toEqual({
      job: { id: "job_sync_1", jobType: "source_sync" },
      jobId: "job_sync_1"
    });
  });
});

describe("Meta Ads management handlers (money-safety + audit + dedup)", () => {
  const operatorContext = {
    workspaceId: "workspace",
    authority: "operator",
    surface: "cli",
    actorId: "operator",
    sessionId: "session"
  } as const;

  interface AuditRow {
    action: string;
    status: string;
    source_id: string;
    actor_type: string;
    details: Record<string, unknown>;
  }

  interface GraphCall {
    url: string;
    method: string | undefined;
    authorization: string | null;
    body: Record<string, unknown> | null;
  }

  // In-memory model of the meta_write_dedup table (migration 0028): a UNIQUE key
  // on (workspace_id, source_id, client_token). `claim` rows are keyed by token;
  // an `insert ... on conflict do nothing` returns the new id only when no row
  // with that token exists yet (mirrors the DB's atomic claim).
  interface DedupRow {
    id: string;
    clientToken: string;
    entityId: string | null;
  }

  // A fake db that serves the meta_ads source + an encrypted Meta credential,
  // records integration_audit_log inserts, and models the atomic dedup table.
  // `dedup` pre-seeds a RESOLVED dedup row (a prior succeeded create) so a repeat
  // with the same client_token is deduped. `dedupRows` lets a test inspect claims.
  function metaWriteTestDb(options: {
    audits: AuditRow[];
    dedup?: { clientToken: string; entityId: string };
    dedupRows?: DedupRow[];
  }): InfiniteOsDb {
    const dedupRows: DedupRow[] = options.dedupRows ?? [];
    if (options.dedup) {
      dedupRows.push({
        id: "mwd_seed",
        clientToken: options.dedup.clientToken,
        entityId: options.dedup.entityId
      });
    }
    return {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        if (sql.includes("insert into integration_audit_log")) {
          const p = params ?? [];
          options.audits.push({
            source_id: String(p[2]),
            actor_type: String(p[3]),
            action: String(p[4]),
            status: String(p[5]),
            details: JSON.parse(String(p[6])) as Record<string, unknown>
          });
        }
        if (sql.includes("update meta_write_dedup")) {
          const p = params ?? [];
          const row = dedupRows.find((r) => r.id === String(p[0]));
          if (row) {
            row.entityId = String(p[1]);
          }
        }
        if (sql.includes("delete from meta_write_dedup")) {
          const p = params ?? [];
          const idx = dedupRows.findIndex((r) => r.id === String(p[0]) && r.entityId === null);
          if (idx !== -1) {
            dedupRows.splice(idx, 1);
          }
        }
        return [] as T[];
      },
      async one<T>(sql: string, params?: unknown[]): Promise<T | null> {
        if (sql.includes("from sources")) {
          return { provider: "meta_ads" } as T;
        }
        if (sql.includes("from connection_credentials")) {
          return {
            credential_kind: "system_user_token",
            encrypted_payload: encryptForTest({
              mode: "live",
              transport: "marketing_api",
              adAccountId: "act_999",
              accessToken: "secret-meta-token",
              apiVersion: "v25.0"
            }),
            oauth_token_id: null
          } as T;
        }
        // Atomic dedup CLAIM: insert ... on conflict do nothing returning id.
        if (sql.includes("insert into meta_write_dedup")) {
          const p = params ?? [];
          const claimId = String(p[0]);
          const token = String(p[3]);
          const entity = String(p[4]);
          if (dedupRows.some((r) => r.clientToken === token)) {
            // Conflict → no row returned (someone else holds the key).
            return null;
          }
          dedupRows.push({ id: claimId, clientToken: token, entityId: null });
          void entity;
          return { id: claimId } as T;
        }
        // Read back the existing claim's entity id on a dedup hit.
        if (sql.includes("from meta_write_dedup")) {
          const token = String(params?.[2] ?? "");
          const row = dedupRows.find((r) => r.clientToken === token);
          return row ? ({ entity_id: row.entityId } as T) : null;
        }
        return null;
      },
      async close() {},
      async ensureWorkspace() {},
      async ensureFirstPhaseDatasets() {},
      async connectSource() {
        return {};
      },
      async updateSourceStatus() {},
      async createJob() {
        // INVARIANT 3: a money write must NEVER enqueue a worker job.
        throw new Error("createJob must not be called by a Meta write handler");
      },
      async claimNextJob() {
        return null;
      },
      async completeJob() {},
      async withTransaction(fn) {
        return fn(this);
      }
    };
  }

  // Decode a Meta WRITE POST body. WRITE POSTs are form-encoded
  // (application/x-www-form-urlencoded): each nested object/array field is a JSON
  // STRING, which we parse back so shape assertions read naturally. Scalars stay
  // strings. Mirrors the production `metaFormEncode` + the connector test decoder.
  function decodeMetaWriteBody(raw: string): Record<string, unknown> | null {
    try {
      const params = new URLSearchParams(raw);
      const body: Record<string, unknown> = {};
      for (const [key, value] of params.entries()) {
        const trimmed = value.trim();
        body[key] = trimmed.startsWith("{") || trimmed.startsWith("[") ? JSON.parse(value) : value;
      }
      return body;
    } catch {
      return null;
    }
  }

  async function withGraph(
    responder: (call: GraphCall) => Response | Promise<Response>,
    fn: (calls: GraphCall[]) => Promise<void>
  ): Promise<void> {
    process.env.GROWTH_OS_ENCRYPTION_KEY = "analytical-test-encryption-key";
    const calls: GraphCall[] = [];
    // FIX 4: vi.stubGlobal/unstubAllGlobals (deterministic under parallel CI)
    // instead of raw `globalThis.fetch = …` + try/finally restore. A contaminated
    // fetch from another concurrent test can no longer mask a money-safety
    // regression here.
    vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body =
        init?.body && typeof init.body === "string" ? decodeMetaWriteBody(init.body) : null;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: GraphCall = {
        url,
        method: init?.method,
        authorization: headers.Authorization ?? headers.authorization ?? null,
        body
      };
      calls.push(call);
      return Promise.resolve(responder(call));
    }) as typeof fetch);
    try {
      await fn(calls);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  }

  it("creates a campaign INLINE, lands PAUSED, never logs the token or raw budget", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () => jsonResponse({ id: "120000000000777", status: "PAUSED" }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        const result = await handlers.create_meta_campaign?.(
          {
            sourceId: "src_meta",
            name: "Demo Requests",
            objective: "OUTCOME_TRAFFIC",
            dailyBudget: 5000,
            clientToken: "tok_camp_1"
          },
          operatorContext
        );

        // INVARIANT 1: hard-coded PAUSED in the POST body, status echoed back.
        expect(calls[0].url).toBe("https://graph.facebook.com/v25.0/act_999/campaigns");
        expect(calls[0].method).toBe("POST");
        expect(calls[0].body).toMatchObject({ status: "PAUSED", objective: "OUTCOME_TRAFFIC" });
        expect(calls[0].authorization).toBe("Bearer secret-meta-token");
        expect(result?.data).toMatchObject({ id: "120000000000777", status: "PAUSED", deduped: false });

        // INVARIANT 6: audit row stores presence flags + ids, NEVER the token/amount.
        const audit = audits.find((row) => row.action === "create_meta_campaign");
        expect(audit?.status).toBe("succeeded");
        expect(audit?.actor_type).toBe("operator");
        expect(audit?.details).toMatchObject({
          entity: "campaign",
          entity_id: "120000000000777",
          client_token: "tok_camp_1",
          status: "PAUSED",
          budget_present: true,
          deduped: false
        });
        const serialized = JSON.stringify(audits);
        expect(serialized).not.toContain("secret-meta-token");
        expect(serialized).not.toContain("5000");
        expect(serialized).not.toContain("daily_budget");
      }
    );
  });

  it("REMEDIATES an unexpected ACTIVE create: best-effort PAUSE + entity id in the audit, still throws", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      (call) =>
        // The create echoes ACTIVE (the should-never-happen case); the follow-up PAUSE succeeds.
        call.url.endsWith("/campaigns")
          ? jsonResponse({ id: "120000000000999", status: "ACTIVE" })
          : jsonResponse({ success: true }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        await expect(
          handlers.create_meta_campaign?.(
            { sourceId: "src_meta", name: "Oops", objective: "OUTCOME_TRAFFIC", clientToken: "tok_active" },
            operatorContext
          )
        ).rejects.toMatchObject({ code: "money_safety_violation", retryable: false });

        // Two Graph calls: [0] the ACTIVE create, [1] the remediation PAUSE of the SAME entity id.
        expect(calls).toHaveLength(2);
        expect(calls[0].url).toBe("https://graph.facebook.com/v25.0/act_999/campaigns");
        expect(calls[1].url).toBe("https://graph.facebook.com/v25.0/120000000000999");
        expect(calls[1].method).toBe("POST");
        expect(calls[1].body).toMatchObject({ status: "PAUSED" });

        // The failed audit names the live entity and records the remediation outcome.
        const audit = audits.find((row) => row.action === "create_meta_campaign" && row.status === "failed");
        expect(audit?.details).toMatchObject({
          entity: "campaign",
          entity_id: "120000000000999",
          error_code: "money_safety_violation",
          money_safety_violation: true,
          remediation_paused: true
        });
        expect(JSON.stringify(audits)).not.toContain("secret-meta-token");
      }
    );
  });

  it("a FAILING remediation pause does not mask the original money_safety_violation (best-effort)", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      (call) =>
        call.url.endsWith("/campaigns")
          ? jsonResponse({ id: "120000000000999", status: "ACTIVE" })
          : jsonResponse({ error: { message: "pause failed" } }, 500), // remediation PAUSE fails
      async (calls) => {
        const handlers = createActionHandlers(db);
        await expect(
          handlers.create_meta_campaign?.(
            { sourceId: "src_meta", name: "Oops", objective: "OUTCOME_TRAFFIC", clientToken: "tok_active2" },
            operatorContext
          )
        ).rejects.toMatchObject({ code: "money_safety_violation" });
        // The pause was attempted (2 calls) but failed; the audit flags it for manual follow-up.
        expect(calls).toHaveLength(2);
        const audit = audits.find((row) => row.action === "create_meta_campaign" && row.status === "failed");
        expect(audit?.details).toMatchObject({
          entity_id: "120000000000999",
          money_safety_violation: true,
          remediation_paused: false
        });
      }
    );
  });

  it("dedups a repeat create by client_token without a second POST", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({
      audits,
      dedup: { clientToken: "tok_dupe", entityId: "120000000000111" }
    });
    await withGraph(
      () => jsonResponse({ id: "should-not-be-created", status: "PAUSED" }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        const result = await handlers.create_meta_campaign?.(
          {
            sourceId: "src_meta",
            name: "Dup",
            objective: "OUTCOME_TRAFFIC",
            clientToken: "tok_dupe"
          },
          operatorContext
        );
        // No Graph POST happened.
        expect(calls).toHaveLength(0);
        expect(result?.data).toMatchObject({ id: "120000000000111", deduped: true });
        const audit = audits.find((row) => row.action === "create_meta_campaign");
        expect(audit?.details).toMatchObject({ deduped: true, entity_id: "120000000000111" });
      }
    );
  });

  it("ATOMIC dedup: two concurrent same-token creates POST exactly once (FIX 5)", async () => {
    const audits: AuditRow[] = [];
    const dedupRows: DedupRow[] = [];
    const db = metaWriteTestDb({ audits, dedupRows });
    await withGraph(
      () => jsonResponse({ id: "120000000000999", status: "PAUSED" }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        // Fire two creates with the SAME client_token concurrently. The UNIQUE
        // claim means only ONE wins the claim and POSTs; the other dedups.
        const [a, b] = await Promise.all([
          handlers.create_meta_campaign?.(
            { sourceId: "src_meta", name: "Race A", objective: "OUTCOME_TRAFFIC", clientToken: "tok_race" },
            operatorContext
          ),
          handlers.create_meta_campaign?.(
            { sourceId: "src_meta", name: "Race B", objective: "OUTCOME_TRAFFIC", clientToken: "tok_race" },
            operatorContext
          )
        ]);
        // THE money-safety guarantee: exactly ONE Graph POST despite two
        // concurrent same-token creates (the UNIQUE claim blocked the second).
        expect(calls).toHaveLength(1);
        // Exactly one result is the real create (deduped:false) and one is the
        // deduped short-circuit (deduped:true). The winner carries the concrete
        // id; the loser carries the existing id, or null if it read the claim
        // while the winner was still mid-flight (documented concurrent behavior).
        const results = [a?.data, b?.data] as Array<Record<string, unknown>>;
        const winner = results.find((d) => d.deduped === false);
        const loser = results.find((d) => d.deduped === true);
        expect(winner).toBeDefined();
        expect(loser).toBeDefined();
        expect(winner?.id).toBe("120000000000999");
        // Only ONE dedup row exists and it resolves to the created entity id.
        expect(dedupRows).toHaveLength(1);
        expect(dedupRows[0].entityId).toBe("120000000000999");
      }
    );
  });

  it("clientToken is OPTIONAL (opt-out): a tokenless create writes NO dedup row and is not deduped", async () => {
    const audits: AuditRow[] = [];
    const dedupRows: DedupRow[] = [];
    const db = metaWriteTestDb({ audits, dedupRows });
    await withGraph(
      () => jsonResponse({ id: "120000000000888", status: "PAUSED" }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        // No clientToken → no dedup row, normal POST.
        await handlers.create_meta_campaign?.(
          { sourceId: "src_meta", name: "NoToken", objective: "OUTCOME_TRAFFIC" },
          operatorContext
        );
        expect(calls).toHaveLength(1);
        expect(dedupRows).toHaveLength(0);
      }
    );
  });

  it("releases an un-resolved claim on a failed POST so the same token can retry", async () => {
    const audits: AuditRow[] = [];
    const dedupRows: DedupRow[] = [];
    const db = metaWriteTestDb({ audits, dedupRows });
    await withGraph(
      () => jsonResponse({ error: { message: "boom" } }, 500),
      async () => {
        const handlers = createActionHandlers(db);
        await expect(
          handlers.create_meta_campaign?.(
            { sourceId: "src_meta", name: "Fails", objective: "OUTCOME_TRAFFIC", clientToken: "tok_fail" },
            operatorContext
          )
        ).rejects.toMatchObject({ retryable: false });
        // The un-resolved claim was released, so the poisoned token is freed.
        expect(dedupRows).toHaveLength(0);
      }
    );
  });

  it("audits a failure and re-throws when Graph echoes ACTIVE (money-safety violation)", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () => jsonResponse({ id: "120000000000222", status: "ACTIVE" }),
      async () => {
        const handlers = createActionHandlers(db);
        await expect(
          handlers.create_meta_campaign?.(
            { sourceId: "src_meta", name: "Sneaky", objective: "OUTCOME_TRAFFIC" },
            operatorContext
          )
        ).rejects.toMatchObject({ code: "money_safety_violation", retryable: false });
        const audit = audits.find((row) => row.action === "create_meta_campaign");
        expect(audit?.status).toBe("failed");
        expect(audit?.details).toMatchObject({ error_code: "money_safety_violation" });
      }
    );
  });

  it("activates an entity (the spend-bearing transition) and audits activation:true", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () => jsonResponse({ success: true, status: "ACTIVE" }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        const result = await handlers.set_meta_entity_status?.(
          { sourceId: "src_meta", entityId: "120000000000333", status: "ACTIVE", entity: "campaign" },
          operatorContext
        );
        expect(calls[0].url).toBe("https://graph.facebook.com/v25.0/120000000000333");
        expect(calls[0].body).toEqual({ status: "ACTIVE" });
        expect(result?.data).toMatchObject({ id: "120000000000333", status: "ACTIVE", activation: true });
        const audit = audits.find((row) => row.action === "set_meta_entity_status");
        expect(audit?.status).toBe("succeeded");
        expect(audit?.details).toMatchObject({ requested_status: "ACTIVE", activation: true });
      }
    );
  });

  it("deletes an entity INLINE (DELETE /{id}, bodyless, bearer-only) and audits with the token redacted", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      // Graph answers a successful DELETE with { success: true }.
      () => jsonResponse({ success: true }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        const result = await handlers.delete_meta_entity?.(
          { sourceId: "src_meta", entityId: "120000000000444", entity: "campaign" },
          operatorContext
        );
        // DELETE hits the NODE id (no act_ edge), is bodyless, bearer-only.
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://graph.facebook.com/v25.0/120000000000444");
        expect(calls[0].method).toBe("DELETE");
        expect(calls[0].url).not.toContain("act_");
        expect(calls[0].body).toBeNull();
        expect(calls[0].authorization).toBe("Bearer secret-meta-token");
        expect(result?.data).toMatchObject({ id: "120000000000444", deleted: true, entity: "campaign" });

        // Operator audit row: succeeded, action/entity-id/status recorded, token redacted.
        const audit = audits.find((row) => row.action === "delete_meta_entity");
        expect(audit?.status).toBe("succeeded");
        expect(audit?.actor_type).toBe("operator");
        expect(audit?.details).toMatchObject({
          action: "delete_meta_entity",
          entity: "campaign",
          entity_id: "120000000000444",
          deleted: true
        });
        const serialized = JSON.stringify(audits);
        expect(serialized).not.toContain("secret-meta-token");
        // INVARIANT 3: a destructive write must NEVER enqueue a worker job (the
        // fake db's createJob throws if called) — reaching here proves it ran inline.
      }
    );
  });

  it("audits a delete failure (non-retryable) and re-throws WITHOUT the token", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () => jsonResponse({ error: { message: "boom" } }, 500),
      async (calls) => {
        const handlers = createActionHandlers(db);
        await expect(
          handlers.delete_meta_entity?.(
            { sourceId: "src_meta", entityId: "120000000000555", entity: "ad" },
            operatorContext
          )
        ).rejects.toMatchObject({ retryable: false });
        // The connector still issued exactly one DELETE; no retry, no second call.
        expect(calls).toHaveLength(1);
        const audit = audits.find((row) => row.action === "delete_meta_entity");
        expect(audit?.status).toBe("failed");
        expect(audit?.details).toMatchObject({ entity: "ad", entity_id: "120000000000555" });
        expect(JSON.stringify(audits)).not.toContain("secret-meta-token");
      }
    );
  });

  it("delete is non-retryable on a 429 too (never inherits the read retryable taxonomy)", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () => jsonResponse({ error: { message: "rate limited" } }, 429),
      async () => {
        const handlers = createActionHandlers(db);
        await expect(
          handlers.delete_meta_entity?.(
            { sourceId: "src_meta", entityId: "120000000000666", entity: "adset" },
            operatorContext
          )
        ).rejects.toMatchObject({ retryable: false });
      }
    );
  });

  it("refuses a non-Meta source before issuing the DELETE", async () => {
    const audits: AuditRow[] = [];
    const db: InfiniteOsDb = {
      ...metaWriteTestDb({ audits }),
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("from sources")) {
          return { provider: "stripe" } as T;
        }
        return null;
      }
    };
    await withGraph(
      () => jsonResponse({ success: true }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        await expect(
          handlers.delete_meta_entity?.(
            { sourceId: "src_stripe", entityId: "120000000000777", entity: "ad" },
            operatorContext
          )
        ).rejects.toThrow("source_provider_mismatch");
        expect(calls).toHaveLength(0);
      }
    );
  });

  it("lists entities as a read (no audit row, normal taxonomy)", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () => jsonResponse({ data: [{ id: "c1", name: "Camp", status: "PAUSED" }] }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        const result = await handlers.list_meta_entities?.(
          { sourceId: "src_meta", entity: "campaign", limit: 5 },
          { ...operatorContext, authority: "tool_agent" }
        );
        expect(calls[0].method).toBe("GET");
        expect(calls[0].url).toContain("/act_999/campaigns");
        expect(result?.data).toMatchObject({ entity: "campaign", count: 1 });
        // Reads do not write an audit row.
        expect(audits).toHaveLength(0);
      }
    );
  });

  // FIX 1 (downstream): get_meta_entity threads the entity-kind hint so the
  // connector requests the SAME full field set as `list` for that object type,
  // instead of degrading to Graph's id-only node. Revert-proof: dropping the
  // `entity` pass-through in the handler reverts the request to the campaign
  // default and fails the adset assertion below.
  it("get_meta_entity threads the entity kind so it requests the full per-type field set", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () =>
        jsonResponse({
          id: "as_1",
          name: "AS",
          status: "PAUSED",
          campaign_id: "cmp_1",
          optimization_goal: "OFFSITE_CONVERSIONS",
          billing_event: "IMPRESSIONS",
          effective_status: "PAUSED"
        }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        const result = await handlers.get_meta_entity?.(
          { sourceId: "src_meta", entityId: "as_1", entity: "adset" },
          { ...operatorContext, authority: "tool_agent" }
        );
        expect(calls[0].method).toBe("GET");
        const url = new URL(calls[0].url);
        expect(url.pathname.endsWith("/as_1")).toBe(true);
        // The adset default field set (NOT the campaign default) is requested.
        expect(url.searchParams.get("fields")).toBe(
          "id,name,status,campaign_id,optimization_goal,billing_event,effective_status"
        );
        // The full node — not just {id} — flows back through the envelope.
        expect(result?.data).toMatchObject({
          id: "as_1",
          entity: { id: "as_1", name: "AS", campaign_id: "cmp_1" }
        });
        // Reads do not write an audit row.
        expect(audits).toHaveLength(0);
      }
    );
  });

  it("get_meta_entity honors an explicit fields override", async () => {
    const audits: AuditRow[] = [];
    const db = metaWriteTestDb({ audits });
    await withGraph(
      () => jsonResponse({ id: "cmp_1", name: "C" }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        await handlers.get_meta_entity?.(
          { sourceId: "src_meta", entityId: "cmp_1", entity: "campaign", fields: "id,name" },
          { ...operatorContext, authority: "tool_agent" }
        );
        expect(new URL(calls[0].url).searchParams.get("fields")).toBe("id,name");
      }
    );
  });

  it("refuses a non-Meta source before touching the Graph API", async () => {
    const audits: AuditRow[] = [];
    const db: InfiniteOsDb = {
      ...metaWriteTestDb({ audits }),
      async one<T>(sql: string): Promise<T | null> {
        if (sql.includes("from sources")) {
          return { provider: "stripe" } as T;
        }
        return null;
      }
    };
    await withGraph(
      () => jsonResponse({ id: "nope" }),
      async (calls) => {
        const handlers = createActionHandlers(db);
        await expect(
          handlers.create_meta_campaign?.(
            { sourceId: "src_stripe", name: "X", objective: "OUTCOME_TRAFFIC" },
            operatorContext
          )
        ).rejects.toThrow("source_provider_mismatch");
        expect(calls).toHaveLength(0);
      }
    );
  });
});

function journeyTestDb(): InfiniteOsDb {
  return {
    async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      if (sql.includes("from sources")) {
        return [
          {
            id: "src_meta",
            provider: "meta_ads",
            connection_name: "Meta Ads",
            status: "connected",
            last_synced_at: "2026-06-07T00:00:00.000Z"
          },
          {
            id: "src_x",
            provider: "x",
            connection_name: "X",
            status: "connected",
            last_synced_at: "2026-06-07T00:00:00.000Z"
          }
        ] as T[];
      }
      if (sql.includes("from metric_definitions")) {
        return [
          {
            id: "meta_ads_clicks",
            name: "Meta Ads clicks",
            source_view: "queryable.vw_meta_ads_campaign_daily",
            description: "Daily Meta Ads clicks from campaign insights"
          },
          {
            id: "x_public_engagement",
            name: "X public engagement",
            source_view: "queryable.vw_x_post_public_metrics",
            description: "Read-only public engagement from latest X post metric snapshots"
          }
        ] as T[];
      }
      if (sql.includes("from queryable_views")) {
        return [
          {
            id: "queryable.vw_meta_ads_campaign_daily",
            description: "Meta Ads campaign daily insights view"
          },
          {
            id: "queryable.vw_x_post_public_metrics",
            description: "X read-only public post metric snapshot view"
          }
        ] as T[];
      }
      if (sql.includes("from queryable.vw_meta_ads_campaign_daily")) {
        return [
          {
            campaign_id: "cmp_launch",
            campaign_name: "Launch Demo Requests",
            meta_ads_clicks: "42",
            meta_ads_spend: "123.45",
            impressions: "1000",
            ctr: "4.2"
          },
          {
            campaign_id: "cmp_retarg",
            campaign_name: "Retargeting",
            meta_ads_clicks: "12",
            meta_ads_spend: "88.10",
            impressions: "700",
            ctr: "1.7"
          }
        ] as T[];
      }
      if (sql.includes("from queryable.vw_x_post_public_metrics")) {
        return [
          {
            x_post_id: "x_1",
            post_url: "https://x.com/founder/status/x_1",
            body_text: "Demo request launch thread",
            published_at: "2026-06-06T10:00:00.000Z",
            x_public_engagement: "80",
            like_count: "50",
            reply_count: "12"
          },
          {
            x_post_id: "x_2",
            post_url: "https://x.com/founder/status/x_2",
            body_text: "Meta creative teardown",
            published_at: "2026-06-05T10:00:00.000Z",
            x_public_engagement: "31",
            like_count: "20",
            reply_count: "4"
          }
        ] as T[];
      }
      return [] as T[];
    },
    async one() {
      return null;
    },
    async close() {},
    async ensureWorkspace() {},
    async ensureFirstPhaseDatasets() {},
    async connectSource() {
      return null as never;
    },
    async updateSourceStatus() {},
    async createJob() {
      return {};
    },
    async claimNextJob() {
      return null;
    },
    async completeJob() {},
    async withTransaction(fn) {
      return fn(this);
    }
  };
}

function encryptForTest(payload: Record<string, unknown>): string {
  return encryptCredentialPayload(payload, "analytical-test-encryption-key");
}
