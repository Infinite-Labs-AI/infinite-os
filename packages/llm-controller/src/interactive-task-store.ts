import { Buffer } from "node:buffer";

import type {
  InteractiveActionRef,
  InteractiveTaskDetail,
  InteractiveTaskEvent,
  InteractiveTaskOrigin,
  InteractiveTaskProvenance,
  InteractiveTaskRecord,
  InteractiveTaskSurface,
} from "@infinite-os/types";

import {
  MAX_INTERACTIVE_GRANT_MS,
  type ApplyInteractiveTaskTransitionInput,
  type CreateInteractiveTaskInput,
  type InteractiveTaskStore,
  type InteractiveTaskStoreDb,
  type InteractiveTaskStoreOptions,
  type InteractiveTaskTransition,
  type PreparedInteractiveActionInput,
  type RevisedInteractiveActionInput,
} from "./interactive-task-types.js";

const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
// Trigger/check/event keys come from cloud rule data: printable, bounded, no control characters.
const KEY_RE = /^[\x21-\x7e]{1,512}$/;
const FORBIDDEN_PROPOSAL_KEY = /(^|_)(authorization|cookie|credential|password|secret|session_?token|access_?token|refresh_?token|api_?key)($|_)/i;
const MAX_EVENT_BYTES = 128 * 1024;
const MAX_PROPOSAL_BYTES = 16 * 1024;
const MAX_SUMMARY_CHARS = 1_000;
const MAX_PROVENANCE_CHARS = 200;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
const SURFACES: readonly InteractiveTaskSurface[] = ["cmdl", "imessage", "agent_tasks"];
const ORIGINS: readonly InteractiveTaskOrigin[] = ["human", "triggered", "scheduled"];
// A proposal that no human has approved yet, or whose grant lapsed: "Apply" may re-prepare it.
const REVISABLE_STATES = new Set(["awaiting_approval", "authorized", "expired"]);

type ErrorCode =
  | "invalid_task_input"
  | "task_id_conflict"
  | "task_not_found"
  | "task_authority_expired"
  | "trigger_key_conflict"
  | "transition_request_conflict"
  | "task_revision_conflict"
  | "invalid_task_transition"
  | "origin_violation"
  | "event_id_conflict"
  | "invocation_id_conflict"
  | "proposal_conflict"
  | "action_not_found"
  | "action_identity_mismatch"
  | "action_state_conflict"
  | "action_authority_expired"
  | "invalid_grant"
  | "unsafe_proposal_payload"
  | "duplicate_record";

export class InteractiveTaskConflictError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly constraint?: string) {
    super(message);
    this.name = "InteractiveTaskConflictError";
  }
}

// Unique-constraint names the store can see, mapped to the typed conflict a caller can act on.
const UNIQUE_CONSTRAINT_CODES: Record<string, ErrorCode> = {
  interactive_tasks_pkey: "task_id_conflict",
  interactive_tasks_trigger_key_idx: "trigger_key_conflict",
  interactive_task_events_pkey: "event_id_conflict",
  interactive_task_events_task_id_transition_request_id_key: "transition_request_conflict",
  interactive_task_events_task_id_sequence_key: "task_revision_conflict",
  interactive_action_refs_pkey: "invocation_id_conflict",
  interactive_action_refs_proposal_head_idx: "proposal_conflict",
  interactive_action_refs_supersedes_idx: "proposal_conflict",
  interactive_action_refs_task_id_proposal_ref_proposal_revision_key: "proposal_conflict",
  interactive_action_refs_task_continuation_idx: "invalid_task_input",
};

/**
 * Postgres integrity errors never leave the store raw. A pre-check normally catches each case
 * first; this covers races and the rules only the database enforces (provenance CHECKs).
 */
function typedDatabaseError(error: unknown): unknown {
  if (error instanceof InteractiveTaskConflictError || !error || typeof error !== "object") return error;
  const { code, constraint: named, message } = error as { code?: unknown; constraint?: unknown; message?: unknown };
  const constraint = typeof named === "string" ? named
    : /constraint "([^"]+)"/.exec(typeof message === "string" ? message : "")?.[1];
  if (code === "23505") {
    return new InteractiveTaskConflictError(UNIQUE_CONSTRAINT_CODES[constraint ?? ""] ?? "duplicate_record",
      "Interactive record already exists.", constraint);
  }
  if (code === "23514" || code === "23503" || code === "23502" || code === "22P02") {
    return new InteractiveTaskConflictError("invalid_task_input", "Interactive record violates a ledger rule.", constraint);
  }
  return error;
}
async function typed<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { throw typedDatabaseError(error); }
}

