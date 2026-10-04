import { randomUUID } from "node:crypto";
import type { InfiniteOsDb } from "@infinite-os/db";
import type { InfiniteOsModelClient, ModelRequest, ModelResponse, ModelUsage } from "@infinite-os/llm-controller";

export interface AuxiliaryBrainUsageReceipt {
  id: string;
  engineProjectId: string;
  feature: "memory_review" | "compaction";
  provider: "codex" | "claude";
  model: string;
  effort: string | null;
  status: "succeeded" | "failed";
  usage: ModelUsage | null;
  occurredAt: string;
  latencyMs: number;
}

type Db = Pick<InfiniteOsDb, "query">;
const COUNTERS = ["promptTokens", "completionTokens", "cacheReadTokens", "cacheCreationTokens", "reasoningTokens"] as const;

/** Whitelist counters: no provider error text, prompts, outputs, or arbitrary metadata in the outbox. */
export function measuredUsage(value: unknown): ModelUsage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const usage: ModelUsage = {};
  for (const key of COUNTERS) {
    const count = raw[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) usage[key] = count;
  }
  return Object.keys(usage).length ? usage : null;
}

export async function recordAuxiliaryBrainUsage(db: Db, receipt: AuxiliaryBrainUsageReceipt): Promise<void> {
  await db.query(`insert into auxiliary_brain_usage_outbox
    (id, workspace_id, feature, provider, model, effort, status, usage, occurred_at, latency_ms)
    values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) on conflict (id) do nothing`,
  [receipt.id, receipt.engineProjectId, receipt.feature, receipt.provider, receipt.model, receipt.effort,
    receipt.status, JSON.stringify(measuredUsage(receipt.usage)), receipt.occurredAt, receipt.latencyMs]);
}

export async function listAuxiliaryBrainUsage(db: Db, workspaceId?: string): Promise<AuxiliaryBrainUsageReceipt[]> {
  const rows = await db.query<AuxiliaryBrainUsageReceipt>(`select id, workspace_id as "engineProjectId", feature,
    provider, model, effort, status, usage, occurred_at as "occurredAt", latency_ms as "latencyMs"
    from auxiliary_brain_usage_outbox ${workspaceId ? "where workspace_id = $1" : ""}
    order by occurred_at, id limit 100`, workspaceId ? [workspaceId] : []);
  return rows.map(row => ({ ...row, occurredAt: new Date(row.occurredAt).toISOString(), usage: measuredUsage(row.usage) }));
}

export async function acknowledgeAuxiliaryBrainUsage(db: Db, workspaceId: string, ids: string[]): Promise<void> {
  await db.query("delete from auxiliary_brain_usage_outbox where workspace_id = $1 and id = any($2::uuid[])", [workspaceId, ids]);
}

/** AUX ONLY: user-facing gateway rounds have their own receipts and must never enter this outbox. */
export async function completeAuxiliaryModel(
  db: Db,
  modelClient: InfiniteOsModelClient,
  feature: AuxiliaryBrainUsageReceipt["feature"],
  workspaceId: string,
  request: ModelRequest,
): Promise<ModelResponse> {
  const metadata = request.model
    ? { provider: "codex" as const, model: request.model.modelId }
    : modelClient.modelMetadata?.();
  // The unconfigured client returns guidance without invoking any model.
  if (!metadata?.provider || !metadata.model) return modelClient.complete(request);
  const startedAt = Date.now();
  const receipt = {
    id: randomUUID(), engineProjectId: workspaceId, feature, provider: metadata.provider,
    model: metadata.model, effort: request.model?.effort ?? null,
    occurredAt: new Date(startedAt).toISOString(),
  };
  let response: ModelResponse;
  try {
    response = await modelClient.complete(request);
  } catch (error) {
    await recordAuxiliaryBrainUsage(db, { ...receipt, status: "failed", usage: measuredUsage((error as { usage?: unknown } | null)?.usage), latencyMs: Date.now() - startedAt });
    throw error;
  }
  await recordAuxiliaryBrainUsage(db, { ...receipt, status: "succeeded", usage: measuredUsage(response.usage), latencyMs: Date.now() - startedAt });
  return response;
}
