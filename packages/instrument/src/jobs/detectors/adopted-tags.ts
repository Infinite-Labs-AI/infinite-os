// Detectors over the customer's ADOPTED tags (lane O8), for jobs 3, 5 and 7. They read the census
// entries (lane O6) for WHERE each adopted init is, then the file text for HOW it is set up.
//
// - Job 7 (`preview_guard`, adopted targets): an adopted GA4 / PostHog init or an adopted Meta bootstrap
//   with no host guard around it fires on every preview deployment. A guard is a production-host check
//   (`location.hostname`, the wizard's emitted guard expression) or a production-only env gate
//   (`VERCEL_ENV === "production"`). Only a positive read counts: an init whose file is not in the
//   snapshot is not reported.
// - Job 3 (`posthog_improve`): the adopted PostHog's `api_host` (direct to PostHog = ad blockers drop
//   it), `capture_pageview` on an SPA, `ui_host`.
// - Job 5 (`meta_improve`): browser STANDARD conversions fired with `fbq('track', …)` (they belong on
//   the server-instructed mirror, never on a click).
import { readPosthogOption } from "../../inspect.js"
import type { CensusEntry, CensusResult } from "../../wizard/contracts/jobs.js"
import type { RepoSnapshot } from "../repo-files.js"
import { codeMatches, isNonProductPath, sortFindings, type Finding } from "./shared.js"

export type GuardableTool = "ga4" | "posthog" | "meta"

export interface UnguardedInitFinding extends Finding {
  tool: GuardableTool
}

const GUARDABLE_KINDS: Record<GuardableTool, ReadonlyArray<CensusEntry["kind"]>> = {
  ga4: ["gtag_config", "next_google_analytics", "react_ga"],
  posthog: ["posthog_init"],
  meta: ["fbq_init"]
}

/**
 * A guard is evidence that PREVIEWS are excluded, not merely that the code looks at the host: the
 * wizard's own guard markers, a production-only env gate, or a host check that names a preview host
 * suffix (host-deny-v1) or compares the host with a real (dotted, non-local) production host. A
 * `location.hostname === 'localhost'` check alone keeps previews firing, so it is NOT a guard
 * (review P2-9).
 */
