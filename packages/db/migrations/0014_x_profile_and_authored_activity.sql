create table x_profile_snapshot (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  captured_at timestamptz not null,
  x_user_id text not null,
  username text,
  followers_count integer not null default 0,
  following_count integer not null default 0,
  tweet_count integer not null default 0,
  listed_count integer not null default 0,
  like_count integer not null default 0,
  public_metrics jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (source_id, captured_at)
);

create view queryable.vw_x_authored_activity as
select
  workspace_id,
  source_id,
  x_post_id,
  author_id,
  conversation_id,
  post_url,
  body_text,
  published_at::date as occurred_on,
  published_at,
  1 as x_post_count,
  case
    when conversation_id is not null and conversation_id <> x_post_id then 1
    else 0
  end as x_comment_count
from x_post;

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
  'queryable.vw_x_authored_activity',
  'vw_x_authored_activity',
  'X authored post and reply activity view',
  'post',
  'published_at',
  '["x_post_id","author_id","conversation_id","post_url","body_text"]',
  '["x_post_count","x_comment_count"]',
  '["x_post"]',
  '24 hours',
  'public_posts_only;reply_count_is_authored_replies_only_when_present_in_source_timeline',
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

create view queryable.vw_x_profile_public_metrics as
with latest_profile as (
  select distinct on (workspace_id, source_id, x_user_id)
    workspace_id,
    source_id,
    x_user_id,
    username,
    captured_at,
    followers_count,
    following_count,
    tweet_count,
    listed_count,
    like_count
  from x_profile_snapshot
  order by workspace_id, source_id, x_user_id, captured_at desc
)
select
  workspace_id,
  source_id,
  x_user_id,
  username,
  captured_at::date as occurred_on,
  captured_at,
  followers_count as x_follower_count,
  following_count as x_following_count,
  tweet_count as x_post_count_profile,
  listed_count as x_listed_count,
  like_count as x_like_count
from latest_profile;

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
  'queryable.vw_x_profile_public_metrics',
  'vw_x_profile_public_metrics',
  'X profile public metrics view',
  'profile/latest_public_metric_snapshot',
  'captured_at',
  '["x_user_id","username"]',
  '["x_follower_count","x_following_count","x_post_count_profile","x_listed_count","x_like_count"]',
  '["x_profile_snapshot"]',
  '24 hours',
  'public_profile_metrics_only',
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
values
(
  'x_post_count',
  'X posts made',
  'Count of authored X posts currently stored in the synced timeline',
  '["tweets made","tweet count","posts made","how many tweets have i made"]',
  'queryable.vw_x_authored_activity',
  '{"type":"direct_column","view":"queryable.vw_x_authored_activity","column":"x_post_count","aggregate":"sum"}',
  'count',
  'posts',
  'sum',
  'published_at',
  '["x_post_id","author_id","conversation_id","post_url","body_text"]',
  'public_posts_only',
  '["How many tweets have I made?"]'
),
(
  'x_comment_count',
  'X comments made',
  'Count of authored X replies/comments inferred from synced authored posts',
  '["comments made","replies made","comments authored","how many comments ive made","how many comments have i made"]',
  'queryable.vw_x_authored_activity',
  '{"type":"direct_column","view":"queryable.vw_x_authored_activity","column":"x_comment_count","aggregate":"sum"}',
  'count',
  'comments',
  'sum',
  'published_at',
  '["x_post_id","author_id","conversation_id","post_url","body_text"]',
  'reply_count_is_authored_replies_only_when_present_in_source_timeline',
  '["How many comments have I made on X?"]'
),
(
  'x_follower_count',
  'X follower count',
  'Latest public follower count from the connected X profile',
  '["followers","follower count","how many followers i have","how many followers do i have"]',
  'queryable.vw_x_profile_public_metrics',
  '{"type":"direct_column","view":"queryable.vw_x_profile_public_metrics","column":"x_follower_count","aggregate":"sum"}',
  'count',
  'followers',
  'sum',
  'captured_at',
  '["x_user_id","username"]',
  'public_profile_metrics_only',
  '["How many followers do I have?"]'
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

grant select, insert, update on x_profile_snapshot to growth_os_worker;
grant select on queryable.vw_x_authored_activity, queryable.vw_x_profile_public_metrics to growth_os_tool_agent, growth_os_app;
