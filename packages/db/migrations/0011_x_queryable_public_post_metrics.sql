create view queryable.vw_x_post_public_metrics as
with latest_snapshot as (
  select distinct on (workspace_id, source_id, x_post_id)
    workspace_id,
    source_id,
    raw_record_id,
    x_post_id,
    captured_at,
    retweet_count,
    reply_count,
    like_count,
    quote_count,
    bookmark_count,
    impression_count
  from x_post_metric_snapshot
  order by workspace_id, source_id, x_post_id, captured_at desc
)
select
  p.workspace_id,
  p.source_id,
  p.x_post_id,
  p.author_id,
  p.conversation_id,
  p.post_url,
  p.body_text,
  p.published_at::date as occurred_on,
  p.published_at,
  s.captured_at,
  s.retweet_count,
  s.reply_count,
  s.like_count,
  s.quote_count,
  s.bookmark_count,
  s.impression_count,
  (
    s.retweet_count +
    s.reply_count +
    s.like_count +
    s.quote_count +
    s.bookmark_count
  ) as x_public_engagement
from x_post p
join latest_snapshot s
  on s.workspace_id = p.workspace_id
  and s.source_id = p.source_id
  and s.x_post_id = p.x_post_id;

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
  'queryable.vw_x_post_public_metrics',
  'vw_x_post_public_metrics',
  'X read-only public post metric snapshot view',
  'post/latest_public_metric_snapshot',
  'published_at',
  '["x_post_id","author_id","post_url","body_text"]',
  '["x_public_engagement","retweet_count","reply_count","like_count","quote_count","bookmark_count","impression_count"]',
  '["x_post","x_post_metric_snapshot"]',
  '24 hours',
  'public_metrics_only;no_posting;no_paid_or_private_metrics;no_content_attribution',
  'drilldown.x_post_public_metric_rows'
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
values (
  'x_public_engagement',
  'X public engagement',
  'Read-only public engagement from latest X post metric snapshots',
  '["best tweet","best post","most popular tweet","tweet engagement","post engagement"]',
  'queryable.vw_x_post_public_metrics',
  '{"type":"direct_column","view":"queryable.vw_x_post_public_metrics","column":"x_public_engagement","aggregate":"sum"}',
  'count',
  'public_interactions',
  'sum',
  'published_at',
  '["x_post_id","author_id","post_url","body_text"]',
  'public_metrics_only;no_posting;no_paid_or_private_metrics;no_content_attribution',
  '["What is my best tweet?","Which X post had the most public engagement?"]'
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

grant select on queryable.vw_x_post_public_metrics to growth_os_tool_agent, growth_os_app;
