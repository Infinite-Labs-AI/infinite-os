// §3f.5: out-of-usage and billing signals from the user's own agent, read from its stream. Pure.
//
// Claude (2.1.287 stream-json): `rate_limit_event.rate_limit_info.status:"rejected"` (keep `resetsAt`, an
// epoch-seconds int, and `rateLimitType`), an `assistant.error` of `rate_limit` / `billing_error`, or a
// `result` with `api_error_status: 429`. `allowed_warning` → one warning line; `isUsingOverage:true` →
// "using your extra-usage credits". The desktop's old `usage limit reached|<epoch>` sentinel is not in
// 2.1.287 and is NOT used here (scout S2 fact 5).
//
// Codex (0.159.2 JSONL): an `error` or `turn.failed` message matching
// /(hit your usage limit|usage limit reached|usage limit exceeded)/i; the reset time is the verbatim text
// after "try again at" (fact source: the desktop's codex-usage-limit parser, re-written here).
//
// On a limit the runner kills the tree, restores the snapshot and keeps the session id; it never switches
// provider and never falls back to Infinite-paid inference.

export interface ClaudeRateLimitInfo {
  status?: unknown
  resetsAt?: unknown
  rateLimitType?: unknown
  utilization?: unknown
  isUsingOverage?: unknown
}

export type ClaudeUsageSignal =
  | { kind: "rejected"; resetsAt: string | null; rateLimitType: string | null }
  | { kind: "warning"; rateLimitType: string | null; utilization: number | null }
  | { kind: "overage" }

/** Converts Claude's `resetsAt` (epoch seconds) to an ISO string; keeps a string as it came. */
export function claudeResetsAt(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value
    return new Date(ms).toISOString()
  }
  if (typeof value === "string" && value.trim() !== "") return value.trim()
  return null
}

/** Reads one parsed Claude stream-json line. Returns every signal it carries (in order of severity). */
export function claudeUsageSignals(event: unknown): ClaudeUsageSignal[] {
  if (!isRecord(event)) return []
  const out: ClaudeUsageSignal[] = []
  if (event.type === "rate_limit_event" && isRecord(event.rate_limit_info)) {
    const info = event.rate_limit_info as ClaudeRateLimitInfo
    const rateLimitType = typeof info.rateLimitType === "string" ? info.rateLimitType : null
    if (info.status === "rejected") {
      out.push({ kind: "rejected", resetsAt: claudeResetsAt(info.resetsAt), rateLimitType })
    } else if (info.status === "allowed_warning") {
      out.push({ kind: "warning", rateLimitType, utilization: typeof info.utilization === "number" ? info.utilization : null })
    }
    if (info.isUsingOverage === true) out.push({ kind: "overage" })
    return out
  }
  if (event.type === "assistant") {
    const error = event.error ?? (isRecord(event.message) ? event.message.error : undefined)
    if (error === "rate_limit" || error === "billing_error") out.push({ kind: "rejected", resetsAt: null, rateLimitType: null })
    return out
  }
  if (event.type === "result" && event.api_error_status === 429) {
    out.push({ kind: "rejected", resetsAt: null, rateLimitType: null })
  }
  return out
}

const CODEX_USAGE_LIMIT = /(hit your usage limit|usage limit reached|usage limit exceeded)/i
const CODEX_TRY_AGAIN = /try again at (.+?)\.?$/i

/** A Codex `error` / `turn.failed` message → `{resetsAt}` when it is a usage limit, else null. */
export function codexUsageLimit(message: unknown): { resetsAt: string | null } | null {
  if (typeof message !== "string" || !CODEX_USAGE_LIMIT.test(message)) return null
  for (const line of message.split(/\r?\n/)) {
    const match = CODEX_TRY_AGAIN.exec(line.trim())
    if (match && match[1]!.trim() !== "") return { resetsAt: match[1]!.trim() }
  }
  return { resetsAt: null }
}

/** The message of a Codex `error` / `turn.failed` event, or null for any other event. */
export function codexErrorMessage(event: unknown): string | null {
  if (!isRecord(event)) return null
  if (event.type === "error" && typeof event.message === "string") return event.message
  if (event.type === "turn.failed" && isRecord(event.error) && typeof event.error.message === "string") return event.error.message
  if ((event.type === "item.completed" || event.type === "item.started") && isRecord(event.item) && event.item.type === "error") {
    return typeof event.item.message === "string" ? event.item.message : null
  }
  return null
}

/** The park line (§3f.5): "resets at <verbatim>; run `npx infinite-tag` again to resume". */
export function outOfUsageResumeLine(resetsAt: string | null): string {
  const when = resetsAt ? `resets at ${resetsAt}` : "the limit resets later"
  return `${when}; run \`npx infinite-tag\` again to resume`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
