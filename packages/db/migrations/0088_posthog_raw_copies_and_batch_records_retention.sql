-- Two retention functions for the cloud engine's daily posthog-raw-retention run (approved by River,
-- 2026-10-28): delete the PostHog raw copies the 90-day rule already retired, and the
-- sync_batch_records bookkeeping of syncs that finished. Nothing is deleted when this file runs;
-- the 1bu-1 Trigger task calls both functions in bounded batches. Local engines have no retention
-- job and are unaffected.
--
-- ── 1. prune_posthog_raw_copies(workspace, source, limit) ───────────────────────────────────────
-- prune_posthog_raw (0064/0065) deletes posthog_event_truth rows below the retention floor and
-- records where raw ends in posthog_prune_watermarks. It never touched raw_records, where every
-- PostHog event keeps its full payload copy forever: on 2026-10-28 the cloud held 1.15M of them
-- (1.47 GB of payload), 169k already without a truth row. Nothing reads a PostHog raw copy: the
-- rollups and every PostHog view read posthog_event_truth / the 0063 rollups, and the 1bu-1 readers
-- of raw_records are Meta- and Stripe-only.
--
-- The rule is the truth rule, applied to the copies: delete a source's PostHog raw rows whose event
-- UTC day is below the source's prune watermark — the days whose truth is already deleted and whose
-- rollups 0065 built before deleting it. The watermark, not the config floor, is the bound: no
-- watermark = never pruned = nothing deleted, so a never-pruned source keeps all of its raw (the
-- 0064 (a) case). The event day is the first 10 characters of payload->>'occurredAt' (the
-- connector's toISOString(), so the UTC day), found through raw_records_posthog_event_day_idx (0087).
--
-- A row is KEPT, however old, while anything still points at it:
--   - posthog_event_truth (a late event re-landed below the watermark; the next truth prune deletes
--     that row, and the raw copy goes the day after);
--   - posthog_session_fact (a session's last event) and posthog_person_current (a person's first
--     event): they are never pruned, and their foreign keys would refuse the delete anyway;
--   - sync_batch_records of a batch that is still running or finished less than a day ago (see 2).
-- The sync_batch_records rows of finished batches that point at a deleted copy are deleted with it,
-- first, in the same transaction. A row a concurrent sync adds in between is not deleted, so its
-- foreign key fails the call instead (see below).
--
-- BOUNDED: at most p_limit raw rows per call (1..10000), so one call is one short transaction; the
-- caller loops. Every deleted raw row costs one index probe per foreign key into raw_records (0074
-- and 0087 index all 34); WITHOUT 0087 each probe is a full table scan, so this function must not
-- be called on a database where 0087 is missing. The source must be a PostHog source of that
-- workspace (raises otherwise): this function never deletes another provider's raw.
--
-- No advisory lock: raw copies feed no rollup, so the 0064 prune/refresh serialization is not
-- needed here. A sync that re-lands an old event in the same instant can make this call fail its
-- foreign-key check; the call then rolls back whole and the next one retries.
--
-- ── 2. prune_finished_sync_batch_records(limit) ─────────────────────────────────────────────────
-- One sync_batch_records row per synced record, never deleted: 2.59M rows, 0.9 GB on the cloud on
-- 2026-10-28, growing about 0.5 GB a month. Every reader is scoped to the batch or run that is
-- still in progress (infinite-os packages/connectors/src/index.ts, 2026-10-28):
--   - the per-chunk status flip in syncExtractedBatch: its own batch_id, while it loads;
--   - the GA4 snapshot replacement (pruneGa4FactWindow): its own sync_run_id, inside that run's
--     CLOSE transaction, which is the one that marks the batch finished;
--   - deleteProject: deletes them;
--   - the foreign key to raw_records: a check, not a reader.
-- Retries open a NEW run and batch; failed batches are never resumed; nothing replays, audits or
-- reports from these rows (record_lineage is separate, and the connectors stopped writing it). So a
-- batch's rows are dead once the batch has finished_at. The rule keeps one day of margin anyway:
-- delete rows of batches whose finished_at is more than 1 day ago (succeeded or failed). A batch
-- that never finished (a crashed load leaves status 'running', finished_at null) keeps its rows.
-- sync_batches and sync_runs themselves are kept: the Meta readers date raw rows through
-- raw_records.sync_batch_id -> sync_batches -> sync_runs, not through this table.
--
-- BOUNDED: at most p_limit rows per call (1..50000), batch by batch, oldest finished batch first.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
-- Drop both functions. Deleted rows do not come back; no other state is created.

create or replace function prune_posthog_raw_copies(
  p_workspace_id text, p_source_id text, p_limit integer
) returns bigint language plpgsql as $$
declare
  v_before  date;
  v_ids     text[];
  v_deleted bigint;
begin
  if p_workspace_id is null or p_source_id is null or p_limit is null then
    raise exception 'prune_posthog_raw_copies: workspace_id, source_id and limit are required';
  end if;
  if p_limit < 1 or p_limit > 10000 then
    raise exception 'prune_posthog_raw_copies: limit % is outside 1..10000', p_limit;
  end if;
  perform 1
     from sources
    where id = p_source_id and workspace_id = p_workspace_id and provider = 'posthog';
  if not found then
    raise exception 'prune_posthog_raw_copies: % is not a PostHog source of workspace %',
      p_source_id, p_workspace_id;
  end if;

  select pruned_before into v_before
    from posthog_prune_watermarks
   where workspace_id = p_workspace_id and source_id = p_source_id;
  -- Never pruned: its truth is all there, so is its raw.
  if v_before is null then
    return 0;
  end if;

  -- to_char, not ::text: the day must compare as YYYY-MM-DD whatever the session DateStyle.
  select array_agg(c.id) into v_ids
    from (
      select r.id
        from raw_records r
       where r.source_id = p_source_id
         and r.object_type = 'posthog_event'
         and left(r.payload ->> 'occurredAt', 10) < to_char(v_before, 'YYYY-MM-DD')
         and not exists (select 1 from posthog_event_truth t where t.raw_record_id = r.id)
         and not exists (select 1 from posthog_session_fact s where s.raw_record_id = r.id)
         and not exists (select 1 from posthog_person_current p where p.raw_record_id = r.id)
         and not exists (
           select 1
             from sync_batch_records sbr
             join sync_batches sb on sb.id = sbr.sync_batch_id
            where sbr.raw_record_id = r.id
              and (sb.finished_at is null or sb.finished_at >= now() - interval '1 day')
         )
       order by left(r.payload ->> 'occurredAt', 10)
       limit p_limit
    ) c;
  if v_ids is null then
    return 0;
  end if;

  delete from sync_batch_records sbr
   using sync_batches sb
   where sb.id = sbr.sync_batch_id
     and sbr.raw_record_id = any(v_ids)
     and sb.finished_at < now() - interval '1 day';
  delete from raw_records where id = any(v_ids);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

create or replace function prune_finished_sync_batch_records(p_limit integer)
returns bigint language plpgsql as $$
declare
  v_batch_id text;
  v_left     integer;
  v_n        integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 50000 then
    raise exception 'prune_finished_sync_batch_records: limit % is outside 1..50000', p_limit;
  end if;
  v_left := p_limit;

  for v_batch_id in
    select sb.id
      from sync_batches sb
     where sb.finished_at < now() - interval '1 day'
       and exists (select 1 from sync_batch_records sbr where sbr.sync_batch_id = sb.id)
     order by sb.finished_at, sb.id
  loop
    delete from sync_batch_records
     where ctid = any(array(
       select ctid from sync_batch_records where sync_batch_id = v_batch_id limit v_left
     ));
    get diagnostics v_n = row_count;
    v_left := v_left - v_n;
    exit when v_left <= 0;
  end loop;

  return p_limit - v_left;
end $$;

-- Grants (0065 pattern: SECURITY INVOKER functions, so a credentialed caller needs the table
-- rights; the cloud task runs as the service role). Re-issued idempotently so this file stands
-- alone on a fresh database.
grant select on sources, posthog_prune_watermarks, posthog_event_truth, posthog_session_fact,
  posthog_person_current, sync_batches to growth_os_worker;
grant select, delete on raw_records, sync_batch_records to growth_os_worker;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select on sources, posthog_prune_watermarks, posthog_event_truth, posthog_session_fact,
      posthog_person_current, sync_batches to engine_app;
    grant select, delete on raw_records, sync_batch_records to engine_app;
  end if;
end
$$;
