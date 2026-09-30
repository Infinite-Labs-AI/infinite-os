-- Weekly Meta ad set WINDOW TOTAL (Ad Brain card 11, River 2026-09-30: "allow a third weekly Meta call per
-- account (level=adset, all days, no breakdown) for window frequency").
--
-- The third weekly read is the breakdown read of 0080 with NO breakdowns parameter: one row per ad set for the
-- whole settled window, carrying Meta's de-duplicated WINDOW reach. Window frequency = impressions / reach is
-- then Meta's own number; it is never rebuilt from daily reach (reach isn't additive across days).
--
-- It is stored beside the breakdowns under dimension 'none' with the single dimension value 'all', and gets
-- its own coverage receipt (dimension 'none'): no receipt = never measured, row_count 0 = a measured none.
-- Written only by syncMetaAdsAdsetBreakdownWindow (dimension "none"), scheduled by the caller from its own
-- settled_history share of the per-account request budget.
--
-- Idempotent (the cloud engine's one-call execute_sql recipe can run a file twice): every constraint is
-- dropped if present and re-added. The names are Postgres's own names for 0080's inline column checks.

alter table meta_ads_adset_breakdown_windows
  drop constraint if exists meta_ads_adset_breakdown_windows_dimension_check;
alter table meta_ads_adset_breakdown_windows
  add constraint meta_ads_adset_breakdown_windows_dimension_check
  check (dimension in ('device_platform', 'publisher_platform', 'none'));

alter table meta_ads_adset_breakdown_windows
  drop constraint if exists meta_ads_adset_breakdown_windows_total_value_check;
alter table meta_ads_adset_breakdown_windows
  add constraint meta_ads_adset_breakdown_windows_total_value_check
  check (dimension <> 'none' or dimension_value = 'all');

alter table meta_ads_breakdown_coverage
  drop constraint if exists meta_ads_breakdown_coverage_dimension_check;
alter table meta_ads_breakdown_coverage
  add constraint meta_ads_breakdown_coverage_dimension_check
  check (dimension in ('device_platform', 'publisher_platform', 'none'));
