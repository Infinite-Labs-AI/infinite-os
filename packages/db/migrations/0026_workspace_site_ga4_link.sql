-- 0026_workspace_site_ga4_link.sql
-- GA4 Analytics v1 (PR3): link a workspace site to the GA4 source that backs it,
-- so per-site analytical queries can resolve {site} -> source_id deterministically.
--
-- Purely additive: a single nullable FK column. No destructive statements.
-- `on delete set null` keeps the workspace_sites row when the GA4 source goes away.
alter table workspace_sites
  add column if not exists ga4_source_id text references sources (id) on delete set null;
