-- Durable state for the Stripe DELTA-FIRST sync lane.
--
-- Steady-state Stripe sync stops re-listing the whole account. After one full import the
-- connector polls ONE UNFILTERED `/v1/events` stream over fixed half-open second-aligned
-- windows, stores every relevant event as immutable historical EVIDENCE, dedupes the changed
-- object keys, re-fetches only those objects' CURRENT state, and advances a watermark. Full
-- refresh drops to at most daily plus documented triggers.
--
-- EVIDENCE CONTRACT (load-bearing): rows in `stripe_event_evidence` are immutable historical
-- evidence — occurrence time, type, `previous_attributes`. They NEVER establish current
-- canonical state. Current state comes only from object retrieval or reconciliation, and those
-- always win. The MRR movement classifier keeps its settled-state semantics and deliberately
-- does NOT consume this table yet; the evidence is stored so a future classifier upgrade is
-- possible without re-reading a retention-expired event stream.

create table if not exists stripe_event_segments (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  -- Half-open [segment_from, segment_to_exclusive), both SECOND-ALIGNED: Stripe's `created`
  -- filters and event timestamps have integer-second resolution, so persisting anything finer
  -- would claim coverage the provider request never observed.
  segment_from timestamptz not null,
  segment_to_exclusive timestamptz not null,
  -- Stripe list cursor (`starting_after`) of the UNFILTERED events stream. Only ever consumed
  -- to resume THIS segment; never shared with the filtered invoice/trial event polls, whose
  -- cursors index a different result set.
  pagination_cursor text,
  -- `open`       — still resumable; the delta lane has NOT observed the whole window.
  -- `closed`     — the delta lane observed the whole window through the event stream.
  -- `superseded` — a FULL refresh re-derived canonical state across this window, so its remaining
  --                purpose is gone. Load-bearing: without a retirement status a single stale OPEN
  --                segment reports a coverage gap forever, which forces the full lane every tick,
  --                and the full lane opens no segments of its own — a permanent full-refresh loop
  --                (~86k reads/month) that nothing could break out of. It is NOT recorded as
  --                `closed` because the delta lane never observed those events.
  status text not null default 'open' check (status in ('open', 'closed', 'superseded')),
  event_count integer not null default 0,
  refetch_count integer not null default 0,
  closed_at timestamptz,
  parser_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_id, id),
  unique (workspace_id, source_id, segment_from, segment_to_exclusive),
  check (segment_from < segment_to_exclusive),
  -- Every RETIRED segment (closed or superseded) carries the instant it stopped being resumable;
  -- an open one never does.
  check ((status = 'open') = (closed_at is null))
);

create index if not exists stripe_event_segments_scope_window_idx
  on stripe_event_segments(workspace_id, source_id, segment_to_exclusive desc);
create index if not exists stripe_event_segments_open_idx
  on stripe_event_segments(workspace_id, source_id, status);

create table if not exists stripe_event_evidence (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  stripe_event_id text not null,
  event_type text not null,
  event_created_at timestamptz not null,
  api_version text,
  livemode boolean,
  -- The entity family the event describes (`subscription`, `customer`, `invoice`, `discount`,
  -- `price`, `coupon`, `credit_note`, `product`) and the external id of the object it carried.
  -- Both are required: an event we cannot key to an object cannot be re-fetched, and inventing
  -- a placeholder would silently drop a change.
  --
  -- TWO SENTINEL KINDS exist alongside the entity families.
  --
  -- `invoice_preview` — an `invoice.upcoming` event. Stripe emits it a few days before EVERY
  -- subscription renewal and its `data.object` is a SIMULATED invoice with NO `id` (the invoice
  -- does not exist yet). It is a documented NON-CHANGE: there is nothing to re-fetch, and the real
  -- `invoice.created`/`.finalized`/`.paid` events arrive on their own. Keyed to the CUSTOMER the
  -- preview is for, and never a re-fetch target.
  --
  -- `unclassified_lifecycle` — the other sentinel. The trial
  -- lane writes it for a subscription lifecycle event its parser could NOT classify (the state
  -- that sets `stripe_trial_history_coverage.incomplete_event_count` and fail-closes the whole
  -- trial funnel). Those rows carry the NORMALIZED lifecycle row as `payload` and exist purely so
  -- the failure is inspectable instead of being a bare counter. They are never re-fetch targets.
  object_kind text not null,
  object_external_id text not null,
  payload jsonb not null,
  previous_attributes jsonb,
  segment_id text,
  created_at timestamptz not null default now(),
  -- INSERT-ONLY. Writers use `on conflict do nothing`; there is no update path.
  unique (workspace_id, source_id, stripe_event_id),
  foreign key (workspace_id, source_id, segment_id)
    references stripe_event_segments(workspace_id, source_id, id)
);

