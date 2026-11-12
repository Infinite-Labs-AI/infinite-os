-- Slim the PostHog raw copies a week after they were written: keep the row, drop the payload body.
-- Nothing is slimmed when this file runs; the cloud retention job calls the function in bounded
-- batches. Local engines have no retention job and are unaffected.
--
-- WHY: every synced PostHog event is stored twice, as a posthog_event_truth row (every field the
-- connector extracts, its properties included; the email is on posthog_person_current) and as a
-- raw_records copy whose payload is the whole extracted event. The copy is kept for the retention
-- window (0088 deletes it below the prune watermark), and for good while a session, person or
-- truth row still points at it. After the load nothing reads a PostHog copy's payload:
--   - truth, persons, distinct ids and sessions are written from the extracted rows in memory, in
--     the same transaction as the copy, and are never re-read from raw_records;
--   - the day rollups (0063) and every PostHog view read posthog_event_truth;
--   - the other raw_records readers (Stripe recurring-value evidence, Meta entity history) never
--     read a PostHog row, and no action exposes a raw payload;
--   - nothing replays or re-extracts truth from raw_records: a re-sync or a backfill fetches the
--     events from PostHog again.
-- Two other parts of the copy are read, and both are kept:
--   - the dedupe key (source_id, object_type, external_id, source_record_hash). The connector
--     hashes the payload it has just fetched and upserts on that key; the stored hash is never
--     recomputed from the stored payload. A re-synced event with unchanged content finds its row
--     as before, the upsert keeps the stored payload (`do update set payload = raw_records.payload`)
--     and its truth row keeps the same raw_record_id. Changed content was a new row before and is
--     a new row now;
--   - the event day, the first 10 characters of payload->>'occurredAt':
--     raw_records_posthog_event_day_idx (0087) and the raw-copy prune (0088) read it. The value is
--     kept as it was, so the day index key does not change.
--
-- slim_posthog_raw_copies(workspace, source, limit) replaces the payload of up to p_limit of a
-- PostHog source's raw copies written more than 7 days ago with
--     {"occurredAt": <the same value>, "slimmed": true}
-- Only payload changes: the id, the dedupe key, extracted_at and the batch stay, so every pointer
-- to the row still holds. "slimmed" marks a payload whose body was dropped, so the row is never
-- taken for an event that had no properties; no connector payload has a top-level "slimmed" key.
-- The week: truth is written in the same transaction as the copy, so the copy has done its job
-- once it commits; the week keeps recent raw payloads around for looking into a sync. It counts
-- from extracted_at, when the copy was written, so a backfill of old events keeps its copies for a
-- week too.
--
-- raw_records_posthog_unslimmed_idx is the work queue: PostHog copies not slimmed yet, by source and
-- write time. A slimmed row's new version is not in it, so a call reads only rows still to do,
-- however many were slimmed before, and a copy written later joins it whatever its event day.
-- Newest first: the oldest copies are the next ones the retention prune deletes, so slimming them
-- first would be wasted work.
--
-- BOUNDED: at most p_limit rows per call (1..10000), one short transaction; the caller loops. Rows a
-- concurrent sync holds are skipped (`for no key update skip locked`) and taken by a later call, so a
-- call never waits on, or deadlocks with, a sync. NO KEY: the id never changes, so the lock does not
-- block a sync's foreign-key checks on the row (a truth or batch-record insert pointing at it). The locked ids are collected first and the update finds
-- them by primary key (0088's shape), so no plan can turn the update into a join over the whole
-- table. Idempotent: a slimmed row is not a candidate again.
-- The source must be a PostHog source of that workspace (raises otherwise): this function never
-- touches another provider's raw.
--
-- DELIBERATELY NOT `concurrently`, like 0087: on a large, live shared database the operator builds
-- raw_records_posthog_unslimmed_idx ONLINE first (`create index concurrently if not exists`, same
-- name and definition, on its own, outside any transaction); this file then finds it and builds
-- nothing. Check it is valid (`pg_index.indisvalid`) before this file runs: `if not exists` also
-- skips an INVALID index left by a failed online build.
--
-- ROLLBACK: drop the function and the index. A slimmed payload does not come back; the fields the
-- connector reads from it are in posthog_event_truth and posthog_person_current.

create index if not exists raw_records_posthog_unslimmed_idx
  on raw_records (source_id, extracted_at)
  where object_type = 'posthog_event' and not (payload ? 'slimmed');

create or replace function slim_posthog_raw_copies(
  p_workspace_id text, p_source_id text, p_limit integer
) returns bigint language plpgsql as $$
declare
  v_ids     text[];
  v_slimmed bigint;
begin
  if p_workspace_id is null or p_source_id is null or p_limit is null then
    raise exception 'slim_posthog_raw_copies: workspace_id, source_id and limit are required';
  end if;
  if p_limit < 1 or p_limit > 10000 then
    raise exception 'slim_posthog_raw_copies: limit % is outside 1..10000', p_limit;
  end if;
  perform 1
     from sources
    where id = p_source_id and workspace_id = p_workspace_id and provider = 'posthog';
  if not found then
    raise exception 'slim_posthog_raw_copies: % is not a PostHog source of workspace %',
      p_source_id, p_workspace_id;
  end if;

  select array_agg(c.id) into v_ids
    from (
      select r.id
        from raw_records r
       where r.source_id = p_source_id
         and r.object_type = 'posthog_event'
         and not (r.payload ? 'slimmed')
         and r.extracted_at < now() - interval '7 days'
       order by r.extracted_at desc
       limit p_limit
         for no key update skip locked
    ) c;
  if v_ids is null then
    return 0;
  end if;

  update raw_records r
     set payload = jsonb_build_object('occurredAt', r.payload -> 'occurredAt', 'slimmed', true)
   where r.id = any(v_ids);
  get diagnostics v_slimmed = row_count;
  return v_slimmed;
end $$;

-- Grants (0065/0088 pattern: a SECURITY INVOKER function, so a credentialed caller needs the table
-- rights; `for no key update` needs UPDATE). Re-issued idempotently so this file stands alone.
grant select on sources to growth_os_worker;
grant select, update on raw_records to growth_os_worker;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select on sources to engine_app;
    grant select, update on raw_records to engine_app;
  end if;
end
$$;
