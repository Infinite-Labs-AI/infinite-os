// The preview guard: which hosts a managed GA4 / PostHog / Meta bootstrap may start on.
//
// Ported from infinite.fast (`productionHostGuard`, infinite-site `.github/scripts/inject-analytics.cjs`
// L294-301 @ 9f65b47) and generalised for customer sites (founder decision 3).
//
// WHY. infinite.fast's Vercel previews (`infinite-site-*.vercel.app`) sent its own test visits into the
// production PostHog project: 5 of 44 page views on 2026-09-25. A preview, a laptop and a staging
// branch are not visitors.
//
// TWO MODES.
//   - "deny" (the customer default, decision 3). EXEMPT FIRST: a host on the exempt list always fires,
//     so production can never be silenced by a deny rule. Then the deny list stops loopback, `.local`,
//     and the preview platforms (`*.vercel.app`, `*.netlify.app`, `*.pages.dev`) plus any preview hosts
//     the hosting connection reported. Anything else is let through: an unknown host fails OPEN, because
//     a guard that silences a real custom domain costs the customer real data. (`staging.acme.com`
//     therefore leaks; only the 7-day host share catches it, and T0 labels it "leaks: deny-list".)
//   - "allow" (infinite.fast parity): only the listed hosts fire. With no hosts it fires nowhere.
//
// THE LISTS come from `contracts/host-deny-v1.json` through F0's frozen constant, never hand-copied
// here. The exempt list a guard is emitted with is union(site-source productionHosts, the hosting
// production domains + aliases, the final host observed in `before`), assembled by the plan (O7).
//
// ONE NORMALISER everywhere a host is compared: trim, lowercase, strip ONE trailing dot (§3h.9).
// `ACME.com.` and `acme.com` are one host. The TS form is F0's `normalizeHost`; the browser form is
// `normalizeHostSource` below, and the emitted guard inlines it.
//
// THE EMITTED SHAPE is one self-contained ES5 EXPRESSION (an immediately-called function) that
// evaluates to `true` when the bootstrap may start. It is byte-local to each guarded snippet: static
// HTML gives each provider its own <script>, so a shared global would order one script after another.
// Callers wrap it as `(function () { if (!(<expression>)) return; …bootstrap… })();` — the IIFE is
// MANDATORY, because on Next.js every provider is concatenated into ONE inline script and a bare
// top-level `return` is a SyntaxError that stops GA4, PostHog, X, Meta and Infinite together
// (`wrapGuardedSnippet` below does it). No `navigator.webdriver` skip and no `VERCEL_ENV` gate: the
// rehearsal serves a preview under the production hostname, and the guard must fire there.
//
// The source is free of backticks, `${` and `</`, so it folds into an HTML <script> and into the Next
// module's string literal unchanged.
import { HOST_DENY_V1, normalizeHost } from "./wizard/contracts/host-deny.js"

export { normalizeHost }

/** The preview guard a managed bootstrap is emitted with. */
export type HostGuardSpec =
  | { mode: "deny"; exempt: readonly string[]; deny: readonly string[] }
  | { mode: "allow"; hosts: readonly string[] }

/** What a host is under a deny-mode guard: exempt (fires), denied (silent) or allowed (fires, unknown). */
export type HostGuardVerdict = "exempt" | "denied" | "allowed"

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const IPV6_LOOPBACK = new Set(["::1", "[::1]"])

/**
 * A normalised host that is safe to write as a literal into a guard: dotted DNS labels, or one of the
 * loopback spellings the deny list itself uses. Throws on anything else, so a malformed connection
 * value fails the plan instead of shipping a guard that can never match.
 */
export function guardHostLiteral(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Preview guard hosts must be strings.")
  }
  const host = normalizeHost(value)
  if (IPV6_LOOPBACK.has(host)) return host
  if (host.length === 0 || host.length > 253 || !host.split(".").every((label) => HOST_LABEL.test(label))) {
    throw new Error(`Preview guard host ${JSON.stringify(value)} is not a hostname.`)
  }
  return host
}

function literalList(values: readonly string[]): string[] {
  return [...new Set(values.map(guardHostLiteral))].sort()
}

/** Normalise a guard spec's lists (deduplicated, sorted) and reject a malformed host. */
export function normalizeHostGuardSpec(spec: HostGuardSpec): HostGuardSpec {
  if (spec.mode === "allow") {
    return { mode: "allow", hosts: literalList(spec.hosts) }
  }
  return { mode: "deny", exempt: literalList(spec.exempt), deny: literalList(spec.deny) }
}

function deniedByContract(host: string): boolean {
  if (HOST_DENY_V1.deny.exact.includes(host)) return true
  return HOST_DENY_V1.deny.suffix.some((suffix) => host.length > suffix.length && host.endsWith(suffix))
}

/** The TS twin of the emitted deny-mode expression (same order: exempt, deny literals, contract, let through). */
export function classifyHost(host: string, guard: { exempt: readonly string[]; deny: readonly string[] }): HostGuardVerdict {
  const normalized = normalizeHost(host)
  if (guard.exempt.some((value) => normalizeHost(value) === normalized)) return "exempt"
  if (guard.deny.some((value) => normalizeHost(value) === normalized)) return "denied"
  if (deniedByContract(normalized)) return "denied"
  return "allowed"
}

/** The TS twin of the emitted expression: does a managed bootstrap start on this host? */
export function hostGuardAllows(host: string, spec: HostGuardSpec): boolean {
  if (!normalizeHost(host)) return false
  if (spec.mode === "allow") {
    const normalized = normalizeHost(host)
    return spec.hosts.some((value) => normalizeHost(value) === normalized)
  }
  return classifyHost(host, spec) !== "denied"
}