type Scope = { taskId: string; workspaceId: string; actorId: string };
type TaskRow = {
  id: string; workspaceId: string; actorId: string; surface: InteractiveTaskSurface;
  origin: InteractiveTaskOrigin; triggerKey: string | null; ruleId: string | null;
  ruleVersion: number | null; checkKey: string | null; eventKey: string | null;
  triggerPayloadHash: string | null;
  clientSurfaceKey: string; providerId: string; modelId: string; agentProfile: string;
  providerSessionId: string | null; acceptedContextRevision: string;
  authorityExpiresAt: string | Date; context: Record<string, unknown>;
  state: InteractiveTaskRecord["state"]; revision: number | string;
  lastEventSequence: number | string; cancelRequestedAt: string | Date | null;
  createdAt: string | Date; updatedAt: string | Date;
};
type EventRow = {
  eventId: string; taskId: string; workspaceId: string; actorId: string;
  sequence: number | string; kind: InteractiveTaskEvent["kind"];
  payload: Record<string, unknown>; transitionRequestId: string;
  transitionRequestHash: string; createdAt: string | Date;
};
type ActionRow = {
  invocationId: string; taskId: string; workspaceId: string; actorId: string;
  sourceKind: InteractiveActionRef["sourceKind"]; sourceRef: string | null;
  operationId: string; adapterVersion: string; schemaVersion: string;
  proposalRef: string; proposalRevision: number; proposalHash: string;
  proposal: Record<string, unknown>; inputHash: string;
  effect: InteractiveActionRef["effect"]; replayPolicy: InteractiveActionRef["replayPolicy"];
  state: InteractiveActionRef["state"]; supersedesInvocationId: string | null;
  preparedContextRevision: string | null;
  authorizationContextRevision: string | null; authorizationExpiresAt: string | Date | null;
  decisionProvenance: string | null; serviceResumeKey: string | null;
  receiptRef: string | null; outcomeSummary: string | null;
  verification: InteractiveActionRef["verification"]; continuationKey: string | null;
  continuationState: InteractiveActionRef["continuationState"]; revision: number | string;
  createdAt: string | Date; updatedAt: string | Date;
};

const TASK_COLUMNS = `id, workspace_id as "workspaceId", actor_id as "actorId", surface, origin,
  trigger_key as "triggerKey", rule_id as "ruleId", rule_version as "ruleVersion", check_key as "checkKey",
  event_key as "eventKey", trigger_payload_hash as "triggerPayloadHash",
  client_surface_key as "clientSurfaceKey", provider_id as "providerId", model_id as "modelId",
  agent_profile as "agentProfile", provider_session_id as "providerSessionId",
  accepted_context_revision as "acceptedContextRevision", authority_expires_at as "authorityExpiresAt",
  context_json as "context", state, revision, last_event_sequence as "lastEventSequence",
  cancel_requested_at as "cancelRequestedAt", created_at as "createdAt", updated_at as "updatedAt"`;
const TASK_SELECT = `select ${TASK_COLUMNS} from interactive_tasks`;
const EVENT_COLUMNS = `event_id as "eventId", task_id as "taskId", workspace_id as "workspaceId",
  actor_id as "actorId", sequence, kind, payload_json as "payload",
  transition_request_id as "transitionRequestId", transition_request_hash as "transitionRequestHash",
  created_at as "createdAt"`;
const EVENT_SELECT = `select ${EVENT_COLUMNS} from interactive_task_events`;
const ACTION_SELECT = `select invocation_id as "invocationId", task_id as "taskId",
  workspace_id as "workspaceId", actor_id as "actorId", source_kind as "sourceKind",
  source_ref as "sourceRef", operation_id as "operationId", adapter_version as "adapterVersion",
  schema_version as "schemaVersion", proposal_ref as "proposalRef", proposal_revision as "proposalRevision",
  proposal_hash as "proposalHash", proposal_json as "proposal", input_hash as "inputHash", effect,
  replay_policy as "replayPolicy", state, supersedes_invocation_id as "supersedesInvocationId",
  prepared_context_revision as "preparedContextRevision",
  authorization_context_revision as "authorizationContextRevision",
  authorization_expires_at as "authorizationExpiresAt", decision_provenance as "decisionProvenance",
  service_resume_key as "serviceResumeKey", receipt_ref as "receiptRef",
  outcome_summary as "outcomeSummary", verification, continuation_key as "continuationKey",
  continuation_state as "continuationState", revision, created_at as "createdAt", updated_at as "updatedAt"
  from interactive_action_refs`;

