// Check 5 — the same provider started twice on one page.
//
// `providerInstallEvidence` (provider-evidence.ts) de-duplicates on (provider, via, key), and the
// harness keeps the first file per provider (scout S5 fact 7), so two `gtag('config', 'G-X')` in one
// page, or infinite-tag's managed PostHog next to the site's own, were silently merged into "GA4 is
// installed". Each extra init sends its own page view: the numbers are wrong by a whole factor and
// nothing anywhere looks broken.
//
// This census counts EVERY init with NO dedupe, per file, split into managed (infinite-tag's own
// block / Next bootstrap) and adopted (the site's) bytes, comments ignored:
//   • the same id twice in ONE file (one page)                         → problem (certain);
//   • a shared entry (runs on every page) + the same id in another file → problem (likely);
//   • managed + adopted for the same tool on one page / shared entry    → problem;
//   • GTM + a hand-written gtag on one page                             → info (the container is not read);
//   • two different ids for one tool across the app                     → info.
// Pages of a multi-page static site are separate pages: the same id once per page is correct.
//
// Incidents guarded (PORT-PLAN §4): the 849ccf1 merge near-miss (the census must see every block),
// and the 9fcbefa preview leak's static half (`censusEntries` exposes every literal id, so a default id
// that is not the connection's shows up).
import type { CensusEntry } from "../wizard/contracts/jobs.js"

import { isSharedEntry } from "./click-id-capture.js"
import { codeView, groupFindings, isHtmlFile, sourceUnits, unitLine } from "./code-view.js"
import {
  providerDuplicateInitMessage,
  providerGtmAndGtagMessage,
  providerManagedAndAdoptedMessage,
  providerMultipleIdsMessage
} from "./copy.js"
import { worstState, type SetupCheckResult, type SetupFinding } from "./types.js"

