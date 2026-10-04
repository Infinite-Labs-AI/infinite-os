-- Phase 1 §2.2 — extend the delivery fact (meta_ads_campaign_daily) with the
-- campaign-day attributes the conversion pipeline needs. Purely additive: every
-- column uses `add column if not exists` and is nullable / defaulted, so existing
-- rows stay valid and the migration is idempotent.
--
-- Deliberately NOT added here (§2.2):
--   * NO scalar results / result_type — those live on the typed child fact
--     meta_ads_campaign_conversions_daily (0031); a scalar here would force one
--     type to win (the §0 Ultima corruption).
--   * NO parallel per-attribution-window columns (one-day-click / seven-day-click /
--     one-day-view) — the per-window subvalues live inside actions_raw (jsonb); the
--     headline (seven-day-click plus one-day-view) is COMPUTED at extract time, not
--     stored as separate columns.
--
-- Columns added:
--   currency            — account currency for THIS delivery row (mirrors the
--                         dimension's currency; load-bearing for the Stripe join).
--   inline_link_clicks  — link clicks (distinct from total `clicks`).
--   landing_page_views  — from actions[action_type='landing_page_view'], NON-omni
--                         (omni_landing_page_view is a different, broader population).
--   attribution_setting — describes the REQUEST (windows + unified on/off),
--                         e.g. '1d_click,7d_click,1d_view'. Provenance, not a lever.
--   actions_raw         — the full actions[] + action_values[] arrays WITH per-window
--                         subvalues, as returned. The recompute/audit source of truth.
--   api_version         — the Graph API version this row was ingested under (pinned
--                         + recorded per §4 so attribution-deprecation drift is
--                         auditable).
--
-- runMigrations() wraps every migration file in begin/commit, so this file is not
-- wrapped again here.

alter table meta_ads_campaign_daily
  add column if not exists currency text,
  add column if not exists inline_link_clicks bigint not null default 0,
  add column if not exists landing_page_views bigint not null default 0,
  add column if not exists attribution_setting text,
  add column if not exists actions_raw jsonb,
  add column if not exists api_version text;