const GUARD_MARKERS =
  /infiniteHostGuard|__infiniteHostAllowed|data-infinite-host-guard|(?:\b|_)VERCEL_ENV\b\s*[!=]==?\s*["'`]production["'`]|["'`]production["'`]\s*[!=]==?\s*[\w.]*VERCEL_ENV\b|\bisProductionHost\s*\(/
const HOST_READ = /\blocation\s*\.\s*(?:hostname|host)\b/
/** host-deny-v1's preview suffixes (`contracts/host-deny-v1.json`). */
const PREVIEW_SUFFIX = /\.vercel\.app|\.netlify\.app|\.pages\.dev/
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)$|\.(?:localhost|local)$/i
const QUOTED_HOST = /["'`]((?:[a-z0-9-]+\.)+[a-z]{2,})["'`]/gi

function hostCheckExcludesPreviews(window: string): boolean {
  if (!HOST_READ.test(window)) return false
  if (PREVIEW_SUFFIX.test(window)) return true
  for (const match of window.matchAll(QUOTED_HOST)) {
    const host = match[1]!.toLowerCase()
    if (!LOCAL_HOST.test(host) && !/\.(?:js|ts|tsx|jsx|mjs|json|html|css)$/.test(host)) return true
  }
  return false
}

/** How many lines above an init a guard may sit (the enclosing `if` / early return). */
export const GUARD_WINDOW_LINES = 15

function isGuarded(text: string, line: number): boolean {
  const lines = text.split("\n")
  const from = Math.max(0, line - 1 - GUARD_WINDOW_LINES)
  const window = lines.slice(from, line).join("\n")
  return GUARD_MARKERS.test(window) || hostCheckExcludesPreviews(window)
}

/** Pure: adopted inits with no host guard, one per (tool, file). */
export function detectUnguardedAdoptedInits(snapshot: RepoSnapshot, census: CensusResult): UnguardedInitFinding[] {
  const findings: UnguardedInitFinding[] = []
  for (const tool of Object.keys(GUARDABLE_KINDS) as GuardableTool[]) {
    const seenFiles = new Set<string>()
    for (const entry of census.entries) {
      if (entry.tool !== tool || entry.owner !== "adopted" || !GUARDABLE_KINDS[tool].includes(entry.kind)) continue
      if (seenFiles.has(entry.file) || isNonProductPath(entry.file)) continue
      const text = snapshot.files.get(entry.file)
      if (text === undefined) continue
      seenFiles.add(entry.file)
      if (isGuarded(text, entry.line)) continue
      findings.push({ file: entry.file, line: entry.line, detail: `adopted ${tool} init without a host guard`, tool })
    }
  }
  return sortFindings(findings)
}

export interface AdoptedPosthogConfig extends Finding {
  apiHost: string | null
  capturePageview: string | null
  uiHost: string | null
  /** `api_host` points at PostHog's own host (or is unset), so ad blockers drop the requests. */
  sendsDirect: boolean
  /** `defaults: '<date>'` (a defaults date of 2025-05-24 or later already captures history changes). */
  defaults: string | null
}

/** PostHog's `defaults` date from which `capture_pageview` follows history changes. */
export const POSTHOG_HISTORY_DEFAULTS_FROM = "2025-05-24"

/** True when the site captures `$pageview` by hand (PostHog's own Next.js app-router recipe). */
export function capturesPageviewManually(snapshot: RepoSnapshot): boolean {
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path) || !text.includes("$pageview")) continue
    if (codeMatches(text, /\bcapture\s*\(\s*["'`]\$pageview["'`]/g).length > 0) return true
  }
  return false
}

/**
 * True when PostHog already counts single-page navigations: `capture_pageview: 'history_change'`, a
 * `defaults` date of 2025-05-24 or later, or a hand-written `$pageview` capture (switching
 * history_change on there would count every navigation twice; review P2-8).
 */
export function posthogCountsNavigations(config: AdoptedPosthogConfig, manualPageview: boolean): boolean {
  if (config.capturePageview === "history_change") return true
  if (manualPageview) return true
  return config.defaults !== null && /^\d{4}-\d{2}-\d{2}$/.test(config.defaults) && config.defaults >= POSTHOG_HISTORY_DEFAULTS_FROM
}

/** Pure: each adopted `posthog.init` file's routing options. */
export function detectAdoptedPosthogConfig(snapshot: RepoSnapshot, census: CensusResult): AdoptedPosthogConfig[] {
  const out: AdoptedPosthogConfig[] = []
  const seen = new Set<string>()
  for (const entry of census.entries) {
    if (entry.tool !== "posthog" || entry.owner !== "adopted" || entry.kind !== "posthog_init" || seen.has(entry.file)) continue
    const text = snapshot.files.get(entry.file)
    if (text === undefined) continue
    seen.add(entry.file)
    const apiHost = readPosthogOption(text, "api_host") ?? null
    const sendsDirect = apiHost === null || /posthog\.com/i.test(apiHost)
    out.push({
      file: entry.file,
      line: entry.line,
      detail: sendsDirect ? "PostHog sends straight to PostHog" : "PostHog sends through a proxy",
      apiHost,
      capturePageview: readPosthogOption(text, "capture_pageview") ?? null,
      uiHost: readPosthogOption(text, "ui_host") ?? null,
      sendsDirect,
      defaults: readPosthogOption(text, "defaults") ?? null
    })
  }
  return sortFindings(out)
}

/** Meta's standard events (fbevents' list). A browser `fbq('track', <standard>)` belongs on the mirror. */
export const META_STANDARD_EVENTS = [
  "AddPaymentInfo",
  "AddToCart",
  "AddToWishlist",
  "CompleteRegistration",
  "Contact",
  "CustomizeProduct",
  "Donate",
  "FindLocation",
  "InitiateCheckout",
  "Lead",
  "Purchase",
  "Schedule",
  "Search",
  "StartTrial",
  "SubmitApplication",
  "Subscribe",
  "ViewContent"
] as const

/** Pure: browser `fbq('track', <standard event>)` calls (PageView excluded). */
export function detectMetaBrowserStandardEvents(snapshot: RepoSnapshot): Finding[] {
  const out: Finding[] = []
  const pattern = new RegExp(`\\bfbq\\s*\\(\\s*["'\`]track["'\`]\\s*,\\s*["'\`](${META_STANDARD_EVENTS.join("|")})["'\`]`, "g")
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path) || !text.includes("fbq")) continue
    for (const match of codeMatches(text, new RegExp(pattern.source, "g"))) {
      out.push({ file: path, line: match.line, detail: `fbq track ${match.match[1]}` })
    }
  }
  return sortFindings(out)
}
