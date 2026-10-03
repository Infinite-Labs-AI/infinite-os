// Job 6 (`duplicates_remove`) trigger detector (lane O8). A duplicate is seeded as a CANDIDATE only;
// the job runs only under an approved `remove_duplicate` plan line (never under `--yes`).
//
// Three shapes (§3e.1 job 6):
// - `repeated_init`: one id initialised / configured more than once on the same page (census count > 1:
//   two `posthog.init`, two `gtag('config', id)`, two `fbq('init', id)`). A static multi-page site that
//   carries ONE snippet per HTML page is not a duplicate;
// - `managed_and_adopted`: the wizard's managed provider and the customer's own copy of the same tool;
// - `gtm_and_gtag`: Tag Manager AND a hand-written gtag firing the SAME measurement id. This one is
//   decided from `before`'s `dry_live` evidence (more than one `page_view` for that id in one load),
//   never from rehearsal data that does not exist yet (R2-10). Without the dry load it is not seeded.
import type { CensusEntry, CensusResult, Evidence } from "../../wizard/contracts/jobs.js"
import type { TestResult, TestTool } from "../../wizard/contracts/test-engine.js"

export type DuplicateKind = "repeated_init" | "managed_and_adopted" | "gtm_and_gtag"

export interface DuplicateFinding {
  kind: DuplicateKind
  tool: TestTool
  id: string | null
  /** The item target (`ga4_gtag`, `posthog_init`, `meta_init:<id>`, …). */
  target: string
  evidence: Evidence[]
  /**
   * The files the job may edit: the owner that GOES only. GTM + gtag → the hand-written gtag's files
   * (never the Tag Manager snippet; GTM edits are never the agent's job); managed + adopted → the site's
   * own copy (never Infinite's managed block); a repeated init → every file holding it.
   */
  editFiles: string[]
  detail: string
}

const filesOf = (entries: readonly CensusEntry[]): string[] => [...new Set(entries.map((entry) => entry.file))].sort()
const at = (entries: readonly CensusEntry[]): string => evidenceOf(entries).map((entry) => ("file" in entry ? `${entry.file}:${entry.line}` : "")).join(", ")

const INIT_KINDS: ReadonlySet<CensusEntry["kind"]> = new Set(["gtag_config", "posthog_init", "fbq_init", "next_google_analytics", "react_ga", "managed_block"])
const SHORT_KIND: Record<TestTool, string> = { ga4: "ga4_config", posthog: "posthog_init", meta: "meta_init", infinite: "infinite_init" }

function evidenceOf(entries: readonly CensusEntry[]): Evidence[] {
  const seen = new Set<string>()
  const out: Evidence[] = []
  for (const entry of [...entries].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))) {
    const key = `${entry.file}:${entry.line}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ file: entry.file, line: entry.line })
  }
  return out
}

function isHtml(path: string): boolean {
  return /\.html?$/i.test(path)
}

/** True when the entries for one id are one per HTML page (a multi-page site), which is not a duplicate. */
function onePerHtmlPage(entries: readonly CensusEntry[]): boolean {
  if (!entries.every((entry) => isHtml(entry.file))) return false
  const perFile = new Map<string, number>()
  for (const entry of entries) perFile.set(entry.file, (perFile.get(entry.file) ?? 0) + 1)
  return [...perFile.values()].every((count) => count === 1)
}

/** Most `page_view` beacons for one GA4 id in a single load of the dry run. */
export function maxPageViewsPerLoad(dryLive: TestResult | null, measurementId: string): number {
  if (!dryLive) return 0
  const perLoad = new Map<string, number>()
  for (const event of dryLive.ga4.events) {
    if (event.tid !== measurementId || event.en !== "page_view" || event.afterNav) continue
    perLoad.set(event.loadLabel, (perLoad.get(event.loadLabel) ?? 0) + 1)
  }
  return Math.max(0, ...perLoad.values())
}

/** Pure. */
export function detectDuplicates(census: CensusResult, dryLive: TestResult | null): DuplicateFinding[] {
  const findings: DuplicateFinding[] = []
  const tools: TestTool[] = ["ga4", "posthog", "meta", "infinite"]
  for (const tool of tools) {
    const entries = census.entries.filter((entry) => entry.tool === tool && INIT_KINDS.has(entry.kind))
    // repeated_init, per literal id.
    const byId = new Map<string, CensusEntry[]>()
    for (const entry of entries) {
      if (entry.id === null) continue
      byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry])
    }
    for (const id of [...byId.keys()].sort()) {
      const group = byId.get(id)!
      if (group.length < 2 || onePerHtmlPage(group)) continue
      findings.push({
        kind: "repeated_init",
        tool,
        id,
        target: `${SHORT_KIND[tool]}:${id}`,
        evidence: evidenceOf(group),
        editFiles: filesOf(group),
        detail: `${id} is set up ${group.length} times (${at(group)})`
      })
    }
    // managed_and_adopted.
    const managed = entries.filter((entry) => entry.owner === "managed")
    const adopted = entries.filter((entry) => entry.owner === "adopted")
    if (managed.length > 0 && adopted.length > 0) {
      findings.push({
        kind: "managed_and_adopted",
        tool,
        id: null,
        target: `${tool}_managed_adopted`,
        evidence: evidenceOf([...managed, ...adopted]),
        editFiles: filesOf(adopted),
        detail: `${tool} is installed by Infinite (${at(managed)}) and by the site (${at(adopted)}); remove the site's copy, keep Infinite's`
      })
    }
  }
  // gtm_and_gtag: decided from the dry load only.
  const gtm = census.entries.filter((entry) => entry.kind === "gtm")
  if (gtm.length > 0 && dryLive) {
    const handGtags = census.entries.filter((entry) => entry.tool === "ga4" && entry.kind === "gtag_config" && entry.owner === "adopted" && entry.id !== null)
    const ids = [...new Set(handGtags.map((entry) => entry.id as string))].sort()
    for (const id of ids) {
      if (maxPageViewsPerLoad(dryLive, id) < 2) continue
      const load = dryLive.loads[0]
      const gtags = handGtags.filter((entry) => entry.id === id)
      findings.push({
        kind: "gtm_and_gtag",
        tool: "ga4",
        id,
        target: ids.length === 1 ? "ga4_gtag" : `ga4_gtag:${id}`,
        evidence: [...evidenceOf([...gtm, ...gtags]), ...(load ? [{ url: load.url }] : [])],
        editFiles: filesOf(gtags),
        detail: `Tag Manager (${at(gtm)}) and a hand-written gtag (${at(gtags)}) both send ${id} (2 page views per visit in the live test); remove the hand-written gtag, keep Tag Manager`
      })
    }
  }
  return findings
}
