-- Index sync_runs by source, newest run first.
--
-- sync_runs has had its primary key only, so every per-source lookup full-scans it: the connection
-- health read (max(finished_at) of a source's succeeded runs, polled by every open desktop), the
-- heartbeat's newest-run / stranded-run checks, source health and the Meta history budget reads
-- (137,524 full scans and 425M rows read on the shared cloud engine by 2026-09-27). The table is small
-- (~4.6k rows) but those scans run on every poll; after the 2026-09-27 outage every avoidable scan counts.
--
-- One index serves them: source_id first (every one of those queries filters by it), started_at
-- descending second (newest-run reads and "since the last success" windows). Status and finished_at
-- filters then touch only that source's rows.
--
-- DELIBERATELY NOT `concurrently`, like 0046, 0073 and 0074: the runner applies each file inside a
-- transaction. On a large, live shared database the operator builds it ONLINE first
-- (`create index concurrently if not exists` with the same name and definition, on its own, outside any
-- transaction) and checks `pg_index.indisvalid`; this file then finds it and builds nothing.
--
-- Additive and idempotent. An index changes plans, never results.

create index if not exists sync_runs_source_id_started_at_idx
  on sync_runs (source_id, started_at desc);
