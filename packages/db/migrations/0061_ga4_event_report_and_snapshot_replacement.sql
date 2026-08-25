-- GA4 event-name grain + snapshot-replacement support.
--
-- WHY (verified in prod, 2026-08-18): the GA4 sync is a rolling-window re-pull whose writer was
-- UPSERT-ONLY. GA4 restates attribution for days after first capture (documented up to ~12 days for
-- key events): a day first lands as "(not set)"/"Unassigned" rows, and once Google resolves the
-- session the SAME conversions come back under new dimension keys ("(direct)"/"Direct"). The upsert
-- adds the restated rows but never deletes the obsolete keys, so the overview fact double-counts
-- (observed: 10 key_events across Aug 4/11/12 where GA and the page fact both say 6). The connector
-- now prunes, at successful CLOSE, fact rows inside the refreshed window whose keys the provider
-- snapshot no longer contains — which requires DELETE grants on the GA4 fact tables (2c).
--
-- Also: `key_events` was only a property-wide lump (no eventName dimension anywhere), so a property
-- with two key events (e.g. `download_click` + `purchase`) could never answer "downloads only".
-- Report E (date/hostName/eventName) lands in a new event-grain fact + view + metrics (1a-1e).
--
-- Additive and idempotent: `create table/index if not exists`, `create or replace view`,
-- `add column if not exists`, registry seeds via `on conflict (id) do update`, and re-runnable
-- grants.

-- 1a. Event-grain fact table. event_name is bounded-cardinality (a property's event taxonomy),
-- host_name matches the other GA4 facts. Upsert key = (source_id, reporting_date, host_name,
-- event_name) — the canonical ordering; writeGa4EventTruth's `on conflict (...)` list MUST match
-- this column set.
create table if not exists ga4_event_report_fact (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  reporting_date date not null,
  host_name text not null default '(not set)',
  event_name text not null default '(not set)',
  event_count integer not null default 0,
  key_events integer not null default 0,
  created_at timestamptz not null default now(),
  constraint ga4_event_report_unique unique (source_id, reporting_date, host_name, event_name)
);

-- 1b. Workspace-scoped read index (the 0046 convention — the unique key leads with source_id and
-- cannot serve the engine's `where workspace_id = $1 and occurred_on between …` read shape).
create index if not exists ga4_event_report_workspace_date_idx
  on ga4_event_report_fact (workspace_id, reporting_date);

-- 1c. View. Aliases follow the metric-id == aliased-view-column convention (0024/0025):
-- event_count -> site_event_count, key_events -> site_key_events. Dev hosts are excluded at the
-- view boundary from day one (the 0027 rule — localhost tag traffic must not pollute sums).
create or replace view queryable.vw_site_events as
select
  workspace_id,
  source_id,
  reporting_date as occurred_on,
  host_name,
  event_name,
  event_count as site_event_count,
  key_events as site_key_events
from ga4_event_report_fact
where (host_name is null or lower(host_name) not in ('localhost', '127.0.0.1'));

-- 1d. Registry seeds (metadata only — execution uses hard-coded SQL in the engine).
insert into queryable_views (
  id,
  view_name,
  description,
  row_grain,
  default_time_column,
  allowed_dimensions,
  allowed_measures,
  source_tables,
  freshness_target,
  caveats,
  drilldown_action
)
values (
  'queryable.vw_site_events',
  'vw_site_events',
  'GA4 event-name authority view (event counts and key events by event name and host)',
  'day/source/host/event',
  'occurred_on',
  '["host_name","event_name"]',
  '["site_event_count","site_key_events"]',
  '["ga4_event_report_fact"]',
  '24 hours',
  'source_native_attribution_only',
  'drilldown.ga4_event_provider_rows'
)
on conflict (id) do update set
  view_name = excluded.view_name,
  description = excluded.description,
  row_grain = excluded.row_grain,
  default_time_column = excluded.default_time_column,
  allowed_dimensions = excluded.allowed_dimensions,
  allowed_measures = excluded.allowed_measures,
  source_tables = excluded.source_tables,
  freshness_target = excluded.freshness_target,
  caveats = excluded.caveats,
  drilldown_action = excluded.drilldown_action;

insert into metric_definitions (
  id,
  name,
  description,
  aliases,
  source_view,
  expression,
  metric_type,
  unit,
  aggregation,
  default_time_column,
  allowed_dimensions,
  caveats,
  examples
)
values
  (
    'site_event_count',
    'Site event count',
    'GA4 event count grouped by event name and host',
    '["ga4 events","site events","event count by name","events by name"]',
    'queryable.vw_site_events',
    '{"type":"direct_column","view":"queryable.vw_site_events","column":"site_event_count","aggregate":"sum"}',
    'count',
    'events',
    'sum',
    'occurred_on',
    '["host_name","event_name"]',
    'source_native_attribution_only',
    '["How many download_click events fired last week?","Event counts by event name this month"]'
  ),
  (
    'site_key_events',
    'Site key events by event',
    'GA4 key events grouped by event name and host (per-event conversions)',
    '["key events by event","key events by name","conversions by event","download conversions"]',
    'queryable.vw_site_events',
    '{"type":"direct_column","view":"queryable.vw_site_events","column":"site_key_events","aggregate":"sum"}',
    'count',
    'events',
    'sum',
    'occurred_on',
    '["host_name","event_name"]',
    'source_native_attribution_only; key_events_may_be_unconfigured',
    '["How many key events came from download_click?","Key events by event name last week"]'
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  aliases = excluded.aliases,
  source_view = excluded.source_view,
  expression = excluded.expression,
  metric_type = excluded.metric_type,
  unit = excluded.unit,
  aggregation = excluded.aggregation,
  default_time_column = excluded.default_time_column,
  allowed_dimensions = excluded.allowed_dimensions,
  caveats = excluded.caveats,
  examples = excluded.examples;

-- 2a. Provider metadata on sources — the GA4 runReport response's property time zone (its dates are
-- property-local, NOT UTC) and the latest property-local date the provider returned any data for
-- (that day may still be partial; GA restates it on later syncs). Written at successful CLOSE only.
alter table sources
  add column if not exists provider_time_zone text,
  add column if not exists provider_data_through_date date;

-- 2b. Grants for the new objects — a new table/view is NOT covered by 0006's apply-time blanket
-- grant (the 0053 grantless-view incident).
grant select, insert, update, delete on ga4_event_report_fact to growth_os_worker;
grant select on queryable.vw_site_events to growth_os_tool_agent, growth_os_app, growth_os_read_api;

-- 2c. Snapshot replacement needs DELETE on the two EXISTING GA4 fact tables (0006/0025 granted the
-- worker only select/insert/update — the upsert-only era). Scope stays exactly the three GA4 fact
-- tables the reconcile window re-pulls; no other provider truth gains delete.
grant delete on ga4_report_snapshot_fact, ga4_page_report_fact to growth_os_worker;

-- 2d. Cloud engine role (optional — exists only on the hosted engine schema; the 0049/0057 guard
-- pattern).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert, update, delete on ga4_event_report_fact to engine_app;
    grant delete on ga4_report_snapshot_fact, ga4_page_report_fact to engine_app;
    grant select on queryable.vw_site_events to engine_app;
  end if;
end
$$;
