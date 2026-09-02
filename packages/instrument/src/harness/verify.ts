// Live verification (teardown §4.2): load the production URL once as a self-identified
// automation agent, then ask each backend to read back a receipt for the lanes it can see.
// `verified` is only ever produced from a backend answer that carries a receipt timestamp.
// Standalone `infinite-tag harness` cannot read the cloud, so it runs with NoneBackend and says
// so; `infinite analytics` wires InfiniteCloudBackend; PosthogQueryBackend needs a founder-
// supplied personal key with Query Read and is optional.
import { derivePosthogRegionHosts } from "../providers/validate.js"
import { DEFAULT_SITE_FETCH_TIMEOUT_MS, SINCE_SKEW_MS, VERIFY_USER_AGENT } from "../server-lane/verify.js"

export type VerifyLane = "infinite" | "ga4" | "posthog" | "meta" | "server_lane"

export type LaneVerification =
  | { state: "verified"; receiptAt: string }
  | { state: "not_verifiable"; reason: string }
  | { state: "no_receipt"; causes: string[] }

export type LaneVerifications = Partial<Record<VerifyLane, LaneVerification>>

export interface VerifyInput {
  url: string
  /** ISO timestamp receipts must be newer than. */
  since: string
  lanes: VerifyLane[]
  log?: (line: string) => void
}

export interface VerificationBackend {
  name: string
  /** Lanes this backend can answer for. The composer asks it only about these. */
  lanes: VerifyLane[]
  verify(input: VerifyInput): Promise<LaneVerifications>
}

export const VERIFY_BUDGET_MS = 60_000
export const VERIFY_POLL_INTERVAL_MS = 3_000

export const NONE_BACKEND_REASON = "run infinite analytics from the desktop CLI to verify"
export const META_NOT_VERIFIABLE_REASON = "Meta has no install-time read-back; open Events Manager → Test Events"
export const NO_BACKEND_REASON = "no backend can read this lane back"
export const SUBSCRIPTION_REQUIRED_REASON = "subscription required — complete onboarding in Infinite Desktop"
export const SUBSCRIPTION_CHECK_UNAVAILABLE_REASON = "subscription check unavailable, try again"
export const RATE_LIMITED_REASON = "rate limited by the cloud; try again in a minute"
export const RETRY_AFTER_CAP_MS = 30_000
/** The running app is too old to carry `analytics.verify.v1` — a version skew, not a failure. */
export const DESKTOP_UPDATE_REQUIRED_REASON =
  "this Infinite Desktop version cannot verify — update the Infinite app"

/** 409 `not_ready`: the desktop refused BEFORE spending a cloud read, and named the exact blocker
 *  (`signed_out` / `no_linked_workspace` / `subscription_required` / `no_provider` / `booting`). */
export function desktopNotReadyReason(state: string): string {
  return `Infinite Desktop is not ready (${state}) — complete onboarding`
}

/** `Retry-After` as delay-seconds or an HTTP date, in ms from `nowMs`; null when absent/unparseable. */
export function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000
  const date = Date.parse(trimmed)
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null
}

interface Timing {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  budgetMs?: number
  pollIntervalMs?: number
}

function timing(options: Timing) {
  return {
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms))),
    budgetMs: options.budgetMs ?? VERIFY_BUDGET_MS,
    pollIntervalMs: options.pollIntervalMs ?? VERIFY_POLL_INTERVAL_MS
  }
}

