// Check 7 — does the site's OWN GA4 / PostHog / Meta init start on every host?
//
// Incident guarded (PORT-PLAN §4, 9fcbefa): 5 of 44 PostHog page views on infinite.fast came from
// preview deploys and localhost before its host guard. A customer's adopted tag has no guard at all:
// every Vercel preview, every `localhost:3000`, every staging copy sends into the production property.
//
// Decision 3 (GA4 + PostHog) and decision 8 (Meta, bootstrap only — never the `_fbc` capture, decision
// 15): adopted inits get a `preview_guard_adopted` plan line and agent job 7 wraps them. This check is
// both the DETECTOR (harness / `before`: an unguarded adopted init is `info`, a plan line) and job 7's
// static proof `adopted_init_guarded` (`strict: true`: an unguarded init is a `problem`).
//
// "Guarded" is read from source, heuristically, and biased so that a wrong answer can only make it
// "missing": the init must sit after a host test — a call to a host-guard predicate
// (`infiniteHostAllowed(...)`, `__infiniteHostAllowed(...)`, `hostAllowed(...)`), or a read of
// `location.hostname` / `location.host` together with a deny-list literal (`.vercel.app`, `localhost`,
// …) — within the preceding stretch of the same unit. Managed inits are not judged here (their guard
// bytes are emitted and executed by T0's host matrix).
//
// With `productionHosts`, a guard that would silence production is a problem (decision 3: the
// production host is ALWAYS exempt): a production host that is deny-shaped (e.g. a pre-launch
// `acme.vercel.app`) and does not appear in the guard's literals.
import { HOST_DENY_V1, normalizeHost } from "../wizard/contracts/host-deny.js"

import { codeView, groupFindings, matchingBracket, sourceUnits, unitLine } from "./code-view.js"
import { hostGuardMissingMessage, hostGuardPresentMessage, hostGuardSilencesProductionMessage } from "./copy.js"
import { worstState, type SetupCheckResult, type SetupFinding } from "./types.js"

