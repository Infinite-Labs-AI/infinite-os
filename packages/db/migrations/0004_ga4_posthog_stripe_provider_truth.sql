create table ga4_report_snapshot_fact (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  report_date date not null,
  country text,
  landing_page text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  sessions integer not null default 0,
  active_users integer not null default 0,
  total_users integer not null default 0,
  created_at timestamptz not null default now()
);

create table ga4_metadata_catalog (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  metadata_type text not null,
  api_name text not null,
  ui_name text,
  description text,
  created_at timestamptz not null default now(),
  unique (source_id, metadata_type, api_name)
);

create table posthog_event_truth (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  event_id text not null,
  event_name text not null,
  distinct_id text,
  person_id text,
  session_id text,
  occurred_at timestamptz not null,
  landing_page text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  properties jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (source_id, event_id)
);

create table posthog_person_current (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  person_id text not null,
  email text,
  created_at_source timestamptz,
  properties jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  unique (source_id, person_id)
);

create table posthog_person_distinct_ids (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  person_id text not null,
  distinct_id text not null,
  created_at timestamptz not null default now(),
  unique (source_id, distinct_id)
);

create table posthog_session_fact (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  session_id text not null,
  distinct_id text,
  started_at timestamptz,
  ended_at timestamptz,
  landing_page text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  created_at timestamptz not null default now(),
  unique (source_id, session_id)
);

create table stripe_customers (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  stripe_customer_id text not null,
  email text,
  name text,
  created_at_source timestamptz,
  created_at timestamptz not null default now(),
  unique (source_id, stripe_customer_id)
);

create table stripe_invoices (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  stripe_invoice_id text not null,
  stripe_customer_id text,
  status text,
  currency text,
  amount_paid bigint not null default 0,
  amount_due bigint not null default 0,
  recognized_at timestamptz,
  created_at_source timestamptz,
  created_at timestamptz not null default now(),
  unique (source_id, stripe_invoice_id)
);

create table stripe_invoice_lines (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  stripe_line_id text not null,
  stripe_invoice_id text not null,
  stripe_product_id text,
  stripe_price_id text,
  amount bigint not null default 0,
  currency text,
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz not null default now(),
  unique (source_id, stripe_line_id)
);

create table stripe_subscriptions (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  stripe_subscription_id text not null,
  stripe_customer_id text,
  status text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at_source timestamptz,
  created_at timestamptz not null default now(),
  unique (source_id, stripe_subscription_id)
);

create table stripe_products (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  stripe_product_id text not null,
  name text,
  active boolean,
  created_at timestamptz not null default now(),
  unique (source_id, stripe_product_id)
);

create table stripe_prices (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  raw_record_id text references raw_records(id),
  stripe_price_id text not null,
  stripe_product_id text,
  currency text,
  unit_amount bigint,
  recurring_interval text,
  active boolean,
  created_at timestamptz not null default now(),
  unique (source_id, stripe_price_id)
);
