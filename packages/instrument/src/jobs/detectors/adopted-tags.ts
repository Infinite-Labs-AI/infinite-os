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

const GUARD_EVIDENCE =
  /\blocation\s*\.\s*(?:hostname|host)\b|\bdocument\s*\.\s*location\s*\.\s*host|infiniteHostGuard|__infiniteHostAllowed|data-infinite-host-guard|\bVERCEL_ENV\b\s*[!=]==?\s*["'`]production["'`]|["'`]production["'`]\s*[!=]==?\s*[\w.]*VERCEL_ENV\b|\bisProductionHost\s*\(/

/** How many lines above an init a guard may sit (the enclosing `if` / early return). */
export const GUARD_WINDOW_LINES = 15

function isGuarded(text: string, line: number): boolean {
  const lines = text.split("\n")
  const from = Math.max(0, line - 1 - GUARD_WINDOW_LINES)
  const window = lines.slice(from, line).join("\n")
  return GUARD_EVIDENCE.test(window)
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
      sendsDirect
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
