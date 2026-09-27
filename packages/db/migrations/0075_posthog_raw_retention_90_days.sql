-- Keep raw PostHog events 90 days instead of 180 (approved by River, 2026-09-27).
--
-- 0064 seeded posthog_retention_config.retention_days = 180. Charts read only the day-grain rollups
-- (posthog_event_daily / posthog_site_daily, 0063), which are kept forever; raw posthog_event_truth
-- exists to (re)build them and for raw drill-down. At 180 days the cloud table would grow from
-- 1.7 GB to about 4.4 GB before the first prune ever deleted a row; at 90 it stays near its size
-- today. What changes for a user: raw drill-down (analysis traces, journeys) reaches back 90 days,
-- not 180. Readers already report the gap: posthog_prune_watermarks.pruned_before marks where raw
-- ends, and every day below it keeps its rollup rows.
--
-- WHEN IT DELETES: this file only changes the policy row. Nothing is deleted when it runs.
-- Deletion happens in the next posthog-raw-retention run (the 1bu-1 Trigger task, daily at 04:10
-- UTC): it reads this row, calls prune_posthog_raw(workspace, source, today_utc - retention_days)
-- for each (workspace, source) pair, which deletes the raw rows before that UTC day and advances
-- the watermark in the same transaction. The first run after this change deletes every raw day older
-- than 90 days at once; after that, each run deletes about one day. Local engines have no
-- retention job and are unaffected.
--
-- SAFE BY 0064's DESIGN: lowering retention moves the prune floor forward, and the rollup refresh
-- clamps to the watermark, so pruned days are never rebuilt from nothing. Raising it again later
-- cannot bring pruned raw back, and cannot damage the rollups either (0064's header, case b).
--
-- Only the 0064 seed value is changed. A deployment that already set its own retention (anything
-- but 180) keeps it.

update posthog_retention_config
   set retention_days = 90
 where singleton
   and retention_days = 180;
