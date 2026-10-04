// Meta Ads insights: the data-volume narrowing ladder + Meta's asynchronous report-job runner.
//
// WHEN ASYNC RUNS — only as the LAST rung, never by window size:
//
//   sync window ──1487534──▶ weeks (window > 7 days) ──1487534──▶ days (window 2–7 days)
//                                                                   │
//                                              single day ──1487534─┴─▶ async report job
//
// Why not "async for windows above N days": the binding Meta constraint is the per-ad-account CALL
// count (code 17 / subcode 2446079 fires at ~250–300 calls, and every lane shares one 300/24h budget).
// An async job returns the SAME rows through the SAME page size as the synchronous edge, so it never
// saves result pages; it only ADDS calls — one POST plus at least one poll (typically several). And
// no hosted lane issues a wide window: the settled-history lane drives 7-day slices, the generic
// orchestrator 30-day windows, restatement ≤35 days, the hot lane one day; the only multi-month run
// (desktop `backfillWindow`) is already month-chunked. Meta's first documented remedy for data-per-
// call errors is "limit your query by limiting the date range"; async is the documented remedy for a
// volume that a narrower date range cannot fix — i.e. a single day that still trips 1487534.
//
// Before this module the ladder bottomed out at WEEKS, and a window already ≤7 days (every settled-
// history slice) "narrowed" into the identical window: a guaranteed second 1487534 and a failed run.
//
// Every HTTP request (sync page, async POST, each poll, each result page) goes through the caller's
// throttle-aware fetch, so the request budget, cooldown, soft deadline and throttle backoff apply
// unchanged and every call is reserved before it is sent — the ladder can fail closed, never overrun.
// Rows for a window are committed to `onRow` only once every page of that window succeeded, so a
// failed rung never leaks a partial window into the narrower retry.

