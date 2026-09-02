// Sending the run report to Infinite — so the desktop's Site Settings can show the stack the
// harness found (GA4 · PostHog · Meta · Infinite pixel · Server lane: state, evidence,
// verification), instead of a founder reading `.infinite/REPORT.md` by hand.
//
// THREE SINKS, ONE INTERFACE, chosen by the CLI (apps/cli commands/analytics.ts, `chooseReportSink`)
// in the same order as verification:
//   1. DesktopBridgeReportSink — the running Infinite app (loopback verb `analytics.report.v1`,
//      1bu-1 apps/desktop/src/main/brain/agent/analytics-report-bridge.ts) makes the cloud call
//      with its own session and the ACTIVE workspace. No token ever reaches the terminal.
//   2. CloudReportSink — ADVANCED, only behind an explicit `--api-token-env` (CI, no Desktop).
//   3. NoneReportSink — nothing to send to; the reason names the one thing to change.
// Standalone `npx infinite-tag harness` wires no sink at all: it is the open-source installer
// and has no Infinite session.
//
// THE PAYLOAD IS THE STATE TABLE AND NOTHING ELSE. Bounded strings only: a state word, one
// evidence clause, one app-root-relative file path, one verification word plus a receipt
// timestamp or a reason. Never file contents, never DOM text, never a query string, never a
// key — provider ids that the harness quotes in a conflict clause are redacted here — and the
// cloud re-bounds and rejects anything outside the vocabulary (400). The report never fails
// the run: a send that does not land prints its reason and moves on.
import type { HarnessProviderId, HarnessReport, ProviderState, ProviderStateKind } from "./types.js"
import { DESKTOP_UPDATE_REQUIRED_REASON, desktopNotReadyReason } from "./verify.js"

/** Every string the payload carries is cut here; the cloud cuts at the same length. */
export const REPORT_STRING_MAX = 200

export type ReportVerificationState = "not_run" | "verified" | "not_verifiable" | "no_receipt" | "adopted_not_ours"

export interface HarnessReportProviderPayload {
  state: ProviderStateKind
  /** One clause: why this state ("written this run; hash-verified …", "left byte-for-byte alone"). */
  via?: string
  /** App-root-relative file the state rests on. Never an absolute path, never contents. */
  evidenceFile?: string
  verification: {
    state: ReportVerificationState
    receiptAt?: string
    reason?: string
  }
  nextAction?: string
}

export interface HarnessReportPayload {
  /** The workspace the CLOUD sink reports to. The desktop bridge ignores it and uses the app's
   *  ACTIVE workspace, so a report can never land on a workspace the app is not signed into. */
  engineProjectId: string
  ranAt: string
  tagVersion: string
  framework: string | null
  hosting: string | null
  providers: Partial<Record<HarnessProviderId, HarnessReportProviderPayload>>
  /** The repo's directory name — a label, not a path. */
  repoLabel?: string
}

export type ReportSendResult = { sent: true } | { sent: false; reason: string }

export interface ReportSink {
  name: string
  send(payload: HarnessReportPayload): Promise<ReportSendResult>
}

/** No Desktop running: the one thing to change is to open it. */
export const NO_DESKTOP_REPORT_REASON = "open the Infinite app and re-run to report"
export const REPORT_SENT_LINE = "Report sent to Infinite."
export function reportNotSentLine(reason: string): string {
  return `Report not sent (${reason}).`
}

function bound(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  return trimmed.length > REPORT_STRING_MAX ? `${trimmed.slice(0, REPORT_STRING_MAX - 1)}…` : trimmed
}

/**
 * Provider ids the harness quotes in its own clauses (a conflict names both ids it found) never
 * leave the machine: GA4 / GTM / GT measurement ids, PostHog project keys, and the 15–16 digit
 * Meta pixel ids. The local REPORT.md keeps them; the cloud and the strip see `<id>`.
 */
const PROVIDER_ID_PATTERN = /\b(?:G-[A-Z0-9]{4,}|GTM-[A-Z0-9]{4,}|GT-[A-Z0-9]{4,}|phc_[A-Za-z0-9]+|\d{15,16})\b/g
export function redactProviderIds(value: string): string {
  return value.replace(PROVIDER_ID_PATTERN, "<id>")
}

function boundClause(value: string | undefined): string | undefined {
  return value === undefined ? undefined : bound(redactProviderIds(value))
}

/** An evidence clause is a FILE only when it looks like one: relative, no spaces, has a dot or slash. */
function looksLikeFile(evidence: string): boolean {
  return !evidence.startsWith("/") && !/\s/.test(evidence) && /[./]/.test(evidence)
}

