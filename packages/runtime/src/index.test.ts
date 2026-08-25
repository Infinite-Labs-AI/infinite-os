import { NoActiveProjectError } from "@infinite-os/config";
import { describe, expect, it } from "vitest";

import {
  ACTION_CATALOG,
  EMBEDDED_ONLY_READ_ACTIONS,
  LOCAL_STORE_READ_ACTIONS,
  MissingWorkspaceError,
  OPERATOR_ACTIONS,
  READ_ACTIONS,
  createDaemonActionRegistry,
  createEnvelope,
  createInfiniteOsRegistry,
  createSessionContext,
  runtimeBoot,
  runtimeVersion,
  type AnswerabilityReason,
  type AnswerabilityStatus,
  type CoverageSummary,
  type EvidenceHandle,
  type JourneyQueryPlan,
  type PolicyRef
} from "./index.js";

describe("runtime smoke", () => {
  it("boots through the shared core package", () => {
    expect(runtimeBoot).toBe(true);
    expect(runtimeVersion).toBe("0.1.0");
  });

  it("marks no-answer answerability statuses as not ok", () => {
    const nonOkStatuses = [
      "unsupported",
      "not_implemented",
      "low_coverage",
      "needs_clarification",
      "too_expensive",
      "error"
    ] satisfies AnswerabilityStatus[];

    for (const status of nonOkStatuses) {
      expect(
        createEnvelope({
          actionId: "validate_journey_plan",
          authority: "tool_agent",
          status
        })
      ).toMatchObject({ ok: false, status });
    }

    for (const status of [
      "ok",
      "resolved",
      "queued"
    ] satisfies AnswerabilityStatus[]) {
      expect(
        createEnvelope({
          actionId: "validate_journey_plan",
          authority: "tool_agent",
          status
        })
      ).toMatchObject({ ok: true, status });
    }
  });

  it("marks any envelope with an error as not ok", () => {
    expect(
      createEnvelope({
        actionId: "run_journey_query",
        authority: "tool_agent",
        error: { code: "execution_error", message: "failed" }
      })
    ).toMatchObject({ ok: false, status: "error" });

    expect(
      createEnvelope({
        actionId: "run_journey_query",
        authority: "tool_agent",
        status: "resolved",
        error: { code: "execution_error", message: "failed" }
      })
    ).toMatchObject({ ok: false, status: "error" });
  });

  it("exports pragmatic evidence, coverage, policy, journey, and reason contracts", () => {
    const plan = {
      intent: "rank_entities_by_outcome",
      actor: { grain: "person" },
      journeyTemplateId: "jt_paid_activation",
      entity: { type: "campaign", filters: { channel: "x" } },
      outcome: {
        id: "recognized_revenue",
        window: "30d",
        policyId: "revenue_policy"
      },
      timeRange: { start: "2026-01-01", end: "2026-01-31" },
      ranking: { metric: "recognized_revenue", direction: "desc" },
      limit: 25
    } satisfies JourneyQueryPlan;
    const evidence = {
      id: "evidence_1",
      kind: "query_result",
      sourceIds: ["stripe", "posthog"],
      claimIds: ["claim_1"]
    } satisfies EvidenceHandle;
    const coverage = {
      sourceIds: ["stripe"],
      requiredSourceIds: ["stripe", "posthog"],
      coveredCount: 1,
      expectedCount: 2,
      coverageRatio: 0.5,
      missingSourceIds: ["posthog"]
    } satisfies CoverageSummary;
    const policyRef = {
      id: "jt_paid_activation",
      kind: "journey_template",
      approved: true
    } satisfies PolicyRef;
    const reasons = [
      "missing_journey_template",
      "unapproved_journey_template"
    ] satisfies AnswerabilityReason[];

    const envelope = createEnvelope({
      actionId: "validate_journey_plan",
      authority: "tool_agent",
      status: "low_coverage",
      answerabilityReason: reasons[0],
      interpretedPlan: plan,
      evidence: [evidence],
      coverage,
      policyRefs: [policyRef]
    });

    expect(envelope).toMatchObject({
      ok: false,
      answerabilityReason: "missing_journey_template",
      interpretedPlan: { intent: "rank_entities_by_outcome" },
      evidence: [{ id: "evidence_1" }],
      coverage: { coveredCount: 1, expectedCount: 2 },
      policyRefs: [{ id: "jt_paid_activation", approved: true }]
    });
    expect(reasons).toContain("unapproved_journey_template");
  });
});

