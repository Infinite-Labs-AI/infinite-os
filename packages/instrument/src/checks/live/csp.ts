// T1 `csp_header`: does the live Content-Security-Policy let the tags load and send?
//
// A CSP that does not list a tool's hosts blocks it silently: the browser drops the script or the
// beacon, prints one console line, and the dashboards simply stay empty. This check reads the live
// policy (headers + `<meta http-equiv>`), works out its STYLE first, then — for a host-list policy —
// which needed host each directive refuses.
//
// The style decides what can be said (job 12):
//   • `none`         — no policy: nothing is blocked → pass;
//   • `hosts`        — host lists: checked host by host → pass / problem;
//   • `nonce`        — nonces / hashes / 'strict-dynamic': whether a script runs depends on per-request
//                      values this read cannot see → undetermined (the test visit's `csp.violations`
//                      decide; job 12 is `blocked: needs_you`);
//   • `report_only`  — only Report-Only policies: nothing is enforced → info (the missing hosts are
//                      still listed, because enforcing it later would block them).
import type { CheckContext, CheckResult } from "../../wizard/contracts/jobs.js"
import type { TestExpect } from "../../wizard/contracts/test-engine.js"
import { checkResult } from "../result.js"

import { isRelativePath, posthogRegion } from "../posthog-hosts.js"
import { probeFetch, type LiveProbeDeps } from "./probe.js"

export const CSP_CHECK_ID = "csp_header" as const

export type CspDirective = "script-src" | "connect-src" | "img-src"

export interface CspNeed {
  directive: CspDirective
  /** A concrete URL the tool loads or sends to (`'self'` needs are written as the page origin). */
  url: string
  tool: "ga4" | "posthog" | "meta" | "infinite" | "inline"
}

/** The concrete URLs each tool needs, per directive, for the tools in `expect`. */
export function cspNeeds(expect: TestExpect, pageOrigin: string, observedPosthogApiHost?: string): CspNeed[] {
  const needs: CspNeed[] = []
  const add = (tool: CspNeed["tool"], directive: CspDirective, url: string) => needs.push({ tool, directive, url })
  if (expect.ga4 && expect.ga4.length > 0) {
    add("ga4", "script-src", "https://www.googletagmanager.com/gtag/js")
    add("ga4", "connect-src", "https://www.google-analytics.com/g/collect")
    add("ga4", "connect-src", "https://region1.google-analytics.com/g/collect")
    // With Google signals on, GA4 also sends to *.analytics.google.com (Google's GA4 CSP guide).
    add("ga4", "connect-src", "https://region1.analytics.google.com/g/collect")
  }
  if (expect.posthog) {
    const apiHost = observedPosthogApiHost ?? expect.posthog.apiHost
    if (isRelativePath(apiHost)) {
      add("posthog", "script-src", `${pageOrigin}${apiHost}/static/array.js`)
      add("posthog", "connect-src", `${pageOrigin}${apiHost}/e/`)
    } else {
      const region = posthogRegion(apiHost) === "eu" ? "eu" : "us"
      add("posthog", "script-src", `https://${region}-assets.i.posthog.com/static/array.js`)
      add("posthog", "connect-src", `https://${region}.i.posthog.com/e/`)
    }
  }
  if (expect.meta && expect.meta.length > 0) {
    add("meta", "script-src", "https://connect.facebook.net/en_US/fbevents.js")
    add("meta", "connect-src", "https://www.facebook.com/tr/")
    add("meta", "img-src", "https://www.facebook.com/tr/")
  }
  if (expect.infinite) add("infinite", "connect-src", `${pageOrigin}${expect.infinite.collectPath}`)
  return needs
}

export type CspStyle = "none" | "hosts" | "nonce" | "report_only"

export interface CspAnalysis {
  style: CspStyle
  /** Needs an ENFORCED (or, for report_only, the report-only) policy refuses. */
  missing: Array<{ directive: CspDirective; host: string; tool: CspNeed["tool"] }>
  /** True when an enforced host-list script-src refuses inline scripts (every managed snippet is inline). */
  inlineBlocked: boolean
}