function iso(value: string | Date): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function nullableIso(value: string | Date | null): string | null { return value === null ? null : iso(value); }
function taskFromRow(row: TaskRow): InteractiveTaskRecord {
  const { triggerKey, ruleId, ruleVersion, checkKey, eventKey, triggerPayloadHash, ...rest } = row;
  const provenance: InteractiveTaskProvenance | null = triggerKey !== null && ruleId !== null && triggerPayloadHash !== null
    ? { triggerKey, ruleId, ruleVersion: ruleVersion === null ? null : Number(ruleVersion), checkKey, eventKey, payloadHash: triggerPayloadHash }
    : null;
  return { ...rest, provenance, revision: Number(row.revision), lastEventSequence: Number(row.lastEventSequence),
    authorityExpiresAt: iso(row.authorityExpiresAt), cancelRequestedAt: nullableIso(row.cancelRequestedAt),
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}
function eventFromRow(row: EventRow): InteractiveTaskEvent {
  return { ...row, sequence: Number(row.sequence), createdAt: iso(row.createdAt) };
}
function actionFromRow(row: ActionRow): InteractiveActionRef {
  return { ...row, revision: Number(row.revision), authorizationExpiresAt: nullableIso(row.authorizationExpiresAt),
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

function requireId(value: unknown, name: string): void {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new InteractiveTaskConflictError("invalid_task_input", `${name} is invalid.`);
}
function requireKey(value: unknown, name: string): void {
  if (typeof value !== "string" || !KEY_RE.test(value)) throw new InteractiveTaskConflictError("invalid_task_input", `${name} is invalid.`);
}
function requireHash(value: unknown, name: string): void {
  if (typeof value !== "string" || !HASH_RE.test(value)) throw new InteractiveTaskConflictError("invalid_task_input", `${name} is invalid.`);
}
function requireDate(value: unknown, name: string): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new InteractiveTaskConflictError("invalid_task_input", `${name} is invalid.`);
  return parsed;
}
function requireText(value: unknown, name: string, max: number): void {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new InteractiveTaskConflictError("invalid_task_input", `${name} is invalid.`);
  }
}
function assertBoundedJson(value: unknown, options: { maxBytes: number; proposal?: boolean }): void {
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { throw new InteractiveTaskConflictError("invalid_task_input", "Payload must be JSON serializable."); }
  if (Buffer.byteLength(encoded, "utf8") > options.maxBytes) {
    throw new InteractiveTaskConflictError(options.proposal ? "unsafe_proposal_payload" : "invalid_task_input", "Payload exceeds its storage bound.");
  }
  const inspect = (item: unknown, depth: number): void => {
    if (depth > 10) throw new InteractiveTaskConflictError("unsafe_proposal_payload", "Proposal payload is too deeply nested.");
    if (Array.isArray(item)) {
      if (item.length > 100) throw new InteractiveTaskConflictError("unsafe_proposal_payload", "Proposal payload contains too many items.");
      for (const child of item) inspect(child, depth + 1);
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (options.proposal && FORBIDDEN_PROPOSAL_KEY.test(key)) {
        throw new InteractiveTaskConflictError("unsafe_proposal_payload", "Proposal payload contains a forbidden field.");
      }
      inspect(child, depth + 1);
    }
  };
  inspect(value, 0);
}
function validateCreate(input: CreateInteractiveTaskInput, nowMs: number): void {
  requireId(input.taskId, "taskId"); requireId(input.workspaceId, "workspaceId");
  requireId(input.actorId, "actorId"); requireId(input.clientSurfaceKey, "clientSurfaceKey");
  requireId(input.initialEvent.eventId, "eventId"); requireId(input.initialEvent.requestId, "requestId");
  requireHash(input.initialEvent.requestHash, "requestHash");
  if (requireDate(input.authorityExpiresAt, "authorityExpiresAt") <= nowMs) {
    throw new InteractiveTaskConflictError("task_authority_expired", "Task authority has already expired.");
  }
  if (!input.providerId || !input.modelId || !input.agentProfile || !input.acceptedContextRevision) {
    throw new InteractiveTaskConflictError("invalid_task_input", "Task execution identity is required.");
  }
  if (!ORIGINS.includes(input.origin) || !SURFACES.includes(input.surface)) {
    throw new InteractiveTaskConflictError("invalid_task_input", "Task origin or surface is invalid.");
  }
  // Only a human's own turn opens with a user_message; an automatic turn is never human intent.
  const expectedKind = input.origin === "human" ? "user_message" : "trigger";
  if (input.initialEvent.kind !== expectedKind) {
    throw new InteractiveTaskConflictError("origin_violation", `A ${input.origin} task must open with a ${expectedKind} event.`);
  }
  if (input.origin === "human") {
    if (input.provenance) throw new InteractiveTaskConflictError("origin_violation", "A human task carries no trigger provenance.");
  } else {
    const provenance = input.provenance;
    if (!provenance) throw new InteractiveTaskConflictError("invalid_task_input", "An automatic task needs provenance.");
    requireKey(provenance.triggerKey, "triggerKey"); requireId(provenance.ruleId, "ruleId");
    requireHash(provenance.payloadHash, "payloadHash");
    if (provenance.ruleVersion !== null && (!Number.isSafeInteger(provenance.ruleVersion) || provenance.ruleVersion < 1)) {
      throw new InteractiveTaskConflictError("invalid_task_input", "ruleVersion is invalid.");
    }
    if (provenance.checkKey !== null) requireKey(provenance.checkKey, "checkKey");
    if (provenance.eventKey !== null) requireKey(provenance.eventKey, "eventKey");
  }
  if (Object.keys(input.context).some((key) => key !== "activeSurfaceId" && key !== "canonicalCwd")) {
    throw new InteractiveTaskConflictError("invalid_task_input", "Task context contains an unsupported field.");
  }
  assertBoundedJson(input.context, { maxBytes: MAX_PROPOSAL_BYTES });
  assertBoundedJson(input.initialEvent.payload, { maxBytes: MAX_EVENT_BYTES });
}
function validateTransitionIdentity(input: ApplyInteractiveTaskTransitionInput): void {
  requireId(input.taskId, "taskId"); requireId(input.workspaceId, "workspaceId"); requireId(input.actorId, "actorId");
  requireId(input.requestId, "requestId"); requireId(input.eventId, "eventId"); requireHash(input.requestHash, "requestHash");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new InteractiveTaskConflictError("invalid_task_input", "expectedRevision is invalid.");
  }
}
function validateActionBody(action: RevisedInteractiveActionInput): void {
  requireId(action.invocationId, "invocationId"); requireId(action.operationId, "operationId");
  requireHash(action.proposalHash, "proposalHash"); requireHash(action.inputHash, "inputHash");
  if (action.continuationKey !== undefined) requireKey(action.continuationKey, "continuationKey");
  assertBoundedJson(action.proposal, { maxBytes: MAX_PROPOSAL_BYTES, proposal: true });
}
function validatePreparedAction(action: PreparedInteractiveActionInput): void {
  validateActionBody(action); requireId(action.proposalRef, "proposalRef");
  // A turn opens a proposal lineage at revision 1; later revisions only come from revise_proposal.
  if (action.proposalRevision !== 1) {
    throw new InteractiveTaskConflictError("invalid_task_input", "A new proposal starts at revision 1.");
  }
}

