-- Point the X authored-activity queryable view at its dedicated row-level
-- drilldown action. Previously this view advertised
-- 'drilldown.x_post_public_metric_rows', but x_post_count / x_comment_count
-- drilldowns now resolve to authored x_post rows (text, url, published_at)
-- via 'drilldown.x_authored_post_rows'. This keeps describe_*/explain_answer
-- metadata consistent with the analytical-engine drilldown routing.
update queryable_views
set drilldown_action = 'drilldown.x_authored_post_rows'
where id = 'queryable.vw_x_authored_activity';
