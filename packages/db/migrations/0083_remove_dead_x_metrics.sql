-- Stop advertising the X (Twitter) read metrics. Nothing has fed them for months.
--
-- WHY. The catalog still listed x_public_engagement (aliases "best tweet" / "best post"),
-- x_post_count, x_comment_count and x_follower_count over three queryable views of x_post /
-- x_post_metric_snapshot / x_profile_snapshot, which hold no rows. An agent asked for "my best tweet"
-- matched the alias, read an empty view and reported X as not syncing. The engine no longer lists
-- these metrics or views (FIRST_PHASE_METRICS / FIRST_PHASE_QUERYABLE_VIEWS); this drops their
-- registry rows and the views so list_metrics / list_queryable_views stop returning them too.
--
-- KEPT. The x_post, x_post_metric_snapshot and x_profile_snapshot TABLES and every row in them are
-- untouched: data and history are never deleted here. X posting (write OAuth) is unaffected.
--
-- No CASCADE on purpose: nothing else reads these views, so a dependent object is a surprise that
-- must fail the migration rather than be dropped with it.
--
-- Idempotent (the cloud engine's one-call execute_sql recipe can run a file twice).
delete from metric_definitions
where id in ('x_public_engagement', 'x_post_count', 'x_comment_count', 'x_follower_count');

delete from queryable_views
where id in (
  'queryable.vw_x_post_public_metrics',
  'queryable.vw_x_authored_activity',
  'queryable.vw_x_profile_public_metrics'
);

drop view if exists queryable.vw_x_post_public_metrics;
drop view if exists queryable.vw_x_authored_activity;
drop view if exists queryable.vw_x_profile_public_metrics;