async function loadTask(db: InteractiveTaskStoreDb, input: Scope, lock = false): Promise<TaskRow | null> {
  return db.one<TaskRow>(`${TASK_SELECT} where id = $1 and workspace_id = $2 and actor_id = $3${lock ? " for update" : ""}`,
    [input.taskId, input.workspaceId, input.actorId]);
}
async function loadActions(db: InteractiveTaskStoreDb, input: Scope): Promise<InteractiveActionRef[]> {
  const rows = await db.query<ActionRow>(`${ACTION_SELECT} where task_id = $1 and workspace_id = $2 and actor_id = $3
    order by proposal_ref, proposal_revision`, [input.taskId, input.workspaceId, input.actorId]);
  return rows.map(actionFromRow);
}
async function loadDetail(db: InteractiveTaskStoreDb, input: Scope): Promise<InteractiveTaskDetail | null> {
  const task = await loadTask(db, input); if (!task) return null;
  return { task: taskFromRow(task), actions: await loadActions(db, input) };
}
async function requiredDetail(db: InteractiveTaskStoreDb, input: Scope): Promise<InteractiveTaskDetail> {
  const detail = await loadDetail(db, input);
  if (!detail) throw new InteractiveTaskConflictError("task_not_found", "Interactive task was not found.");
  return detail;
}
async function loadAction(db: InteractiveTaskStoreDb, scope: Scope, invocationId: string): Promise<ActionRow> {
  const row = await db.one<ActionRow>(`${ACTION_SELECT} where invocation_id = $1 and task_id = $2 and workspace_id = $3 and actor_id = $4`,
    [invocationId, scope.taskId, scope.workspaceId, scope.actorId]);
  if (!row) throw new InteractiveTaskConflictError("action_not_found", "Interactive action was not found.");
  return row;
}
async function assertInvocationIdFree(db: InteractiveTaskStoreDb, invocationId: string): Promise<void> {
  // Invocation ids are global; never reveal which task or workspace already owns one.
  if (await db.one(`select 1 as found from interactive_action_refs where invocation_id = $1`, [invocationId])) {
    throw new InteractiveTaskConflictError("invocation_id_conflict", "Invocation id is already in use.");
  }
}
async function assertEventIdFree(db: InteractiveTaskStoreDb, eventId: string): Promise<void> {
  if (await db.one(`select 1 as found from interactive_task_events where event_id = $1`, [eventId])) {
    throw new InteractiveTaskConflictError("event_id_conflict", "Event id is already in use.");
  }
}
function assertActionIdentity(row: ActionRow, expected: { proposalHash: string; inputHash: string; proposalRef?: string }): void {
  if (row.proposalHash !== expected.proposalHash || row.inputHash !== expected.inputHash ||
    (expected.proposalRef !== undefined && row.proposalRef !== expected.proposalRef)) {
    throw new InteractiveTaskConflictError("action_identity_mismatch", "Interactive action identity changed.");
  }
}
function transitionEvent(transition: InteractiveTaskTransition, revisedRevision?: number): { kind: InteractiveTaskEvent["kind"]; payload: Record<string, unknown> } {
  switch (transition.kind) {
    case "record_turn_result": return { kind: "assistant_message", payload: { text: transition.assistantMessage } };
    case "append_event": return { kind: transition.eventKind, payload: transition.payload };
    case "revise_proposal": return { kind: "proposal_revised", payload: { invocationId: transition.revised.invocationId,
      supersededInvocationId: transition.invocationId, proposalRevision: revisedRevision } };
    case "resolve_approval": return { kind: "approval_resolved", payload: { invocationId: transition.invocationId, decision: transition.decision } };
    case "expire_authorization": return { kind: "authorization_expired", payload: { invocationId: transition.invocationId, reason: transition.reason } };
    case "claim_dispatch": return { kind: "action_dispatch", payload: { invocationId: transition.invocationId } };
    case "record_outcome": return { kind: "action_outcome", payload: { invocationId: transition.invocationId, state: transition.state, summary: transition.outcomeSummary, verification: transition.verification } };
    case "claim_continuation": return { kind: "continuation", payload: { invocationId: transition.invocationId, state: "running" } };
    case "finish_continuation": return { kind: "continuation", payload: { invocationId: transition.invocationId, state: transition.state } };
    case "cancel_task": return { kind: "task_state", payload: { state: "cancelled", reason: transition.reason } };
  }
}
async function insertEvent(db: InteractiveTaskStoreDb, input: ApplyInteractiveTaskTransitionInput, sequence: number,
  event: ReturnType<typeof transitionEvent>): Promise<EventRow> {
  assertBoundedJson(event.payload, { maxBytes: MAX_EVENT_BYTES });
  await assertEventIdFree(db, input.eventId);
  const row = await db.one<EventRow>(`insert into interactive_task_events
    (event_id, task_id, workspace_id, actor_id, sequence, kind, payload_json, transition_request_id, transition_request_hash)
    values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) returning ${EVENT_COLUMNS}`,
    [input.eventId, input.taskId, input.workspaceId, input.actorId, sequence, event.kind,
      JSON.stringify(event.payload), input.requestId, input.requestHash]);
  if (!row) throw new Error("Interactive event insert returned no row.");
  return row;
}
async function insertAction(db: InteractiveTaskStoreDb, scope: Scope, action: RevisedInteractiveActionInput,
  lineage: { proposalRef: string; proposalRevision: number; supersedesInvocationId: string | null; preparedContextRevision: string }): Promise<void> {
  await assertInvocationIdFree(db, action.invocationId);
  await db.query(`insert into interactive_action_refs
    (invocation_id,task_id,workspace_id,actor_id,source_kind,source_ref,operation_id,adapter_version,
     schema_version,proposal_ref,proposal_revision,proposal_hash,proposal_json,input_hash,effect,replay_policy,
     state,supersedes_invocation_id,prepared_context_revision,continuation_key,continuation_state)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,'awaiting_approval',$17,$18,$19,
      case when $19::text is null then 'not_required' else 'pending' end)`,
    [action.invocationId,scope.taskId,scope.workspaceId,scope.actorId,action.sourceKind,action.sourceRef??null,
     action.operationId,action.adapterVersion,action.schemaVersion,lineage.proposalRef,lineage.proposalRevision,
     action.proposalHash,JSON.stringify(action.proposal),action.inputHash,action.effect,action.replayPolicy,
     lineage.supersedesInvocationId,lineage.preparedContextRevision,action.continuationKey??null]);
}

