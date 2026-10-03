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
// "missing". The host test must be the CONDITION of an `if` that governs the init, with the right
// polarity:
//   • `if (<deny test>) return` before the init, or `if (!(<allow test>)) return` — the emitted shape,
//     `if (!(<infinite-tag guard expression>)) return;` — guards the rest of the function;
//   • `if (<allow test>) { …init… }` / `if (<allow test>) init(…)` guards that block or statement.
// An allow test is a host-guard predicate (`infiniteHostAllowed(...)`, `hostAllowed(...)`), infinite-tag's
// emitted guard expression, or a deny test written negated (`host !== 'localhost' && !host.endsWith(…)`).
// A deny test is a read of `location.hostname` / `location.host` (or a variable read from it) compared
// with a WHOLE quoted deny-list host (`'localhost'`, `'.vercel.app'`, …; `localStorage` is not `local`).
// An inverted guard (`if (host.endsWith('.vercel.app')) { gtag(…) }` fires ONLY on previews), a host
// read with no `if`, or a test whose polarity cannot be read is "missing". Managed inits are not judged
// here (their guard bytes are emitted and executed by T0's host matrix).
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
/** infinite-tag's emitted guard expression (O5 `buildHostGuardExpression`): true when the bootstrap may start. */
const EMITTED_GUARD = /\(function \(h\) \{ var n = [\s\S]*?return (?:true|false); \}\)\(/
const DENY_HOSTS = [...HOST_DENY_V1.deny.exact, ...HOST_DENY_V1.deny.suffix, ...HOST_DENY_V1.deny.suffix.map((suffix) => suffix.slice(1))]
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** A WHOLE quoted deny-list host, or a regex literal naming one (`/\.vercel\.app$/`). */
const DENY_LITERAL = new RegExp(
  String.raw`["'\x60](?:${DENY_HOSTS.map(escapeRegExp).join("|")})["'\x60]|/[^/\n]*(?:vercel\\\.app|netlify\\\.app|pages\\\.dev|localhost)[^/\n]*/`,
  "g"
)

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
        const guarded = governingGuard(code, windowStart, at)
        const literalHosts = [...window.matchAll(/["']([a-z0-9-]+(?:\.[a-z0-9-]+)+\.?)["']/gi)].map((hit) => normalizeHost(hit[1] as string))
        reads.push({ tool, file: unit.file, line: unitLine(unit, at), guarded, literalHosts })
      }
    }
  }
  return reads
}

/** Does any `if (<host test>)` in the window govern the init at `initAt` with the right polarity? */
function governingGuard(code: string, windowStart: number, initAt: number): boolean {
  const window = code.slice(windowStart, initAt)
  const readsHost = HOST_READ.test(window)
  const candidates = new Set<number>()
  for (const pattern of [GUARD_CALL, EMITTED_GUARD]) {
    for (const match of window.matchAll(new RegExp(pattern.source, "g"))) candidates.add(windowStart + (match.index ?? 0))
  }
  if (readsHost) for (const match of window.matchAll(new RegExp(DENY_LITERAL.source, "g"))) candidates.add(windowStart + (match.index ?? 0))
  for (const offset of [...candidates].sort((a, b) => b - a)) {
    const condition = enclosingIfCondition(code, offset, initAt)
    if (!condition) continue
    const allowWhenTrue = conditionPolarity(code.slice(condition.open + 1, condition.close))
    if (allowWhenTrue === null) continue
    if (governs(code, condition.close, initAt, allowWhenTrue)) return true
  }
  return false
}

/** The `if (…)` whose condition contains `offset` (and closes before the init): its paren offsets. */
function enclosingIfCondition(code: string, offset: number, initAt: number): { open: number; close: number } | null {
  const searchFrom = Math.max(0, offset - GUARD_WINDOW_CHARS)
  const ifs = [...code.slice(searchFrom, offset).matchAll(/\bif\s*\(/g)].reverse()
  for (const match of ifs) {
    const open = searchFrom + (match.index ?? 0) + match[0].length - 1
    const close = matchingBracket(code, open)
    if (close !== -1 && close > offset && close < initAt) return { open, close }
  }
  return null
}

/**
 * Is the condition TRUE when the host is allowed (`true`), TRUE when it is denied (`false`), or
 * unreadable (`null`)? A leading `!` over the whole condition flips it.
 */
function conditionPolarity(condition: string): boolean | null {
  let text = condition.trim()
  let negated = false
  while (text.startsWith("!") && !text.startsWith("!=")) {
    const rest = text.slice(1).trim()
    const whole = rest.startsWith("(") ? matchingBracket(rest, 0) === rest.length - 1 : /^[\w$.]+\s*\([^]*\)$/.test(rest) && matchingBracket(rest, rest.indexOf("(")) === rest.length - 1
    if (!whole) break
    negated = !negated
    text = rest.startsWith("(") ? rest.slice(1, -1).trim() : rest
  }
  let allowWhenTrue: boolean
  if (EMITTED_GUARD.test(text) || GUARD_CALL.test(text)) {
    // A predicate negated inside a longer expression (`!hostAllowed() || x`) cannot be read.
    if (/!\s*(?:\(|[\w$.]*[hH]ost(?:Allowed|Guard)\s*\()/.test(text)) return null
    allowWhenTrue = true
  } else if (new RegExp(DENY_LITERAL.source).test(text)) {
    const negatedTests = /!==?|!\s*[\w$.]+\s*\.\s*(?:endsWith|includes|startsWith|test|match)\s*\(|indexOf\s*\([^)]*\)\s*(?:===?\s*-1|<\s*0)/.test(text)
    const positiveTests = /[^!=]===?[^=]|(?<!!\s*[\w$.]*)\.\s*(?:endsWith|includes|startsWith|test|match)\s*\(|indexOf\s*\([^)]*\)\s*(?:!==?\s*-1|>=?\s*0)/.test(text)
    if (negatedTests && positiveTests) return null
    if (!negatedTests && !positiveTests) return null
    allowWhenTrue = negatedTests
  } else {
    return null
  }
  return negated ? !allowWhenTrue : allowWhenTrue
}

/**
 * Does the `if` whose condition closes at `close` keep the init at `initAt` off denied hosts?
 * `if (denied) return` (allowWhenTrue false + return) guards the rest of the function;
 * `if (allowed) { … }` / `if (allowed) init()` (allowWhenTrue true) guards that block or statement.
 */
function governs(code: string, close: number, initAt: number, allowWhenTrue: boolean): boolean {
  const after = code.slice(close + 1).trimStart()
  const returns = /^(?:return\b|\{\s*return\b)/.test(after)
  if (returns) return !allowWhenTrue
  if (!allowWhenTrue) {
    // `if (denied) { …; return; }` before the init (the emitted shape with an `onDenied` beat).
    if (!after.startsWith("{")) return false
    const braceAt = code.indexOf("{", close + 1)
    const blockEnd = matchingBracket(code, braceAt)
    return blockEnd !== -1 && blockEnd < initAt && /\breturn\b/.test(code.slice(braceAt, blockEnd))
  }
  if (after.startsWith("{")) {
    const braceAt = code.indexOf("{", close + 1)
    const blockEnd = matchingBracket(code, braceAt)
    return blockEnd === -1 || initAt < blockEnd
  }
  // `if (allowed) init(...)` on one statement.
  const statementEnd = code.slice(close + 1).search(/;|\n/)
  return statementEnd === -1 || initAt < close + 1 + statementEnd
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
