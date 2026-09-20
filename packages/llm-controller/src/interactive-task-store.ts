import { Buffer } from "node:buffer";

import type {
  InteractiveActionRef,
  InteractiveTaskDetail,
  InteractiveTaskEvent,
  InteractiveTaskRecord,
} from "@infinite-os/types";

import type {
  ApplyInteractiveTaskTransitionInput,
  CreateInteractiveTaskInput,
  InteractiveTaskStore,
  InteractiveTaskStoreDb,
  InteractiveTaskTransition,
  PreparedInteractiveActionInput,
} from "./interactive-task-types.js";

const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const FORBIDDEN_PROPOSAL_KEY = /(^|_)(authorization|cookie|credential|password|secret|session_?token|access_?token|refresh_?token|api_?key)($|_)/i;
const MAX_EVENT_BYTES = 128 * 1024;
const MAX_PROPOSAL_BYTES = 16 * 1024;
const MAX_SUMMARY_CHARS = 1_000;

type ErrorCode =
  | "invalid_task_input"
  | "task_id_conflict"
  | "task_not_found"
  | "transition_request_conflict"
  | "task_revision_conflict"
  | "invalid_task_transition"
  | "action_not_found"
  | "action_identity_mismatch"
  | "action_state_conflict"
  | "action_authority_expired"
  | "unsafe_proposal_payload";

export class InteractiveTaskConflictError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "InteractiveTaskConflictError";
  }
}

type TaskRow = {
  id: string; workspaceId: string; actorId: string; surface: "cmdl";
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
  state: InteractiveActionRef["state"]; preparedContextRevision: string | null;
  authorizationContextRevision: string | null; authorizationExpiresAt: string | Date | null;
  decisionProvenance: string | null; serviceResumeKey: string | null;
  receiptRef: string | null; outcomeSummary: string | null;
  verification: InteractiveActionRef["verification"]; continuationKey: string | null;
  continuationState: InteractiveActionRef["continuationState"]; revision: number | string;
  createdAt: string | Date; updatedAt: string | Date;
};

const TASK_SELECT = `select id, workspace_id as "workspaceId", actor_id as "actorId", surface,
  client_surface_key as "clientSurfaceKey", provider_id as "providerId", model_id as "modelId",
  agent_profile as "agentProfile", provider_session_id as "providerSessionId",
  accepted_context_revision as "acceptedContextRevision", authority_expires_at as "authorityExpiresAt",
  context_json as "context", state, revision, last_event_sequence as "lastEventSequence",
  cancel_requested_at as "cancelRequestedAt", created_at as "createdAt", updated_at as "updatedAt"
  from interactive_tasks`;
const EVENT_SELECT = `select event_id as "eventId", task_id as "taskId", workspace_id as "workspaceId",
  actor_id as "actorId", sequence, kind, payload_json as "payload",
  transition_request_id as "transitionRequestId", transition_request_hash as "transitionRequestHash",
  created_at as "createdAt" from interactive_task_events`;
const ACTION_SELECT = `select invocation_id as "invocationId", task_id as "taskId",
  workspace_id as "workspaceId", actor_id as "actorId", source_kind as "sourceKind",
  source_ref as "sourceRef", operation_id as "operationId", adapter_version as "adapterVersion",
  schema_version as "schemaVersion", proposal_ref as "proposalRef", proposal_revision as "proposalRevision",
  proposal_hash as "proposalHash", proposal_json as "proposal", input_hash as "inputHash", effect,
  replay_policy as "replayPolicy", state, prepared_context_revision as "preparedContextRevision",
  authorization_context_revision as "authorizationContextRevision",
  authorization_expires_at as "authorizationExpiresAt", decision_provenance as "decisionProvenance",
  service_resume_key as "serviceResumeKey", receipt_ref as "receiptRef",
  outcome_summary as "outcomeSummary", verification, continuation_key as "continuationKey",
  continuation_state as "continuationState", revision, created_at as "createdAt", updated_at as "updatedAt"
  from interactive_action_refs`;