const INITS: ReadonlyArray<{ tool: "GA4" | "PostHog" | "Meta pixel"; pattern: RegExp }> = [
  { tool: "GA4", pattern: /\b(?:window\.)?gtag\s*\(\s*["']config["']/g },
  { tool: "GA4", pattern: /\bReactGA\.initialize\s*\(/g },
  { tool: "PostHog", pattern: /\bposthog\.init\s*\(/g },
  { tool: "Meta pixel", pattern: /\b(?:window\.)?fbq\s*\(\s*["']init["']\s*,\s*(?:["']\d+["']|[A-Za-z_$][\w$.]*)\s*\)/g }
]

/** How far back from an init a guard may sit (one snippet / one effect body). */
export const GUARD_WINDOW_CHARS = 1_200

const GUARD_CALL = /\b(?:__)?(?:infinite)?[hH]ost(?:Allowed|Guard)\s*\(/
const HOST_READ = /\blocation\s*\.\s*host(?:name)?\b/
const DENY_LITERALS = [...HOST_DENY_V1.deny.exact, ...HOST_DENY_V1.deny.suffix.map((suffix) => suffix.slice(1))]

export interface HostGuardRead {
  tool: "GA4" | "PostHog" | "Meta pixel"
  file: string
  line: number
  guarded: boolean
  /** Host-shaped string literals in the guard window (the guard's exempt / allow list). */
  literalHosts: string[]
}

export function readAdoptedInitGuards(files: ReadonlyMap<string, string>): HostGuardRead[] {
  const reads: HostGuardRead[] = []
  for (const unit of sourceUnits(files)) {
    if (unit.managed) continue
    const code = codeView(unit.file, unit.text)
    for (const { tool, pattern } of INITS) {
      for (const match of code.matchAll(pattern)) {
        const at = match.index ?? 0
        const windowStart = Math.max(0, at - GUARD_WINDOW_CHARS)
        const window = code.slice(windowStart, at)
        const guardAt = lastGuardOffset(window)
        const guarded = guardAt !== -1 && guardStillOpen(code, windowStart + guardAt, at)
        const literalHosts = [...window.matchAll(/["']([a-z0-9-]+(?:\.[a-z0-9-]+)+\.?)["']/gi)].map((hit) => normalizeHost(hit[1] as string))
        reads.push({ tool, file: unit.file, line: unitLine(unit, at), guarded, literalHosts })
      }
    }
  }
  return reads
}

/** Offset of the last host test in the window, or -1. */
function lastGuardOffset(window: string): number {
  let last = -1
  for (const match of window.matchAll(new RegExp(GUARD_CALL.source, "g"))) last = match.index ?? last
  if (DENY_LITERALS.some((literal) => window.includes(literal))) {
    for (const match of window.matchAll(new RegExp(HOST_READ.source, "g"))) last = Math.max(last, match.index ?? -1)
  }
  return last
}

/**
 * Does the host test at `guardAt` still govern the init at `initAt`? When the test is an `if (…)`
 * followed by a block, the init must sit inside that block; `if (…) return` guards the rest of the
 * function. Anything else (an `&&` chain, a ternary) is taken as governing.
 */
function guardStillOpen(code: string, guardAt: number, initAt: number): boolean {
  const before = code.slice(Math.max(0, guardAt - 200), guardAt)
  const ifMatch = [...before.matchAll(/\bif\s*\(/g)].pop()
  if (!ifMatch) return true
  const open = Math.max(0, guardAt - 200) + (ifMatch.index ?? 0) + ifMatch[0].length - 1
  const close = matchingBracket(code, open)
  if (close === -1 || close > initAt) return close !== -1
  const after = code.slice(close + 1).trimStart()
  if (after.startsWith("{")) {
    const braceAt = code.indexOf("{", close + 1)
    const blockEnd = matchingBracket(code, braceAt)
    return blockEnd === -1 || initAt < blockEnd
  }
  if (/^return\b/.test(after)) return true
  // `if (cond) init(...)` on one statement.
  const statementEnd = code.indexOf(";", close + 1)
  return statementEnd === -1 || initAt < statementEnd
}

function deniedByRules(host: string): boolean {
  return HOST_DENY_V1.deny.exact.includes(host) || HOST_DENY_V1.deny.suffix.some((suffix) => host.endsWith(suffix))
}

export interface HostGuardInput {
  files: ReadonlyMap<string, string>
  /** Job 7's proof: an unguarded adopted init is a problem, not a plan line. */
  strict?: boolean
  /** The exempt production hosts (site source ∪ hosting domains + aliases ∪ the observed host). */
  productionHosts?: readonly string[]
}

export function checkHostGuard(input: HostGuardInput): SetupCheckResult {
  const findings: SetupFinding[] = []
  const toolOf = new Map<SetupFinding, string>()
  const production = (input.productionHosts ?? []).map(normalizeHost)
  for (const read of readAdoptedInitGuards(input.files)) {
    const base = { check: "host_guard" as const, file: read.file, line: read.line }
    if (!read.guarded) {
      findings.push({
        ...base,
        code: "INF_SETUP_HOST_GUARD_MISSING",
        state: input.strict ? "problem" : "info",
        confidence: input.strict ? "certain" : "likely",
        message: hostGuardMissingMessage({ ...read, strict: input.strict === true })
      })
      toolOf.set(findings[findings.length - 1] as SetupFinding, read.tool)
      continue
    }
    const silenced = production.filter((host) => deniedByRules(host) && !read.literalHosts.includes(host))
    if (silenced.length > 0) {
      findings.push({
        ...base,
        code: "INF_SETUP_HOST_GUARD_SILENCES_PRODUCTION",
        state: "problem",
        confidence: "certain",
        message: hostGuardSilencesProductionMessage({ ...read, hosts: silenced })
      })
      toolOf.set(findings[findings.length - 1] as SetupFinding, read.tool)
      continue
    }
    findings.push({ ...base, code: "INF_SETUP_HOST_GUARD_PRESENT", state: "ok", confidence: "likely", message: hostGuardPresentMessage(read) })
    toolOf.set(findings[findings.length - 1] as SetupFinding, read.tool)
  }
  // Job 7's proof keeps one finding per init (each is an item's target); the plan-line view groups
  // by tool so a multi-page site reads as one line per tool.
  const shown = input.strict ? findings : groupFindings(findings, (finding) => `${finding.code}\u0000${toolOf.get(finding) ?? ""}`)
  return { check: "host_guard", state: worstState(shown), findings: shown }
}