describe("createSessionContext workspace fail-closed", () => {
  it("returns the bound context for a valid workspace id", () => {
    const context = createSessionContext({
      workspaceId: "proj_valid",
      sessionId: "sess_1",
      authority: "operator",
      surface: "cli"
    });
    expect(context).toMatchObject({
      workspaceId: "proj_valid",
      sessionId: "sess_1",
      authority: "operator",
      surface: "cli"
    });
  });

  it("throws instead of silently coercing a missing workspace id to \"default\"", () => {
    expect(() =>
      createSessionContext({
        sessionId: "sess_1",
        authority: "operator",
        surface: "cli"
      })
    ).toThrow(MissingWorkspaceError);
  });

  it("throws on an empty / whitespace-only workspace id", () => {
    for (const workspaceId of ["", "   "]) {
      expect(() =>
        createSessionContext({
          workspaceId,
          authority: "tool_agent",
          surface: "app"
        })
      ).toThrow(MissingWorkspaceError);
    }
  });

  it("throws an error that the existing NoActiveProjectError guards still catch", () => {
    let caught: unknown;
    try {
      createSessionContext({ authority: "operator", surface: "cli" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NoActiveProjectError);
    expect(caught).toBeInstanceOf(MissingWorkspaceError);
  });
});

describe("Meta Ads management action authority (money-safety)", () => {
  const META_WRITE_IDS = [
    "create_meta_campaign",
    "create_meta_ad_set",
    "create_meta_ad",
    "create_meta_creative",
    "set_meta_entity_status",
    // update_meta_budget changes an existing daily budget (spend-affecting) → operator-only.
    "update_meta_budget",
    // delete_meta_entity is destructive (irreversible) → operator-only, exactly
    // like the spend-bearing writes: a tool_agent must NEVER be able to delete.
    "delete_meta_entity"
  ] as const;
  const META_READ_IDS = ["list_meta_entities", "get_meta_entity"] as const;

  it("registers every Meta WRITE id as operator-authority and every Meta READ id as tool_agent", () => {
    for (const id of META_WRITE_IDS) {
      expect((OPERATOR_ACTIONS as readonly string[]).includes(id)).toBe(true);
      expect((READ_ACTIONS as readonly string[]).includes(id)).toBe(false);
      const card = ACTION_CATALOG.find((action) => action.id === id);
      expect(card?.authority).toBe("operator");
      // Operator writes audit through the operator_audit provenance policy.
      expect(card?.provenancePolicy).toBe("operator_audit");
    }
    for (const id of META_READ_IDS) {
      expect((READ_ACTIONS as readonly string[]).includes(id)).toBe(true);
      expect((OPERATOR_ACTIONS as readonly string[]).includes(id)).toBe(false);
      const card = ACTION_CATALOG.find((action) => action.id === id);
      expect(card?.authority).toBe("tool_agent");
    }
  });

  // Creates auto-resolve the workspace's connected Meta source, so sourceId is OPTIONAL on them
  // (⌘L never plumbs a source id — same pattern as run_meta_live_insights). The mutate-existing
  // writes + reads still require an explicit sourceId.
  const META_CREATE_IDS = [
    "create_meta_campaign",
    "create_meta_ad_set",
    "create_meta_ad",
    "create_meta_creative"
  ] as const;

  it("requires sourceId for the mutate-existing Meta writes + reads (but NOT the auto-resolving creates)", () => {
    const sourceRequiredIds = [
      ...META_WRITE_IDS.filter((id) => !(META_CREATE_IDS as readonly string[]).includes(id)),
      ...META_READ_IDS
    ];
    for (const id of sourceRequiredIds) {
      const card = ACTION_CATALOG.find((action) => action.id === id);
      expect(card).toBeDefined();
      const schema = card?.inputSchema as { required?: string[] } | undefined;
      expect(schema?.required).toContain("sourceId");
    }
  });

  it("makes sourceId OPTIONAL on every Meta CREATE (auto-resolved server-side) while keeping their other required fields", () => {
    const expectedRequired: Record<string, string[]> = {
      create_meta_campaign: ["name", "objective"],
      create_meta_ad_set: ["campaignId", "name", "optimizationGoal", "billingEvent"],
      create_meta_ad: ["adsetId", "name", "creativeId"],
      create_meta_creative: ["name", "pageId"]
    };
    for (const id of META_CREATE_IDS) {
      const card = ACTION_CATALOG.find((action) => action.id === id);
      const schema = card?.inputSchema as { required?: string[] } | undefined;
      expect(schema?.required).not.toContain("sourceId");
      expect(schema?.required).toEqual(expectedRequired[id]);
    }
  });

  it("exposes dollar (major-unit) budget fields on campaign + ad set creates alongside the cents fields", () => {
    for (const id of ["create_meta_campaign", "create_meta_ad_set"] as const) {
      const card = ACTION_CATALOG.find((action) => action.id === id);
      const schema = card?.inputSchema as
        | { properties?: Record<string, { type?: string }> }
        | undefined;
      // cents fields stay (back-compat) …
      expect(schema?.properties?.dailyBudget?.type).toBe("number");
      // … and the new dollar/major-unit fields are additive.
      expect(schema?.properties?.dailyBudgetMajor?.type).toBe("number");
      expect(schema?.properties?.lifetimeBudgetMajor?.type).toBe("number");
    }
  });

  it("run_meta_live_insights is a tool_agent READ with bounded enums, optional sourceId, and provider-truth provenance", () => {
    // Deliberately NOT in META_READ_IDS above: sourceId is OPTIONAL here (it auto-resolves to the
    // workspace's sole connected meta_ads source so the ⌘L tool never needs source plumbing);
    // everything else about the read contract is pinned exactly like its list/get siblings.
    expect((READ_ACTIONS as readonly string[]).includes("run_meta_live_insights")).toBe(true);
    expect((OPERATOR_ACTIONS as readonly string[]).includes("run_meta_live_insights")).toBe(false);
    const card = ACTION_CATALOG.find((action) => action.id === "run_meta_live_insights");
    expect(card?.authority).toBe("tool_agent");
    // Live Graph VALUES (bounded window + row cap) — the evidence-reader provenance class,
    // never "metadata" (it returns numbers) and never "queryable_view" (it never reads the store).
    expect(card?.provenancePolicy).toBe("bounded_provider_truth");
    const schema = card?.inputSchema as {
      required?: string[];
      properties?: Record<string, { enum?: string[] }>;
      additionalProperties?: boolean;
    };
    expect(schema?.required).toEqual([]);
    expect(schema?.additionalProperties).toBe(false);
    // Bounded vocabularies: no free-form Graph edge/fields are expressible from this schema.
    expect(schema?.properties?.level?.enum).toEqual(["campaign", "adset", "ad"]);
    expect(schema?.properties?.datePreset?.enum).toContain("last_30d");
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(
      ["datePreset", "level", "limit", "since", "sourceId", "until"]
    );
  });

  it("exposes videoUrl on the Meta creative create schema for desktop uploaded video assets", () => {
    const card = ACTION_CATALOG.find((action) => action.id === "create_meta_creative");
    const schema = card?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(schema?.properties).toMatchObject({
      imageUrl: { type: "string" },
      videoUrl: { type: "string" },
    });
  });

  it("requires `entity` for set_meta_entity_status + delete_meta_entity (uniform, early — CLI needs it to pick the subcommand)", () => {
    for (const id of ["set_meta_entity_status", "delete_meta_entity"] as const) {
      const card = ACTION_CATALOG.find((action) => action.id === id);
      const schema = card?.inputSchema as { required?: string[] } | undefined;
      // entity must be REQUIRED so the failure is uniform regardless of transport (the meta_ads_cli
      // path needs it to pick `ads <entity> update|delete`; the direct-Graph path tolerates its
      // absence — making it required closes that transport-dependent late-failure gap).
      expect(schema?.required).toContain("entity");
    }
  });

  it("update_meta_budget requires sourceId/entityId/entity/dailyBudget and restricts entity to campaign|adset (no ad-level budget)", () => {
    const card = ACTION_CATALOG.find((action) => action.id === "update_meta_budget");
    expect(card).toBeDefined();
    const schema = card?.inputSchema as
      | { required?: string[]; properties?: Record<string, { enum?: string[]; exclusiveMinimum?: number; type?: string }> }
      | undefined;
    expect(schema?.required).toEqual(["sourceId", "entityId", "entity", "dailyBudget"]);
    // Meta has NO ad-level budget → the enum must exclude "ad"/"creative".
    expect(schema?.properties?.entity?.enum).toEqual(["campaign", "adset"]);
    // dailyBudget is a strictly-positive integer-cents amount (0 is not valid).
    expect(schema?.properties?.dailyBudget?.type).toBe("number");
    expect(schema?.properties?.dailyBudget?.exclusiveMinimum).toBe(0);
  });

  it("forbids a tool_agent session from executing any Meta WRITE action", async () => {
    const registry = createInfiniteOsRegistry();
    const toolAgentContext = createSessionContext({
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "app"
    });
    for (const id of META_WRITE_IDS) {
      await expect(
        registry.execute(id, { sourceId: "src_meta" }, toolAgentContext)
      ).rejects.toThrow("operator authority required");
    }
  });

  it("lets an operator session reach the (unwired) Meta WRITE handlers without an authority error", async () => {
    // With no handler injected the catalog returns the not_implemented stub, but
    // crucially assertAuthority must NOT throw for an operator — proving the gate
    // is authority, not a blanket block.
    const registry = createInfiniteOsRegistry();
    const operatorContext = createSessionContext({
      workspaceId: "workspace",
      authority: "operator",
      surface: "cli"
    });
    for (const id of META_WRITE_IDS) {
      const envelope = await registry.execute(id, { sourceId: "src_meta" }, operatorContext);
      expect(envelope.actionId).toBe(id);
      expect(envelope.authority).toBe("operator");
    }
  });

  it("registers delete_meta_entity as a destructive operator-only verb a tool_agent can never fire", async () => {
    // Revert-proof guard for the destructive cleanup verb: if it ever drifts into
    // READ_ACTIONS / tool_agent authority, an LLM session could delete live ad
    // objects. Keep this assertion narrow and explicit.
    expect((OPERATOR_ACTIONS as readonly string[]).includes("delete_meta_entity")).toBe(true);
    expect((READ_ACTIONS as readonly string[]).includes("delete_meta_entity")).toBe(false);
    const card = ACTION_CATALOG.find((action) => action.id === "delete_meta_entity");
    expect(card?.authority).toBe("operator");
    expect(card?.provenancePolicy).toBe("operator_audit");
    const schema = card?.inputSchema as { required?: string[] } | undefined;
    // entity is REQUIRED (review): uniform + early failure regardless of transport.
    expect(schema?.required).toEqual(["sourceId", "entityId", "entity"]);

    const registry = createInfiniteOsRegistry();
    const toolAgentContext = createSessionContext({
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "app"
    });
    await expect(
      registry.execute(
        "delete_meta_entity",
        { sourceId: "src_meta", entityId: "120000000000333" },
        toolAgentContext
      )
    ).rejects.toThrow("operator authority required");
  });
});

describe("createDaemonActionRegistry (Phase-2 native-analytics removal)", () => {
  it("excludes every EMBEDDED_ONLY_READ_ACTIONS id from list() AND execute()", async () => {
    const registry = createDaemonActionRegistry();
    const advertised = new Set(registry.list().map((action) => action.id));
    const context = createSessionContext({
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "app"
    });
    for (const retired of EMBEDDED_ONLY_READ_ACTIONS) {
      expect(advertised.has(retired), `${retired} must not be advertised`).toBe(false);
      expect(registry.get(retired)).toBeUndefined();
      await expect(registry.execute(retired, {}, context)).rejects.toThrow(
        `Unknown Infinite OS action: ${retired}`
      );
    }
  });

  it("keeps every other catalog action and scrubs retired ids from recommendedNextActions", () => {
    const registry = createDaemonActionRegistry();
    const advertised = new Set(registry.list().map((action) => action.id));
    const retired = new Set<string>(EMBEDDED_ONLY_READ_ACTIONS);
    for (const card of ACTION_CATALOG) {
      if (retired.has(card.id)) {
        continue;
      }
      expect(advertised.has(card.id), `${card.id} must survive on the daemon surface`).toBe(true);
    }
    // Full-size check: everything except the retired set survives.
    expect(registry.list().length).toBe(ACTION_CATALOG.length - EMBEDDED_ONLY_READ_ACTIONS.length);
    for (const action of registry.list()) {
      for (const next of action.recommendedNextActions) {
        expect(retired.has(next), `${action.id} still recommends retired ${next}`).toBe(false);
      }
    }
  });

  it("leaves createInfiniteOsRegistry (the embedded/full path) byte-complete", () => {
    // The embedding host executes the retired handlers in-process — the FULL
    // registry (and the createActionHandlers map behind it) must keep carrying
    // every catalog action, including the retired daemon ids.
    const registry = createInfiniteOsRegistry();
    const ids = new Set(registry.list().map((action) => action.id));
    for (const action of ACTION_CATALOG) {
      expect(ids.has(action.id)).toBe(true);
    }
    for (const retired of EMBEDDED_ONLY_READ_ACTIONS) {
      expect(ids.has(retired)).toBe(true);
    }
  });

  it("pins LOCAL_STORE_READ_ACTIONS ⊆ EMBEDDED_ONLY_READ_ACTIONS and keeps Meta reads on the surface", () => {
    const embedded = new Set<string>(EMBEDDED_ONLY_READ_ACTIONS);
    for (const id of LOCAL_STORE_READ_ACTIONS) {
      expect(embedded.has(id)).toBe(true);
    }
    const advertised = new Set<string>(createDaemonActionRegistry().list().map((action) => action.id));
    // Founder hard limit: the Meta lane (live-Graph reads + operator writes)
    // stays fully advertised on the daemon.
    for (const metaAction of [
      "list_meta_assets",
      "list_meta_entities",
      "get_meta_entity",
      "create_meta_campaign",
      "update_meta_budget",
      "set_meta_entity_status",
      "delete_meta_entity"
    ]) {
      expect(advertised.has(metaAction), `${metaAction} must stay advertised`).toBe(true);
    }
  });
});

describe("createDaemonActionRegistry envelope nextActions scrub", () => {
  it("filters retired ids out of surviving handlers' RUNTIME envelopes", async () => {
    // validate_journey_plan survives but its embedded-host envelope recommends
    // the retired run_journey_query — the daemon surface must not re-steer the
    // model toward a tool it refuses.
    const registry = createDaemonActionRegistry({
      validate_journey_plan: (_input, context) =>
        createEnvelope({
          actionId: "validate_journey_plan",
          authority: context.authority,
          data: { valid: true },
          nextActions: ["run_journey_query", "search_context", "resolve_entity"]
        })
    });
    const context = createSessionContext({
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "app"
    });
    const envelope = await registry.execute("validate_journey_plan", {}, context);
    expect(envelope.nextActions).toEqual(["search_context"]);
  });

  it("leaves the full registry's envelopes untouched (embedded/CLI keep the family)", async () => {
    const registry = createInfiniteOsRegistry({
      validate_journey_plan: (_input, context) =>
        createEnvelope({
          actionId: "validate_journey_plan",
          authority: context.authority,
          data: { valid: true },
          nextActions: ["run_journey_query", "search_context"]
        })
    });
    const context = createSessionContext({
      workspaceId: "workspace",
      authority: "tool_agent",
      surface: "cli"
    });
    const envelope = await registry.execute("validate_journey_plan", {}, context);
    expect(envelope.nextActions).toEqual(["run_journey_query", "search_context"]);
  });
});
