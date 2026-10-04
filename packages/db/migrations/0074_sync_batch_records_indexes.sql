-- Index the two columns every sync looks sync_batch_records up by.
--
-- 0002 created sync_batch_records with its primary key only, so every lookup below is a FULL
-- scan of a table that grows by one row per synced record, forever (1.39M rows on the shared cloud
-- engine by 2026-09-27; 27,860 full scans, 8.2 billion rows read, 0 index reads). That one table
-- was about 85% of the cloud database's disk reads, and part of the 2026-09-27 prod outage.
--
-- The lookups, and the index each one uses:
--   1. the per-chunk status flip in syncExtractedBatch, once per 500-record chunk:
--        update sync_batch_records set record_status = 'provider_truth_written'
--         where sync_batch_id = $1 and record_status = 'raw_written'
--      -> sync_batch_records_sync_batch_id_record_status_idx (both predicates, in that order);
--   2. deleteProject's
--        delete from sync_batch_records where sync_batch_id in (select id from sync_batches ...)
--      -> the same index, by its leading column;
--   3. the GA4 prune (pruneGa4FactWindow), per fact row in the window:
--        not exists (select 1 from sync_batch_records sbr join sync_batches sb on sb.id = sbr.sync_batch_id
--                      where sb.sync_run_id = $5 and sbr.raw_record_id = f.raw_record_id)
--      -> sync_batch_records_raw_record_id_idx per row, or the first index once the run's batches
--         are known; the planner picks either, and both beat a full scan per statement;
--   4. the foreign key sync_batch_records.raw_record_id -> raw_records(id): deleting a raw_records
--      row checks this table for referencing rows -> sync_batch_records_raw_record_id_idx.
--
-- DELIBERATELY NOT `concurrently`, like 0046 and 0073: the migration runner applies each file
-- inside a transaction, where `create index concurrently` is an error. On a large, live shared
-- database the operator builds both indexes ONLINE first (`create index concurrently if not exists`
-- with the same names and definitions, each statement on its own, outside any transaction); this
-- file then finds them and builds nothing. Check both are valid (`pg_index.indisvalid`) before this
-- file runs: `if not exists` also skips an INVALID index left by a failed online build.
--
-- Additive and idempotent: two `create index if not exists`. No table, view, constraint or row is
-- touched, and an index changes plans, never results.

create index if not exists sync_batch_records_sync_batch_id_record_status_idx
  on sync_batch_records (sync_batch_id, record_status);

create index if not exists sync_batch_records_raw_record_id_idx
  on sync_batch_records (raw_record_id);