function budgetCauses(budgetMs: number, lane: string): string[] {
  return [
    `No ${lane} event arrived within ${Math.round(budgetMs / 1000)}s.`,
    "this check loads the page without running JavaScript — open the URL in a real browser during the poll window so browser tags fire",
    "not deployed yet (the receipt is read from production, not from your working tree)",
    "edge/WAF refused the automation user agent",
    "a consent gate is blocking the tag",
    "the deployed environment carries a different key"
  ]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Standalone mode: nothing can be read back, and the report says exactly that. */
export class NoneBackend implements VerificationBackend {
  readonly name = "none"
  readonly lanes: VerifyLane[] = ["infinite", "ga4", "posthog", "meta", "server_lane"]
  async verify(input: VerifyInput): Promise<LaneVerifications> {
    const out: LaneVerifications = {}
    for (const lane of input.lanes) out[lane] = { state: "not_verifiable", reason: NONE_BACKEND_REASON }
    return out
  }
}

export interface InfiniteCloudBackendOptions extends Timing {
  /** e.g. https://api.ultima.inc — the verify route is `${origin}/api/analytics/verify`. */
  origin: string
  /** Bearer token for the founder's cloud session. Never logged, never written. */
  token: string
  engineProjectId: string
  fetch?: typeof fetch
}

export interface DesktopBridgeBackendOptions extends Timing {
  /** The running desktop's loopback bridge origin, from `bridge.json` (never a public host). */
  bridgeUrl: string
  /** The descriptor's LOCAL bridge bearer — not a cloud credential. Never logged, never written. */
  token: string
  fetch?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** One lane's answer from the cloud, decoded honestly: `verified` needs a receipt timestamp. */
function decodeCloudLane(raw: unknown): LaneVerification | null {
  if (!isRecord(raw) || typeof raw.state !== "string") return null
  if (raw.state === "verified") {
    return typeof raw.receiptAt === "string" && raw.receiptAt.trim() !== ""
      ? { state: "verified", receiptAt: raw.receiptAt }
      : { state: "not_verifiable", reason: "the cloud answered verified without a receipt timestamp" }
  }
  if (raw.state === "not_verifiable") {
    return { state: "not_verifiable", reason: typeof raw.reason === "string" ? raw.reason : "not verifiable" }
  }
  if (raw.state === "no_receipt") {
    return { state: "no_receipt", causes: typeof raw.reason === "string" ? [raw.reason] : [] }
  }
  return null
}

/**
 * The error CODE across the shapes this endpoint family answers with: the cloud route's
 * `{ error: "host_not_registered" }`, the desktop bridge's protocol fault `{ error: { code } }`,
 * and the bridge's own service refusals `{ error: "cloud_unavailable", message }`.
 */
function errorCodeOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const error = payload.error
  if (typeof error === "string" && error) return error
  if (isRecord(error) && typeof error.code === "string" && error.code) return error.code
  return undefined
}

function errorReasonOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  if (typeof payload.reason === "string" && payload.reason) return payload.reason
  const error = payload.error
  if (isRecord(error) && typeof error.message === "string" && error.message) return error.message
  if (typeof payload.message === "string" && payload.message) return payload.message
  return undefined
}

/** Per-peer wording. Every string a founder reads names WHO refused, so the next move is obvious. */
interface VerifyPeerCopy {
  unreachable(detail: string): string
  rejected(status: number): string
  routeMissing: string
  unexpectedShape: string
  unavailable(status: number): string
  badRequest(code: string, reason: string | undefined): string
}

interface VerifyPollConfig extends Timing {
  endpoint: string
  headers: Record<string, string>
  body(lanes: VerifyLane[]): Record<string, unknown>
  copy: VerifyPeerCopy
  fetch?: typeof fetch
  /** Peer-specific TERMINAL answers, consulted before the shared ladder (the bridge's 409/503s). */
  terminal?(status: number, payload: unknown): string | null
}

const CLOUD_COPY: VerifyPeerCopy = {
  unreachable: (detail) => `the cloud was unreachable (${detail})`,
  rejected: (status) => `the cloud rejected this session (HTTP ${status})`,
  routeMissing: "the cloud verify route is not available yet (HTTP 404)",
  unexpectedShape: "the cloud verify route answered with an unexpected shape",
  unavailable: (status) => `the cloud verify route was unavailable (HTTP ${status})`,
  badRequest: (code, reason) => `the cloud rejected the request: ${code}${reason ? ` — ${reason}` : ""}`
}

const BRIDGE_COPY: VerifyPeerCopy = {
  unreachable: (detail) => `the Infinite app was unreachable (${detail})`,
  rejected: (status) =>
    `the Infinite app rejected this terminal's bridge credentials (HTTP ${status}) — restart the app and re-run`,
  routeMissing: DESKTOP_UPDATE_REQUIRED_REASON,
  unexpectedShape: "the Infinite app answered with an unexpected shape",
  unavailable: (status) => `the Infinite app could not serve verification (HTTP ${status})`,
  badRequest: (code, reason) => `the Infinite app rejected the request: ${code}${reason ? ` — ${reason}` : ""}`
}

/** Trim trailing "/" without a regex: these origins are caller-supplied, and `/\/+$/` on a long
 *  run of slashes is a polynomial-backtracking hazard (CodeQL js/polynomial-redos). */
function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1
  return value.slice(0, end)
}

/** Read a response body ONCE, leniently: a 429/503 with an empty body is normal, not an outage. */
async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "")
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/**
 * The one poll loop both backends ride: POST the lanes still pending, decode each answer, and keep
 * asking until every lane settles or the budget runs out. The wire contract is the CLOUD's
 * (`{lanes: Record<lane, {state, receiptAt?, reason?}>}`) whichever peer answers it, because the
 * desktop bridge forwards the cloud's status and body verbatim.
 */
