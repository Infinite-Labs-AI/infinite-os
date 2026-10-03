// T1 `redirect_walk`: do campaign tags survive every redirect hop?
//
// A link from an ad lands on `https://acme.com/?utm_source=meta&fbclid=…`. If a redirect on the way
// (apex → www, http → https, a trailing-slash rule, an old path) rebuilds the URL without its query,
// the visitor arrives untagged: the visit is "direct", the `_fbc` click id is never written, and the
// ad that paid for it gets no credit. Nothing on the page can see this, because the page only ever
// sees the URL it ended up on.
//
// The walk follows each hop BY HAND (`redirect: "manual"`), with HEAD and `Purpose: prefetch` (GET only
// when a server refuses HEAD), and compares the query at every hop with what it started with.
//
// The test click ids carry the `INFINITE_TEST_NOT_REAL_` marker (decision 12: a fake click id only on a
// no-send load — this walk loads no page and runs no script), so one that leaks anywhere is
// recognisable as ours.
//
// Incident guarded (PORT-PLAN §4): the `vercel.json` redirect that ran before middleware (42e7a3c) —
// `redirectsCoveringPaths` flags a config redirect whose source covers a counted path; the walk
// proves the hops keep the query live.
import { FAKE_CLICK_ID_PREFIX } from "../../wizard/contracts/test-engine.js"
import type { CheckContext, CheckResult } from "../../wizard/contracts/jobs.js"
import { checkResult } from "../result.js"

import { probeFetch, type LiveProbeDeps } from "./probe.js"

export const REDIRECT_WALK_CHECK_ID = "redirect_walk" as const
export const REDIRECT_WALK_MAX_HOPS = 10

export interface RedirectWalkInput {
  urls: readonly string[]
  /** The run id (for the marker suffix); doctor passes none. */
  runId?: string | null
}

/**
 * The query the walk starts with: `utm_*` ONLY (B19). The walk reads PRODUCTION, so it never carries a fake
 * click id (decision 12 keeps `fbclid`/`gclid` to no-send loads; their survival is tested in the rehearsal and
 * the preview's own dry load). The values are recognisable as test traffic.
 */
export function redirectTestParams(runId: string | null | undefined): Record<string, string> {
  const suffix = (runId ?? "").replace(/-/g, "").slice(0, 6) || "doctor"
  return {
    utm_source: "infinite_redirect_check",
    utm_medium: "redirect_walk",
    utm_campaign: `check_${suffix}`
  }
}

export interface RedirectHop {
  from: string
  to: string
  status: number
}

export type RedirectWalk =
  | { kind: "kept"; hops: RedirectHop[]; finalStatus: number }
  | { kind: "dropped"; hops: RedirectHop[]; at: RedirectHop; missing: string[] }
  | { kind: "loop"; hops: RedirectHop[] }
  | { kind: "too_many"; hops: RedirectHop[] }
  | { kind: "unreachable"; hops: RedirectHop[]; detail: string }

export async function walkRedirects(startUrl: string, params: Record<string, string>, deps: LiveProbeDeps): Promise<RedirectWalk> {
  const start = new URL(startUrl)
  for (const [key, value] of Object.entries(params)) start.searchParams.set(key, value)
  const hops: RedirectHop[] = []
  const seen = new Set<string>()
  let current = start.href
  for (let hop = 0; hop <= REDIRECT_WALK_MAX_HOPS; hop += 1) {
    if (seen.has(current)) return { kind: "loop", hops }
    seen.add(current)
    let response = await probeFetch(current, deps, { method: "HEAD", redirect: "manual" })
    if (!response.ok && (response.status === 405 || response.status === 501)) {
      response = await probeFetch(current, deps, { method: "GET", redirect: "manual" })
    }
    if (!response.ok) {
      return { kind: "unreachable", hops, detail: response.status === 0 ? response.detail : `the page answered HTTP ${response.status}` }
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null
    if (!location) return { kind: "kept", hops, finalStatus: response.status }
    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      return { kind: "unreachable", hops, detail: `hop ${hops.length + 1} redirects to an unreadable Location` }
    }
    const step: RedirectHop = { from: current, to: next.href, status: response.status }
    hops.push(step)
    const missing = Object.entries(params)
      .filter(([key, value]) => next.searchParams.get(key) !== value)
      .map(([key]) => key)
    if (missing.length > 0) return { kind: "dropped", hops, at: step, missing }
    current = next.href
  }
  return { kind: "too_many", hops }
}

