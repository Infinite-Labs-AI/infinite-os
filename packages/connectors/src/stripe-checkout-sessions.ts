import { randomUUID } from "node:crypto";
import type { InfiniteOsDb } from "@infinite-os/db";

import {
  stripeEventSecondBoundary,
  stripeTimestampMs,
  type StripeEventApi,
} from "./stripe-delta.js";

/**
 * Stripe CHECKOUT SESSIONS — the full history of Checkout / Payment Link sales.
 *
 * A one-off sale made through Checkout or a Payment Link creates NO invoice unless the merchant
 * enabled `invoice_creation`, so the invoice lanes never see it. The delta lane has kept minimised
 * `checkout.session.completed` evidence since parser stripe-delta-events-v2, but `/v1/events` only
 * reaches back ~30 days. This lane lists `/v1/checkout/sessions` itself and stores a minimised
 * canonical row per session (0082).
 *
 * THREE WRITERS, ONE TABLE.
 *   1. The HISTORY CRAWL — `status=complete&created[lt]=<anchor>`, newest to oldest, a bounded
 *      number of pages per run, resumable from its cursor. It rides EVERY run (full or delta) until
 *      it completes: at the daily full cadence alone a busy account would take months.
 *   2. INCREMENTAL LIST WINDOWS — after the crawl, each FULL run re-lists
 *      `[listed_through - overlap, now)`. The overlap is longer than a session's 24-hour lifetime, so
 *      a session created before the cutoff that completed after it is still listed. An unfinished
 *      window is resumed by the next run of EITHER lane.
 *   3. The DELTA LANE — upserts sessions from the session events it already polls (zero extra
 *      reads), and advances `listed_through` when a closed window contained it.
 *
 * WHY EVENTS MAY WRITE THIS TABLE. Elsewhere event payloads are evidence only and current state
 * comes from a retrieve. A COMPLETE session is terminal: amount, currency, mode and every reference
 * are fixed at completion. The one field that still moves is `payment_status` (a delayed payment
 * method completes `unpaid` and settles later), and that change is itself delivered as
 * `checkout.session.async_payment_succeeded` / `_failed` carrying the whole session. Each row
 * records the instant it describes (`observed_at`) and the writer only replaces it with an
 * observation at least as new, so an older event processed late can never roll state back. A
 * retrieve per sale would cost one read per transaction for no additional truth.
 *
 * MODE. `/v1/checkout/sessions` cannot filter on `mode`, so every mode is stored and the read
 * selects `mode = 'payment' and stripe_invoice_id is null`.
 *
 * CAPABILITY. A restricted key may lack `Checkout Sessions: Read`. A list 403 with
 * `more_permissions_required` is recorded as `capability_state = 'missing_permission'` and the
 * rest of the Stripe sync carries on; any other failure fails the run as it would on any endpoint.
 */

export const STRIPE_CHECKOUT_SESSIONS_PATH = "/v1/checkout/sessions";

/** The Dashboard checkbox a restricted key needs, in the probe's `<Resource>: Read` wording. */
export const STRIPE_CHECKOUT_SESSIONS_PERMISSION = "Checkout Sessions: Read";

/** Stripe: a session expires 24 hours after creation at the latest (`expires_at` max). */
export const STRIPE_CHECKOUT_SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * How far an incremental window reaches back before `listed_through`. A session created up to 24h
 * before the cutoff can complete after it, and the list filters on `created`, so anything shorter
 * than the lifetime would leave such a sale unlisted. One extra hour of margin.
 */
export const STRIPE_CHECKOUT_SESSION_LIST_OVERLAP_MS =
  STRIPE_CHECKOUT_SESSION_MAX_LIFETIME_MS + 60 * 60 * 1000;

/** Pages per run for either list step — the same bound the invoice crawl uses. */
export const STRIPE_CHECKOUT_SESSION_MAX_PAGES = 5;

/** The session events that carry the whole session object and may update its row. */
export const STRIPE_CHECKOUT_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
]);

