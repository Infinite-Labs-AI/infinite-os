import { NoActiveProjectError } from "@infinite-os/config";
import { describe, expect, it } from "vitest";

import {
  ACTION_CATALOG,
  MissingWorkspaceError,
  OPERATOR_ACTIONS,
  READ_ACTIONS,
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

  it("exposes an input schema requiring sourceId for every Meta management action", () => {
    for (const id of [...META_WRITE_IDS, ...META_READ_IDS]) {
      const card = ACTION_CATALOG.find((action) => action.id === id);
      expect(card).toBeDefined();
      const schema = card?.inputSchema as { required?: string[] } | undefined;
      expect(schema?.required).toContain("sourceId");
    }
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
    expect(schema?.required).toEqual(["sourceId", "entityId"]);

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