type Policy = Map<string, string[]>

export function parseCspPolicies(header: string | null): Policy[] {
  if (!header) return []
  return header
    .split(",")
    .map((text) => {
      const policy: Policy = new Map()
      for (const part of text.split(";")) {
        const tokens = part.trim().split(/\s+/).filter(Boolean)
        const name = tokens.shift()?.toLowerCase()
        if (name && !policy.has(name)) policy.set(name, tokens)
      }
      return policy
    })
    .filter((policy) => policy.size > 0)
}

function sourcesFor(policy: Policy, directive: CspDirective): string[] | null {
  const chain = directive === "script-src" ? ["script-src-elem", "script-src", "default-src"] : [directive, "default-src"]
  for (const name of chain) {
    const sources = policy.get(name)
    if (sources) return sources
  }
  return null
}

/** Does one source expression allow `url` (loaded from a page at `pageOrigin`)? */
export function sourceAllows(source: string, url: URL, pageOrigin: string): boolean {
  const value = source.toLowerCase()
  if (value === "*") return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "wss:" || url.protocol === "ws:"
  if (value === "'self'") return url.origin === pageOrigin
  if (/^[a-z][a-z0-9+.-]*:$/.test(value)) return url.protocol === value
  if (value.startsWith("'")) return false
  // Scheme and host compare case-insensitively; the path does not.
  const match = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):\/\/)?(\*\.)?([^/:]+|\*)(?::(\d+|\*))?(\/.*)?$/.exec(source)
  if (!match) return false
  const [, rawScheme, wildcard, rawHost, port, path] = match
  const scheme = rawScheme?.toLowerCase()
  const host = (rawHost as string).toLowerCase()
  if (scheme && `${scheme}:` !== url.protocol && !(scheme === "http" && url.protocol === "https:")) return false
  if (!scheme && url.protocol !== "https:" && url.protocol !== "http:") return false
  const hostname = url.hostname.toLowerCase()
  if (host === "*") {
    // `*` alone in the host position is only valid as `*` (handled above); treat as no match.
    return false
  }
  if (wildcard) {
    if (!hostname.endsWith(`.${host}`)) return false
  } else if (hostname !== host) return false
  if (port && port !== "*") {
    const effective = url.port || (url.protocol === "https:" ? "443" : "80")
    if (port !== effective) return false
  }
  if (path && path !== "/") {
    if (path.endsWith("/")) {
      if (!url.pathname.startsWith(path)) return false
    } else if (url.pathname !== path) return false
  }
  return true
}

function policyAllows(policy: Policy, need: CspNeed, pageOrigin: string): boolean {
  const sources = sourcesFor(policy, need.directive)
  if (sources === null) return true
  const url = new URL(need.url)
  return sources.some((source) => sourceAllows(source, url, pageOrigin))
}

function isNonceStyle(policy: Policy): boolean {
  const scripts = sourcesFor(policy, "script-src") ?? []
  return scripts.some((source) => /^'(nonce-|sha256-|sha384-|sha512-|strict-dynamic')/i.test(source))
}

export function analyzeCsp(
  enforcedHeader: string | null,
  reportOnlyHeader: string | null,
  metaPolicies: readonly string[],
  needs: readonly CspNeed[],
  pageOrigin: string
): CspAnalysis {
  const enforced = [...parseCspPolicies(enforcedHeader), ...metaPolicies.flatMap((text) => parseCspPolicies(text))]
  const reportOnly = parseCspPolicies(reportOnlyHeader)
  const policies = enforced.length > 0 ? enforced : reportOnly
  if (policies.length === 0) return { style: "none", missing: [], inlineBlocked: false }
  const missing: CspAnalysis["missing"] = []
  for (const need of needs) {
    if (policies.every((policy) => policyAllows(policy, need, pageOrigin))) continue
    const host = new URL(need.url).host
    if (!missing.some((row) => row.directive === need.directive && row.host === host)) {
      missing.push({ directive: need.directive, host, tool: need.tool })
    }
  }
  const nonce = policies.some(isNonceStyle)
  const inlineBlocked =
    !nonce &&
    policies.some((policy) => {
      const scripts = sourcesFor(policy, "script-src")
      return scripts !== null && !scripts.some((source) => source.toLowerCase() === "'unsafe-inline'")
    })
  if (enforced.length === 0) return { style: "report_only", missing, inlineBlocked }
  return { style: nonce ? "nonce" : "hosts", missing, inlineBlocked }
}