export interface StripeCheckoutSessionRow {
  kind: "checkout_session";
  externalId: string;
  sessionId: string;
  mode: string;
  status: string;
  paymentStatus: string;
  amountTotal: number | null;
  amountSubtotal: number | null;
  currency: string | null;
  customerId: string | null;
  invoiceId: string | null;
  paymentIntentId: string | null;
  subscriptionId: string | null;
  sessionCreatedAt: string;
  livemode: boolean;
  observedAt: string;
  observedVia: "list" | "event";
}

export class StripeCheckoutSessionShapeError extends Error {}

/**
 * Project a Stripe Checkout Session onto the minimised row. Nothing but the listed fields survives:
 * `customer_details`, `shipping_details`, `custom_fields` and the rest of the session hold the
 * buyer's name, email, phone and addresses. Every reference is reduced to its id.
 *
 * Throws on a session missing a field every Session carries — keying, dating or classifying a row
 * from a guess would put an unknowable sale into revenue. An absent AMOUNT is kept as null, never 0.
 */
export function stripeCheckoutSessionRow(
  session: Record<string, unknown>,
  observedAt: string,
  observedVia: "list" | "event",
): StripeCheckoutSessionRow {
  const sessionId = requiredString(session, "id");
  const created = session.created;
  if (typeof created !== "number" || !Number.isFinite(created)) {
    throw new StripeCheckoutSessionShapeError(`Stripe Checkout session ${sessionId} has no created time`);
  }
  if (typeof session.livemode !== "boolean") {
    throw new StripeCheckoutSessionShapeError(`Stripe Checkout session ${sessionId} has no livemode`);
  }
  return {
    kind: "checkout_session",
    externalId: sessionId,
    sessionId,
    mode: requiredString(session, "mode", sessionId),
    status: requiredString(session, "status", sessionId),
    paymentStatus: requiredString(session, "payment_status", sessionId),
    amountTotal: minorAmount(session.amount_total),
    amountSubtotal: minorAmount(session.amount_subtotal),
    currency: typeof session.currency === "string" && session.currency !== "" ? session.currency : null,
    customerId: referenceId(session.customer),
    invoiceId: referenceId(session.invoice),
    paymentIntentId: referenceId(session.payment_intent),
    subscriptionId: referenceId(session.subscription),
    sessionCreatedAt: new Date(created * 1_000).toISOString(),
    livemode: session.livemode,
    observedAt,
    observedVia,
  };
}

/**
 * Session rows from the delta lane's UNFILTERED event page, observed at each event's `created`.
 *
 * Same failure doctrine as `stripeDeltaFanout`: inside the window's normal part a session event we
 * cannot project is a sale we would silently drop, so it fails the run; in the REACH-BACK part
 * (before `fanoutFromMs`, already covered by a full run's list) it is counted and skipped, so one
 * malformed event cannot fail every tick until the reach-back cap ages it out. Events the fan-out
 * already rejected never reach here (it runs first, on the same page).
 */
export function stripeCheckoutSessionRowsFromEvents(
  events: StripeEventApi[],
  options: { fanoutFromMs?: number } = {},
): { rows: StripeCheckoutSessionRow[]; unparseableReachBackEventTypes: Record<string, number> } {
  const fanoutFromMs = options.fanoutFromMs ?? Number.NEGATIVE_INFINITY;
  const rows: StripeCheckoutSessionRow[] = [];
  const unparseableReachBackEventTypes: Record<string, number> = {};
  for (const event of events) {
    if (!STRIPE_CHECKOUT_SESSION_EVENT_TYPES.has(event.type)) continue;
    const createdMs = typeof event.created === "number" && Number.isFinite(event.created)
      ? event.created * 1_000
      : null;
    if (createdMs === null) {
      throw new StripeCheckoutSessionShapeError(`Stripe event ${event.id} (${event.type}) has no created time`);
    }
    const object = event.data?.object;
    try {
      if (!object || typeof object !== "object") {
        throw new StripeCheckoutSessionShapeError(
          `Stripe event ${event.id} (${event.type}) carried no session object`,
        );
      }
      rows.push(stripeCheckoutSessionRow(
        object as Record<string, unknown>,
        new Date(createdMs).toISOString(),
        "event",
      ));
    } catch (error) {
      if (!(error instanceof StripeCheckoutSessionShapeError) || createdMs >= fanoutFromMs) throw error;
      unparseableReachBackEventTypes[event.type] = (unparseableReachBackEventTypes[event.type] ?? 0) + 1;
    }
  }
  // Oldest first, so the per-run de-dupe (newest wins, later on a tie) keeps the latest state.
  rows.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  return { rows, unparseableReachBackEventTypes };
}