/**
 * The observed production hosts a deny rule would silence and the exempt list does not cover. The plan
 * (O7) refuses to emit a deny guard while this is non-empty: production must never go dark because its
 * only domain is, say, `acme.vercel.app` (§3h.9).
 */
export function productionDeniedConflict(
  observedHosts: readonly string[],
  exempt: readonly string[],
  deny: readonly string[] = []
): string[] {
  const exemptSet = new Set(exempt.map(normalizeHost))
  // The guard's own extra deny literals silence a host exactly like a contract rule does.
  const denySet = new Set(deny.map(normalizeHost))
  const conflicts = new Set<string>()
  for (const raw of observedHosts) {
    const host = normalizeHost(raw)
    if (host.length === 0 || exemptSet.has(host)) continue
    if (denySet.has(host) || deniedByContract(host)) conflicts.add(host)
  }
  return [...conflicts].sort()
}

/**
 * Browser source of the one normaliser, as an ES5 function expression:
 * `function (h) { … return normalised; }`. Same three steps as `normalizeHost`.
 */
export const normalizeHostSource =
  'function (h) { h = String(h == null ? "" : h).replace(/^\\s+|\\s+$/g, "").toLowerCase(); return h.charAt(h.length - 1) === "." ? h.slice(0, -1) : h; }'

/** Emitted as a JSON array literal; every value already passed `guardHostLiteral`. */
function arrayLiteral(values: readonly string[]): string {
  return JSON.stringify(values)
}

export interface HostGuardExpressionOptions {
  /** The ES5 expression that yields the host to test. Default `location.hostname`. */
  hostExpression?: string
}

/**
 * The guard as ONE ES5 expression that is `true` when the bootstrap may start. Wrap it with
 * `wrapGuardedSnippet`; never emit it as a bare `if (...) return;` at script top level.
 */
export function buildHostGuardExpression(spec: HostGuardSpec, options: HostGuardExpressionOptions = {}): string {
  const host = options.hostExpression ?? 'typeof location !== "undefined" ? location.hostname : null'
  const normalized = normalizeHostGuardSpec(spec)
  const prologue = `${options.hostExpression === undefined ? "if (h === null) return true; " : ""}var n = (${normalizeHostSource})(h), i; if (!n) return false;`
  if (normalized.mode === "allow") {
    return [
      "(function (h) {",
      prologue,
      `var a = ${arrayLiteral(normalized.hosts)};`,
      "for (i = 0; i < a.length; i += 1) if (a[i] === n) return true;",
      "return false;",
      `})(${host})`
    ].join(" ")
  }
  const denyExact = [...new Set([...HOST_DENY_V1.deny.exact, ...normalized.deny])]
  return [
    "(function (h) {",
    prologue,
    `var x = ${arrayLiteral(normalized.exempt)}, d = ${arrayLiteral(denyExact)}, s = ${arrayLiteral(HOST_DENY_V1.deny.suffix)};`,
    "for (i = 0; i < x.length; i += 1) if (x[i] === n) return true;",
    "for (i = 0; i < d.length; i += 1) if (d[i] === n) return false;",
    "for (i = 0; i < s.length; i += 1) if (n.length > s[i].length && n.slice(n.length - s[i].length) === s[i]) return false;",
    "return true;",
    `})(${host})`
  ].join(" ")
}

/**
 * The guard a plan's artifacts ask for, validated: `{}` when there is none, `{ spec }` when it is usable,
 * `{ error }` (a plan blocker) when a host is malformed or a production host the plan knows about would
 * be silenced by a deny rule the exempt list does not cover.
 */
export function resolveArtifactHostGuard(artifacts: {
  productionHosts?: string[]
  infinite?: { productionHosts?: string[] }
  hostGuard?: { mode: "deny"; exempt: string[]; deny: string[] }
}): { spec?: HostGuardSpec; error?: string } {
  const guard = artifacts.hostGuard
  if (guard === undefined) return {}
  if (guard === null || typeof guard !== "object" || guard.mode !== "deny" || !Array.isArray(guard.exempt) || !Array.isArray(guard.deny)) {
    return { error: "The preview guard must be { mode: \"deny\", exempt: [...], deny: [...] }." }
  }
  let spec: HostGuardSpec
  try {
    spec = normalizeHostGuardSpec({ mode: "deny", exempt: guard.exempt, deny: guard.deny })
  } catch (error) {
    return { error: (error as Error).message }
  }
  // Every production host the plan knows: the site's own list and the Infinite source's verified hosts.
  const production = [...(artifacts.productionHosts ?? []), ...(artifacts.infinite?.productionHosts ?? [])]
  const conflicts = productionDeniedConflict(production, guard.exempt, guard.deny)
  if (conflicts.length > 0) {
    return {
      error: `The preview guard would silence production host(s) ${conflicts.join(", ")}: add them to the exempt list.`
    }
  }
  return { spec }
}

/**
 * `(function () { if (!(<guard>)) return; <body> })();` — the only shape a guarded snippet may take
 * (one IIFE per snippet, so the `return` can only ever stop its own provider).
 */
export function wrapGuardedSnippet(body: string, spec: HostGuardSpec, onDenied?: string): string {
  // The body is not re-indented: a snippet's bytes stay exactly what its builder emitted.
  const check = onDenied
    ? [`if (!(${buildHostGuardExpression(spec)})) {`, 'if (typeof window !== "undefined") {', onDenied, "}", "return;", "}"].join("\n")
    : `if (!(${buildHostGuardExpression(spec)})) return;`
  return ["(function () {", check, body, "})();"].join("\n")
}