function providerPayload(state: ProviderState): HarnessReportProviderPayload {
  const out: HarnessReportProviderPayload = { state: state.state, verification: { state: "not_run" } }
  const via = boundClause(state.reason)
  if (via !== undefined) out.via = via
  const evidence = bound(state.evidence)
  if (evidence !== undefined) {
    if (looksLikeFile(evidence)) out.evidenceFile = evidence
    else if (out.via === undefined) out.via = boundClause(evidence)
  }
  const verification = state.verification
  switch (verification.kind) {
    case "verified":
      // Belt and braces with state.ts: the word never travels without its timestamp.
      out.verification = verification.receiptAt.trim() !== ""
        ? { state: "verified", receiptAt: verification.receiptAt }
        : { state: "not_verifiable", reason: "verified without a receipt timestamp" }
      break
    case "not_verifiable":
      out.verification = { state: "not_verifiable", reason: boundClause(verification.reason) ?? "not verifiable" }
      break
    case "no_receipt": {
      const reason = boundClause(verification.causes[0])
      out.verification = reason ? { state: "no_receipt", reason } : { state: "no_receipt" }
      break
    }
    case "adopted_not_ours":
      out.verification = { state: "adopted_not_ours" }
      break
    case "not_run":
      out.verification = { state: "not_run" }
      break
  }
  return out
}

/**
 * The wire shape of one run: seven provider rows reduced to bounded words. `ranAt` is the run's
 * start (the moment the tree was inspected), not when the send happens.
 */
export function buildHarnessReportPayload(
  report: HarnessReport,
  input: { engineProjectId: string; tagVersion: string; repoLabel?: string }
): HarnessReportPayload {
  const providers: HarnessReportPayload["providers"] = {}
  for (const state of report.providers) providers[state.provider] = providerPayload(state)
  const repoLabel = bound(input.repoLabel)
  return {
    engineProjectId: input.engineProjectId,
    ranAt: report.startedAt,
    tagVersion: input.tagVersion,
    framework: bound(report.framework ?? undefined) ?? null,
    hosting: bound(report.hosting ?? undefined) ?? null,
    providers,
    ...(repoLabel !== undefined ? { repoLabel } : {})
  }
}

/** Nothing to send to. The reason is the CLI's to set — it knows WHY (no app, an old app, an
 *  empty `--api-token-env` variable) — and defaults to "open the app". */
export class NoneReportSink implements ReportSink {
  readonly name = "none"
  private readonly reason: string

  constructor(reason: string = NO_DESKTOP_REPORT_REASON) {
    this.reason = reason
  }

  async send(_payload: HarnessReportPayload): Promise<ReportSendResult> {
    return { sent: false, reason: this.reason }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Loop, not `/\/+$/` — these origins are caller-supplied and CodeQL flags that regex as polynomial. */
function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === "/") end -= 1
  return value.slice(0, end)
}

/** The error CODE across the shapes this endpoint family answers with: the cloud route's
 *  `{ error: "not_linked" }`, the bridge's protocol fault `{ error: { code } }`, and the bridge's
 *  own service refusals `{ error: "cloud_unavailable", message }`. */
function errorCodeOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  const error = payload.error
  if (typeof error === "string" && error) return error
  if (isRecord(error) && typeof error.code === "string" && error.code) return error.code
  return null
}

function errorReasonOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  if (typeof payload.reason === "string" && payload.reason) return payload.reason
  const error = payload.error
  if (isRecord(error) && typeof error.message === "string" && error.message) return error.message
  if (typeof payload.message === "string" && payload.message) return payload.message
  return null
}

/** Per-peer wording. Every string a founder reads names WHO refused, so the next move is obvious. */
interface ReportPeerCopy {
  unreachable(detail: string): string
  rejected(status: number): string
  routeMissing: string
  unavailable(status: number): string
  badRequest(code: string, reason: string | null): string
}

const CLOUD_COPY: ReportPeerCopy = {
  unreachable: (detail) => `the cloud was unreachable (${detail})`,
  rejected: (status) => `the cloud rejected this session (HTTP ${status})`,
  routeMissing: "the cloud report route is not available yet (HTTP 404)",
  unavailable: (status) => `the cloud report route was unavailable (HTTP ${status})`,
  badRequest: (code, reason) => `the cloud rejected the report: ${code}${reason ? ` — ${reason}` : ""}`
}

const BRIDGE_COPY: ReportPeerCopy = {
  unreachable: (detail) => `the Infinite app was unreachable (${detail})`,
  rejected: (status) =>
    `the Infinite app rejected this terminal's bridge credentials (HTTP ${status}) — restart the app and re-run`,
  routeMissing: DESKTOP_UPDATE_REQUIRED_REASON,
  unavailable: (status) => `the Infinite app could not send the report (HTTP ${status})`,
  badRequest: (code, reason) => `the Infinite app rejected the report: ${code}${reason ? ` — ${reason}` : ""}`
}

