import { describe, expect, it } from "vitest";

import {
  createEnvelope,
  createSessionContext,
  listRecipes,
  runRecipe,
  type InfiniteOsActionId
} from "../src/index.js";

describe("operator recipes", () => {
  it("describes fixed recipes without creating a second action registry", () => {
    const recipes = listRecipes();
    expect(recipes.map((recipe) => recipe.id)).toEqual([
      "connect_source",
      "verify_credentials",
      "sync_source",
      "inspect_schema",
      "explain_answer",
      "save_report",
      "export_report",
      "save_export_report"
    ]);
    expect(recipes.flatMap((recipe) => recipe.steps).map((step) => step.actionId)).not.toContain(
      "resolve_question"
    );
  });

  it("composes existing actions and carries source/report ids forward", async () => {
    const calls: Array<{ actionId: InfiniteOsActionId; input: Record<string, unknown> }> = [];
    const context = createSessionContext({ workspaceId: "proj_test", authority: "operator", surface: "cli" });

    const result = await runRecipe(
      "save_export_report",
      { name: "Revenue", toolPlan: { metric: "recognized_revenue" } },
      context,
      async (actionId, input) => {
        calls.push({ actionId, input });
        if (actionId === "create_saved_report") {
          return createEnvelope({
            actionId,
            authority: "operator",
            data: { report: { id: "report_1" } }
          });
        }
        return createEnvelope({ actionId, authority: "operator", data: { job: { id: `job_${actionId}` } } });
      }
    );

    expect(result.final.actionId).toBe("export_saved_report");
    expect(calls).toEqual([
      {
        actionId: "create_saved_report",
        input: { name: "Revenue", toolPlan: { metric: "recognized_revenue" } }
      },
      {
        actionId: "run_saved_report",
        input: { name: "Revenue", toolPlan: { metric: "recognized_revenue" }, reportId: "report_1" }
      },
      {
        actionId: "export_saved_report",
        input: {
          name: "Revenue",
          toolPlan: { metric: "recognized_revenue" },
          reportId: "report_1",
          jobId: "job_run_saved_report",
          format: "json"
        }
      }
    ]);
  });
});