const PATTERNS: ReadonlyArray<{ tool: CensusEntry["tool"]; kind: CensusEntry["kind"]; pattern: RegExp }> = [
  { tool: "ga4", kind: "gtag_config", pattern: /\b(?:window\.)?gtag\s*\(\s*["']config["']\s*,\s*(?:["'](G-[A-Z0-9]+)["']|[A-Za-z_$])/g },
  { tool: "ga4", kind: "next_google_analytics", pattern: /<GoogleAnalytics\b[^>]*\bgaId\s*=\s*\{?\s*(?:["'](G-[A-Z0-9]+)["']|[A-Za-z_$])/g },
  { tool: "ga4", kind: "react_ga", pattern: /\bReactGA\.initialize\s*\(\s*(?:["'](G-[A-Z0-9]+)["']|[A-Za-z_$])/g },
  { tool: "posthog", kind: "posthog_init", pattern: /\bposthog\.init\s*\(\s*(?:["'](phc_[A-Za-z0-9_]+)["']|[A-Za-z_$])/g },
  { tool: "meta", kind: "fbq_init", pattern: /\b(?:window\.)?fbq\s*\(\s*["']init["']\s*,\s*(?:["'](\d{6,24})["']\s*\)|[A-Za-z_$][\w$.]*\s*\))/g },
  { tool: "x", kind: "gtm", pattern: /googletagmanager\.com\/gtm\.js\?id=(GTM-[A-Z0-9]+)|["'](GTM-[A-Z0-9]{4,})["']/g }
]

const TOOL_LABEL: Record<CensusEntry["tool"], string> = {
  ga4: "GA4",
  posthog: "PostHog",
  meta: "the Meta pixel",
  infinite: "Infinite",
  x: "Tag Manager"
}

/**
 * Every provider init in the app, one entry per occurrence (no dedupe). GTM containers are reported
 * with `kind: "gtm"` and `tool: "x"` (the contract's catch-all tool for non-graded tags).
 */
export function censusEntries(files: ReadonlyMap<string, string>): CensusEntry[] {
  const entries: CensusEntry[] = []
  for (const unit of sourceUnits(files)) {
    const text = codeView(unit.file, unit.text)
    for (const { tool, kind, pattern } of PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const id = match[1] ?? match[2] ?? null
        entries.push({ tool, kind, id, file: unit.file, line: unitLine(unit, match.index ?? 0), owner: unit.managed ? "managed" : "adopted" })
      }
    }
  }
  return entries
}

const MAX_PLACES = 5

export interface ProviderCensusInput {
  files: ReadonlyMap<string, string>
}

export function checkProviderCensus(input: ProviderCensusInput): SetupCheckResult {
  const entries = censusEntries(input.files)
  const findings: SetupFinding[] = []
  const place = (entry: CensusEntry) => `${entry.file}:${entry.line}`
  const tools = entries.filter((entry) => entry.kind !== "gtm")

  // 1. The same id more than once in ONE file.
  const flagged = new Set<string>()
  const byFileAndId = groupBy(tools.filter((entry) => entry.id !== null), (entry) => `${entry.file}\u0000${entry.tool}\u0000${entry.id}`)
  const sameFile: SetupFinding[] = []
  const keyOf = new Map<SetupFinding, string>()
  for (const group of byFileAndId.values()) {
    if (group.length < 2) continue
    const first = group[0] as CensusEntry
    const key = `${first.tool}\u0000${first.id}`
    flagged.add(key)
    sameFile.push({
      check: "provider_census",
      code: "INF_SETUP_PROVIDER_DUPLICATE_INIT",
      state: "problem",
      confidence: "certain",
      file: first.file,
      line: first.line,
      message: providerDuplicateInitMessage({ tool: TOOL_LABEL[first.tool], id: first.id as string, places: group.slice(0, MAX_PLACES).map(place), sameFile: true })
    })
    keyOf.set(sameFile[sameFile.length - 1] as SetupFinding, key)
  }
  // The same duplicate on many pages (a shared template) is one line, naming the other pages.
  findings.push(...groupFindings(sameFile, (finding) => keyOf.get(finding) ?? ""))

  // 2. A shared entry plus the same id in another (non-HTML) file.
  const byId = groupBy(tools.filter((entry) => entry.id !== null && !isHtmlFile(entry.file)), (entry) => `${entry.tool}\u0000${entry.id}`)
  for (const [key, group] of byId) {
    if (flagged.has(key)) continue
    const files = [...new Set(group.map((entry) => entry.file))]
    if (files.length < 2 || !files.some(isSharedEntry)) continue
    const first = group.find((entry) => isSharedEntry(entry.file)) as CensusEntry
    findings.push({
      check: "provider_census",
      code: "INF_SETUP_PROVIDER_DUPLICATE_INIT",
      state: "problem",
      confidence: "likely",
      file: first.file,
      line: first.line,
      message: providerDuplicateInitMessage({ tool: TOOL_LABEL[first.tool], id: first.id as string, places: group.slice(0, MAX_PLACES).map(place), sameFile: false })
    })
  }

  // 3. Managed + adopted for one tool, on one page or with the adopted one in a shared entry.
  for (const tool of ["ga4", "posthog", "meta"] as const) {
    const managed = tools.filter((entry) => entry.tool === tool && entry.owner === "managed")
    const adopted = tools.filter((entry) => entry.tool === tool && entry.owner === "adopted")
    if (managed.length === 0 || adopted.length === 0) continue
    const sameFile = adopted.find((entry) => managed.some((other) => other.file === entry.file))
    // Off one page: the managed code runs from a shared entry on every route, so an adopted init in any
    // non-HTML module (a provider component, `_app`) is very likely live on the same pages.
    const managedShared = managed.some((entry) => isSharedEntry(entry.file) && !isHtmlFile(entry.file))
    const shared =
      sameFile ??
      adopted.find((entry) => !isHtmlFile(entry.file) && (isSharedEntry(entry.file) || managedShared))
    if (!shared) continue
    const managedAt = managed.find((entry) => entry.file === shared.file) ?? (managed[0] as CensusEntry)
    findings.push({
      check: "provider_census",
      code: "INF_SETUP_PROVIDER_MANAGED_AND_ADOPTED",
      state: "problem",
      confidence: sameFile ? "certain" : "likely",
      file: shared.file,
      line: shared.line,
      message: providerManagedAndAdoptedMessage({ tool: TOOL_LABEL[tool], managed: place(managedAt), adopted: place(shared), sameFile: sameFile !== undefined })
    })
  }

  // 4. GTM and a hand-written gtag config on one page / in a shared entry.
  const gtm = entries.filter((entry) => entry.kind === "gtm" && entry.id !== null)
  for (const container of gtm) {
    const gtag = tools.find(
      (entry) => entry.tool === "ga4" && entry.id !== null && (entry.file === container.file || (isSharedEntry(entry.file) && isSharedEntry(container.file)))
    )
    if (!gtag) continue
    findings.push({
      check: "provider_census",
      code: "INF_SETUP_PROVIDER_GTM_AND_GTAG",
      state: "info",
      confidence: "likely",
      file: container.file,
      line: container.line,
      message: providerGtmAndGtagMessage({ container: container.id as string, ga4Id: gtag.id as string, file: container.file })
    })
    break
  }

  // 5. Several literal ids for one tool.
  for (const tool of ["ga4", "posthog", "meta"] as const) {
    const ids = new Map<string, string>()
    for (const entry of tools) if (entry.tool === tool && entry.id !== null && !ids.has(entry.id)) ids.set(entry.id, entry.file)
    if (ids.size < 2) continue
    const first = tools.find((entry) => entry.tool === tool && entry.id !== null) as CensusEntry
    findings.push({
      check: "provider_census",
      code: "INF_SETUP_PROVIDER_MULTIPLE_IDS",
      state: "info",
      confidence: "likely",
      file: first.file,
      line: first.line,
      message: providerMultipleIdsMessage({ tool: TOOL_LABEL[tool], ids: [...ids].slice(0, MAX_PLACES).map(([id, file]) => ({ id, file })) })
    })
  }

  return { check: "provider_census", state: worstState(findings), findings }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item])
  return groups
}
