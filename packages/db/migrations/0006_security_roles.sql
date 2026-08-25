do $$
begin
  if not exists (select from pg_roles where rolname = 'growth_os_migrator') then
    create role growth_os_migrator;
  end if;
  if not exists (select from pg_roles where rolname = 'growth_os_app') then
    create role growth_os_app;
  end if;
  if not exists (select from pg_roles where rolname = 'growth_os_worker') then
    create role growth_os_worker;
  end if;
  if not exists (select from pg_roles where rolname = 'growth_os_tool_agent') then
    create role growth_os_tool_agent;
  end if;
  if not exists (select from pg_roles where rolname = 'growth_os_read_api') then
    create role growth_os_read_api;
  end if;
end $$;

revoke all on schema public from growth_os_tool_agent;
revoke all on schema public from growth_os_read_api;

grant usage on schema queryable to growth_os_tool_agent;
grant usage on schema queryable to growth_os_read_api;
grant select on all tables in schema queryable to growth_os_tool_agent;
grant select on all tables in schema queryable to growth_os_read_api;
grant select on metric_definitions, queryable_views to growth_os_tool_agent;

grant select, insert, update on job_runs, job_locks, sync_runs, sync_batches, sync_batch_records, sync_cursors, sync_errors, raw_records, record_lineage to growth_os_worker;
grant select on connection_credentials to growth_os_worker;
grant select, insert, update on ga4_report_snapshot_fact, ga4_metadata_catalog, posthog_event_truth, posthog_person_current, posthog_person_distinct_ids, posthog_session_fact, stripe_customers, stripe_invoices, stripe_invoice_lines, stripe_subscriptions, stripe_products, stripe_prices to growth_os_worker;

grant select on queryable_views, metric_definitions to growth_os_app;
grant select on all tables in schema queryable to growth_os_app;
grant select, insert, update on workspaces, datasets, sources, source_scopes, integration_audit_log, sync_schedules, saved_reports, job_runs to growth_os_app;

alter role growth_os_tool_agent set search_path = queryable, public;
alter role growth_os_tool_agent set statement_timeout = '5000ms';
alter role growth_os_read_api set search_path = queryable, public;
alter role growth_os_read_api set statement_timeout = '10000ms';