function iso(value: string | Date): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function nullableIso(value: string | Date | null): string | null { return value === null ? null : iso(value); }
function taskFromRow(row: TaskRow): InteractiveTaskRecord {
  return { ...row, revision: Number(row.revision), lastEventSequence: Number(row.lastEventSequence),
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

function requireId(value: string, name: string): void {
  if (!ID_RE.test(value)) throw new InteractiveTaskConflictError("invalid_task_input", `${name} is invalid.`);
}
function requireHash(value: string, name: string): void {
  if (!HASH_RE.test(value)) throw new InteractiveTaskConflictError("invalid_task_input", `${name} is invalid.`);
}
function requireDate(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new InteractiveTaskConflictError("invalid_task_input", `${name} is invalid.`);
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
function validateCreate(input: CreateInteractiveTaskInput): void {
  requireId(input.taskId, "taskId"); requireId(input.workspaceId, "workspaceId");
  requireId(input.actorId, "actorId"); requireId(input.clientSurfaceKey, "clientSurfaceKey");
  requireId(input.initialEvent.eventId, "eventId"); requireId(input.initialEvent.requestId, "requestId");
  requireHash(input.initialEvent.requestHash, "requestHash"); requireDate(input.authorityExpiresAt, "authorityExpiresAt");
  if (!input.providerId || !input.modelId || !input.agentProfile || !input.acceptedContextRevision) {
    throw new InteractiveTaskConflictError("invalid_task_input", "Task execution identity is required.");
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
function validatePreparedAction(action: PreparedInteractiveActionInput): void {
  requireId(action.invocationId, "invocationId"); requireId(action.operationId, "operationId");
  requireId(action.proposalRef, "proposalRef"); requireHash(action.proposalHash, "proposalHash"); requireHash(action.inputHash, "inputHash");
  if (!Number.isSafeInteger(action.proposalRevision) || action.proposalRevision < 1) {
    throw new InteractiveTaskConflictError("invalid_task_input", "proposalRevision is invalid.");
  }
  assertBoundedJson(action.proposal, { maxBytes: MAX_PROPOSAL_BYTES, proposal: true });
}

async function loadTask(db: InteractiveTaskStoreDb, input: { taskId: string; workspaceId: string; actorId: string }, lock = false): Promise<TaskRow | null> {
  return db.one<TaskRow>(`${TASK_SELECT} where id = $1 and workspace_id = $2 and actor_id = $3${lock ? " for update" : ""}`,
    [input.taskId, input.workspaceId, input.actorId]);
}
async function loadActions(db: InteractiveTaskStoreDb, input: { taskId: string; workspaceId: string; actorId: string }): Promise<InteractiveActionRef[]> {
  const rows = await db.query<ActionRow>(`${ACTION_SELECT} where task_id = $1 and workspace_id = $2 and actor_id = $3 order by created_at, invocation_id`,
    [input.taskId, input.workspaceId, input.actorId]);
  return rows.map(actionFromRow);
}
async function loadDetail(db: InteractiveTaskStoreDb, input: { taskId: string; workspaceId: string; actorId: string }): Promise<InteractiveTaskDetail | null> {
  const task = await loadTask(db, input); if (!task) return null;
  return { task: taskFromRow(task), actions: await loadActions(db, input) };
}
async function requiredDetail(db: InteractiveTaskStoreDb, input: { taskId: string; workspaceId: string; actorId: string }): Promise<InteractiveTaskDetail> {
  const detail = await loadDetail(db, input);
  if (!detail) throw new InteractiveTaskConflictError("task_not_found", "Interactive task was not found.");
  return detail;
}
async function loadAction(db: InteractiveTaskStoreDb, scope: { taskId: string; workspaceId: string; actorId: string }, invocationId: string): Promise<ActionRow> {
  const row = await db.one<ActionRow>(`${ACTION_SELECT} where invocation_id = $1 and task_id = $2 and workspace_id = $3 and actor_id = $4`,
    [invocationId, scope.taskId, scope.workspaceId, scope.actorId]);
  if (!row) throw new InteractiveTaskConflictError("action_not_found", "Interactive action was not found.");
  return row;
}
function assertActionIdentity(row: ActionRow, expected: { proposalHash: string; inputHash: string; proposalRef?: string }): void {
  if (row.proposalHash !== expected.proposalHash || row.inputHash !== expected.inputHash ||
    (expected.proposalRef !== undefined && row.proposalRef !== expected.proposalRef)) {
    throw new InteractiveTaskConflictError("action_identity_mismatch", "Interactive action identity changed.");
  }
}
function transitionEvent(transition: InteractiveTaskTransition): { kind: InteractiveTaskEvent["kind"]; payload: Record<string, unknown> } {
  switch (transition.kind) {
    case "record_turn_result": return { kind: "assistant_message", payload: { text: transition.assistantMessage } };
    case "append_event": return { kind: transition.eventKind, payload: transition.payload };
    case "reprepare_action": return { kind: "approval_requested", payload: { invocationId: transition.invocationId, reprepared: true } };
    case "resolve_approval": return { kind: "approval_resolved", payload: { invocationId: transition.invocationId, decision: transition.decision } };
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
  const row = await db.one<EventRow>(`insert into interactive_task_events
    (event_id, task_id, workspace_id, actor_id, sequence, kind, payload_json, transition_request_id, transition_request_hash)
    values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
    returning event_id as "eventId", task_id as "taskId", workspace_id as "workspaceId", actor_id as "actorId",
      sequence, kind, payload_json as "payload", transition_request_id as "transitionRequestId",
      transition_request_hash as "transitionRequestHash", created_at as "createdAt"`,
    [input.eventId, input.taskId, input.workspaceId, input.actorId, sequence, event.kind,
      JSON.stringify(event.payload), input.requestId, input.requestHash]);
  if (!row) throw new Error("Interactive event insert returned no row.");
  return row;
}

export function createInteractiveTaskStore(db: InteractiveTaskStoreDb): InteractiveTaskStore {
  return {
    async createTask(input) {
      validateCreate(input);
      return db.withTransaction(async (tx) => {
        const existing = await tx.one<TaskRow>(`${TASK_SELECT} where id = $1 for update`, [input.taskId]);
        if (existing) {
          if (existing.workspaceId !== input.workspaceId || existing.actorId !== input.actorId) {
            throw new InteractiveTaskConflictError("task_id_conflict", "Interactive task identity is already in use.");
          }
          const event = await tx.one<EventRow>(`${EVENT_SELECT} where task_id = $1 and transition_request_id = $2`,
            [input.taskId, input.initialEvent.requestId]);
          if (!event || event.transitionRequestHash !== input.initialEvent.requestHash) {
            throw new InteractiveTaskConflictError("transition_request_conflict", "Interactive task create request changed.");
          }
          return { ...(await requiredDetail(tx, input)), event: eventFromRow(event), replayed: true };
        }
        const task = await tx.one<TaskRow>(`insert into interactive_tasks
          (id, workspace_id, actor_id, surface, client_surface_key, provider_id, model_id, agent_profile,
           accepted_context_revision, authority_expires_at, context_json, revision, last_event_sequence)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,1,1)
          returning id, workspace_id as "workspaceId", actor_id as "actorId", surface,
            client_surface_key as "clientSurfaceKey", provider_id as "providerId", model_id as "modelId",
            agent_profile as "agentProfile", provider_session_id as "providerSessionId",
            accepted_context_revision as "acceptedContextRevision", authority_expires_at as "authorityExpiresAt",
            context_json as "context", state, revision, last_event_sequence as "lastEventSequence",
            cancel_requested_at as "cancelRequestedAt", created_at as "createdAt", updated_at as "updatedAt"`,
          [input.taskId,input.workspaceId,input.actorId,input.surface,input.clientSurfaceKey,input.providerId,input.modelId,
            input.agentProfile,input.acceptedContextRevision,input.authorityExpiresAt,JSON.stringify(input.context)]);
        if (!task) throw new Error("Interactive task insert returned no row.");
        const event = await tx.one<EventRow>(`insert into interactive_task_events
          (event_id,task_id,workspace_id,actor_id,sequence,kind,payload_json,transition_request_id,transition_request_hash)
          values ($1,$2,$3,$4,1,$5,$6::jsonb,$7,$8)
          returning event_id as "eventId", task_id as "taskId", workspace_id as "workspaceId", actor_id as "actorId",
            sequence,kind,payload_json as "payload",transition_request_id as "transitionRequestId",
            transition_request_hash as "transitionRequestHash",created_at as "createdAt"`,
          [input.initialEvent.eventId,input.taskId,input.workspaceId,input.actorId,input.initialEvent.kind,
            JSON.stringify(input.initialEvent.payload),input.initialEvent.requestId,input.initialEvent.requestHash]);
        if (!event) throw new Error("Interactive task initial event insert returned no row.");
        return { task: taskFromRow(task), actions: [], event: eventFromRow(event), replayed: false };
      });
    },
    getTask(input) { return loadDetail(db, input); },
    async listActiveTasks(input) {
      const rows = await db.query<TaskRow>(`${TASK_SELECT} where workspace_id = $1 and actor_id = $2 and surface = $3
        and state not in ('completed','failed','cancelled') order by updated_at desc limit 20`,
        [input.workspaceId,input.actorId,input.surface]);
      return Promise.all(rows.map(async (row) => ({ task: taskFromRow(row),
        actions: await loadActions(db,{taskId:row.id,workspaceId:row.workspaceId,actorId:row.actorId}) })));
    },
    async listEvents(input) {
      if (!await loadTask(db,input)) return [];
      const after = Number.isSafeInteger(input.after) && (input.after ?? 0) >= 0 ? input.after ?? 0 : 0;
      const limit = Number.isSafeInteger(input.limit) ? Math.min(200,Math.max(1,input.limit ?? 100)) : 100;
      const rows = await db.query<EventRow>(`${EVENT_SELECT} where task_id = $1 and workspace_id = $2 and actor_id = $3
        and sequence > $4 order by sequence limit $5`,[input.taskId,input.workspaceId,input.actorId,after,limit]);
      return rows.map(eventFromRow);
    },
    async transition(input) {
      validateTransitionIdentity(input);
      return db.withTransaction(async (tx) => {
        const taskRow = await loadTask(tx,input,true);
        if (!taskRow) throw new InteractiveTaskConflictError("task_not_found","Interactive task was not found.");
        const prior = await tx.one<EventRow>(`${EVENT_SELECT} where task_id = $1 and transition_request_id = $2`,[input.taskId,input.requestId]);
        if (prior) {
          if (prior.transitionRequestHash !== input.requestHash) throw new InteractiveTaskConflictError("transition_request_conflict","Transition request id was reused with different input.");
          return { ...(await requiredDetail(tx,input)),event:eventFromRow(prior),replayed:true };
        }
        if (Number(taskRow.revision) !== input.expectedRevision) throw new InteractiveTaskConflictError("task_revision_conflict","Interactive task revision changed.");
        const sequence = Number(taskRow.lastEventSequence) + 1;
        let taskState = taskRow.state;
        let providerSessionId = taskRow.providerSessionId;
        let cancelRequested = false;
        const transition = input.transition;
        const scope = {taskId:input.taskId,workspaceId:input.workspaceId,actorId:input.actorId};

        if (transition.kind === "record_turn_result") {
          if (transition.actions.length > 32) throw new InteractiveTaskConflictError("invalid_task_transition","Too many actions in one turn result.");
          assertBoundedJson({text:transition.assistantMessage},{maxBytes:MAX_EVENT_BYTES});
          for (const action of transition.actions) {
            validatePreparedAction(action);
            await tx.query(`insert into interactive_action_refs
              (invocation_id,task_id,workspace_id,actor_id,source_kind,source_ref,operation_id,adapter_version,
               schema_version,proposal_ref,proposal_revision,proposal_hash,proposal_json,input_hash,effect,replay_policy,
               state,prepared_context_revision,continuation_key,continuation_state)
              values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,'awaiting_approval',$17,$18,
                case when $18::text is null then 'not_required' else 'pending' end)`,
              [action.invocationId,input.taskId,input.workspaceId,input.actorId,action.sourceKind,action.sourceRef??null,
               action.operationId,action.adapterVersion,action.schemaVersion,action.proposalRef,action.proposalRevision,
               action.proposalHash,JSON.stringify(action.proposal),action.inputHash,action.effect,action.replayPolicy,
               taskRow.acceptedContextRevision,action.continuationKey??null]);
          }
          providerSessionId = transition.providerSessionId ?? providerSessionId;
          taskState = transition.actions.length > 0 ? "awaiting_approval" : "completed";
        } else if (transition.kind === "append_event") {
          assertBoundedJson(transition.payload,{maxBytes:MAX_EVENT_BYTES});
        } else if (transition.kind === "reprepare_action") {
          const action = await loadAction(tx,scope,transition.invocationId); assertActionIdentity(action,transition);
          if (action.state !== "awaiting_approval" && action.state !== "authorized") throw new InteractiveTaskConflictError("action_state_conflict","Only an undispatched action can be reprepared.");
          await tx.query(`update interactive_action_refs set prepared_context_revision=$2,revision=revision+1,updated_at=now()
            where invocation_id=$1 and task_id=$3 and workspace_id=$4 and actor_id=$5`,
            [transition.invocationId,transition.preparedContextRevision,input.taskId,input.workspaceId,input.actorId]);
        } else if (transition.kind === "resolve_approval") {
          requireDate(transition.authorizationExpiresAt,"authorizationExpiresAt");
          const action = await loadAction(tx,scope,transition.invocationId); assertActionIdentity(action,transition);
          if (action.state !== "awaiting_approval") throw new InteractiveTaskConflictError("action_state_conflict","Action is not awaiting approval.");
          await tx.query(`update interactive_action_refs set state=$2,prepared_context_revision=$3,
            authorization_context_revision=$3,authorization_expires_at=$4,decision_provenance=$5,
            revision=revision+1,updated_at=now() where invocation_id=$1 and task_id=$6 and workspace_id=$7 and actor_id=$8`,
            [transition.invocationId,transition.decision==="approve"?"authorized":"declined",transition.preparedContextRevision,
             transition.authorizationExpiresAt,transition.decisionProvenance,input.taskId,input.workspaceId,input.actorId]);
          taskState = transition.decision === "approve" ? "active" : "completed";
        } else if (transition.kind === "claim_dispatch") {
          const action = await loadAction(tx,scope,transition.invocationId); assertActionIdentity(action,transition);
          if (action.state !== "authorized") throw new InteractiveTaskConflictError("action_state_conflict","Action is not authorized for dispatch.");
          if (action.preparedContextRevision !== transition.preparedContextRevision || action.authorizationContextRevision !== transition.preparedContextRevision) {
            throw new InteractiveTaskConflictError("action_identity_mismatch","Action was not prepared under the current authority.");
          }
          if (!action.authorizationExpiresAt || Date.parse(iso(action.authorizationExpiresAt)) < Date.now()) throw new InteractiveTaskConflictError("action_authority_expired","Action authorization expired before dispatch.");
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
            where task_id=$1 and workspace_id=$2 and actor_id=$3 and state in ('prepared','awaiting_approval','authorized')`,
            [input.taskId,input.workspaceId,input.actorId]);
          taskState = "cancelled"; cancelRequested = true;
        }
        const event = await insertEvent(tx,input,sequence,transitionEvent(transition));
        await tx.query(`update interactive_tasks set state=$4,provider_session_id=$5,revision=revision+1,last_event_sequence=$6,
          cancel_requested_at=case when $7 then now() else cancel_requested_at end,updated_at=now()
          where id=$1 and workspace_id=$2 and actor_id=$3`,[input.taskId,input.workspaceId,input.actorId,taskState,
          providerSessionId,sequence,cancelRequested]);
        return { ...(await requiredDetail(tx,input)),event:eventFromRow(event),replayed:false };
      });
    },
  };
}