/**
 * One row per session per run: the NEWEST observation wins, and on a tie the later one in input
 * order (callers pass listed rows after event rows, so a list read at the run's end beats an event
 * stamped the same instant).
 */
export function stripeCheckoutSessionRowsDeduped(
  rows: StripeCheckoutSessionRow[],
): StripeCheckoutSessionRow[] {
  const bySession = new Map<string, StripeCheckoutSessionRow>();
  for (const row of rows) {
    const prior = bySession.get(row.sessionId);
    if (!prior || Date.parse(row.observedAt) >= Date.parse(prior.observedAt)) {
      bySession.set(row.sessionId, row);
    }
  }
  return [...bySession.values()];
}

// ---------------------------------------------------------------------------------------------
// List-step planning
// ---------------------------------------------------------------------------------------------

export interface StripeCheckoutSessionSyncStateRow {
  capability_state: string;
  missing_permission: string | null;
  backfill_state: string;
  backfill_anchor: string | Date | null;
  backfill_starting_after: string | null;
  backfill_reached_created_at: string | Date | null;
  window_from: string | Date | null;
  window_to: string | Date | null;
  window_starting_after: string | null;
  listed_through: string | Date | null;
}

export type StripeCheckoutSessionListStep =
  | {
    kind: "backfill";
    anchorMs: number;
    startingAfter: string | null;
    params: Record<string, string>;
  }
  | {
    kind: "window";
    fromMs: number;
    toMs: number;
    startingAfter: string | null;
    params: Record<string, string>;
  }
  | { kind: "none" };

/**
 * What THIS run lists:
 *   • the key lacks the permission  -> nothing on a DELTA run; the FULL run retries;
 *   • the crawl is unfinished       -> its next bounded step (any lane);
 *   • an incremental window is open -> resume it verbatim (any lane);
 *   • a FULL run with the crawl done -> a fresh window `[listed_through - overlap, now)`;
 *   • otherwise (a delta run)        -> nothing: the session events keep the table current.
 *
 * Bounds are whole seconds — Stripe's `created` filters are integer seconds, and the persisted
 * state must describe exactly the interval Stripe was asked for.
 *
 * A key recorded as `missing_permission` is re-tried on the FULL lane only (daily). Re-trying on
 * every 15-minute delta tick would spend ~2,900 reads a month on a known 403 out of Stripe's
 * 10,000/month floor; the gap stays typed and visible in the meantime.
 */
export function planStripeCheckoutSessionListStep(input: {
  state: StripeCheckoutSessionSyncStateRow | null;
  lane: "full" | "delta";
  cursorEndMs: number;
}): StripeCheckoutSessionListStep {
  const { state, lane, cursorEndMs } = input;
  if (!Number.isFinite(cursorEndMs)) throw new Error("Stripe Checkout session cursor end is invalid");
  const nowBoundaryMs = stripeEventSecondBoundary(cursorEndMs);

  if (lane !== "full" && state?.capability_state === "missing_permission") return { kind: "none" };

  if (!state || state.backfill_state !== "complete") {
    const persistedAnchorMs = stripeTimestampMs(state?.backfill_anchor ?? null);
    const continuing = state?.backfill_state === "in_progress" && persistedAnchorMs !== null;
    const anchorMs = continuing ? persistedAnchorMs : nowBoundaryMs;
    return {
      kind: "backfill",
      anchorMs,
      startingAfter: continuing ? state.backfill_starting_after : null,
      params: {
        limit: "100",
        status: "complete",
        "created[lt]": String(Math.floor(anchorMs / 1_000)),
      },
    };
  }

  const openFromMs = stripeTimestampMs(state.window_from);
  const openToMs = stripeTimestampMs(state.window_to);
  if (openFromMs !== null && openToMs !== null && openFromMs < openToMs) {
    return windowStep(openFromMs, openToMs, state.window_starting_after);
  }

  if (lane !== "full") return { kind: "none" };

  const listedThroughMs = stripeTimestampMs(state.listed_through);
  if (listedThroughMs === null) {
    // A complete crawl always stamps `listed_through` (the anchor). Without it there is no lower
    // bound for a window, and inventing one would claim coverage nothing observed.
    throw new Error("Stripe Checkout session crawl is complete but has no listed_through cutoff");
  }
  const fromMs = stripeEventSecondBoundary(listedThroughMs - STRIPE_CHECKOUT_SESSION_LIST_OVERLAP_MS);
  // Never invert the window on a cutoff younger than now (a crawl that finished seconds ago).
  const toMs = Math.max(nowBoundaryMs, fromMs + 1_000);
  return windowStep(fromMs, toMs, null);
}

