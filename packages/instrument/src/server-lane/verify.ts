// `infinite-tag verify --server-lane <url>` — the network check.
//
// 1. GET the customer's URL, identified as automation, so their middleware records ONE document
//    request — the only way to prove their middleware is actually running — noting the time first.
// 2. Poll Infinite's receipt endpoint with the SAME source headers (source key + HMAC signature)
//    until it reports at least one server-lane event since that time, or the budget runs out.
// 3. Report PASS with received / lastPath / lastReceivedAt, or FAIL with the most likely cause.
//
// The secret is read from the environment by the CLI and never persisted. Everything network-shaped
// is injectable so the tests run against a mocked fetch.
import { INSTRUMENT_VERSION } from "../package-manager.js"
import { INFINITE_SERVER_LANE_RECEIPT_URL } from "../workspace-artifacts.js"

import { serverLaneCopy } from "./copy.js"
import {
  SERVER_LANE_SIGNATURE_HEADER,
  SERVER_LANE_SOURCE_KEY_HEADER,
  hmacHex
} from "./helpers.js"

/**
 * The check's user agent — deliberately NOT a browser.
 *
 * verify used to send a current Chrome UA so the customer's middleware would record the page load.
 * It did — as a HUMAN visit. Every run wrote one fabricated person into the customer's own numbers,
 * on the very lane whose honesty is the product, and did it silently on the first run. The recorded
 * `userAgentFamily` is derived from this exact string by `classifyUserAgent`, and the receiving side
 * maps `browser` to a human row and `automation` to a flagged agent row, so the whole fix is to stop
 * lying in the string.
 *
 * TWO properties are load-bearing here, both pinned in verify.test.ts against the package's own
 * helpers — change the string only together with those assertions:
 *   1. It classifies as `automation` (the `monitor` token matches AUTOMATION_USER_AGENT_PATTERN), so
 *      the row lands in the agent bucket instead of inflating visits.
 *   2. It still satisfies `isDocumentRequest` (runtime-source.ts): the family is a recorded PROPERTY,
 *      never a gate, so the document event — and therefore the receipt this check waits for — still
 *      fires. See the note on `Purpose: prefetch` at the page load below.
 *
 * The stable product token leads so a customer allowlisting it in a WAF is not broken by a version
 * bump, and the URL gives whoever reads their logs somewhere to go.
 */
export const VERIFY_USER_AGENT = `infinite-tag-verify/${INSTRUMENT_VERSION} (+https://infinite.fast; server-lane monitor)`

/** Edge/WAF answers that mean the probe was refused rather than the page being broken. */
const BOT_PROTECTION_STATUSES = new Set([401, 403, 405, 406, 429])

export const DEFAULT_VERIFY_BUDGET_MS = 60_000
export const DEFAULT_VERIFY_POLL_INTERVAL_MS = 3_000
export const DEFAULT_SITE_FETCH_TIMEOUT_MS = 15_000
/** How far before the page load `since` is set, to absorb clock skew between us and Infinite. */
export const SINCE_SKEW_MS = 5_000

/** The receipt request's raw query string — the exact bytes after "?" — built in one place. */
export function receiptQueryString(since: string): string {
  return `since=${encodeURIComponent(since)}`
}

/**
 * The receipt request signature: hex HMAC-SHA256 over the RAW QUERY STRING (a GET has no body, so
 * the query is the signed message — byte-for-byte as sent). Aligned with the receiving side
 * (the receiving side's `GET /api/analytics/site/server-lane/receipt`, 2026-08-18). ONE place: if the receiving
 * side ever changes what it signs, change only this function.
 */
export function receiptRequestSignature(secret: string, since: string): string {
  return hmacHex(secret, receiptQueryString(since))
}

export interface ReceiptSummary {
  received: number
  lastPath: string | null
  lastReceivedAt: string | null
}

/** Lenient decode of the receipt payload — one place to align field names with the receiving side. */
export function parseReceipt(payload: unknown): ReceiptSummary | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const receivedRaw = record.received ?? record.count ?? record.receivedCount
  const received =
    typeof receivedRaw === "number" && Number.isFinite(receivedRaw)
      ? receivedRaw
      : typeof receivedRaw === "boolean"
        ? receivedRaw
          ? 1
          : 0
        : null
  if (received === null) return null
  const lastPath = record.lastPath ?? record.last_path
  const lastReceivedAt = record.lastReceivedAt ?? record.last_received_at ?? record.lastAt
  return {
    received,
    lastPath: typeof lastPath === "string" ? lastPath : null,
    lastReceivedAt: typeof lastReceivedAt === "string" ? lastReceivedAt : null
  }
}

export interface VerifyServerLaneOptions {
  url: string
  secret: string | undefined
  sourceKey: string | undefined
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  budgetMs?: number
  pollIntervalMs?: number
  receiptUrl?: string
  log?: (line: string) => void
}

export interface VerifyServerLaneResult {
  ok: boolean
  url: string
  since: string
  siteStatus: number | null
  received: number
  lastPath: string | null
  lastReceivedAt: string | null
  /** FAIL only: the most likely cause first, then the others worth checking. */
  causes: string[]
  /** Machine-readable failure class. */
  failure?:
    | "missing_secret"
    | "missing_source_key"
    | "site_unreachable"
    | "unauthorized"
    | "receipt_unavailable"
    | "no_receipt"
}

