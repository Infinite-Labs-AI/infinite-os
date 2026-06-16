import { randomUUID } from "node:crypto";

import type { ActionEnvelope } from "@infinite-os/runtime";

export type ChatMessageRole = "system" | "user" | "assistant" | "tool" | "summary";
export type ChatActionStatus = ActionEnvelope["status"] | "requires_confirmation";

export interface SessionStoreDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
}

export interface EnsureSessionInput {
  sessionId: string;
  workspaceId: string;
  actorId: string;
  surface: "cli" | "api" | "app" | "mcp";
  modelProvider?: string;
  modelName?: string;
  modelAuthSource?: string;
  parentSessionId?: string;
}

export interface AppendMessageInput {
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  tokenCount?: number;
  providerMessageId?: string;
  reasoningMetadata?: Record<string, unknown>;
  codexMessageItems?: unknown[];
  codexReasoningItems?: unknown[];
}

export interface RecordActionCallInput {
  sessionId: string;
  messageId?: string;
  providerToolCallId?: string;
  actionId: string;
  authority: "tool_agent" | "operator";
  input: unknown;
  outputEnvelope?: unknown;
  status: ChatActionStatus;
  requiresConfirmation: boolean;
  confirmationId?: string;
  inputHash?: string;
}

export interface PendingActionCall {
  id: string;
  sessionId: string;
  actionId: string;
  input: unknown;
  inputHash?: string | null;
}

export interface ConfirmActionCallInput {
  confirmationId: string;
  outputEnvelope: unknown;
  status: ChatActionStatus;
}

