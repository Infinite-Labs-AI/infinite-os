-- Analytics fact-table indexes — the GA4/PostHog truth tables have carried only their
-- primary key and their sync upsert key (`unique (source_id, …)`) since 0004/0025, so
-- every dashboard read seq-scans EVERY workspace's rows. The canonical read shape the
-- analytical engine emits is
--
--   where workspace_id = $1 and occurred_on >= $2 and occurred_on <= $3
--
-- against the queryable views (`vw_site_traffic`, `vw_site_pages`, `vw_posthog_events`,
-- `vw_posthog_site`, `vw_site_conversion_rate`), all of which project straight off these
-- three tables. The existing unique keys lead with `source_id`, so they can never serve a
-- workspace-scoped scan; these indexes lead with `workspace_id` and carry the table's
-- time column next, which is exactly the leading-column order those predicates need.
--
-- Cost grows with every sync day and every customer, so this is doing more work each week
-- it is missing. Write amplification on sync is negligible at current volumes (three
-- b-trees on append/upsert-mostly tables).
--
-- Additive and idempotent: `create index if not exists` only — no table, view, constraint,
-- or row is touched, so this holds on a fresh DB and on any DB already at 0045.
--
-- DELIBERATELY NOT `concurrently`: the migration runner applies each file inside a
-- transaction (and the cloud `engine` schema is materialized by the same runner over a
-- session connection), and `create index concurrently` cannot run in a transaction block.
-- The tables are small enough today that the transactional write lock is a non-issue.

-- Daily GA4 traffic grain (0004, renamed report_date -> reporting_date in 0007).
create index if not exists ga4_report_snapshot_workspace_date_idx
  on ga4_report_snapshot_fact (workspace_id, reporting_date);

-- Page-level GA4 grain (0025 — this table was born with `reporting_date`).
create index if not exists ga4_page_report_workspace_date_idx
  on ga4_page_report_fact (workspace_id, reporting_date);

-- PostHog event truth (0004). `occurred_at` is a timestamptz and the queryable views group
-- by `date(occurred_at)`, so through a view the time column is not directly sargable — for
-- the view readers the win is the leading `workspace_id` (one workspace's slice instead of
-- the whole table).
--
-- The COLUMN ORDER is set by the direct reader, not the views: the `posthog_event_count`
-- drilldown (packages/analytical-engine/src/index.ts) runs
--   where workspace_id = $1 … order by occurred_at desc, event_name asc limit $3
-- which plans as an Index Scan BACKWARD on this index with `Presorted Key: occurred_at` —
-- a genuine top-N win that needs `occurred_at` at position 2 and `event_name` at position 3.
-- In `vw_posthog_site` (`where event_name = '$pageview'`) `event_name` is only a NON-LEADING
-- Index Cond, not an index-only-scan enabler — that view also reads `properties->>'$os'` &
-- friends off the heap, so an index-only scan is structurally impossible there. And
-- `vw_site_conversion_rate`'s `count(*) filter (where event_name = 'signup')` is an aggregate
-- FILTER, which never becomes an Index Cond at all.
--
-- TRADE-OFF (measured, so nobody "optimizes" this backwards): a hypothetical
-- (workspace_id, event_name, occurred_at) beats this order on vw_posthog_site's bitmap scan
-- (cost 10.29 vs 30.29) but LOSES the backward-ordered drilldown scan entirely. The
-- committed order wins on balance.
create index if not exists posthog_event_truth_workspace_time_event_idx
  on posthog_event_truth (workspace_id, occurred_at, event_name);
