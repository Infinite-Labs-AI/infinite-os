import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JOURNEY_ENTITY_TYPES } from "@infinite-os/core";

import {
  FIRST_PHASE_ACTIONS,
  FIRST_PHASE_METRICS,
  FIRST_PHASE_PROVIDERS,
  FIRST_PHASE_QUERYABLE_VIEWS,
  READ_ACTIONS,
  assertAuthority,
  createInfiniteOsRegistry,
  createSessionContext
} from "../src/index.js";

const ORIGINAL_FIRST_PHASE_ACTIONS = [
  "list_sources",
  "describe_source",
  "get_recent_sync_runs",
  "sync_source_now",
  "list_source_schedules",
  "list_queryable_views",
  "describe_queryable_view",
  "list_metrics",
  "describe_metric",
  "run_metric_query",
  "run_breakdown_query",
  "run_funnel_query",
  "explain_answer",
  "drilldown_result",
  "connect_source",
  "reconnect_source",
  "revoke_source",
  "start_source_sync",
  "update_source_schedule",
  "pause_source_schedule",
  "resume_source_schedule",
  "create_saved_report",
  "run_saved_report",
  "export_saved_report"
] as const;

const CURATED_READ_ACTIONS = [
  "search_context",
  "describe_context_item",
  "resolve_entity",
  "validate_journey_plan",
  "run_journey_query",
  "fetch_evidence",
  "verify_claims"
] as const;