// Keyset cursor over (created_at, id). created_at travels as Postgres text so microseconds survive.
function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), "utf8").toString("base64url");
}
function decodeCursor(cursor: string): [string, string] {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string" &&
      ID_RE.test(value[1]) && Number.isFinite(Date.parse(value[0]))) return [value[0], value[1]];
  } catch { /* fall through */ }
  throw new InteractiveTaskConflictError("invalid_task_input", "cursor is invalid.");
}

export function createInteractiveTaskStore(
  db: InteractiveTaskStoreDb,
  options: InteractiveTaskStoreOptions = {},
): InteractiveTaskStore {
  const now = options.now ?? (() => new Date());
  const maxGrantMs = options.maxGrantMs ?? MAX_INTERACTIVE_GRANT_MS;
  if (!Number.isSafeInteger(maxGrantMs) || maxGrantMs < 1 || maxGrantMs > MAX_INTERACTIVE_GRANT_MS) {
    throw new RangeError(`maxGrantMs must be between 1 and ${MAX_INTERACTIVE_GRANT_MS}.`);
  }
  return {
    async createTask(input) {
      validateCreate(input, now().getTime());
      const provenance = input.origin === "human" ? null : input.provenance;
      return typed(() => db.withTransaction(async (tx) => {
        // A retried automatic turn maps to the task its trigger key already opened.
        if (provenance) {
          const keyed = await tx.one<TaskRow>(`${TASK_SELECT} where workspace_id = $1 and trigger_key = $2 for update`,
            [input.workspaceId, provenance.triggerKey]);
          if (keyed) return replayTriggeredCreate(tx, keyed, input.actorId);
        }
        const existing = await tx.one<TaskRow>(`${TASK_SELECT} where id = $1 for update`, [input.taskId]);
        if (existing) {
          if (existing.workspaceId !== input.workspaceId || existing.actorId !== input.actorId || existing.triggerKey !== null) {
            throw new InteractiveTaskConflictError("task_id_conflict", "Interactive task identity is already in use.");
          }
          const event = await tx.one<EventRow>(`${EVENT_SELECT} where task_id = $1 and transition_request_id = $2`,
            [input.taskId, input.initialEvent.requestId]);
          if (!event || event.transitionRequestHash !== input.initialEvent.requestHash) {
            throw new InteractiveTaskConflictError("transition_request_conflict", "Interactive task create request changed.");
          }
          return { ...(await requiredDetail(tx, input)), event: eventFromRow(event), replayed: true };
        }
        await assertEventIdFree(tx, input.initialEvent.eventId);
        const task = await tx.one<TaskRow>(`insert into interactive_tasks
          (id, workspace_id, actor_id, surface, origin, trigger_key, rule_id, rule_version, check_key, event_key,
           trigger_payload_hash, client_surface_key, provider_id, model_id, agent_profile,
           accepted_context_revision, authority_expires_at, context_json, revision, last_event_sequence)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,1,1)
          on conflict (workspace_id, trigger_key) where trigger_key is not null do nothing
          returning ${TASK_COLUMNS}`,
          [input.taskId,input.workspaceId,input.actorId,input.surface,input.origin,provenance?.triggerKey ?? null,
            provenance?.ruleId ?? null,provenance?.ruleVersion ?? null,provenance?.checkKey ?? null,
            provenance?.eventKey ?? null,provenance?.payloadHash ?? null,input.clientSurfaceKey,input.providerId,
            input.modelId,input.agentProfile,input.acceptedContextRevision,input.authorityExpiresAt,
            JSON.stringify(input.context)]);
        if (!task) {
          // A concurrent create won the trigger key between our read and insert.
          const keyed = await tx.one<TaskRow>(`${TASK_SELECT} where workspace_id = $1 and trigger_key = $2`,
            [input.workspaceId, provenance?.triggerKey ?? null]);
          if (!keyed) throw new Error("Interactive task insert returned no row.");
          return replayTriggeredCreate(tx, keyed, input.actorId);
        }
        const event = await tx.one<EventRow>(`insert into interactive_task_events
          (event_id,task_id,workspace_id,actor_id,sequence,kind,payload_json,transition_request_id,transition_request_hash)
          values ($1,$2,$3,$4,1,$5,$6::jsonb,$7,$8) returning ${EVENT_COLUMNS}`,
          [input.initialEvent.eventId,input.taskId,input.workspaceId,input.actorId,input.initialEvent.kind,
            JSON.stringify(input.initialEvent.payload),input.initialEvent.requestId,input.initialEvent.requestHash]);
        if (!event) throw new Error("Interactive task initial event insert returned no row.");
        return { task: taskFromRow(task), actions: [], event: eventFromRow(event), replayed: false };
      }));
    },
    getTask(input) { return typed(() => loadDetail(db, input)); },
    async listActiveTasks(input) {
      requireId(input.workspaceId, "workspaceId"); requireId(input.actorId, "actorId");
      const limit = input.limit ?? DEFAULT_PAGE;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) {
        throw new InteractiveTaskConflictError("invalid_task_input", "limit is invalid.");
      }
      if (input.surface !== undefined && !SURFACES.includes(input.surface)) throw new InteractiveTaskConflictError("invalid_task_input", "surface is invalid.");
      if (input.origin !== undefined && !ORIGINS.includes(input.origin)) throw new InteractiveTaskConflictError("invalid_task_input", "origin is invalid.");
      const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
      return typed(async () => {
        const rows = await db.query<TaskRow & { cursorCreatedAt: string }>(`select ${TASK_COLUMNS},
            created_at::text as "cursorCreatedAt" from interactive_tasks
          where workspace_id = $1 and actor_id = $2 and state not in ('completed','failed','cancelled')
            and ($3::text is null or surface = $3) and ($4::text is null or origin = $4)
            and ($5::timestamptz is null or (created_at, id) < ($5::timestamptz, $6::text))
          order by created_at desc, id desc limit $7`,
          [input.workspaceId,input.actorId,input.surface ?? null,input.origin ?? null,after?.[0] ?? null,after?.[1] ?? null,limit + 1]);
        const page = rows.slice(0, limit);
        const tasks = await Promise.all(page.map(async ({ cursorCreatedAt: _cursor, ...row }) => ({ task: taskFromRow(row),
          actions: await loadActions(db,{taskId:row.id,workspaceId:row.workspaceId,actorId:row.actorId}) })));
        const last = page.at(-1);
        return { tasks, nextCursor: rows.length > limit && last ? encodeCursor(last.cursorCreatedAt, last.id) : null };
      });
    },
    listEvents(input) {
      return typed(async () => {
        if (!await loadTask(db,input)) return [];
        const after = Number.isSafeInteger(input.after) && (input.after ?? 0) >= 0 ? input.after ?? 0 : 0;
        const limit = Number.isSafeInteger(input.limit) ? Math.min(200,Math.max(1,input.limit ?? 100)) : 100;
        const rows = await db.query<EventRow>(`${EVENT_SELECT} where task_id = $1 and workspace_id = $2 and actor_id = $3
          and sequence > $4 order by sequence limit $5`,[input.taskId,input.workspaceId,input.actorId,after,limit]);
        return rows.map(eventFromRow);
      });
    },
    async transition(input) {
      validateTransitionIdentity(input);
      return typed(() => db.withTransaction(async (tx) => {
        const taskRow = await loadTask(tx,input,true);
        if (!taskRow) throw new InteractiveTaskConflictError("task_not_found","Interactive task was not found.");
        const prior = await tx.one<EventRow>(`${EVENT_SELECT} where task_id = $1 and transition_request_id = $2`,[input.taskId,input.requestId]);
        if (prior) {
          if (prior.transitionRequestHash !== input.requestHash) throw new InteractiveTaskConflictError("transition_request_conflict","Transition request id was reused with different input.");
          return { ...(await requiredDetail(tx,input)),event:eventFromRow(prior),replayed:true };
        }
        const transition = input.transition;
        // An automatic turn records exactly one result. A retried turn (new request id, new model
        // output, any invocation ids or revisions) maps to that existing outcome and adds nothing.
        if (transition.kind === "record_turn_result" && taskRow.triggerKey !== null) {
          const recorded = await tx.one<EventRow>(`${EVENT_SELECT} where task_id = $1 and kind = 'assistant_message'
            order by sequence limit 1`,[input.taskId]);
          if (recorded) return { ...(await requiredDetail(tx,input)),event:eventFromRow(recorded),replayed:true };
        }
        if (Number(taskRow.revision) !== input.expectedRevision) throw new InteractiveTaskConflictError("task_revision_conflict","Interactive task revision changed.");
        const nowMs = now().getTime();
        const sequence = Number(taskRow.lastEventSequence) + 1;
        let taskState = taskRow.state;
        let providerSessionId = taskRow.providerSessionId;
        let cancelRequested = false;
        let revisedRevision: number | undefined;
        const scope = {taskId:input.taskId,workspaceId:input.workspaceId,actorId:input.actorId};

        if (transition.kind === "record_turn_result") {
          // New proposals need the originating turn's authority; a late turn cannot add them.
          if (Date.parse(iso(taskRow.authorityExpiresAt)) <= nowMs) throw new InteractiveTaskConflictError("task_authority_expired","Task authority expired before the turn result.");
          if (transition.actions.length > 32) throw new InteractiveTaskConflictError("invalid_task_transition","Too many actions in one turn result.");
          assertBoundedJson({text:transition.assistantMessage},{maxBytes:MAX_EVENT_BYTES});
          const refs = new Set<string>();
          for (const action of transition.actions) {
            validatePreparedAction(action);
            if (refs.has(action.proposalRef)) throw new InteractiveTaskConflictError("proposal_conflict","A turn result names one proposal twice.");
            refs.add(action.proposalRef);
            await assertInvocationIdFree(tx,action.invocationId);
            if (await tx.one(`select 1 as found from interactive_action_refs where task_id = $1 and proposal_ref = $2`,[input.taskId,action.proposalRef])) {
              throw new InteractiveTaskConflictError("proposal_conflict","Proposal already exists; revise it instead.");
            }
            await insertAction(tx,scope,action,{proposalRef:action.proposalRef,proposalRevision:1,supersedesInvocationId:null,
              preparedContextRevision:taskRow.acceptedContextRevision});
          }
          providerSessionId = transition.providerSessionId ?? providerSessionId;
          taskState = transition.actions.length > 0 ? "awaiting_approval" : "completed";
        } else if (transition.kind === "append_event") {
          if (transition.eventKind !== "progress" && transition.eventKind !== "user_message") {
            throw new InteractiveTaskConflictError("invalid_task_transition","Only progress or a user message can be appended.");
          }
          if (transition.eventKind === "user_message" && taskRow.origin !== "human") {
            throw new InteractiveTaskConflictError("origin_violation","An automatic task never records a user message.");
          }
          assertBoundedJson(transition.payload,{maxBytes:MAX_EVENT_BYTES});
        } else if (transition.kind === "revise_proposal") {
          const action = await loadAction(tx,scope,transition.invocationId);
          if (action.proposalHash !== transition.proposalHash) throw new InteractiveTaskConflictError("action_identity_mismatch","Only the named revision can be revised.");
          if (!REVISABLE_STATES.has(action.state)) throw new InteractiveTaskConflictError("action_state_conflict","Only an undispatched, undeclined proposal can be re-prepared.");
          validateActionBody(transition.revised);
          if (transition.revised.operationId !== action.operationId || transition.revised.effect !== action.effect) {
            throw new InteractiveTaskConflictError("action_identity_mismatch","A revision cannot change the operation or its effect.");
          }
          requireText(transition.preparedContextRevision,"preparedContextRevision",MAX_PROVENANCE_CHARS);
          // Supersede first: the head index allows one live revision per lineage at any instant.
          await tx.query(`update interactive_action_refs set state='superseded',revision=revision+1,updated_at=now()
            where invocation_id=$1 and task_id=$2 and workspace_id=$3 and actor_id=$4`,
            [transition.invocationId,input.taskId,input.workspaceId,input.actorId]);
          revisedRevision = action.proposalRevision + 1;
          await insertAction(tx,scope,transition.revised,{proposalRef:action.proposalRef,proposalRevision:revisedRevision,
            supersedesInvocationId:action.invocationId,preparedContextRevision:transition.preparedContextRevision});
          taskState = "awaiting_approval";
        } else if (transition.kind === "resolve_approval") {
          requireText(transition.decisionProvenance,"decisionProvenance",MAX_PROVENANCE_CHARS);
          const action = await loadAction(tx,scope,transition.invocationId); assertActionIdentity(action,transition);
          if (action.state !== "awaiting_approval") throw new InteractiveTaskConflictError("action_state_conflict","Action is not awaiting approval.");
          let expiresAt: string | null = null;
          if (transition.decision === "approve") {
            const expiresMs = requireDate(transition.authorizationExpiresAt,"authorizationExpiresAt");
            // A grant is fresh human authority for at most the ceiling; it is never extended.
            if (expiresMs <= nowMs || expiresMs - nowMs > maxGrantMs) {
              throw new InteractiveTaskConflictError("invalid_grant",`A grant must expire within ${maxGrantMs}ms from now.`);
            }
            expiresAt = new Date(expiresMs).toISOString();
          }
          await tx.query(`update interactive_action_refs set state=$2,prepared_context_revision=$3,
            authorization_context_revision=$3,authorization_expires_at=$4,decision_provenance=$5,
            revision=revision+1,updated_at=now() where invocation_id=$1 and task_id=$6 and workspace_id=$7 and actor_id=$8`,
            [transition.invocationId,transition.decision==="approve"?"authorized":"declined",transition.preparedContextRevision,
             expiresAt,transition.decisionProvenance,input.taskId,input.workspaceId,input.actorId]);
          taskState = transition.decision === "approve" ? "active" : "completed";
        } else if (transition.kind === "expire_authorization") {
          if (!["lapsed","host_restart","discarded"].includes(transition.reason)) throw new InteractiveTaskConflictError("invalid_task_input","Expiry reason is invalid.");
          const action = await loadAction(tx,scope,transition.invocationId);
          if (action.state !== "authorized") throw new InteractiveTaskConflictError("action_state_conflict","Only an authorized, undispatched action has a grant to expire.");
          if (transition.reason === "lapsed" && action.authorizationExpiresAt && Date.parse(iso(action.authorizationExpiresAt)) > nowMs) {
            throw new InteractiveTaskConflictError("action_state_conflict","The grant has not lapsed yet.");
          }
          await tx.query(`update interactive_action_refs set state='expired',revision=revision+1,updated_at=now()
            where invocation_id=$1 and task_id=$2 and workspace_id=$3 and actor_id=$4`,
            [transition.invocationId,input.taskId,input.workspaceId,input.actorId]);
          taskState = "awaiting_approval";
        } else if (transition.kind === "claim_dispatch") {
          const action = await loadAction(tx,scope,transition.invocationId); assertActionIdentity(action,transition);
          if (action.state !== "authorized") throw new InteractiveTaskConflictError("action_state_conflict","Action is not authorized for dispatch.");
          if (action.preparedContextRevision !== transition.preparedContextRevision || action.authorizationContextRevision !== transition.preparedContextRevision) {
            throw new InteractiveTaskConflictError("action_identity_mismatch","Action was not prepared under the current authority.");
          }
          // A grant ends at its expiry instant; restore or delay can never extend it.
          if (!action.authorizationExpiresAt || Date.parse(iso(action.authorizationExpiresAt)) <= nowMs) throw new InteractiveTaskConflictError("action_authority_expired","Action authorization expired before dispatch.");
          if (action.serviceResumeKey && action.serviceResumeKey !== transition.serviceResumeKey) throw new InteractiveTaskConflictError("action_identity_mismatch","Action service resume key changed.");
          await tx.query(`update interactive_action_refs set state='dispatching',service_resume_key=coalesce(service_resume_key,$2),
            revision=revision+1,updated_at=now() where invocation_id=$1 and task_id=$3 and workspace_id=$4 and actor_id=$5`,
            [transition.invocationId,transition.serviceResumeKey,input.taskId,input.workspaceId,input.actorId]);
        } else if (transition.kind === "record_outcome") {
          if (transition.outcomeSummary.length > MAX_SUMMARY_CHARS) throw new InteractiveTaskConflictError("invalid_task_input","Outcome summary is too long.");
          const action = await loadAction(tx,scope,transition.invocationId);
          if (action.state !== "dispatching" && action.state !== "unknown") throw new InteractiveTaskConflictError("action_state_conflict","Action has no reconcilable dispatch.");
          const continuationState = transition.state === "succeeded" && action.continuationKey ? "pending" : action.continuationState;
          await tx.query(`update interactive_action_refs set state=$2,receipt_ref=coalesce(receipt_ref,$3),outcome_summary=$4,
            verification=$5,continuation_state=$6,revision=revision+1,updated_at=now()
            where invocation_id=$1 and task_id=$7 and workspace_id=$8 and actor_id=$9`,
            [transition.invocationId,transition.state,transition.receiptRef??null,transition.outcomeSummary,transition.verification,
             continuationState,input.taskId,input.workspaceId,input.actorId]);
          taskState = transition.state === "unknown" ? "recovering" : transition.state === "failed" ? "failed" : continuationState === "pending" ? "active" : "completed";
        } else if (transition.kind === "claim_continuation") {
          const action = await loadAction(tx,scope,transition.invocationId);
          if (action.state !== "succeeded" || action.continuationState !== "pending" || action.continuationKey !== transition.continuationKey) throw new InteractiveTaskConflictError("action_state_conflict","Continuation is not pending for this action.");
          await tx.query(`update interactive_action_refs set continuation_state='running',revision=revision+1,updated_at=now()
            where invocation_id=$1 and task_id=$2 and workspace_id=$3 and actor_id=$4`,[transition.invocationId,input.taskId,input.workspaceId,input.actorId]);
        } else if (transition.kind === "finish_continuation") {
          const action = await loadAction(tx,scope,transition.invocationId);
          if (action.continuationState !== "running" || action.continuationKey !== transition.continuationKey) throw new InteractiveTaskConflictError("action_state_conflict","Continuation is not running for this action.");
          await tx.query(`update interactive_action_refs set continuation_state=$2,revision=revision+1,updated_at=now()
            where invocation_id=$1 and task_id=$3 and workspace_id=$4 and actor_id=$5`,[transition.invocationId,transition.state,input.taskId,input.workspaceId,input.actorId]);
          taskState = transition.state === "completed" ? "completed" : "failed";
        } else if (transition.kind === "cancel_task") {
          if (!transition.reason.trim() || transition.reason.length > 200) throw new InteractiveTaskConflictError("invalid_task_input","Cancellation reason is invalid.");
          await tx.query(`update interactive_action_refs set state='cancelled',revision=revision+1,updated_at=now()
            where task_id=$1 and workspace_id=$2 and actor_id=$3 and state in ('prepared','awaiting_approval','authorized','expired')`,
            [input.taskId,input.workspaceId,input.actorId]);
          taskState = "cancelled"; cancelRequested = true;
        } else {
          throw new InteractiveTaskConflictError("invalid_task_transition","Unknown transition.");
        }
        const event = await insertEvent(tx,input,sequence,transitionEvent(transition,revisedRevision));
        await tx.query(`update interactive_tasks set state=$4,provider_session_id=$5,revision=revision+1,last_event_sequence=$6,
          cancel_requested_at=case when $7 then now() else cancel_requested_at end,updated_at=now()
          where id=$1 and workspace_id=$2 and actor_id=$3`,[input.taskId,input.workspaceId,input.actorId,taskState,
          providerSessionId,sequence,cancelRequested]);
        return { ...(await requiredDetail(tx,input)),event:eventFromRow(event),replayed:false };
      }));
    },
  };

  async function replayTriggeredCreate(tx: InteractiveTaskStoreDb, keyed: TaskRow, actorId: string) {
    if (keyed.actorId !== actorId) throw new InteractiveTaskConflictError("trigger_key_conflict","Trigger key belongs to another task.");
    const first = await tx.one<EventRow>(`${EVENT_SELECT} where task_id = $1 and sequence = 1`,[keyed.id]);
    if (!first) throw new Error("Interactive task has no opening event.");
    const scope = {taskId:keyed.id,workspaceId:keyed.workspaceId,actorId:keyed.actorId};
    return { ...(await requiredDetail(tx,scope)), event: eventFromRow(first), replayed: true };
  }
}
