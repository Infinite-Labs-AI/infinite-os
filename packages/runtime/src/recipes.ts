import type { ActionEnvelope, InfiniteOsActionId, SessionContext } from "./index.js";

export type RecipeId =
  | "connect_source"
  | "verify_credentials"
  | "sync_source"
  | "inspect_schema"
  | "explain_answer"
  | "save_report"
  | "export_report"
  | "save_export_report";

export interface RecipeStep {
  actionId: InfiniteOsActionId;
  authority: "tool_agent" | "operator";
  input: Record<string, unknown>;
  title: string;
}

export interface RecipeDefinition {
  id: RecipeId;
  title: string;
  category: "operator" | "read" | "reports";
  summary: string;
  steps: RecipeStep[];
}

export interface RecipeRunResult {
  recipeId: RecipeId;
  steps: Array<RecipeStep & { result: ActionEnvelope }>;
  final: ActionEnvelope;
}

export type RecipeExecutor = (
  actionId: InfiniteOsActionId,
  input: Record<string, unknown>,
  context: SessionContext
) => Promise<ActionEnvelope>;

export function listRecipes(): RecipeDefinition[] {
  return [
    {
      id: "connect_source",
      title: "Connect source",
      category: "operator",
      summary: "Create a first-phase provider source and run its credential check.",
      steps: [
        {
          actionId: "connect_source",
          authority: "operator",
          input: {},
          title: "Store encrypted credentials and create the source"
        }
      ]
    },
    {
      id: "verify_credentials",
      title: "Verify credentials",
      category: "operator",
      summary: "Reconnect a source with optional new credentials, then return source status.",
      steps: [
        {
          actionId: "reconnect_source",
          authority: "operator",
          input: {},
          title: "Run provider credential verification"
        },
        {
          actionId: "describe_source",
          authority: "tool_agent",
          input: {},
          title: "Inspect source status"
        }
      ]
    },
    {
      id: "sync_source",
      title: "Sync source",
      category: "operator",
      summary: "Queue a source sync, then inspect recent sync runs.",
      steps: [
        {
          actionId: "start_source_sync",
          authority: "operator",
          input: {},
          title: "Queue source sync"
        },
        {
          actionId: "get_recent_sync_runs",
          authority: "tool_agent",
          input: { limit: 10 },
          title: "Read recent sync runs"
        }
      ]
    },
    {
      id: "inspect_schema",
      title: "Inspect schema",
      category: "read",
      summary: "List queryable views and metrics exposed to operators and MCP clients.",
      steps: [
        {
          actionId: "list_queryable_views",
          authority: "tool_agent",
          input: {},
          title: "List queryable views"
        },
        {
          actionId: "list_metrics",
          authority: "tool_agent",
          input: {},
          title: "List metrics"
        }
      ]
    },
    {
      id: "explain_answer",
      title: "Explain answer",
      category: "read",
      summary: "Explain the last or supplied metric and return bounded drilldown provenance.",
      steps: [
        {
          actionId: "explain_answer",
          authority: "tool_agent",
          input: {},
          title: "Explain metric"
        },
        {
          actionId: "drilldown_result",
          authority: "tool_agent",
          input: {},
          title: "Return bounded provider-truth rows"
        }
      ]
    },
    {
      id: "save_report",
      title: "Save report",
      category: "reports",
      summary: "Create an operator-owned saved report from an existing analytical tool plan.",
      steps: [
        {
          actionId: "create_saved_report",
          authority: "operator",
          input: {},
          title: "Create saved report"
        }
      ]
    },
    {
      id: "export_report",
      title: "Export report",
      category: "reports",
      summary: "Queue a durable JSON export for an existing saved report.",
      steps: [
        {
          actionId: "export_saved_report",
          authority: "operator",
          input: { format: "json" },
          title: "Queue report export"
        }
      ]
    },
    {
      id: "save_export_report",
      title: "Save and export report",
      category: "reports",
      summary: "Create a saved report, queue a run, then queue a durable JSON export.",
      steps: [
        {
          actionId: "create_saved_report",
          authority: "operator",
          input: {},
          title: "Create saved report"
        },
        {
          actionId: "run_saved_report",
          authority: "operator",
          input: {},
          title: "Queue report run"
        },
        {
          actionId: "export_saved_report",
          authority: "operator",
          input: { format: "json" },
          title: "Queue report export"
        }
      ]
    }
  ];
}

export async function runRecipe(
  recipeId: RecipeId,
  input: Record<string, unknown>,
  context: SessionContext,
  execute: RecipeExecutor
): Promise<RecipeRunResult> {
  const recipe = listRecipes().find((candidate) => candidate.id === recipeId);
  if (!recipe) {
    throw new Error(`unknown_recipe:${recipeId}`);
  }

  const completed: RecipeRunResult["steps"] = [];
  let carried = { ...input };
  for (const step of recipe.steps) {
    const stepInput = applyCarriedInput(step.input, carried);
    const result = await execute(step.actionId, stepInput, context);
    completed.push({ ...step, input: stepInput, result });
    carried = carryForward(carried, result);
  }

  const final = completed.at(-1)?.result;
  if (!final) {
    throw new Error(`empty_recipe:${recipeId}`);
  }
  return { recipeId, steps: completed, final };
}

function applyCarriedInput(
  stepInput: Record<string, unknown>,
  carried: Record<string, unknown>
): Record<string, unknown> {
  return { ...carried, ...stepInput };
}

function carryForward(
  current: Record<string, unknown>,
  envelope: ActionEnvelope
): Record<string, unknown> {
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return current;
  }
  const record = data as Record<string, unknown>;
  const source = record.source;
  const job = record.job;
  const report = record.report;
  return {
    ...current,
    ...(isRecord(source) && typeof source.id === "string" ? { sourceId: source.id } : {}),
    ...(isRecord(job) && typeof job.id === "string" ? { jobId: job.id } : {}),
    ...(isRecord(report) && typeof report.id === "string" ? { reportId: report.id } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
