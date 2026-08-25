-- 0041: fail the forever-queued connect-time connector jobs.
--
-- WHY: the connect-time enqueue paths (queue-mode start_source_sync + queueInitialSyncOnConnect)
-- insert source_sync / source_backfill job_runs at status='queued', but deployments that do not
-- run apps/worker (e.g. the embedded-daemon desktop shape) have nothing that drains the queue —
-- those rows sit 'queued' forever. This marks them failed (auditable via `error`; NOT deleted)
-- so the queue reflects reality.
--
-- SAFETY — 7-day age guard: infinite-os is open core and a self-hosted deployment may run
-- apps/worker legitimately. A live queue drains in minutes, so anything queued for 7+ days is
-- dead regardless of deployment shape; anything younger is left alone. Migrations run at daemon
-- boot before any worker starts, and this statement is idempotent (matches 0 rows on re-run —
-- and the migration ledger only applies it once anyway).
--
-- Scope: connector job types only. materialized_view_refresh / saved_report_* are untouched.

update job_runs
   set status = 'failed',
       finished_at = now(),
       error = 'failed by migration 0041: connect-time enqueue with no worker to drain it '
               || '(forever-queued connector-job cleanup)'
 where status = 'queued'
   and job_type in ('source_sync', 'source_backfill')
   and created_at < now() - interval '7 days';
