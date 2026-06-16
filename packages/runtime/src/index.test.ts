import { NoActiveProjectError } from "@infinite-os/config";
import { describe, expect, it } from "vitest";

import {
  MissingWorkspaceError,
  createEnvelope,
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
