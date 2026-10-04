-- 0065_prune_rolls_up_before_deleting.sql
-- Closes the one hole 0064 left open: prune_posthog_raw can delete raw that was NEVER ROLLED UP,
-- destroying that history permanently. 0064 made rollups survive pruning; it assumed the rollups
-- were already THERE. For a source caught mid-ingestion they are not.
--
-- ── THE TWO-CONDITION SCENARIO (both are normal operation, not edge cases) ───────────────────────
--   (1) TRUTH COMMITS BEFORE THE ROLLUP EXISTS. The PostHog connector writes truth per LOAD chunk,
--       each chunk in its OWN transaction; refresh_posthog_daily_rollups runs later, once, in the
--       CLOSE hook. So between the first chunk and the CLOSE there is a real window — minutes to
--       hours on a large backfill — in which raw exists with NO rollup behind it.
--   (2) THE RETENTION CRON ENUMERATES SOURCES FROM TRUTH. A source that is mid-backfill with more
--       than retention_days of history is therefore a prune CANDIDATE before its first CLOSE has
--       ever run.
-- Under 0064 the cron then deletes that raw and advances the watermark in the same transaction. The
-- CLOSE refresh that finally arrives is clamped to the watermark (0064's whole point) and skips
-- exactly those days — which now have neither raw nor rollups, and never will again. The failure is
-- SILENT: no error, no counter, just a permanent hole in history that only shows up as charts that
-- are short for days nobody thinks to check. It needs no race to fire — a first backfill of >180d of
-- history that straddles one retention-cron tick is enough.
--
-- ── THE FIX: ROLL UP BEFORE DELETING ────────────────────────────────────────────────────────────
-- prune_posthog_raw is re-created to refresh the rollups for the window it is about to delete —
-- INSIDE its own transaction, BEFORE the DELETE, while the raw is still there to read. Same
-- name/signature/return, so the retention cron keeps calling it unchanged.
--   window start = the source's EXISTING watermark if it has one, else the min truth day.
--     Using the watermark when present keeps the window tight (days below it are already permanent
--     rollup history with no raw — refresh would clamp them away regardless, so re-reading them
--     would be pure waste), and falling back to the min truth day is what actually rescues the
--     never-closed source: its whole unrolled history gets rolled up before any of it is deleted.
--   window end = v_before - 1, the last day the DELETE will touch. Deliberately NOT v_before: days
--     from v_before on keep their raw and belong to the CLOSE hook. Rolling them up here would
--     publish a PARTIAL rollup for a day whose chunks are still landing.
--   SKIPPED ENTIRELY when the window is empty — no truth and no watermark (NULL), or a start above
--     v_before - 1 (nothing below the floor). This guard is load-bearing, not a micro-optimisation:
--     refresh_posthog_daily_rollups RAISES on from > to, so calling it with an empty window would
--     throw and take the retention cron down for every healthy source it touched.
-- pg_advisory_xact_lock is REENTRANT within one transaction, so the nested refresh re-taking the
-- same (workspace, source) lock the prune already holds is a no-op — the two functions still
-- serialize against OTHER transactions exactly as 0064 specified.
--
-- COST: the first prune of a long-backfilled source rolls up its entire pre-floor history in one
-- call. That is bounded by the raw being deleted in the same statement anyway, and it happens ONCE
-- per source — every later prune starts at the watermark and covers only one cron interval.
--
-- ── WHAT DOES NOT CHANGE ────────────────────────────────────────────────────────────────────────
-- refresh_posthog_daily_rollups is untouched (0064's body stands). The config-floor clamp, the
-- monotonic watermark advance, the advisory lock, the STRICT config read and every grant are
-- carried forward verbatim. 0064's redefined conservation invariant still holds — and now holds
-- HONESTLY, because the days below the watermark actually have the rollups it promises:
-- sum(event_count) = count(truth) only on days at or after the watermark; below it, rollups are
-- permanent history with no raw backing.
--
-- ── RESIDUAL, STATED PLAINLY ────────────────────────────────────────────────────────────────────
-- Raw that arrives for a day BELOW an already-advanced watermark is still clamped away unrolled —
-- 0064 declared those days closed and this migration does not reopen them. That is a deliberate
-- boundary, not an oversight: it is bounded by one cron interval of lateness on data already older
-- than retention_days.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
-- Reverting prune_posthog_raw to 0064's body re-arms the destruction above for every source that
-- has not yet had its first CLOSE. There is no state to undo — this migration only redefines a
-- function — so a revert is a plain re-issue of 0064's body, and should be treated as a regression,
-- not a rollback.

create or replace function prune_posthog_raw(
  p_workspace_id text, p_source_id text, p_before date
) returns bigint language plpgsql as $$
declare
  v_floor        date;
  v_before       date;
  v_window_start date;
  v_deleted      bigint;
begin
  if p_workspace_id is null or p_source_id is null or p_before is null then
    raise exception 'prune_posthog_raw: workspace_id, source_id and before-date are required';
  end if;

  -- Serialize with refresh_posthog_daily_rollups per (workspace, source) — see 0064's header.
  perform pg_advisory_xact_lock(
    hashtextextended('posthog_raw_retention:' || p_workspace_id || ':' || p_source_id, 0)
  );

  -- STRICT: a missing (or duplicated) policy row fails LOUD — never a silent unclamped prune.
  select (now() at time zone 'utc')::date - retention_days
    into strict v_floor
    from posthog_retention_config;

  -- Caller-drift guard: never delete raw the policy still guarantees.
  v_before := least(p_before, v_floor);

  -- ROLL UP BEFORE DELETING — the 0065 fix. Existing watermark if any, else the min truth day (UTC
  -- calendar days, matching every other day expression since 0063).
  select coalesce(
           (select pruned_before
              from posthog_prune_watermarks
             where workspace_id = p_workspace_id and source_id = p_source_id),
           (select min((occurred_at at time zone 'utc')::date)
              from posthog_event_truth
             where workspace_id = p_workspace_id and source_id = p_source_id)
         )
    into v_window_start;

  -- Empty window => SKIP. Calling refresh with from > to would RAISE and fail the whole prune.
  if v_window_start is not null and v_window_start <= v_before - 1 then
    perform refresh_posthog_daily_rollups(
      p_workspace_id, p_source_id, v_window_start, v_before - 1
    );
  end if;

  delete from posthog_event_truth
   where workspace_id = p_workspace_id
     and source_id = p_source_id
     and (occurred_at at time zone 'utc')::date < v_before;
  get diagnostics v_deleted = row_count;

  -- Advance the watermark even on a zero-row delete: below v_before there is provably no raw NOW,
  -- so a refresh must never rebuild those days from nothing.
  insert into posthog_prune_watermarks (workspace_id, source_id, pruned_before)
  values (p_workspace_id, p_source_id, v_before)
  on conflict (workspace_id, source_id) do update
    set pruned_before = greatest(posthog_prune_watermarks.pruned_before, excluded.pruned_before),
        updated_at = now();

  return v_deleted;
end $$;

-- Grants are unchanged from 0064 (same function name, same SECURITY INVOKER, same tables touched):
-- prune callers already hold config SELECT, truth DELETE and watermark DML, and the nested refresh
-- needs only the rollup DML + watermark SELECT they were granted for calling it directly. Re-issued
-- idempotently so this file stands alone on a fresh database (the 0053 / 2026-08-04 grantless
-- incidents: a function re-created without its grants restated is how those started).
grant select on posthog_retention_config to growth_os_worker, growth_os_app, growth_os_tool_agent;
grant select, insert, update, delete on posthog_prune_watermarks to growth_os_worker;
grant select on posthog_prune_watermarks to growth_os_app, growth_os_tool_agent;
grant select, delete on posthog_event_truth to growth_os_worker;
grant select, insert, update, delete on posthog_event_daily, posthog_site_daily to growth_os_worker;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select on posthog_retention_config to engine_app;
    grant select, insert, update, delete on posthog_prune_watermarks to engine_app;
    grant select, delete on posthog_event_truth to engine_app;
    grant select, insert, update, delete on posthog_event_daily, posthog_site_daily to engine_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'growth_os_read_api') then
    grant select on posthog_retention_config, posthog_prune_watermarks to growth_os_read_api;
  end if;
end
$$;