create index if not exists stripe_event_evidence_scope_time_idx
  on stripe_event_evidence(workspace_id, source_id, event_created_at, stripe_event_id);
create index if not exists stripe_event_evidence_object_idx
  on stripe_event_evidence(workspace_id, source_id, object_kind, object_external_id, event_created_at);

create table if not exists stripe_sync_watermarks (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text not null references sources(id),
  -- "Events AND current state observed through" — the second-aligned lagged upper bound of the
  -- last successfully closed run of EITHER lane. Drives `awaiting_sync`-style freshness gates.
  delta_data_as_of timestamptz,
  last_full_refresh_at timestamptz,
  -- The instant from which continuous event coverage can be truthfully claimed. RESET (never
  -- back-dated) whenever a coverage gap is detected: history older than the gap is
  -- unrecoverable because Stripe list endpoints filter on `created`, never `updated`.
  continuous_coverage_from timestamptz,
  -- A durable DEMAND for the full lane, parked by a delta run that refused to apply its window and
  -- cleared by the full run that satisfies it. Today the only value is `delta_fanout_exceeded`: one
  -- `price.*`/`coupon.*` edit can fan out through the local reverse index to every subscription
  -- referencing it, and past ~200 individual retrieves a full refresh (~30 reads) is strictly
  -- cheaper AND strictly more complete. Free text rather than a check constraint would let a caller
  -- invent a marker and pin a source to the expensive lane forever, so the reader validates it
  -- against a closed union and ignores anything else.
  pending_full_refresh_reason text
    check (pending_full_refresh_reason is null
           or pending_full_refresh_reason in ('delta_fanout_exceeded')),
  -- Written by the reconciliation lane (0059), not by the delta lane.
  reconciled_at timestamptz,
  last_drift_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_id)
);

-- Per-run Stripe request accounting (requests by endpoint class, pages, 429s +
-- `Stripe-Rate-Limited-Reason`, objects re-fetched). Stripe's rolling read allowance is 500
-- reads per transaction with a 10,000/month floor, so read volume is the scheduling gate.
alter table sync_runs
  add column if not exists request_telemetry jsonb;

-- LOCAL REVERSE INDEX for the delta fan-out. `price.*` and `coupon.*` events name an object,
-- not the subscriptions that reference it, and Stripe emits no parent event for a subresource
-- change — so revaluing the affected subscriptions requires looking them up in OUR tables.
-- `stripe_subscription_items.stripe_price_id` already exists; the coupon behind a discount was
-- resolved during extraction but never stored, so it is added here.
alter table stripe_subscription_discounts
  add column if not exists stripe_coupon_id text;

create index if not exists stripe_subscription_discounts_coupon_idx
  on stripe_subscription_discounts(workspace_id, source_id, stripe_coupon_id);
create index if not exists stripe_subscription_items_price_idx
  on stripe_subscription_items(workspace_id, source_id, stripe_price_id);

grant select, insert, update on stripe_event_segments to growth_os_worker;
grant select, insert on stripe_event_evidence to growth_os_worker;
grant select, insert, update on stripe_sync_watermarks to growth_os_worker;
grant select on
  stripe_event_segments,
  stripe_event_evidence,
  stripe_sync_watermarks
to growth_os_app, growth_os_tool_agent;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert, update on
      stripe_event_segments,
      stripe_sync_watermarks
    to engine_app;
    grant select, insert on stripe_event_evidence to engine_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'growth_os_read_api') then
    grant select on
      stripe_event_segments,
      stripe_event_evidence,
      stripe_sync_watermarks
    to growth_os_read_api;
  end if;
end
$$;