interface ReportPostConfig {
  endpoint: string
  headers: Record<string, string>
  body: Record<string, unknown>
  copy: ReportPeerCopy
  fetch?: typeof fetch
  /** Peer-specific TERMINAL answers, consulted before the shared ladder (the bridge's 409/503s). */
  terminal?(status: number, payload: unknown): string | null
}

/** Read a response body ONCE, leniently: a 429 with an empty body is normal, not an outage. */
async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "")
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** One POST, every failure shape mapped to a reason the CLI prints; nothing throws. */
async function postReport(config: ReportPostConfig): Promise<ReportSendResult> {
  const fetchImpl = config.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(config.body)
    })
  } catch (error) {
    return { sent: false, reason: config.copy.unreachable(errorText(error)) }
  }
  if (response.ok) {
    await response.text().catch(() => "")
    return { sent: true }
  }
  const payload = await readPayload(response)
  const terminal = config.terminal?.(response.status, payload)
  if (terminal) return { sent: false, reason: terminal }
  const code = errorCodeOf(payload)
  if (response.status === 401 || response.status === 403) {
    return { sent: false, reason: config.copy.rejected(response.status) }
  }
  if (response.status === 402) {
    return { sent: false, reason: "subscription required — complete onboarding in Infinite Desktop" }
  }
  if (response.status === 404) {
    return {
      sent: false,
      reason: code === "not_linked" ? "this workspace is not linked to your Infinite account" : config.copy.routeMissing
    }
  }
  if (response.status === 429) {
    return { sent: false, reason: "rate limited by the cloud; try again in a minute" }
  }
  if (response.status === 400) {
    return { sent: false, reason: config.copy.badRequest(code ?? "invalid_request", errorReasonOf(payload)) }
  }
  return { sent: false, reason: config.copy.unavailable(response.status) }
}

export interface CloudReportSinkOptions {
  /** e.g. https://api.ultima.inc — the route is `${origin}/api/analytics/harness-report`. */
  origin: string
  /** Bearer token for the founder's cloud session. Never logged, never written. */
  token: string
  fetch?: typeof fetch
}

/**
 * ADVANCED: one POST straight to the cloud's `/api/analytics/harness-report` with a bearer the
 * founder supplied through `--api-token-env`. Prefer {@link DesktopBridgeReportSink} — the running
 * app makes this same call with its own session and no token ever reaches the terminal.
 */
export class CloudReportSink implements ReportSink {
  readonly name = "infinite-cloud"
  private readonly options: CloudReportSinkOptions

  constructor(options: CloudReportSinkOptions) {
    this.options = options
  }

  send(payload: HarnessReportPayload): Promise<ReportSendResult> {
    return postReport({
      endpoint: `${trimTrailingSlashes(this.options.origin)}/api/analytics/harness-report`,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: { ...payload },
      copy: CLOUD_COPY,
      fetch: this.options.fetch
    })
  }
}

export interface DesktopBridgeReportSinkOptions {
  /** The running desktop's loopback bridge origin, from `bridge.json` (never a public host). */
  bridgeUrl: string
  /** The descriptor's LOCAL bridge bearer — not a cloud credential. Never logged, never written. */
  token: string
  fetch?: typeof fetch
}

/**
 * Reporting through the RUNNING DESKTOP — the default for `infinite analytics`. The CLI POSTs the
 * app's loopback verb `analytics.report.v1`; the app forwards to the cloud with its own session and
 * its ACTIVE workspace (the payload's `engineProjectId` is deliberately not sent), and returns the
 * cloud's status and body verbatim. 409 `not_ready` is the app refusing BEFORE any cloud write —
 * signed out / unlinked / unsubscribed / booting — and names the state; a 503
 * `capability_unavailable` is an app too old to carry the verb.
 */
export class DesktopBridgeReportSink implements ReportSink {
  readonly name = "infinite-desktop"
  private readonly options: DesktopBridgeReportSinkOptions

  constructor(options: DesktopBridgeReportSinkOptions) {
    this.options = options
  }

  send(payload: HarnessReportPayload): Promise<ReportSendResult> {
    const { engineProjectId: _ignored, ...report } = payload
    return postReport({
      endpoint: `${trimTrailingSlashes(this.options.bridgeUrl)}/v1/analytics/report`,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: { protocolVersion: 1, ...report },
      copy: BRIDGE_COPY,
      fetch: this.options.fetch,
      terminal: (status, body) => {
        if (status === 409) {
          const state = isRecord(body) && typeof body.state === "string" && body.state ? body.state : "not ready"
          return desktopNotReadyReason(state)
        }
        if (status === 503) {
          const code = errorCodeOf(body)
          if (code === "capability_unavailable") return DESKTOP_UPDATE_REQUIRED_REASON
          if (code === "cloud_unavailable" || code === "no_linked_workspace" || code === "service_unavailable") {
            return errorReasonOf(body) ?? BRIDGE_COPY.unavailable(status)
          }
        }
        return null
      }
    })
  }
}