async function pollVerifyEndpoint(input: VerifyInput, config: VerifyPollConfig): Promise<LaneVerifications> {
  const fetchImpl = config.fetch ?? globalThis.fetch
  const { now, sleep, budgetMs, pollIntervalMs } = timing(config)
  const settled: LaneVerifications = {}
  const pending = new Set<VerifyLane>(input.lanes)
  const startedAt = now()
  let unavailableStreak = 0

  const failAll = (reason: string): LaneVerifications => {
    for (const lane of pending) settled[lane] = { state: "not_verifiable", reason }
    return settled
  }

  for (;;) {
    let response: Response
    try {
      response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: config.headers,
        body: JSON.stringify(config.body([...pending]))
      })
    } catch (error) {
      return failAll(config.copy.unreachable(errorText(error)))
    }
    const payload = await readPayload(response)

    const terminal = config.terminal?.(response.status, payload)
    if (terminal) return failAll(terminal)

    if (response.status === 401 || response.status === 403) {
      return failAll(config.copy.rejected(response.status))
    }
    if (response.status === 402) {
      // requireActiveSubscriptionOr402 — body `{ error: "entitlement_required",
      // code: "NO_PLATFORM_SUBSCRIPTION", feature: "platform", action: { type: "upgrade" } }`.
      // The founder can install, and nothing else runs until the subscription is active. Not a
      // missing receipt and never retried — a gate, and it says so.
      return failAll(SUBSCRIPTION_REQUIRED_REASON)
    }
    if (response.status === 404) {
      return failAll(config.copy.routeMissing)
    }
    if (response.status === 400) {
      // The typed 400s (`host_not_registered`, `invalid_request` + reason) are answers, not
      // outages: quoted verbatim, never retried.
      return failAll(config.copy.badRequest(errorCodeOf(payload) ?? "invalid_request", errorReasonOf(payload)))
    }
    if (response.status === 429) {
      // Rate limited: honour Retry-After (capped at 30 s) inside the same 60 s budget, then say so.
      const retryAfter = retryAfterMs(response.headers.get("retry-after"), now())
      const wait = Math.min(retryAfter ?? pollIntervalMs, RETRY_AFTER_CAP_MS)
      if (now() - startedAt + wait > budgetMs) return failAll(RATE_LIMITED_REASON)
      await sleep(wait)
      continue
    }
    if (!response.ok) {
      // `subscription_check_unavailable` (503, retryable: true) is the entitlement check being
      // down, not the route: it stays on the retry loop and then names itself.
      const subscriptionCheckDown = errorCodeOf(payload) === "subscription_check_unavailable"
      unavailableStreak += 1
      if (unavailableStreak >= 3) {
        return failAll(
          subscriptionCheckDown ? SUBSCRIPTION_CHECK_UNAVAILABLE_REASON : config.copy.unavailable(response.status)
        )
      }
    } else {
      unavailableStreak = 0
      const lanes = isRecord(payload) && isRecord(payload.lanes) ? payload.lanes : null
      if (!lanes) return failAll(config.copy.unexpectedShape)
      for (const lane of [...pending]) {
        const decoded = decodeCloudLane(lanes[lane])
        if (decoded && decoded.state !== "no_receipt") {
          settled[lane] = decoded
          pending.delete(lane)
        }
      }
    }
    if (pending.size === 0) return settled
    if (now() - startedAt + pollIntervalMs > budgetMs) break
    await sleep(pollIntervalMs)
  }
  for (const lane of pending) settled[lane] = { state: "no_receipt", causes: budgetCauses(budgetMs, lane) }
  return settled
}

/**
 * Client for the cloud's `POST /api/analytics/verify` (contract: bearer auth; body
 * `{engineProjectId, url, since, lanes}`; response `{lanes: Record<lane, {state, receiptAt?, reason?}>}`).
 *
 * ADVANCED / ESCAPE HATCH: it needs a cloud bearer in the CLI's own hands, which the companion
 * design deliberately avoids. Prefer {@link DesktopBridgeBackend} — the running app makes this same
 * call with its own session and no token ever reaches the terminal.
 */
export class InfiniteCloudBackend implements VerificationBackend {
  readonly name = "infinite-cloud"
  readonly lanes: VerifyLane[] = ["infinite", "ga4", "posthog", "meta", "server_lane"]
  private readonly options: InfiniteCloudBackendOptions

