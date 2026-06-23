-- 0038_chat_action_calls_workspace_id.sql
-- Money-safety keystone (P0-A): pin every pending confirmation to the workspace that
-- authored it. `chat_action_calls` previously had NO workspace_id, so a confirmation's
-- origin workspace could only be inferred via the session join. The confirm path looked
-- the row up by `confirmation_id` alone (`confirm_${sha256({actionId,input}).slice(0,16)}`,
-- which carries NO workspace), so two brands sharing one install could collide on the same
-- action+input, and a confirm under the wrong active project executed under the wrong
-- resolution context (a confused deputy). Binding workspace_id directly on the row lets
-- both confirm surfaces (HTTP + CLI) scope the lookup/update by workspace and fail closed
-- on a cross-workspace mismatch.
--
-- Additive + backfilled: the column is added nullable, backfilled from chat_sessions
-- (the authoritative origin workspace via session_id), then set NOT NULL once the backfill
-- is clean. `recordActionCall` writes workspace_id on every new row going forward, so the
-- NOT NULL constraint holds for all future inserts.
alter table chat_action_calls
  add column workspace_id text references workspaces(id);

-- Backfill from the owning chat_session (1:1 via session_id → chat_sessions.id).
update chat_action_calls c
   set workspace_id = s.workspace_id
  from chat_sessions s
 where c.session_id = s.id
   and c.workspace_id is null;

-- Drop orphans the backfill could NOT pin: rows whose session is gone or whose chat_session has no
-- workspace_id. They can't be scoped (a NULL workspace_id re-opens the confused-deputy hole the
-- lookups close) and a pending confirmation with no resolvable workspace can never be safely
-- confirmed — so they are dead records. Removing them lets the NOT NULL below hold on a DB that
-- predates this column. On a fresh DB (or one whose backfill was clean) this deletes zero rows.
delete from chat_action_calls
 where workspace_id is null;

-- Lock it down: a NULL workspace_id would re-open the confused-deputy hole the scoped
-- lookups close, so every row (existing + future) must be pinned.
alter table chat_action_calls
  alter column workspace_id set not null;

-- Scope confirm-path lookups/updates by (confirmation_id, workspace_id). confirmation_id is
-- NOT unique across workspaces, so this index keeps the workspace-scoped SELECT/UPDATE fast.
create index chat_action_calls_workspace_confirmation_idx
  on chat_action_calls(workspace_id, confirmation_id);