const ATTRIBUTE_ENTITIES: Record<string, string> = { "&amp;": "&", "&#39;": "'", "&apos;": "'", "&quot;": '"' }

/**
 * The four entities a CSP `content` attribute uses, decoded in ONE pass: `&amp;quot;` is the literal text
 * `&quot;`, never a second-round `"` (decoding `&amp;` first and then `&quot;` would unescape twice).
 */
export function decodeAttributeEntities(value: string): string {
  return value.replace(/&(?:amp|#39|apos|quot);/g, (entity) => ATTRIBUTE_ENTITIES[entity] ?? entity)
}

/** `<meta http-equiv="Content-Security-Policy" content="…">` policies in a page. */
export function metaCspPolicies(html: string): string[] {
  const policies: string[] = []
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/http-equiv\s*=\s*["']content-security-policy["']/i.test(tag)) continue
    const content = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag)
    const value = content?.[1] ?? content?.[2]
    if (value) policies.push(decodeAttributeEntities(value))
  }
  return policies
}

export interface CspInput {
  url: string
  expect: TestExpect
  /** The PostHog `api_host` the page really uses, when known (it decides proxy vs direct hosts). */
  observedPosthogApiHost?: string
}

export async function checkCsp(input: CspInput, deps: LiveProbeDeps, ctx: Pick<CheckContext, "runId" | "now">): Promise<CheckResult[]> {
  const evidence = [{ url: input.url }]
  const result = (state: CheckResult["state"], reason: string) => [checkResult(CSP_CHECK_ID, state, "T1", ctx, { reason, evidence })]
  const response = await probeFetch(input.url, deps, { accept: "text/html,application/xhtml+xml" })
  if (!response.ok) return result("undetermined", `the page could not be read (${response.detail}), so its policy was not checked`)
  const origin = new URL(response.finalUrl).origin
  const needs = cspNeeds(input.expect, origin, input.observedPosthogApiHost)
  const analysis = analyzeCsp(
    response.headers.get("content-security-policy"),
    response.headers.get("content-security-policy-report-only"),
    metaCspPolicies(response.text),
    needs,
    origin
  )
  const missing = analysis.missing.map((row) => `${row.directive} does not allow ${row.host} (${row.tool})`)
  switch (analysis.style) {
    case "none":
      return result("pass", "no Content-Security-Policy, so nothing blocks the tags")
    case "report_only":
      return result(
        "info",
        `only a Report-Only policy, so nothing is blocked${missing.length > 0 ? `; enforcing it as written would block: ${missing.join("; ")}` : ""}`
      )
    case "nonce":
      return result(
        "undetermined",
        `the policy uses nonces, hashes or 'strict-dynamic', so whether the tags run cannot be read from the header${missing.length > 0 ? ` (its host lists refuse: ${missing.join("; ")})` : ""}; the test visit's blocked-request count decides`
      )
    case "hosts": {
      // Nothing to check against is not a pass: the policy was read, but no tool was measured.
      if (needs.length === 0) return result("info", "a host-list policy is in place; no expected tool was given to check against it")
      const problems = [...missing, ...(analysis.inlineBlocked ? ["script-src does not allow inline scripts ('unsafe-inline'), so the inline tag snippets cannot run"] : [])]
      if (problems.length > 0) return result("problem", `the policy blocks the tags: ${problems.join("; ")}`)
      return result("pass", "the policy allows every host the tags need")
    }
  }
}