export async function verifyServerLane(options: VerifyServerLaneOptions): Promise<VerifyServerLaneResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)))
  const log = options.log ?? (() => undefined)
  const budgetMs = options.budgetMs ?? DEFAULT_VERIFY_BUDGET_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_VERIFY_POLL_INTERVAL_MS
  const receiptUrl = options.receiptUrl ?? INFINITE_SERVER_LANE_RECEIPT_URL

  const base: VerifyServerLaneResult = {
    ok: false,
    url: options.url,
    since: new Date(now() - SINCE_SKEW_MS).toISOString(),
    siteStatus: null,
    received: 0,
    lastPath: null,
    lastReceivedAt: null,
    causes: []
  }

  if (!options.secret) {
    return { ...base, failure: "missing_secret", causes: [serverLaneCopy.verifyCli.causes.missingSecret] }
  }
  if (!options.sourceKey) {
    return { ...base, failure: "missing_source_key", causes: [serverLaneCopy.verifyCli.causes.missingSourceKey] }
  }
  const secret = options.secret
  const sourceKey = options.sourceKey

  log(serverLaneCopy.verifyCli.loading(options.url))
  let siteStatus: number | null = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_SITE_FETCH_TIMEOUT_MS)
    try {
      // DELIBERATELY NOT SENT: `Purpose: prefetch`. `isDocumentRequest()` rejects a prefetch before
      // anything else (runtime-source.ts), so that header would suppress the very document event the
      // receipt poll below waits for — verify would then fail for every correctly-installed
      // customer, which is a worse lie than the one being fixed. The other option considered was an
      // explicitly-synthetic header the middleware recognises; it needs a runtime-source change AND
      // a receiving-side rule, and would break verify against every middleware already deployed at
      // the current version. So the check keeps producing a real row — it IS a real request, and
      // hiding it would be its own dishonesty — and simply files it as what it is: automation.
      const response = await fetchImpl(options.url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "user-agent": VERIFY_USER_AGENT,
          // REQUIRED, not decoration: `isDocumentRequest()` drops anything whose Accept omits
          // text/html, and then no document event — and no receipt — could ever exist.
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          // Kept so i18n sites serve their normal document instead of a locale edge case. It is not
          // what made this row look human; the user agent was.
          "accept-language": "en-US,en;q=0.9"
        },
        signal: controller.signal
      })
      siteStatus = response.status
      // Drain the body so keep-alive connections are released; content is irrelevant.
      await response.text().catch(() => "")
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return {
      ...base,
      failure: "site_unreachable",
      causes: [
        serverLaneCopy.verifyCli.causes.siteUnreachable(
          error instanceof Error ? error.message : String(error)
        )
      ]
    }
  }

  log(serverLaneCopy.verifyCli.polling(Math.round(budgetMs / 1000)))
  const startedAt = now()
  let unavailableStreak = 0
  let lastUnavailableStatus = 0
  for (;;) {
    let response: Response
    try {
      response = await fetchImpl(`${receiptUrl}?${receiptQueryString(base.since)}`, {
        method: "GET",
        headers: {
          accept: "application/json",
          [SERVER_LANE_SOURCE_KEY_HEADER]: sourceKey,
          [SERVER_LANE_SIGNATURE_HEADER]: receiptRequestSignature(secret, base.since)
        }
      })
    } catch {
      response = new Response(null, { status: 599 })
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ...base,
        siteStatus,
        failure: "unauthorized",
        causes: [serverLaneCopy.verifyCli.causes.unauthorized]
      }
    }
    if (response.ok) {
      unavailableStreak = 0
      const summary = parseReceipt(await response.json().catch(() => null))
      if (summary && summary.received > 0) {
        return {
          ...base,
          ok: true,
          siteStatus,
          received: summary.received,
          lastPath: summary.lastPath,
          lastReceivedAt: summary.lastReceivedAt
        }
      }
    } else {
      unavailableStreak += 1
      lastUnavailableStatus = response.status
      if (unavailableStreak >= 3) {
        return {
          ...base,
          siteStatus,
          failure: "receipt_unavailable",
          causes: [serverLaneCopy.verifyCli.causes.receiptUnavailable(lastUnavailableStatus)]
        }
      }
    }

    if (now() - startedAt + pollIntervalMs > budgetMs) break
    await sleep(pollIntervalMs)
  }

  const causes: string[] = [...serverLaneCopy.verifyCli.causes.noReceipt]
  if (siteStatus !== null && BOT_PROTECTION_STATUSES.has(siteStatus)) {
    // The failure mode the honest user agent introduces: a WAF that would have waved a Chrome
    // string through refuses a self-identified monitor. Naming it first stops the customer from
    // hunting a middleware bug that isn't there.
    causes.unshift(serverLaneCopy.verifyCli.causes.botProtection(siteStatus, VERIFY_USER_AGENT))
  } else if (siteStatus !== null && (siteStatus < 200 || siteStatus >= 300)) {
    causes.unshift(serverLaneCopy.verifyCli.causes.siteUnreachable(`HTTP ${siteStatus}`))
  }
  return { ...base, siteStatus, failure: "no_receipt", causes }
}

/** Human rendering for the CLI. */
export function renderServerLaneVerify(result: VerifyServerLaneResult): string {
  const lines = ["", serverLaneCopy.verifyCli.header, ""]
  if (result.ok) {
    lines.push(`✅ ${serverLaneCopy.verifyCli.pass(result.received, result.lastPath, result.lastReceivedAt)}`)
  } else {
    lines.push(`❌ ${serverLaneCopy.verifyCli.fail}`)
    if (result.siteStatus !== null) {
      lines.push(`  Site responded HTTP ${result.siteStatus}; receipts checked since ${result.since}.`)
    }
    if (result.causes.length > 0) {
      lines.push("", serverLaneCopy.verifyCli.likelyCause)
      lines.push(...result.causes.map((cause, index) => `  ${index === 0 ? "•" : "·"} ${cause}`))
    }
  }
  lines.push("")
  return lines.join("\n")
}
