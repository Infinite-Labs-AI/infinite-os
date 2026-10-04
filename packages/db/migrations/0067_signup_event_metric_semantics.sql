-- Preserve the metric ID, aliases and query semantics for existing callers.
-- Provider event occurrences cannot establish unique account registrations.
update metric_definitions set
  name = 'PostHog signup events',
  unit = 'events',
  description = 'Occurrences of the PostHog event named signup; not verified account registrations',
  caveats = 'PostHog signup event occurrences, not verified account registrations; capture and sync coverage apply',
  examples = '["How many PostHog signup events were captured in the last 30 days?"]'
where id = 'signup_count';