  constructor(options: InfiniteCloudBackendOptions) {
    this.options = options
  }

  async verify(input: VerifyInput): Promise<LaneVerifications> {
    return pollVerifyEndpoint(input, {
      ...this.options,
      endpoint: `${stripTrailingSlashes(this.options.origin)}/api/analytics/verify`,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: (lanes) => ({
        engineProjectId: this.options.engineProjectId,
        url: input.url,
        since: input.since,
        lanes
      }),
      copy: CLOUD_COPY
    })
  }
}

/**
 * Verification through the RUNNING DESKTOP — the default for `infinite analytics`.
 *
 * The CLI holds no cloud session by design (the companion train): it POSTs to the desktop's
 * loopback bridge (`analytics.verify.v1`, 1bu-1
 * apps/desktop/src/main/brain/agent/analytics-verify-bridge.ts), and the desktop — which holds the
 * session and knows the ACTIVE workspace — makes the cloud call and returns its status and body
 * verbatim. The founder never handles a token, and this class never sees one: `token` here is the
 * LOCAL bridge bearer from `bridge.json`, useless anywhere but this machine's loopback port.
 *
 * The one shape the cloud cannot produce is 409 `not_ready`: the desktop refusing BEFORE it spends
 * a cloud read, because it is signed out / unlinked / unsubscribed / still booting. That is a
 * gate, not a missing receipt, and it names the exact state so the founder knows what to fix.
 */
export class DesktopBridgeBackend implements VerificationBackend {
  readonly name = "infinite-desktop"
  readonly lanes: VerifyLane[] = ["infinite", "ga4", "posthog", "meta", "server_lane"]
  private readonly options: DesktopBridgeBackendOptions

  constructor(options: DesktopBridgeBackendOptions) {
    this.options = options
  }

  async verify(input: VerifyInput): Promise<LaneVerifications> {
    return pollVerifyEndpoint(input, {
      ...this.options,
      endpoint: `${stripTrailingSlashes(this.options.bridgeUrl)}/v1/analytics/verify`,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: (lanes) => ({ protocolVersion: 1, url: input.url, since: input.since, lanes }),
      copy: BRIDGE_COPY,
      terminal: (status, payload) => {
        if (status === 409) {
          const state = isRecord(payload) && typeof payload.state === "string" && payload.state ? payload.state : "not ready"
          return desktopNotReadyReason(state)
        }
        if (status === 503) {
          const code = errorCodeOf(payload)
          if (code === "capability_unavailable") return DESKTOP_UPDATE_REQUIRED_REASON
          // The bridge's OWN refusals are terminal — retrying cannot change a signed-out app or an
          // unlinked workspace. A FORWARDED cloud 503 (subscription_check_unavailable) is not
          // handled here, so it keeps the shared retry ladder.
          if (code === "cloud_unavailable" || code === "no_linked_workspace" || code === "service_unavailable") {
            return errorReasonOf(payload) ?? BRIDGE_COPY.unavailable(status)
          }
        }
        return null
      }
    })
  }
}

export interface PosthogQueryBackendOptions extends Timing {
  /** The ingestion/api host the tag was installed with; the app host is derived from its region. */
  apiHost: string
  /** Personal API key with Query Read. Optional: without it the lane is `not verifiable (no query key)`. */
  queryKey: string | undefined
  /** PostHog project id; `@current` resolves to the key's project. */
  projectId?: string
  fetch?: typeof fetch
}

export const POSTHOG_PAGEVIEW_QUERY =
  "select timestamp from events where event = '$pageview' and timestamp > toDateTime({since}) order by timestamp desc limit 1"

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null
  const parsed = Date.parse(value.replace(" ", "T"))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

/** One bounded HogQL poll (posthog.com/docs/api/queries) — ad-hoc use, never an export. */
export class PosthogQueryBackend implements VerificationBackend {
  readonly name = "posthog-query"
  readonly lanes: VerifyLane[] = ["posthog"]
  private readonly options: PosthogQueryBackendOptions

  constructor(options: PosthogQueryBackendOptions) {
    this.options = options
  }