export interface RecordTokenUsageInput {
  sessionId: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface CompactSessionInput {
  sessionId: string;
  newSessionId?: string;
  summaryText: string;
  summaryJson?: Record<string, unknown>;
  modelProvider?: string;
  modelName?: string;
}

export interface CompactSessionResult {
  sessionId: string;
  parentSessionId: string;
}

export interface ChatSessionListItem {
  id: string;
  sessionKey?: string;
  workspaceId?: string;
  actorId?: string;
  surface?: string;
  status?: string;
  title?: string | null;
  updatedAt?: string;
  modelProvider?: string | null;
  modelName?: string | null;
  modelAuthSource?: string | null;
}

export interface ChatSessionDetail extends ChatSessionListItem {
  messages: Array<Record<string, unknown>>;
  actionCalls: Array<Record<string, unknown>>;
  summaries?: Array<Record<string, unknown>>;
}

export interface ChatSessionSearchResult extends ChatSessionListItem {
  snippet?: string | null;
  lastMatchedAt?: string;
}

export interface SearchSessionsOptions {
  excludeSessionId?: string;
}

export interface ChatSessionStore {
  ensureSession(input: EnsureSessionInput): Promise<void>;
  appendMessage(input: AppendMessageInput): Promise<void>;
  recordActionCall(input: RecordActionCallInput): Promise<void>;
  getPendingActionCall?(confirmationId: string): Promise<PendingActionCall | null>;
  confirmActionCall?(input: ConfirmActionCallInput): Promise<void>;
  recordTokenUsage?(input: RecordTokenUsageInput): Promise<void>;
  listSessions(workspaceId: string): Promise<ChatSessionListItem[]>;
  getSession(sessionId: string): Promise<ChatSessionDetail | null>;
  searchSessions(
    workspaceId: string,
    query: string,
    options?: SearchSessionsOptions
  ): Promise<ChatSessionSearchResult[]>;
  resumeSession(sessionId: string): Promise<void>;
  endSession(sessionId: string, reason?: string): Promise<void>;
  compactSession(input: CompactSessionInput): Promise<CompactSessionResult>;
}

export function createSessionStore(db: SessionStoreDb): ChatSessionStore {
  return {
    async ensureSession(input) {
      await db.query(
        `
          insert into chat_sessions (
            id, workspace_id, session_key, actor_id, surface,
            model_provider, model_name, model_auth_source, parent_session_id, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
          on conflict (workspace_id, session_key)
          do update set
            actor_id = excluded.actor_id,
            surface = excluded.surface,
            model_provider = coalesce(excluded.model_provider, chat_sessions.model_provider),
            model_name = coalesce(excluded.model_name, chat_sessions.model_name),
            model_auth_source = coalesce(excluded.model_auth_source, chat_sessions.model_auth_source),
            updated_at = now()
        `,
        [
          input.sessionId,
          input.workspaceId,
          input.sessionId,
          input.actorId,
          input.surface,
          input.modelProvider ?? null,
          input.modelName ?? null,
          input.modelAuthSource ?? null,
          input.parentSessionId ?? null
        ]
      );
    },
    async appendMessage(input) {
      await db.query(
        `
          insert into chat_messages (
            id, session_id, role, content, token_count, provider_message_id,
            reasoning_metadata_json, codex_message_items_json, codex_reasoning_items_json
          )
          values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
        `,
        [
          `msg_${randomUUID()}`,
          input.sessionId,
          input.role,
          input.content,
          input.tokenCount ?? null,
          input.providerMessageId ?? null,
          JSON.stringify(input.reasoningMetadata ?? {}),
          JSON.stringify(input.codexMessageItems ?? []),
          JSON.stringify(input.codexReasoningItems ?? [])
        ]
      );
      await db.query("update chat_sessions set updated_at = now() where id = $1", [input.sessionId]);
    },
    async recordActionCall(input) {
      await db.query(
        `
          insert into chat_action_calls (
            id, session_id, message_id, provider_tool_call_id, action_id, authority,
            input_json, output_envelope_json, status, requires_confirmation, confirmation_id,
            input_hash
          )
          values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
        `,
        [
          `call_${randomUUID()}`,
          input.sessionId,
          input.messageId ?? null,
          input.providerToolCallId ?? null,
          input.actionId,
          input.authority,
          JSON.stringify(input.input ?? {}),
          JSON.stringify(input.outputEnvelope ?? {}),
          input.status,
          input.requiresConfirmation,
          input.confirmationId ?? null,
          input.inputHash ?? null
        ]
      );
      await db.query("update chat_sessions set updated_at = now() where id = $1", [input.sessionId]);
    },
    async getPendingActionCall(confirmationId) {
      return db.one<PendingActionCall>(
        `
          select
            id,
            session_id as "sessionId",
            action_id as "actionId",
            input_json as "input",
            input_hash as "inputHash"
          from chat_action_calls
          where confirmation_id = $1
            and requires_confirmation = true
            and confirmed_at is null
          limit 1
        `,
        [confirmationId]
      );
    },
    async confirmActionCall(input) {
      await db.query(
        `
          update chat_action_calls
          set confirmed_at = now(),
            output_envelope_json = $2::jsonb,
            status = $3,
            requires_confirmation = false
          where confirmation_id = $1
            and requires_confirmation = true
            and confirmed_at is null
        `,
        [input.confirmationId, JSON.stringify(input.outputEnvelope ?? {}), input.status]
      );
    },
    async recordTokenUsage(input) {
      const promptTokens = input.promptTokens ?? 0;
      const completionTokens = input.completionTokens ?? 0;
      await db.query(
        `
          update chat_sessions
          set last_prompt_tokens = $2,
            last_completion_tokens = $3,
            total_tokens = coalesce(total_tokens, 0) + $2 + $3,
            updated_at = now()
          where id = $1
        `,
        [input.sessionId, promptTokens, completionTokens]
      );
    },
    async listSessions(workspaceId) {
      return db.query<ChatSessionListItem>(
        `
          select
            id,
            session_key as "sessionKey",
            workspace_id as "workspaceId",
            actor_id as "actorId",
            surface,
            status,
            title,
            updated_at as "updatedAt",
            model_provider as "modelProvider",
            model_name as "modelName",
            model_auth_source as "modelAuthSource"
          from chat_sessions
          where workspace_id = $1
          order by updated_at desc
          limit 100
        `,
        [workspaceId]
      );
    },
    async getSession(sessionId) {
      const session = await db.one<ChatSessionListItem>(
        `
          select
            id,
            session_key as "sessionKey",
            workspace_id as "workspaceId",
            actor_id as "actorId",
            surface,
            status,
            title,
            updated_at as "updatedAt",
            model_provider as "modelProvider",
            model_name as "modelName",
            model_auth_source as "modelAuthSource"
          from chat_sessions
          where id = $1
        `,
        [sessionId]
      );
      if (!session) {
        return null;
      }
      const messages = await db.query<Record<string, unknown>>(
        `
          select
            id,
            role,
            content,
            created_at as "createdAt",
            token_count as "tokenCount",
            provider_message_id as "providerMessageId",
            reasoning_metadata_json as "reasoningMetadata",
            codex_message_items_json as "codexMessageItems",
            codex_reasoning_items_json as "codexReasoningItems",
            redaction_state as "redactionState"
          from chat_messages
          where session_id = $1
          order by created_at asc
        `,
        [sessionId]
      );
      const actionCalls = await db.query<Record<string, unknown>>(
        `
          select
            id,
            provider_tool_call_id as "providerToolCallId",
            action_id as "actionId",
            authority,
            input_json as "input",
            output_envelope_json as "outputEnvelope",
            status,
            requires_confirmation as "requiresConfirmation",
            confirmation_id as "confirmationId",
            input_hash as "inputHash",
            confirmed_at as "confirmedAt",
            created_at as "createdAt"
          from chat_action_calls
          where session_id = $1
          order by created_at asc
        `,
        [sessionId]
      );
      const summaries = await db.query<Record<string, unknown>>(
        `
          select
            id,
            session_id as "sessionId",
            parent_session_id as "parentSessionId",
            summary_text as "summaryText",
            summary_json as "summaryJson",
            model_provider as "modelProvider",
            model_name as "modelName",
            created_at as "createdAt"
          from chat_session_summaries
          where session_id = $1 or parent_session_id = $1
          order by created_at desc
          limit 10
        `,
        [sessionId]
      );
      return {
        ...session,
        messages,
        actionCalls,
        summaries
      };
    },
    async searchSessions(workspaceId, query, options) {
      const trimmedQuery = query.trim();
      if (!trimmedQuery) {
        return [];
      }
      return db.query<ChatSessionSearchResult>(
        `
          with recursive
          search_query as (
            select websearch_to_tsquery('english', $2) as query
          ),
          excluded_lineage(id) as (
            select $3::text
            where $3::text is not null
            union
            select s.parent_session_id
            from chat_sessions s
            join excluded_lineage e on s.id = e.id
            where s.parent_session_id is not null
            union
            select child.id
            from chat_sessions child
            join excluded_lineage e on child.parent_session_id = e.id
          )
          select
            s.id,
            s.session_key as "sessionKey",
            s.workspace_id as "workspaceId",
            s.actor_id as "actorId",
            s.surface,
            s.status,
            s.title,
            s.updated_at as "updatedAt",
            s.model_provider as "modelProvider",
            s.model_name as "modelName",
            s.model_auth_source as "modelAuthSource",
            max(m.created_at) as "lastMatchedAt",
            ts_headline('english', max(m.content), (select query from search_query)) as snippet
          from chat_sessions s
          join chat_messages m on m.session_id = s.id
          where s.workspace_id = $1
            and to_tsvector('english', m.content) @@ (select query from search_query)
            and ($3::text is null or s.id not in (select id from excluded_lineage))
          group by
            s.id, s.session_key, s.workspace_id, s.actor_id, s.surface, s.status,
            s.title, s.updated_at, s.model_provider, s.model_name, s.model_auth_source
          order by max(m.created_at) desc
          limit 50
        `,
        [workspaceId, trimmedQuery, options?.excludeSessionId ?? null]
      );
    },
    async resumeSession(sessionId) {
      await db.query(
        `
          update chat_sessions
          set status = 'active', ended_at = null, end_reason = null, updated_at = now()
          where id = $1
        `,
        [sessionId]
      );
    },
    async endSession(sessionId, reason = "operator_request") {
      await db.query(
        `
          update chat_sessions
          set status = 'ended', ended_at = now(), end_reason = $2, updated_at = now()
          where id = $1
        `,
        [sessionId, reason]
      );
    },
    async compactSession(input) {
      const parent = await db.one<{
        id: string;
        workspaceId: string;
        sessionKey: string;
        actorId: string;
        surface: "cli" | "api" | "app" | "mcp";
        modelProvider?: string | null;
        modelName?: string | null;
        modelAuthSource?: string | null;
      }>(
        `
          select
            id,
            workspace_id as "workspaceId",
            session_key as "sessionKey",
            actor_id as "actorId",
            surface,
            model_provider as "modelProvider",
            model_name as "modelName",
            model_auth_source as "modelAuthSource"
          from chat_sessions
          where id = $1
        `,
        [input.sessionId]
      );
      if (!parent) {
        throw new Error(`Chat session not found: ${input.sessionId}`);
      }
      const newSessionId = input.newSessionId ?? `session_${randomUUID()}`;
      await db.query(
        `
          update chat_sessions
          set status = 'compacted', ended_at = now(), end_reason = 'compacted', updated_at = now()
          where id = $1
        `,
        [input.sessionId]
      );
      await db.query(
        `
          insert into chat_session_summaries (
            id, session_id, parent_session_id, summary_text, summary_json,
            model_provider, model_name
          )
          values ($1, $2, null, $3, $4::jsonb, $5, $6)
        `,
        [
          `summary_${randomUUID()}`,
          input.sessionId,
          input.summaryText,
          JSON.stringify(input.summaryJson ?? {}),
          input.modelProvider ?? parent.modelProvider ?? null,
          input.modelName ?? parent.modelName ?? null
        ]
      );
      await this.ensureSession({
        sessionId: newSessionId,
        workspaceId: parent.workspaceId,
        actorId: parent.actorId,
        surface: parent.surface,
        modelProvider: input.modelProvider ?? parent.modelProvider ?? undefined,
        modelName: input.modelName ?? parent.modelName ?? undefined,
        modelAuthSource: parent.modelAuthSource ?? undefined,
        parentSessionId: input.sessionId
      });
      await this.appendMessage({
        sessionId: newSessionId,
        role: "summary",
        content: input.summaryText
      });
      return {
        sessionId: newSessionId,
        parentSessionId: input.sessionId
      };
    }
  };
}