function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url
  }
}

export async function checkRedirectWalk(
  input: RedirectWalkInput,
  deps: LiveProbeDeps,
  ctx: Pick<CheckContext, "runId" | "now">
): Promise<CheckResult[]> {
  const params = redirectTestParams(input.runId ?? ctx.runId)
  const results: CheckResult[] = []
  for (const url of input.urls) {
    const evidence = [{ url: withoutQuery(url) }]
    const result = (state: CheckResult["state"], reason: string) =>
      checkResult(REDIRECT_WALK_CHECK_ID, state, "T1", ctx, { reason, evidence })
    let walk: RedirectWalk
    try {
      walk = await walkRedirects(url, params, deps)
    } catch (error) {
      results.push(result("undetermined", `test error: ${error instanceof Error ? error.message : String(error)}`))
      continue
    }
    const path = walk.hops.map((hop) => `${hop.status} → ${withoutQuery(hop.to)}`).join(", ")
    switch (walk.kind) {
      case "kept":
        results.push(
          result(
            "pass",
            walk.hops.length === 0
              ? "no redirect: the landing URL keeps its campaign tags"
              : `every hop keeps utm_* (${walk.hops.length} hop${walk.hops.length === 1 ? "" : "s"}: ${path})`
          )
        )
        break
      case "dropped":
        results.push(
          result(
            "problem",
            `hop ${walk.hops.length} (${withoutQuery(walk.at.from)} → ${withoutQuery(walk.at.to)}, HTTP ${walk.at.status}) drops ${walk.missing.join(", ")} — ad clicks through this redirect arrive untagged and unattributed`
          )
        )
        break
      case "loop":
        results.push(result("problem", `the redirects loop (${path})`))
        break
      case "too_many":
        results.push(result("problem", `more than ${REDIRECT_WALK_MAX_HOPS} redirect hops (${path})`))
        break
      case "unreachable":
        results.push(result("undetermined", `the walk could not finish: ${walk.detail}${path ? ` after ${path}` : ""}`))
        break
    }
  }
  return results
}

// ---- Static companion: a config redirect that swallows a counted path -------------------------

export interface RedirectCoverage {
  source: string
  covers: string
  why: "conversion_path" | "middleware_matcher"
}

/**
 * Redirects in `vercel.json` run BEFORE middleware, so a redirect whose `source` covers a conversion
 * path or a middleware matcher path means the server lane never sees that request (incident 42e7a3c).
 * Pure; returns one row per (redirect, covered path). Unparseable JSON returns null (undetermined).
 */
export function redirectsCoveringPaths(
  vercelJsonText: string,
  paths: { conversionPaths: readonly string[]; matcherPaths: readonly string[] }
): RedirectCoverage[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(vercelJsonText)
  } catch {
    return null
  }
  const redirects = (parsed as { redirects?: unknown }).redirects
  if (!Array.isArray(redirects)) return []
  const rows: RedirectCoverage[] = []
  for (const entry of redirects) {
    const source = (entry as { source?: unknown })?.source
    if (typeof source !== "string") continue
    const pattern = vercelSourcePattern(source)
    for (const [list, why] of [
      [paths.conversionPaths, "conversion_path"],
      [paths.matcherPaths, "middleware_matcher"]
    ] as const) {
      for (const path of list) if (pattern.test(path)) rows.push({ source, covers: path, why })
    }
  }
  return rows
}

/** A Vercel `source` (path-to-regexp style) as a RegExp: `:param`, `:param*`, `(.*)`, `*`. */
export function vercelSourcePattern(source: string): RegExp {
  let out = ""
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string
    if (char === ":") {
      const name = /^:[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index))?.[0] ?? ":"
      index += name.length - 1
      const next = source[index + 1]
      if (next === "(") {
        const close = source.indexOf(")", index + 1)
        out += `(${source.slice(index + 2, close)})`
        index = close
      } else if (next === "*") {
        out += "(.*)"
        index += 1
      } else if (next === "+") {
        out += "(.+)"
        index += 1
      } else {
        out += "([^/]+)"
      }
      continue
    }
    if (char === "(") {
      const close = source.indexOf(")", index)
      out += `(${source.slice(index + 1, close)})`
      index = close
      continue
    }
    if (char === "*") {
      out += ".*"
      continue
    }
    out += char.replace(/[.+?^${}|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${out}$`)
}
