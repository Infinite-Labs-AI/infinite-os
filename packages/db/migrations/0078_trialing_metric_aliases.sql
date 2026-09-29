-- The trialing-now snapshot is not a count of trials started.
--
-- stripe_trialing_subscribers counts distinct connected-Stripe customers trialing at the time of the read (0048).
-- Its aliases "trials" and "new trials" and its example "How many trials started this week?" sent a
-- trial-START question to that snapshot, which takes no window. A snapshot is never a start, so both
-- phrasings leave the snapshot; "current trials" names what it does count.
--
-- The metric id, query and every other alias row are unchanged. signup_count keeps its "signups" alias:
-- for an engine whose PostHog event named signup IS its signup, that phrasing is right.
--
-- A plain UPDATE of one row, so re-running this file (the cloud engine's one-call execute_sql recipe)
-- is a no-op.
update metric_definitions set
  aliases = '["trialing subscribers","current trials","trial customers"]'::jsonb,
  examples = '["How many customers are trialing right now?"]'::jsonb
where id = 'stripe_trialing_subscribers';