describe("Infinite OS runtime action registry", () => {
  it("registers first-phase and curated read actions and providers", () => {
    const registry = createInfiniteOsRegistry();
    expect(registry.list().map((action) => action.id)).toEqual(
      [...FIRST_PHASE_ACTIONS].sort()
    );
    expect(FIRST_PHASE_ACTIONS).toEqual([
      ...READ_ACTIONS,
      "connect_source",
      "reconnect_source",
      "revoke_source",
      "start_source_sync",
      "update_source_schedule",
      "pause_source_schedule",
      "resume_source_schedule",
      "create_saved_report",
      "run_saved_report",
      "export_saved_report",
      // Meta Ads WRITE/management (operator-only) — see OPERATOR_ACTIONS.
      "create_meta_campaign",
      "create_meta_ad_set",
      "create_meta_ad",
      "create_meta_creative",
      "set_meta_entity_status",
      // Destructive cleanup (operator-only, irreversible, no spend) — PR #3b.
      "delete_meta_entity"
    ]);
    expect(FIRST_PHASE_ACTIONS).toEqual(
      expect.arrayContaining([...ORIGINAL_FIRST_PHASE_ACTIONS])
    );
    expect(READ_ACTIONS).toEqual(
      expect.arrayContaining([...CURATED_READ_ACTIONS])
    );
    expect(FIRST_PHASE_PROVIDERS).toEqual([
      "google_analytics_4",
      "posthog",
      "stripe",
      "x",
      "shopify",
      "meta_ads"
    ]);
    expect(FIRST_PHASE_QUERYABLE_VIEWS).toContain("queryable.vw_posthog_events");
    expect(FIRST_PHASE_METRICS).toContain("posthog_event_count");
  });

  // Phase-2 slice-1a §3/§5/§9 — the TWO-PLACE allowlist contract. A grain-aware view is invisible
  // to the tool agent unless it is in FIRST_PHASE_QUERYABLE_VIEWS (which feeds BOTH
  // rejectUnsafeView/QUERYABLE_VIEW_SET in the engine AND the run_metric_query/run_breakdown_query
  // `view` enum here). The §5 resolver swaps to these adset siblings by grain; this pins that the
  // runtime half of the two-place allowlist actually exposes them (a regression that drops them
  // would silently 404 every adset query at the runtime guard before the resolver ever runs).
  it("§9: exposes both adset grain views in the allowlist AND the analytical tool-schema view enum", () => {
    for (const view of [
      "queryable.vw_meta_ads_adset_daily",
      "queryable.vw_meta_ads_adset_conversions_daily"
    ]) {
      expect(FIRST_PHASE_QUERYABLE_VIEWS).toContain(view);
    }

    const registry = createInfiniteOsRegistry();
    for (const actionId of ["run_metric_query", "run_breakdown_query"]) {
      const schema = registry.get(actionId)?.inputSchema as
        | { properties?: { view?: { enum?: string[] } } }
        | undefined;
      const viewEnum = schema?.properties?.view?.enum ?? [];
      expect(viewEnum).toContain("queryable.vw_meta_ads_adset_daily");
      expect(viewEnum).toContain("queryable.vw_meta_ads_adset_conversions_daily");
      // The campaign siblings stay exposed too (no-regression: the family base is still valid).
      expect(viewEnum).toContain("queryable.vw_meta_ads_campaign_daily");
      expect(viewEnum).toContain("queryable.vw_meta_ads_campaign_conversions_daily");
    }
  });

  // Phase-2 slice-1b §3/§5 — the same two-place allowlist contract for the AD (finest) grain.
  // The §5 resolver swaps to these ad siblings when an ad_id/ad_name dim is present; this pins
  // that the runtime half exposes them so an ad-grain query is not 404'd at the runtime guard
  // before the finest-grain-wins resolver ever runs.
  it("§5 slice-1b: exposes both ad grain views in the allowlist AND the analytical tool-schema view enum", () => {
    for (const view of [
      "queryable.vw_meta_ads_ad_daily",
      "queryable.vw_meta_ads_ad_conversions_daily"
    ]) {
      expect(FIRST_PHASE_QUERYABLE_VIEWS).toContain(view);
    }

    const registry = createInfiniteOsRegistry();
    for (const actionId of ["run_metric_query", "run_breakdown_query"]) {
      const schema = registry.get(actionId)?.inputSchema as
        | { properties?: { view?: { enum?: string[] } } }
        | undefined;
      const viewEnum = schema?.properties?.view?.enum ?? [];
      expect(viewEnum).toContain("queryable.vw_meta_ads_ad_daily");
      expect(viewEnum).toContain("queryable.vw_meta_ads_ad_conversions_daily");
      // The adset + campaign siblings stay exposed (no-regression at the coarser grains).
      expect(viewEnum).toContain("queryable.vw_meta_ads_adset_daily");
      expect(viewEnum).toContain("queryable.vw_meta_ads_campaign_daily");
    }
  });

  it("exposes governed curated action metadata without raw SQL", () => {
    const registry = createInfiniteOsRegistry();
    const actionIds = registry.list().map((action) => action.id);

    expect(actionIds).toEqual(
      expect.arrayContaining([...CURATED_READ_ACTIONS])
    );
    expect(actionIds).not.toContain("run_sql");
    expect(actionIds).not.toContain("run_provider_query");
    expect(registry.get("run_journey_query")).toMatchObject({
      category: "journey",
      authority: "tool_agent",
      provenancePolicy: "queryable_view",
      inputSchema: {
        required: ["plan", "validationId"]
      }
    });
    expect(registry.get("sync_source_now")).toMatchObject({
      category: "sources",
      authority: "tool_agent",
      provenancePolicy: "operator_audit",
      inputSchema: {
        required: ["sourceId"],
        properties: {
          refreshWindowDays: expect.objectContaining({
            minimum: 1,
            maximum: 3650
          })
        }
      }
    });
    expect(registry.get("validate_journey_plan")?.outputSchema).toMatchObject({
      properties: {
        status: {
          enum: expect.arrayContaining([
            "low_coverage",
            "needs_clarification",
            "too_expensive",
            "error"
          ])
        },
        answerabilityReason: {
          enum: expect.arrayContaining([
            "missing_journey_template",
            "unapproved_journey_template",
            "insufficient_source_coverage"
          ])
        },
        evidence: expect.any(Object),
        coverage: expect.any(Object),
        policyRefs: expect.any(Object),
        interpretedPlan: expect.any(Object)
      }
    });
    expect(registry.get("fetch_evidence")).toMatchObject({
      category: "evidence",
      authority: "tool_agent",
      provenancePolicy: "bounded_provider_truth"
    });
  });

  it("exposes the opt-in compareTo parameter on run_metric_query for WoW/MoM/YoY trends", () => {
    const registry = createInfiniteOsRegistry();
    const metricSchema = registry.get("run_metric_query")?.inputSchema as Record<string, any>;

    // compareTo is present, enum-constrained, and NOT required (opt-in/additive).
    expect(metricSchema.properties.compareTo.enum).toEqual(["prior_period", "prior_year"]);
    expect(metricSchema.required).toEqual(["metric"]);
    expect(metricSchema.properties.compareTo.description).toMatch(/prior period|year-over-year|WoW|MoM|YoY/i);
    // The description tells the model the comparison applies to run_metric_query only.
    expect(metricSchema.properties.compareTo.description).toMatch(/run_metric_query only/i);
    // The tool summary surfaces the comparison capability so the model adopts it.
    expect(registry.get("run_metric_query")?.summary).toMatch(/week-over-week|prior period|comparison/i);

    // run_breakdown_query shares analyticalQuerySchema(), so the property is visible there
    // too (the handler no-ops it); this pins that shared-schema reality.
    const breakdownSchema = registry.get("run_breakdown_query")?.inputSchema as Record<string, any>;
    expect(breakdownSchema.properties.compareTo.enum).toEqual(["prior_period", "prior_year"]);
    expect(breakdownSchema.required).toEqual(["metric", "groupBy"]);
  });

  it("keeps journey entity tool schemas aligned to the shared vocabulary", () => {
    const registry = createInfiniteOsRegistry();
    const resolveEntitySchema = registry.get("resolve_entity")
      ?.inputSchema as Record<string, any>;
    const validatePlanSchema = registry.get("validate_journey_plan")
      ?.inputSchema as Record<string, any>;

    expect(resolveEntitySchema.properties.entityType.enum).toEqual([
      ...JOURNEY_ENTITY_TYPES
    ]);
    expect(
      validatePlanSchema.properties.plan.properties.entity.properties.type.enum
    ).toEqual([...JOURNEY_ENTITY_TYPES]);
  });

  it("blocks operator actions from tool-agent sessions", async () => {
    const registry = createInfiniteOsRegistry();
    const context = createSessionContext({
      authority: "tool_agent",
      surface: "api",
      workspaceId: "workspace-1"
    });
    await expect(
      registry.execute("start_source_sync", {}, context)
    ).rejects.toThrow(/operator authority/);
  });

  it("allows read actions for tool-agent sessions", async () => {
    const registry = createInfiniteOsRegistry();
    const context = createSessionContext({
      authority: "tool_agent",
      surface: "api",
      workspaceId: "workspace-1"
    });
    const result = await registry.execute(
      "search_context",
      { query: "paid activation" },
      context
    );
    expect(result).toMatchObject({
      actionId: "search_context",
      authority: "tool_agent",
      status: "not_implemented"
    });
  });

  it("has explicit authority semantics", () => {
    expect(() => assertAuthority("operator", "operator")).not.toThrow();
    expect(() => assertAuthority("tool_agent", "operator")).toThrow();
  });

  it("exposes operator-facing action metadata for CLI and MCP transports", () => {
    const registry = createInfiniteOsRegistry();
    const connectSource = registry.get("connect_source");

    expect(registry.get("resolve_question")).toBeUndefined();
    expect(connectSource).toMatchObject({
      category: "operator",
      authority: "operator",
      provenancePolicy: "operator_audit",
      recipeIds: ["connect_source"]
    });
  });

  it("keeps rootDir-dot package exports pointed at current build output", () => {
    for (const packagePath of [
      "../package.json",
      "../../config/package.json",
      "../../db/package.json",
      "../../llm-controller/package.json"
    ]) {
      const packageJson = JSON.parse(
        readFileSync(join(import.meta.dirname, packagePath), "utf8")
      ) as { exports?: Record<string, string>; name?: string };

      expect(packageJson.exports?.["."], packageJson.name).toBe(
        "./dist/src/index.js"
      );
    }
  });
});
