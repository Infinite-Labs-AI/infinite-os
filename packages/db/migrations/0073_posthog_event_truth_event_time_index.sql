-- Event-name reads on posthog_event_truth: an event-name-leading COVERING index.
--
-- Cohort / journey and fires-per-session reads name the events they want:
--
--   where workspace_id = $1 and event_name = any($2) and occurred_at >= $3 and occurred_at < $4
--
-- and project only identity columns (source_id, distinct_id, session_id) plus the key. On the
-- 0046 index (workspace_id, occurred_at, event_name) that read has two costs, both paid per page
-- on a cold cache:
--   1. the walk: `event_name` sits after the time column, so the scan visits EVERY stored event
--      of the workspace in the range and discards the other names inside the index;
--   2. the heap: every matching row is fetched from the table for its identity columns, one
--      random page per match, and on this table a row is wide (the raw `properties` document).
-- On a large workspace the heap fetches are the bigger of the two, so an index that only fixes
-- the walk is not enough.
--
-- This index leads with (workspace_id, event_name, occurred_at), so the walk touches only the
-- named events, and INCLUDEs the three identity columns, so the read is an INDEX-ONLY scan with no
-- heap fetch for any page the visibility map marks all-visible. INCLUDE (not key) columns: they
-- are never searched on, and keeping them out of the key keeps the key order the planner uses.
-- Every included value is a bounded identifier (source, PostHog distinct id, session id), far
-- below the b-tree row-size limit.
--
-- KEPT: 0046's posthog_event_truth_workspace_time_event_idx. The drilldown `order by occurred_at
-- desc` still needs a time-leading index (0046 records the measured trade-off), and reads with no
-- event filter still walk by time. This index is additive.
--
-- VISIBILITY MAP: an index-only scan still visits the heap for every page NOT marked all-visible.
-- This table is insert-mostly, and the default insert-triggered autovacuum
-- (autovacuum_vacuum_insert_scale_factor = 0.2) waits for inserts equal to a fifth of the table,
-- so on a large table the most recent days, which are the ones reads ask for most, stay
-- not-all-visible and fall back to heap fetches. A 1% insert scale factor keeps the map current;
-- each such vacuum only visits the pages changed since the last one.
--
-- DELIBERATELY NOT `concurrently`, like 0046: the migration runner applies each file inside a
-- transaction, where `create index concurrently` is an error. On a large, live shared database
-- the index is built ONLINE by an operator first (`create index concurrently if not exists` with
-- the same name and definition, outside any transaction); this file then finds it and is a
-- no-op for the index. Check the result is valid (`pg_index.indisvalid`) before this file runs:
-- `if not exists` also skips an INVALID index left by a failed online build.
--
-- Additive and idempotent: `create index if not exists` plus a storage parameter. No table,
-- view, constraint or row is touched.

create index if not exists posthog_event_truth_workspace_event_time_idx
  on posthog_event_truth (workspace_id, event_name, occurred_at)
  include (source_id, distinct_id, session_id);

alter table posthog_event_truth set (autovacuum_vacuum_insert_scale_factor = 0.01);