export interface MetaAdsInsightsWindow {
  since: string;
  until: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function inclusiveDays(window: MetaAdsInsightsWindow): number {
  const since = new Date(`${window.since}T00:00:00.000Z`).getTime();
  const until = new Date(`${window.until}T00:00:00.000Z`).getTime();
  return Math.round((until - since) / DAY_MS) + 1;
}

function splitWindow(window: MetaAdsInsightsWindow, days: number): MetaAdsInsightsWindow[] {
  const out: MetaAdsInsightsWindow[] = [];
  let cursor = new Date(`${window.since}T00:00:00.000Z`);
  const until = new Date(`${window.until}T00:00:00.000Z`);
  while (cursor <= until) {
    const end = new Date(cursor.getTime() + (days - 1) * DAY_MS);
    const windowUntil = end < until ? end : until;
    out.push({ since: isoDay(cursor), until: isoDay(windowUntil) });
    cursor = new Date(windowUntil.getTime() + DAY_MS);
  }
  return out;
}

/**
 * The next-narrower date windows for a window that tripped Meta's data-volume error.
 * >7 days → 7-day weeks; 2–7 days → single days; one day → [] (no narrower date range exists;
 * the caller's final rung is the async report job). Never returns the input window itself.
 */
export function metaAdsNarrowerWindows(window: MetaAdsInsightsWindow): MetaAdsInsightsWindow[] {
  const days = inclusiveDays(window);
  if (days > 7) return splitWindow(window, 7);
  if (days > 1) return splitWindow(window, 1);
  return [];
}

export interface MetaAdsNarrowingInput<Row> {
  window: MetaAdsInsightsWindow;
  urlFor: (range: MetaAdsInsightsWindow) => string;
  /** Synchronous pager for one /insights URL (throttle-aware, budgeted, page-capped). */
  fetchPages: (url: string, onRow: (row: Row) => void) => Promise<void>;
  /** Meta "reduce the amount of data" classifier (100/1487534, or its code-1 message twin). */
  isDataVolumeError: (error: unknown) => boolean;
  /** Last rung for a single day that still trips the data-volume error. Returns the whole day. */
  finalRung: (range: MetaAdsInsightsWindow, url: string) => Promise<Row[]>;
  onRow: (row: Row) => void;
}

/** Fetch one insights window synchronously, narrowing on data-volume errors (see file header). */
export async function metaAdsFetchInsightsWindowWithNarrowing<Row>(input: MetaAdsNarrowingInput<Row>): Promise<void> {
  const { window } = input;
  try {
    const pending: Row[] = [];
    await input.fetchPages(input.urlFor(window), (row) => pending.push(row));
    pending.forEach(input.onRow);
    return;
  } catch (error) {
    if (!input.isDataVolumeError(error)) throw error;
  }
  const narrower = metaAdsNarrowerWindows(window);
  if (narrower.length === 0) {
    (await input.finalRung(window, input.urlFor(window))).forEach(input.onRow);
    return;
  }
  for (const range of narrower) {
    await metaAdsFetchInsightsWindowWithNarrowing({ ...input, window: range });
  }
}

// ── Async report job ─────────────────────────────────────────────────────────────────────────────

export type MetaAdsAsyncInsightsStep = "submit" | "poll" | "results";

export interface MetaAdsAsyncInsightsPolicy {
  /** Hard cap on status polls (each is one budgeted Meta call). */
  maxPolls: number;
  /** First poll delay; doubles per poll up to maxPollDelayMs. */
  initialPollDelayMs: number;
  maxPollDelayMs: number;
  /** Wall-clock ceiling from submit to completed status. */
  timeoutMs: number;
  /** Result-edge page cap (fail loud, never truncate). */
  pageLimit: number;
  /** Result-edge page size. */
  resultPageSize: string;
}

// Worst case one job costs 1 + maxPolls + result pages calls. 10 polls with 2s→30s backoff covers
// ~3.5 min of Meta-side work for a single day, well inside the hosted 900s run wall.
export const META_ADS_ASYNC_INSIGHTS_DEFAULT_POLICY: MetaAdsAsyncInsightsPolicy = {
  maxPolls: 10,
  initialPollDelayMs: 2_000,
  maxPollDelayMs: 30_000,
  timeoutMs: 4 * 60_000,
  pageLimit: 1_000,
  resultPageSize: "500",
};

export interface MetaAdsAsyncInsightsDeps {
  /** Throttle-aware, budget-reserving fetch. `step` picks the telemetry request kind. */
  fetch: (url: string, init: RequestInit, step: MetaAdsAsyncInsightsStep) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Build the typed, retryable provider error the connector surfaces. */
  fail: (message: string) => Error;
}

interface MetaAdsReportRunStatus {
  async_status?: unknown;
  async_percent_completion?: unknown;
  error_code?: unknown;
  error_subcode?: unknown;
  error_message?: unknown;
}

const PENDING_STATUSES = new Set(["Job Not Started", "Job Started", "Job Running"]);
const FAILED_STATUSES = new Set(["Job Failed", "Job Skipped"]);

/**
 * Run ONE Meta async insights report: POST the same /insights query → poll the Ad Report Run →
 * page `/{report_run_id}/insights`. Returns every row only after the last page succeeded.
 *
 * Job Failed / Job Skipped / timeout → a RETRYABLE failure, no fallback: this runs only after the
 * synchronous edge already refused the same single day, so a sync retry is a guaranteed wasted call.
 * Nothing is committed, so the scheduler re-runs the window later (resumable), exactly like a
 * request-budget stop. The report_run_id is deliberately not persisted (Meta: expires in 30 days;
 * a fresh job on retry is simpler than a cross-run resume and costs one POST).
 */
export async function metaAdsRunAsyncInsightsJob<Row>(
  syncInsightsUrl: string,
  deps: MetaAdsAsyncInsightsDeps,
  policy: MetaAdsAsyncInsightsPolicy = META_ADS_ASYNC_INSIGHTS_DEFAULT_POLICY,
): Promise<Row[]> {
  const submit = new URL(syncInsightsUrl);
  const segments = submit.pathname.split("/").filter(Boolean);
  if (submit.hostname !== "graph.facebook.com" || segments.length !== 3 || segments[2] !== "insights") {
    throw deps.fail("Meta Ads async insights refused an unexpected submit URL");
  }
  const graphBase = `${submit.origin}/${segments[0]}`;
  // Paging params belong to the result edge, not the job definition.
  const pageSize = submit.searchParams.get("limit") ?? policy.resultPageSize;
  submit.searchParams.delete("limit");
  submit.searchParams.delete("after");

  const submitted = await (await deps.fetch(submit.toString(), { method: "POST", headers: { "Content-Type": "application/json" } }, "submit")).json() as { report_run_id?: unknown };
  const reportRunId = typeof submitted.report_run_id === "string" || typeof submitted.report_run_id === "number"
    ? String(submitted.report_run_id) : "";
  if (!/^\d+$/.test(reportRunId)) throw deps.fail("Meta Ads async insights submit returned no report_run_id");

  const startedAt = deps.now();
  let delay = policy.initialPollDelayMs;
  for (let poll = 0; ; poll += 1) {
    if (poll >= policy.maxPolls || deps.now() - startedAt >= policy.timeoutMs) {
      throw deps.fail(`Meta Ads async insights job ${reportRunId} did not complete within ${poll} polls / ${policy.timeoutMs}ms; the reporting window remains incomplete`);
    }
    await deps.sleep(delay);
    delay = Math.min(delay * 2, policy.maxPollDelayMs);
    const statusUrl = new URL(`${graphBase}/${reportRunId}`);
    statusUrl.searchParams.set("fields", "async_status,async_percent_completion,error_code,error_subcode,error_message");
    const status = await (await deps.fetch(statusUrl.toString(), { method: "GET", headers: { "Content-Type": "application/json" } }, "poll")).json() as MetaAdsReportRunStatus;
    const state = typeof status.async_status === "string" ? status.async_status : "";
    if (FAILED_STATUSES.has(state)) {
      const detail = [status.error_code, status.error_subcode].filter((v) => typeof v === "number").join("/");
      throw deps.fail(`Meta Ads async insights job ${reportRunId} ended ${state}${detail ? ` (${detail})` : ""}; the reporting window remains incomplete`);
    }
    // Meta: poll until async_status is Job Completed AND async_percent_completion is 100.
    if (state === "Job Completed" && status.async_percent_completion === 100) break;
    if (state !== "Job Completed" && !PENDING_STATUSES.has(state)) {
      throw deps.fail(`Meta Ads async insights job ${reportRunId} returned an unknown status`);
    }
  }

  const rows: Row[] = [];
  const first = new URL(`${graphBase}/${reportRunId}/insights`);
  first.searchParams.set("limit", pageSize);
  let next: string | null = first.toString();
  for (let page = 0; page < policy.pageLimit; page += 1) {
    if (!next) return rows;
    const body = await (await deps.fetch(next, { method: "GET", headers: { "Content-Type": "application/json" } }, "results")).json() as { data?: Row[]; paging?: { next?: string } };
    rows.push(...(body.data ?? []));
    next = body.paging?.next ?? null;
  }
  if (!next) return rows;
  throw deps.fail(`Meta Ads async insights results exceeded the ${policy.pageLimit}-page limit (refusing to truncate)`);
}