  async verify(input: VerifyInput): Promise<LaneVerifications> {
    if (!input.lanes.includes("posthog")) return {}
    if (!this.options.queryKey) return { posthog: { state: "not_verifiable", reason: "no query key" } }
    const fetchImpl = this.options.fetch ?? globalThis.fetch
    const { now, sleep, budgetMs, pollIntervalMs } = timing(this.options)
    const { uiHost } = derivePosthogRegionHosts(this.options.apiHost)
    const endpoint = `${uiHost.replace(/\/+$/, "")}/api/projects/${this.options.projectId ?? "@current"}/query/`
    const startedAt = now()
    let unavailableStreak = 0
    for (;;) {
      let response: Response
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.queryKey}`,
            "content-type": "application/json",
            accept: "application/json"
          },
          body: JSON.stringify({
            query: { kind: "HogQLQuery", query: POSTHOG_PAGEVIEW_QUERY, values: { since: input.since } }
          })
        })
      } catch (error) {
        return { posthog: { state: "not_verifiable", reason: `PostHog was unreachable (${errorText(error)})` } }
      }
      if (response.status === 401 || response.status === 403) {
        return {
          posthog: {
            state: "not_verifiable",
            reason: `PostHog rejected the query key (HTTP ${response.status}) — it needs the Query Read scope`
          }
        }
      }
      if (!response.ok) {
        unavailableStreak += 1
        if (unavailableStreak >= 3) {
          return { posthog: { state: "not_verifiable", reason: `PostHog's query API was unavailable (HTTP ${response.status})` } }
        }
      } else {
        unavailableStreak = 0
        const payload: unknown = await response.json().catch(() => null)
        const results = isRecord(payload) && Array.isArray(payload.results) ? payload.results : []
        const first = Array.isArray(results[0]) ? results[0][0] : undefined
        const receiptAt = normalizeTimestamp(first)
        if (receiptAt) return { posthog: { state: "verified", receiptAt } }
      }
      if (now() - startedAt + pollIntervalMs > budgetMs) break
      await sleep(pollIntervalMs)
    }
    return { posthog: { state: "no_receipt", causes: budgetCauses(budgetMs, "posthog") } }
  }
}

export interface VerifyLanesInput extends Timing {
  url: string
  lanes: VerifyLane[]
  backends: VerificationBackend[]
  fetch?: typeof fetch
  log?: (line: string) => void
}

export interface VerifyLanesResult {
  url: string
  since: string
  siteStatus: number | null
  lanes: Record<VerifyLane, LaneVerification>
}

/**
 * Fire once, then read back per lane. The page is loaded as `infinite-tag-verify` so the
 * customer's own numbers record a flagged agent row, never a visitor. Lanes no backend covers
 * are `not_verifiable`, Meta always is, and a site that cannot be loaded is reported as the
 * cause instead of pretending to poll.
 */
export async function verifyLanes(input: VerifyLanesInput): Promise<VerifyLanesResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch
  const { now } = timing(input)
  const log = input.log ?? (() => undefined)
  const since = new Date(now() - SINCE_SKEW_MS).toISOString()
  const lanes = {} as Record<VerifyLane, LaneVerification>

  log(`Loading ${input.url} once as ${VERIFY_USER_AGENT} …`)
  let siteStatus: number | null = null
  let loadError: string | null = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_SITE_FETCH_TIMEOUT_MS)
    try {
      const response = await fetchImpl(input.url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "user-agent": VERIFY_USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9"
        },
        signal: controller.signal
      })
      siteStatus = response.status
      await response.text().catch(() => "")
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    loadError = errorText(error)
  }

  if (loadError !== null) {
    for (const lane of input.lanes) {
      lanes[lane] = { state: "no_receipt", causes: [`the site could not be loaded (${loadError})`] }
    }
    return { url: input.url, since, siteStatus, lanes }
  }

  for (const lane of input.lanes) {
    if (lane === "meta") lanes[lane] = { state: "not_verifiable", reason: META_NOT_VERIFIABLE_REASON }
  }
  const remaining = input.lanes.filter((lane) => lane !== "meta")
  for (const backend of input.backends) {
    const asked = remaining.filter((lane) => backend.lanes.includes(lane) && lanes[lane] === undefined)
    if (asked.length === 0) continue
    log(`Polling ${backend.name} for ${asked.join(", ")} …`)
    const answers = await backend.verify({ url: input.url, since, lanes: asked, log })
    for (const lane of asked) {
      const answer = answers[lane]
      if (!answer) continue
      // Belt and braces: a backend can never mint `verified` without a receipt timestamp.
      lanes[lane] =
        answer.state === "verified" && (!answer.receiptAt || answer.receiptAt.trim() === "")
          ? { state: "not_verifiable", reason: `${backend.name} answered verified without a receipt timestamp` }
          : answer
    }
  }
  for (const lane of remaining) {
    if (lanes[lane] === undefined) lanes[lane] = { state: "not_verifiable", reason: NO_BACKEND_REASON }
  }
  return { url: input.url, since, siteStatus, lanes }
}