function windowStep(
  fromMs: number,
  toMs: number,
  startingAfter: string | null,
): StripeCheckoutSessionListStep {
  return {
    kind: "window",
    fromMs,
    toMs,
    startingAfter,
    params: {
      limit: "100",
      status: "complete",
      "created[gte]": String(Math.floor(fromMs / 1_000)),
      "created[lt]": String(Math.floor(toMs / 1_000)),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------------------------

/**
 * What a run learned, applied at CLOSE. Every part is optional: a part a run did not exercise
 * leaves the stored columns exactly as they were.
 */
export interface StripeCheckoutSessionCheckpoint {
  /** Set whenever the list endpoint was called this run (success or permission 403). */
  capability?:
    | { state: "available" }
    | { state: "missing_permission"; permission: string };
  backfill?: {
    state: "in_progress" | "complete";
    anchor: string;
    startingAfter: string | null;
    /** Oldest `created` listed by the crawl so far, including earlier runs. */
    reachedCreatedAt: string | null;
  };
  /** Replace the open-window columns (all null = no window open). */
  window?: { from: string | null; to: string | null; startingAfter: string | null };
  /** Advance the coverage claim. Never moves it backwards. */
  listedThrough?: string;
}

/**
 * The checkpoint for one list step that returned a page set. `priorReachedCreatedAt` carries the
 * crawl's progress across runs.
 */
export function stripeCheckoutSessionCheckpointForStep(input: {
  step: Exclude<StripeCheckoutSessionListStep, { kind: "none" }>;
  page: { complete: boolean; nextStartingAfter: string | null };
  rows: StripeCheckoutSessionRow[];
  priorReachedCreatedAt: string | Date | null;
}): StripeCheckoutSessionCheckpoint {
  const { step, page, rows, priorReachedCreatedAt } = input;
  if (step.kind === "backfill") {
    const anchor = new Date(step.anchorMs).toISOString();
    const createdMs = rows.map((row) => Date.parse(row.sessionCreatedAt));
    const priorMs = stripeTimestampMs(priorReachedCreatedAt ?? null);
    if (priorMs !== null) createdMs.push(priorMs);
    const reachedCreatedAt = createdMs.length > 0
      ? new Date(Math.min(...createdMs)).toISOString()
      : null;
    return {
      capability: { state: "available" },
      backfill: {
        state: page.complete ? "complete" : "in_progress",
        anchor,
        startingAfter: page.complete ? null : page.nextStartingAfter,
        reachedCreatedAt,
      },
      // The crawl covers every session that COMPLETED before the anchor: those were all created
      // before it, and the first page was read at or after it.
      ...(page.complete ? { listedThrough: anchor } : {}),
    };
  }
  if (page.complete) {
    return {
      capability: { state: "available" },
      window: { from: null, to: null, startingAfter: null },
      listedThrough: new Date(step.toMs).toISOString(),
    };
  }
  return {
    capability: { state: "available" },
    window: {
      from: new Date(step.fromMs).toISOString(),
      to: new Date(step.toMs).toISOString(),
      startingAfter: page.nextStartingAfter,
    },
  };
}

/**
 * Can a CLOSED delta window advance the coverage claim? Only when the key can read Checkout
 * sessions, the crawl is complete, no list window is open (that window owns the next advance), and
 * the window's NORMAL start reaches back to or before the claim — so every completion event from
 * the claim onward was observed.
 *
 * Never while the permission is missing: whether Stripe returns `checkout.session.*` events to a
 * key without Checkout read access is not something this claim may rest on. Holding the claim
 * makes the first FULL window after the grant re-list the whole gap from `listed_through`.
 */
export function stripeCheckoutSessionDeltaAdvance(input: {
  state: StripeCheckoutSessionSyncStateRow | null;
  fanoutFromMs: number;
  segmentToExclusive: string;
}): string | null {
  const { state, fanoutFromMs, segmentToExclusive } = input;
  if (!state || state.capability_state !== "available") return null;
  if (state.backfill_state !== "complete") return null;
  if (stripeTimestampMs(state.window_from) !== null) return null;
  const listedThroughMs = stripeTimestampMs(state.listed_through);
  if (listedThroughMs === null || fanoutFromMs > listedThroughMs) return null;
  return segmentToExclusive;
}

export async function readStripeCheckoutSessionSyncState(
  db: InfiniteOsDb,
  scope: { workspaceId: string; sourceId: string },
): Promise<StripeCheckoutSessionSyncStateRow | null> {
  return db.one<StripeCheckoutSessionSyncStateRow & Record<string, unknown>>(
    `select capability_state, missing_permission, backfill_state, backfill_anchor,
            backfill_starting_after, backfill_reached_created_at, window_from, window_to,
            window_starting_after, listed_through
       from stripe_checkout_session_sync_state
      where workspace_id = $1 and source_id = $2`,
    [scope.workspaceId, scope.sourceId],
  );
}

/**
 * Apply a run's checkpoint inside the connector's CLOSE transaction. Columns a checkpoint part did
 * not mention keep their stored value; `listed_through` only ever moves forward.
 */
export async function writeStripeCheckoutSessionCheckpoint(
  tx: InfiniteOsDb,
  scope: { workspaceId: string; sourceId: string },
  checkpoint: StripeCheckoutSessionCheckpoint,
): Promise<void> {
  const capability = checkpoint.capability ?? null;
  const backfill = checkpoint.backfill ?? null;
  const window = checkpoint.window ?? null;
  await tx.query(
    `insert into stripe_checkout_session_sync_state (
       id, workspace_id, source_id, capability_state, missing_permission, capability_checked_at,
       backfill_state, backfill_anchor, backfill_starting_after, backfill_reached_created_at,
       backfill_completed_at, window_from, window_to, window_starting_after, listed_through,
       last_successful_sync_at, updated_at
     ) values (
       $1, $2, $3,
       coalesce($4, 'unknown'), $5, case when $4::text is null then null else now() end,
       coalesce($6, 'pending'), $7::timestamptz, $8, $9::timestamptz,
       case when $6 = 'complete' then now() else null end,
       $11::timestamptz, $12::timestamptz, $13, $14::timestamptz,
       now(), now()
     )
     on conflict (workspace_id, source_id) do update set
       capability_state = coalesce($4, stripe_checkout_session_sync_state.capability_state),
       missing_permission = case when $4::text is null
                              then stripe_checkout_session_sync_state.missing_permission
                              else $5 end,
       capability_checked_at = case when $4::text is null
                                 then stripe_checkout_session_sync_state.capability_checked_at
                                 else now() end,
       backfill_state = coalesce($6, stripe_checkout_session_sync_state.backfill_state),
       backfill_anchor = case when $6::text is null
                           then stripe_checkout_session_sync_state.backfill_anchor
                           else $7::timestamptz end,
       backfill_starting_after = case when $6::text is null
                                   then stripe_checkout_session_sync_state.backfill_starting_after
                                   else $8 end,
       backfill_reached_created_at = case when $6::text is null
                                       then stripe_checkout_session_sync_state.backfill_reached_created_at
                                       else $9::timestamptz end,
       backfill_completed_at = case
         when $6 = 'complete' then coalesce(stripe_checkout_session_sync_state.backfill_completed_at, now())
         when $6::text is null then stripe_checkout_session_sync_state.backfill_completed_at
         else null end,
       window_from = case when $10 then $11::timestamptz else stripe_checkout_session_sync_state.window_from end,
       window_to = case when $10 then $12::timestamptz else stripe_checkout_session_sync_state.window_to end,
       window_starting_after = case when $10 then $13
                                 else stripe_checkout_session_sync_state.window_starting_after end,
       listed_through = case
         when $14::timestamptz is null then stripe_checkout_session_sync_state.listed_through
         when stripe_checkout_session_sync_state.listed_through is null then $14::timestamptz
         else greatest(stripe_checkout_session_sync_state.listed_through, $14::timestamptz) end,
       last_successful_sync_at = now(),
       updated_at = now()`,
    [
      `stripe_checkout_state_${randomUUID()}`,
      scope.workspaceId,
      scope.sourceId,
      capability?.state ?? null,
      capability?.state === "missing_permission" ? capability.permission : null,
      backfill?.state ?? null,
      backfill?.anchor ?? null,
      backfill?.startingAfter ?? null,
      backfill?.reachedCreatedAt ?? null,
      window !== null,
      window?.from ?? null,
      window?.to ?? null,
      window?.startingAfter ?? null,
      checkpoint.listedThrough ?? null,
    ],
  );
}

/** Upsert one session row; an older observation never overwrites a newer one. */
export async function writeStripeCheckoutSessionTruth(
  tx: InfiniteOsDb,
  scope: { workspaceId: string; sourceId: string },
  row: StripeCheckoutSessionRow,
  rawRecordId: string,
): Promise<void> {
  await tx.query(
    `insert into stripe_checkout_sessions (
       id, workspace_id, source_id, raw_record_id, stripe_checkout_session_id, mode, status,
       payment_status, amount_total, amount_subtotal, currency, stripe_customer_id,
       stripe_invoice_id, stripe_payment_intent_id, stripe_subscription_id, session_created_at,
       livemode, observed_at, observed_via
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     on conflict (source_id, stripe_checkout_session_id) do update set
       raw_record_id = excluded.raw_record_id,
       mode = excluded.mode,
       status = excluded.status,
       payment_status = excluded.payment_status,
       amount_total = excluded.amount_total,
       amount_subtotal = excluded.amount_subtotal,
       currency = excluded.currency,
       stripe_customer_id = excluded.stripe_customer_id,
       stripe_invoice_id = excluded.stripe_invoice_id,
       stripe_payment_intent_id = excluded.stripe_payment_intent_id,
       stripe_subscription_id = excluded.stripe_subscription_id,
       session_created_at = excluded.session_created_at,
       livemode = excluded.livemode,
       observed_at = excluded.observed_at,
       observed_via = excluded.observed_via,
       updated_at = now()
     where excluded.observed_at >= stripe_checkout_sessions.observed_at`,
    [
      `stripe_checkout_session_${randomUUID()}`,
      scope.workspaceId,
      scope.sourceId,
      rawRecordId,
      row.sessionId,
      row.mode,
      row.status,
      row.paymentStatus,
      row.amountTotal,
      row.amountSubtotal,
      row.currency,
      row.customerId,
      row.invoiceId,
      row.paymentIntentId,
      row.subscriptionId,
      row.sessionCreatedAt,
      row.livemode,
      row.observedAt,
      row.observedVia,
    ],
  );
}

function requiredString(
  source: Record<string, unknown>,
  field: string,
  sessionId?: string,
): string {
  const value = source[field];
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new StripeCheckoutSessionShapeError(
    sessionId
      ? `Stripe Checkout session ${sessionId} has no ${field}`
      : `Stripe Checkout session has no ${field}`,
  );
}

function minorAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function referenceId(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (value && typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" && id.trim() !== "" ? id : null;
  }
  return null;
}
