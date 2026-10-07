import { planExclusions } from "../install/plan-exclusions.js"
import { withNote } from "./state-machine.js"
import { isContinuedWork } from "../install/plan-permission.js"
import { scopeOwnerJob } from "./owner-scope.js"
// The checklist job registry (lane O8; §3e.1, §3e.7). It turns what `before` measured into CANDIDATE
// checklist items, keeps only the ones the user's plan approved, hands each agent job its allowlist and
// brief, and computes item states from the wizard's own check results.
//
// NORMATIVE (§3e.7, R1-03):
// - `seedCandidates(scan, beforeFacts)` runs in `before`. It is deterministic for the same input and
//   reads NOTHING from an agent. Each candidate names the plan line kind it needs
//   (`requiredLineKind`), so lane O7 can put its id in that line's `jobIds`.
// - `applyApprovals(candidates, plan, approvals)` runs after `plan`: a candidate whose line was
//   declined is dropped; one whose required line is unanswered is `blocked:needs_you`; an
//   adopted-provider job (or any job that needs a line) with no such line in the plan is never seeded.
// - Claims never tick anything (`state-machine.ts`); `proven` needs THIS run's id on every live check.
import { CONVERSION_TYPES, type ConversionType } from "../wizard/contracts/bridge.js"
import type { PlanLineKind } from "../wizard/contracts/asks.js"
import {
  JOB_TABLE,
  type BeforeFacts,
  type BlockedReason,
  type ChecklistItem,
  type CheckResult,
  type CheckTier,
  type Evidence,
  type JobCheckSpec,
  type JobId,
  type JobRegistry,
  type PlanApprovals,
  type PlanModel,
  type ScanResult
} from "../wizard/contracts/jobs.js"
import type { TestTool } from "../wizard/contracts/test-engine.js"
import { buildAllow, unionAllow, isConsentLine, type AllowSpec } from "./allow.js"
import { buildBrief, prescribedPasteOf, type BriefFacts } from "./briefs.js"
import {
  capturesPageviewManually,
  detectAdoptedPosthogConfig,
  detectUnguardedAdoptedInits,
  posthogCountsNavigations
} from "./detectors/adopted-tags.js"
import { detectDuplicates } from "./detectors/duplicates.js"
import { OUTCOME_CONVERSION_TYPES } from "./detectors/outcomes.js"
import { isJobScan, scanForJobs, type JobScan } from "./detectors/index.js"
import { approvedConversionNames, boundConversionNames } from "./plan-data.js"
import { repoPath, type RepoSnapshot } from "./repo-files.js"
import { applyResults } from "./state-machine.js"
import { MANAGED_NEXT_CONFIG_FILE } from "../frameworks/vercel-config.js"
import type { Scanner } from "../review/scan.js"

// ---------------------------------------------------------------------------------------------
// Item ids and the plan line each candidate needs
// ---------------------------------------------------------------------------------------------

/** A stable, readable slug of a repo path for an item target (`src/server.ts` → `src_server_ts`). */
export function pathSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "root"
}

/** `<jobId>:<target>`. */
export function itemId(jobId: JobId, target: string): string {
  return `${jobId}:${target}`
}

/** The target half of an item id. */
export function itemTarget(item: Pick<ChecklistItem, "id">): string {
  const index = item.id.indexOf(":")
  return index < 0 ? "" : item.id.slice(index + 1)
}

/**
 * The plan line kind a candidate needs before it is seeded, or null when it needs none (it is still
 * dropped if a line naming it is declined). ONE seeding gate (§3z.12 §3e.5, B13), with a required line
 * kind PER TARGET, so lane O7's own improve seeds and the installer's open jobs go through the same rule:
 *   posthog_improve:defaults           → posthog_defaults_bump_adopted
 *   posthog_improve:sensitive_pages    → sensitive_pages
 *   posthog_improve:history_change / :proxy (and any other) → improve_additive
 *   ga4_improve:*                      → improve_additive
 *   meta_improve:capture…              → capture_beside_adopted_pixel
 *   meta_improve:autoconfig_off_adopted→ autoconfig_off_adopted
 *   meta_improve:retire_fbc_writer…    → retire_fbc_writer
 *   meta_improve:* (the mirror wiring) → improve_additive
 *   preview_guard:<tool>               → preview_guard_adopted
 *   server_lane_mount                  → server_lane (plan-wide)
 * Job 1 mounts the server lane, so it needs the approved `server_lane` line: declining the lane drops it.
 */
export function requiredLineKind(item: Pick<ChecklistItem, "id" | "jobId">): PlanLineKind | null {
  const target = itemTarget(item)
  const startsWith = (prefix: string) => target === prefix || target.startsWith(`${prefix}:`) || target.startsWith(`${prefix}-`) || target.startsWith(prefix)
  switch (item.jobId) {
    case "server_lane_mount":
      return "server_lane"
    case "posthog_improve":
      if (startsWith("defaults")) return "posthog_defaults_bump_adopted"
      if (startsWith("sensitive_pages")) return "sensitive_pages"
      return "improve_additive"
    case "ga4_improve":
      // R4-8: GA4's page-change page_view is its own line (a change to the customer's own tag, approved by the user).
      if (startsWith("spa_page_view")) return "ga4_spa_page_views"
      return "improve_additive"
    case "meta_improve":
      if (startsWith("retire_fbc_writer")) return "retire_fbc_writer"
      if (startsWith("autoconfig_off_adopted")) return "autoconfig_off_adopted"
      if (startsWith("capture")) return "capture_beside_adopted_pixel"
      if (startsWith("spa_page_view")) return "meta_spa_page_views"
      return "improve_additive"
    case "duplicates_remove":
      return "remove_duplicate"
    case "preview_guard":
      return "preview_guard_adopted"
    case "server_conversions":
    case "conversions_to_tools":
      return "conversion_names"
    case "privacy_paragraph":
      return "privacy_text"
    default:
      return null
  }
}

// ---------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------

/** Frameworks whose click test runs offline (T0); every other framework's runs in the rehearsal (RH). */
const T0_CLICK_FRAMEWORKS: ReadonlySet<string> = new Set(["static-html", "vite-react"])
/** Single-page-app frameworks: PostHog's `capture_pageview` must follow history changes. */
const SPA_FRAMEWORKS: ReadonlySet<string> = new Set(["next-app-router", "next-pages-router", "vite-react"])
/** The Next.js frameworks (their rewrites live in the Next config). */
const NEXT_FRAMEWORKS: ReadonlySet<string> = new Set(["next-app-router", "next-pages-router"])
/** Every Next config file name Next reads. */
const NEXT_CONFIG_NAMES: readonly string[] = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"]

/**
 * R4-8: the dry load really changed page in the app (its `spaNavigation`): some tool sent after the change, or a load
 * ended on another page than it started. Exported for the plan's line and its tests.
 */
export function dryNavigated(dry: NonNullable<BeforeFacts["dryLive"]>): boolean {
  if (dry.ga4.events.some((event) => event.afterNav) || dry.posthog.events.some((event) => event.afterNav) || dry.meta.tr.some((tr) => tr.afterNav)) return true
  if (dry.infinite.events.some((event) => event.nav)) return true
  const pathOf = (url: string | null | undefined) => {
    try {
      return url ? new URL(url).pathname : null
    } catch {
      return null
    }
  }
  // LF4-P3-3: a server redirect (/ → /en) also ends on another path, but no page change happened in the app. The page
  // the app LANDED on is the last redirect's target (or the url when there was none); only a path change after that
  // landing is the app's own page change.
  return dry.loads.some((load) => {
    if (load.finalUrl === null || load.finalUrl === undefined) return false
    const final = pathOf(load.finalUrl)
    if (final === null) return false
    const last = load.redirects?.[load.redirects.length - 1]
    const landed = last ? pathOf(new URL(last.to, load.url).toString()) : pathOf(load.url)
    return landed !== null && final !== landed
  })
}

/** Third-party hosts a tag needs through the CSP. */
const TAG_HOSTS = /(?:^|\.)(?:googletagmanager\.com|google-analytics\.com|analytics\.google\.com|posthog\.com|facebook\.net|facebook\.com|doubleclick\.net)$/i

/**
 * The checks that verify ONE item. JOB_TABLE lists every check a job's items may need; an item carries
 * only the ones about its own target, so no item waits forever on a check that is never run for it
 * (`preview_guard:ga4` on Meta's host matrix) or fails on someone else's work (review P2-4).
 */
const TARGET_CHECKS: Partial<Record<JobId, (target: string, framework: string) => readonly string[] | null>> = {
  // LF4 close round 2 (P1-1): `posthog_config` passes on an untouched config, so each target whose change is a setting
  // the wizard can read also carries `posthog_improve_applied` (the setting is in the adopted init).
  posthog_improve: (target, framework) =>
    target === "proxy"
      ? ["S:posthog_config", "S:posthog_improve_applied", ...(framework.startsWith("next") ? ["S:next_rewrites_exact"] : []), "RH:posthog_via_proxy_once", "PV:posthog_distinct_id_receipt"]
      : target === "history_change" || target === "defaults" || target === "sensitive_pages"
        ? ["S:posthog_config", "S:posthog_improve_applied", "PV:posthog_distinct_id_receipt"]
        : ["S:posthog_config", "PV:posthog_distinct_id_receipt"],
  // R4-8: a page-change page_view is proven by the rehearsal's own page change (one GA4 page_view after it, never two).
  ga4_improve: (target) =>
    target === "id"
      ? ["S:ga4_id_applied", "T1:ga4_loader_id", "RH:ga4_one_page_view", "PV:ga4_seen_leaving"]
      : target === "spa_page_view"
        ? ["S:spa_page_view_applied", "RH:ga4_spa_page_view", "RH:ga4_one_page_view", "PV:ga4_seen_leaving"]
        : ["RH:ga4_one_page_view", "PV:ga4_seen_leaving"],
  // R4-2: the capture beside an adopted pixel is checked like the writer it replaces: one `_fbc`, holding the last
  // click, on the page as the agent left it (`item-t0.ts` builds that page from the job's files).
  meta_improve: (target) =>
    target === "retire_fbc_writer" || target === "capture"
      ? ["S:click_id_capture", "T0:fbc_capture", "PV:meta_seen_leaving"]
      : target === "spa_page_view"
        ? ["S:spa_page_view_applied", "RH:meta_spa_page_view"]
        : target === "autoconfig_off_adopted"
          ? // LF4-P1-2: its own work is checked (the mirror's event-id check passed on a page with nothing of it).
            ["S:meta_autoconfig_off", "PV:meta_seen_leaving"]
          : // LF4 close round 2 (P1-1): the mirror's own work (`meta_mirror_wired`); the event-id check passes on nothing.
            ["S:meta_event_id_from_helper", "S:meta_mirror_wired", "T1:meta_traffic_permissions", "RH:meta_pixel_once", "PV:meta_seen_leaving"],
  duplicates_remove: (target) => {
    const tool = target.startsWith("ga4") ? "ga4" : target.startsWith("posthog") ? "posthog" : target.startsWith("meta") ? "meta" : null
    const census = tool === "ga4" ? "S:census_ga4_config_once" : tool === "posthog" ? "S:census_posthog_init_once" : tool === "meta" ? "S:census_meta_init_once" : null
    return ["S:census_one_per_tool", ...(census ? [census] : []), "RH:one_beacon_per_tool", "PV:one_beacon_per_tool"]
  },
  // §3e.1 job 7: T0's host matrix only "where executable", i.e. where the guarded init is in markup the
  // offline engine can load (static HTML / Vite's index.html). A Next component's init is not: there the
  // rehearsal's preview_self load decides (I1b; before, the item carried a T0 check that tested the
  // MANAGED page instead of the agent's edit, so a correct guard could never pass).
  // §3x.3: an outcome conversion's success branch cannot run in a no-send load (every non-GET is cancelled), so its
  // checks are the static `track_after_success` and the passive first real conversion; a click conversion keeps the
  // click test.
  conversions_to_tools: (target) =>
    OUTCOME_CONVERSION_TYPES.has(target as ConversionType)
      ? ["S:no_fbq_standard_on_click", "S:track_after_success", "P:first_real_conversion"]
      : // LF4 close round 2 (P1-1): on a framework whose click test runs in the rehearsal, `no_fbq_standard_on_click`
        // was the click conversion's only local check, and it passes with nothing of the job in the code.
        ["T0:click_test", "RH:click_test", "S:no_fbq_standard_on_click", "S:conversion_tracked", "P:first_real_conversion"],
  preview_guard: (target, framework) => {
    const t0 = T0_CLICK_FRAMEWORKS.has(framework) ? ["T0:host_matrix"] : []
    return target === "meta"
      ? ["S:adopted_init_guarded", ...t0, "RH:preview_self_silent", "T1:meta_host_matrix"]
      : ["S:adopted_init_guarded", ...t0, "RH:preview_self_silent"]
  }
}

/** The checks one item of `jobId` / `target` carries on `framework` (the plan's improve seeds use this too). */
export function itemChecksFor(jobId: JobId, target: string, framework: string): ChecklistItem["checks"] {
  return checksFor(jobId, target, framework)
}

function checksFor(jobId: JobId, target: string, framework: string): ChecklistItem["checks"] {
  const clickTier: CheckTier = T0_CLICK_FRAMEWORKS.has(framework) ? "T0" : "RH"
  const table = JOB_TABLE[jobId].checks.filter((spec) => spec.checkId !== "click_test" || spec.tier === clickTier)
  const chosen = TARGET_CHECKS[jobId]?.(target, framework)
  const specs = chosen ? table.filter((spec) => chosen.includes(`${spec.tier}:${spec.checkId}`)) : table
  return specs.map((spec) => ({ id: spec.checkId, tier: spec.tier, state: "not_run" as const }))
}

interface CandidateInput {
  jobId: JobId
  target: string
  finding: string
  evidence: Evidence[]
  allow: AllowSpec
  blockedReason?: BlockedReason
  leftForYou?: string
}

const TOOL_TITLE: Readonly<Record<string, string>> = { ga4: "GA4", posthog: "PostHog", meta: "Meta pixel", infinite: "Infinite" }

/**
 * §3x.3 A job that can hold several items titles each by its target, so no two items share a title ("Keep previews
 * silent: GA4" and "Keep previews silent: Meta pixel", never two "Keep previews silent (existing tags)").
 */
export function itemTitle(jobId: JobId, target: string): string {
  const spec = JOB_TABLE[jobId]
  switch (jobId) {
    case "preview_guard":
      return `Keep previews silent: ${TOOL_TITLE[target] ?? target}`
    case "conversions_to_tools":
      return `Send the ${target} conversion to GA4 and PostHog`
    case "server_conversions":
      return `Report the ${target} conversion from the server`
    default:
      return spec.title
  }
}

function makeItem(input: CandidateInput, framework: string): ChecklistItem {
  const spec = JOB_TABLE[input.jobId]
  // An agent job with nothing it may touch cannot be done by an agent: it is the user's.
  const blockedReason = input.blockedReason ?? (input.allow.files.length === 0 && input.allow.create.length === 0 ? "needs_you" : undefined)
  const item: ChecklistItem = {
    id: itemId(input.jobId, input.target),
    jobId: input.jobId,
    n: spec.n,
    title: itemTitle(input.jobId, input.target),
    owner: "agent",
    trigger: { finding: input.finding, evidence: dedupeEvidence(input.evidence) },
    allow: input.allow,
    checks: checksFor(input.jobId, input.target, framework),
    state: blockedReason ? "blocked" : "pending"
  }
  if (blockedReason) item.blockedReason = blockedReason
  if (input.leftForYou) { item.state = "left_for_you"; withNote(item, input.leftForYou); item.checks = []; delete item.blockedReason }
  return item
}

function dedupeEvidence(evidence: readonly Evidence[]): Evidence[] {
  const seen = new Set<string>()
  const out: Evidence[] = []
  for (const entry of evidence) {
    const key = "url" in entry ? `u:${entry.url}` : `f:${entry.file}:${entry.line}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

const fileEvidence = (findings: ReadonlyArray<{ file: string; line: number }>): Evidence[] => findings.map((finding) => ({ file: finding.file, line: finding.line }))
const filesOf = (findings: ReadonlyArray<{ file: string }>): string[] => findings.map((finding) => finding.file)

/** The app-shell files present in the snapshot (where a pixel boots / the managed tag goes). */
function entryLayoutFiles(scan: JobScan): string[] {
  const candidates = [
    "app/layout.tsx",
    "app/layout.jsx",
    "app/layout.js",
    "src/app/layout.tsx",
    "src/app/layout.jsx",
    "src/app/layout.js",
    "pages/_app.tsx",
    "pages/_app.jsx",
    "pages/_app.js",
    "pages/_document.tsx",
    "pages/_document.jsx",
    "pages/_document.js",
    "src/pages/_app.tsx",
    "src/pages/_document.tsx",
    "index.html",
    "src/main.tsx",
    "src/main.jsx"
  ].map((path) => repoPath(scan.snapshot.appRoot, path))
  return candidates.filter((path) => scan.snapshot.files.has(path))
}

function existingAppFiles(scan: JobScan, names: readonly string[]): string[] {
  return names.map((name) => repoPath(scan.snapshot.appRoot, name)).filter((path) => scan.snapshot.files.has(path))
}

function serverLaneModulePaths(scan: JobScan): string[] {
  return ["lib/infinite-server-lane.ts", "lib/infinite-server-lane.mjs", "lib/infinite-server-lane.js", "lib/infinite-outcome.ts", "lib/infinite-outcome.mjs", "lib/infinite-outcome.js"].map((path) =>
    repoPath(scan.snapshot.appRoot, path)
  )
}

/** The tools this run will NEWLY install: connected (or Infinite itself) but absent from the census. */
export function newlyInstalledTools(facts: BeforeFacts): TestTool[] {
  const present = new Set(facts.census.entries.map((entry) => entry.tool))
  const connected: TestTool[] = ["infinite"]
  if (facts.keys.ga4.status === "connected" && facts.keys.ga4.streams.length > 0) connected.push("ga4")
  if (facts.keys.posthog.status === "connected") connected.push("posthog")
  if (facts.keys.meta.status === "connected" && facts.keys.meta.pixels.length > 0) connected.push("meta")
  return connected.filter((tool) => !present.has(tool))
}

function problemChecks(facts: BeforeFacts, pattern: RegExp, tiers: readonly CheckTier[]): CheckResult[] {
  return facts.checks.filter((check) => check.state === "problem" && tiers.includes(check.tier) && pattern.test(check.checkId))
}

/**
 * §3e.1 triggers → candidates. Pure and deterministic: the same scan and facts always give the same
 * items in the same order (job number, then id). Nothing here comes from an agent.
 */
export function seedCandidatesFrom(scan: JobScan, facts: BeforeFacts): ChecklistItem[] {
  const d = scan.detections
  const framework = scan.framework
  const cmpFiles = d.cmp.files
  const allow = (files: readonly string[], create: readonly string[] = []): AllowSpec => buildAllow(files, create, cmpFiles, scan.snapshot.appRoot)
  const out: CandidateInput[] = []

  // 1 server_lane_mount
  for (const finding of d.serverMount) {
    out.push({
      jobId: "server_lane_mount",
      target: pathSlug(finding.file),
      finding:
        finding.kind === "existing_middleware"
          ? `Your ${finding.detail}: ${finding.unpatchableReason ?? "the installer refused to patch it"}`
          : `A ${finding.detail} needs the server lane mounted by hand`,
      evidence: fileEvidence([finding]),
      allow: allow([finding.file, ...serverLaneModulePaths(scan)])
    })
  }

  // 2 unusual_layout (one item per kind)
  for (const kind of ["custom_builder", "no_app_shell", "ambiguous_monorepo"] as const) {
    const findings = d.layout.filter((finding) => finding.kind === kind)
    if (findings.length === 0) continue
    const files = kind === "custom_builder" ? [...filesOf(findings), ...entryLayoutFiles(scan)] : []
    out.push({
      jobId: "unusual_layout",
      target: kind,
      finding:
        kind === "custom_builder"
          ? `The site is built with ${findings.map((finding) => finding.detail.replace(/ build$/, "")).join(", ")}; the installer can only plan it`
          : kind === "no_app_shell"
            ? "No app shell or HTML entry was found for the tag"
            : "This workspace has several web apps; pick the one to tag",
      evidence: fileEvidence(findings),
      allow: allow(files),
      ...(kind === "custom_builder" ? {} : { blockedReason: "needs_you" as const })
    })
  }

  // 3 posthog_improve (adopted PostHog only)
  const posthogConfigs = detectAdoptedPosthogConfig(scan.snapshot, facts.census)
  if (posthogConfigs.length > 0) {
    // The /ingest rewrite lives in the Next config. A Next app with NO config yet gets the installer's
    // managed `next.config.mjs` (any Infinite or PostHog proxy install creates it) or none at all, so the
    // job may edit that file, or create it: without it, `next_rewrites_exact` could never pass (I1b).
    const nextConfigs = existingAppFiles(scan, NEXT_CONFIG_NAMES)
    const createConfig = nextConfigs.length === 0 && NEXT_FRAMEWORKS.has(framework) ? [repoPath(scan.snapshot.appRoot, MANAGED_NEXT_CONFIG_FILE)] : []
    const posthogFiles = [...filesOf(posthogConfigs), ...nextConfigs, ...createConfig, ...existingAppFiles(scan, ["vercel.json"])]
    const direct = posthogConfigs.filter((config) => config.sendsDirect === true)
    const sentDirectLive = (facts.dryLive?.posthog.events ?? []).some((event) => !event.sameOrigin)
    if (direct.length > 0 || sentDirectLive) {
      out.push({
        jobId: "posthog_improve",
        target: "proxy",
        finding: "PostHog is adopted and sends straight to PostHog (ad blockers drop it)",
        evidence: fileEvidence(direct.length > 0 ? direct : posthogConfigs),
        allow: allow(posthogFiles, createConfig)
      })
    }
    const manualPageview = capturesPageviewManually(scan.snapshot)
    const notHistory = posthogConfigs.filter((config) => !posthogCountsNavigations(config, manualPageview))
    if (SPA_FRAMEWORKS.has(framework) && notHistory.length > 0) {
      out.push({
        jobId: "posthog_improve",
        target: "history_change",
        finding: "PostHog is adopted on a single-page app without `capture_pageview: 'history_change'` (page changes are missed)",
        evidence: fileEvidence(notHistory),
        allow: allow(posthogFiles, createConfig)
      })
    }
  }

  // 4 ga4_improve (adopted GA4 only)
  const adoptedGa4 = facts.census.entries.filter((entry) => entry.tool === "ga4" && entry.owner === "adopted" && entry.kind !== "gtm")
  if (adoptedGa4.length > 0) {
    const ga4Files = filesOf(adoptedGa4)
    const streamIds = facts.keys.ga4.status === "connected" ? facts.keys.ga4.streams.map((stream) => stream.measurementId) : []
    const wrongId = streamIds.length > 0 ? adoptedGa4.filter((entry) => entry.id !== null && !streamIds.includes(entry.id)) : []
    if (wrongId.length > 0) {
      out.push({
        jobId: "ga4_improve",
        target: "id",
        finding: `The site's GA4 id (${[...new Set(wrongId.map((entry) => entry.id))].join(", ")}) is not a stream of the connected property`,
        evidence: fileEvidence(wrongId),
        allow: allow(ga4Files)
      })
    }
    // SPA page views: the dry load navigated (some tool saw the navigation) and the adopted GA4 sent its
    // first page_view but none after the navigation. Without an observed navigation nothing is seeded.
    const dry = facts.dryLive
    if (SPA_FRAMEWORKS.has(framework) && dry !== null) {
      const adoptedIds = new Set(adoptedGa4.map((entry) => entry.id).filter((id): id is string => id !== null))
      // R4-8 (live run 4): the page change is observed by ANY tool that sent after it, or by the load itself ending on
      // another page. Run 4's site had only GA4 and Meta: Meta's page-change PageView proved the navigation, GA4 sent
      // nothing for it, and this read only GA4 and Infinite, so the plan never offered the fix the headline named.
      const navigationObserved = dryNavigated(dry)
      const firstPageView = dry.ga4.events.some((event) => !event.afterNav && event.en === "page_view" && adoptedIds.has(event.tid))
      const pageViewAfterNav = dry.ga4.events.some((event) => event.afterNav && event.en === "page_view" && adoptedIds.has(event.tid))
      if (navigationObserved && firstPageView && !pageViewAfterNav) {
        out.push({
          jobId: "ga4_improve",
          target: "spa_page_view",
          finding: "GA4 sends no page_view when the single-page app changes page (seen in the live test)",
          evidence: [...fileEvidence(adoptedGa4), ...dry.loads.slice(0, 1).map((load) => ({ url: load.url }))],
          allow: allow(ga4Files)
        })
      }
    }
  }

  // 5 meta_improve (adopted Meta only)
  const adoptedMeta = facts.census.entries.filter((entry) => entry.tool === "meta" && entry.owner === "adopted")
  if (adoptedMeta.length > 0) {
    const metaFiles = [...filesOf(adoptedMeta), ...entryLayoutFiles(scan)]
    if (d.metaBrowserStandardEvents.length > 0) {
      out.push({
        jobId: "meta_improve",
        target: "mirror",
        finding: "Standard Meta conversions are fired from the browser; they belong on the server-instructed mirror",
        evidence: fileEvidence(d.metaBrowserStandardEvents),
        allow: allow([...metaFiles, ...filesOf(d.metaBrowserStandardEvents)])
      })
    }
  }
  // §3x.3 (F6): the before load navigated once and the site's own Meta pixel sent no PageView for it.
  const metaSpaMissed = facts.checks.some((check) => check.checkId === "test_run:meta" && check.state === "problem" && (check.reason ?? "").startsWith("meta_spa_page_view_missing"))
  const adoptedMetaInits = facts.census.entries.filter((entry) => entry.tool === "meta" && entry.owner === "adopted")
  if (metaSpaMissed && adoptedMetaInits.length > 0) {
    out.push({
      jobId: "meta_improve",
      target: "spa_page_view",
      finding: "Meta counts only the first page of a visit: the test load's page change sent no PageView",
      evidence: fileEvidence(adoptedMetaInits),
      allow: allow(filesOf(adoptedMetaInits))
    })
  }
  const hostOnlyWriters = d.fbcWriters.filter((finding) => finding.hostOnly)
  if (hostOnlyWriters.length > 0) {
    out.push({
      jobId: "meta_improve",
      target: "retire_fbc_writer",
      finding: "A hand-written `_fbc` writer sets a host-only cookie that shadows Meta's own (new ad clicks are lost)",
      evidence: fileEvidence(hostOnlyWriters),
      allow: allow(filesOf(hostOnlyWriters))
    })
  }

  // 6 duplicates_remove
  for (const duplicate of detectDuplicates(facts.census, facts.dryLive)) {
    out.push({
      jobId: "duplicates_remove",
      target: duplicate.target,
      finding: duplicate.detail,
      evidence: duplicate.evidence,
      allow: allow(duplicate.editFiles)
    })
  }

  // 7 preview_guard (adopted inits with no host guard)
  const unguarded = detectUnguardedAdoptedInits(scan.snapshot, facts.census)
  for (const tool of ["ga4", "posthog", "meta"] as const) {
    const findings = unguarded.filter((finding) => finding.tool === tool)
    if (findings.length === 0) continue
    out.push({
      jobId: "preview_guard",
      target: tool,
      finding: `The site's own ${tool === "ga4" ? "GA4" : tool === "posthog" ? "PostHog" : "Meta pixel"} fires on preview deployments too`,
      evidence: fileEvidence(findings),
      allow: allow(filesOf(findings)),

    })
  }

  // 8 server_conversions (one per conversion type)
  for (const type of CONVERSION_TYPES) {
    const findings = d.outcomes.filter((finding) => finding.conversionType === type)
    if (findings.length === 0) continue
    out.push({
      jobId: "server_conversions",
      target: type,
      finding: `${findings.map((finding) => finding.detail).join(", ")}: report the ${type} from the server when it becomes real`,
      evidence: fileEvidence(findings),
      allow: allow(filesOf(findings))
    })
  }

  // 9 identify_reset
  if (d.auth.login.length > 0) {
    out.push({
      jobId: "identify_reset",
      target: "auth",
      finding: `A login exists (${d.auth.login[0]!.detail}); visits can be joined to accounts`,
      evidence: fileEvidence([...d.auth.login, ...d.auth.logout]),
      allow: allow([...filesOf(d.auth.login), ...filesOf(d.auth.logout), ...filesOf(d.auth.clientHooks)])
    })
  }

  // 10 conversions_to_tools (one per conversion type with an element, a handler or a success path).
  // §3x.3 (B3): for an OUTCOME conversion (signup, lead, booking, purchase, trial) the targets are where it SUCCEEDS
  // in the browser; the links and buttons that lead to the form are intent (the runtime records those clicks).
  // Only a download or a custom conversion is the click itself.
  const conversionTypes = new Set<ConversionType>([
    ...d.conversionElements.map((finding) => finding.conversionType),
    ...d.outcomes.map((finding) => finding.conversionType),
    ...d.successPaths.map((finding) => finding.conversionType)
  ])
  for (const type of CONVERSION_TYPES) {
    if (!conversionTypes.has(type)) continue
    if (OUTCOME_CONVERSION_TYPES.has(type)) {
      const success = d.successPaths.filter((finding) => finding.conversionType === type)
      out.push(
        success.length > 0
          ? {
              jobId: "conversions_to_tools",
              target: type,
              finding: `The ${type} succeeds at ${success.map((finding) => `${finding.file}:${finding.line}`).join(", ")}; send the approved ${type} conversion to GA4 and PostHog there`,
              evidence: fileEvidence(success),
              allow: allow(filesOf(success))
            }
          : {
              jobId: "conversions_to_tools",
              target: type,
              finding: `No place where a ${type} succeeds was found in the browser code (only links to it); the conversion is not sent from a click`,
              evidence: fileEvidence([...d.conversionElements, ...d.outcomes].filter((finding) => finding.conversionType === type)),
              allow: allow([]),
              blockedReason: "needs_you"
            }
      )
      continue
    }
    const elements = d.conversionElements.filter((finding) => finding.conversionType === type)
    const handlers = d.outcomes.filter((finding) => finding.conversionType === type)
    out.push({
      jobId: "conversions_to_tools",
      target: type,
      finding: `${type} conversion points found; send the approved ${type} conversion to GA4 and PostHog`,
      evidence: fileEvidence([...elements, ...handlers]),
      allow: allow([...filesOf(elements), ...filesOf(handlers)])
    })
  }

  // 11 setup_check_fixes (static setup-check problems with file evidence)
  const setupProblems = facts.checks.filter(
    (check) => check.state === "problem" && check.tier === "S" && !!check.reason?.trim() && check.reason.trim() !== "problem" && (check.evidence ?? []).some((entry) => "file" in entry)
  )
  for (const check of [...setupProblems].sort((a, b) => (a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0))) {
    const evidence = (check.evidence ?? []).filter((entry): entry is { file: string; line: number } => "file" in entry)
    out.push({
      jobId: "setup_check_fixes",
      target: check.checkId,
      finding: `Setup check ${check.checkId}: ${check.reason ?? "problem"}`,
      evidence,
      allow: allow(filesOf(evidence))
    })
  }

  // 12 csp (only when a CSP really blocks a tag host)
  const cspProblems = problemChecks(facts, /csp/i, ["T1"])
  const violations = (facts.dryLive?.csp.violations ?? []).filter((violation) => TAG_HOSTS.test(violation.blockedHost))
  if (cspProblems.length > 0 || violations.length > 0) {
    const urlEvidence: Evidence[] = [
      ...cspProblems.flatMap((check) => (check.evidence ?? []).filter((entry) => "url" in entry)),
      ...(facts.dryLive?.loads.slice(0, 1).map((load) => ({ url: load.url })) ?? [])
    ]
    if (d.csp.length === 0) {
      out.push({ jobId: "csp", target: "host_config", finding: "A content security policy blocks the tag hosts, and it is not set in this repo", evidence: urlEvidence, allow: allow([]), blockedReason: "needs_you" })
    }
    for (const owner of d.csp) {
      out.push({
        jobId: "csp",
        target: pathSlug(owner.file),
        finding:
          owner.style === "hosts"
            ? "The content security policy blocks the tag hosts"
            : `The content security policy uses ${owner.style === "nonce" ? "a nonce" : "strict-dynamic"}; adding hosts cannot fix it`,
        evidence: [...fileEvidence([owner]), ...urlEvidence],
        allow: allow([owner.file]),
        ...(owner.style === "hosts" ? {} : { blockedReason: "needs_you" as const })
      })
    }
  }

  // 13 redirect_utms
  const redirectProblems = problemChecks(facts, /redirect/i, ["T1"])
  const redirectOwners = d.redirects
  const covering = redirectOwners.filter((finding) => finding.coversCountedPath)
  if (redirectProblems.length > 0) {
    const urlEvidence = redirectProblems.flatMap((check) => (check.evidence ?? []).filter((entry) => "url" in entry))
    if (redirectOwners.length === 0) {
      out.push({ jobId: "redirect_utms", target: "host_config", finding: "A redirect drops the UTMs, and it is not set in this repo", evidence: urlEvidence, allow: allow([]), blockedReason: "needs_you" })
    } else {
      out.push({
        jobId: "redirect_utms",
        target: "query",
        finding: "A redirect drops the query string (UTMs and click ids) on the way to the page",
        evidence: [...urlEvidence, ...fileEvidence(redirectOwners)],
        allow: allow(filesOf(redirectOwners))
      })
    }
  }
  if (covering.length > 0) {
    out.push({
      jobId: "redirect_utms",
      target: "counted_paths",
      finding: "A host-level redirect answers before the server lane on a counted path",
      evidence: fileEvidence(covering),
      allow: allow([...filesOf(covering), ...d.middleware])
    })
  }

  const items = out.map(input => {
    const item = makeItem(input, framework)
    if (item.state === "blocked" && item.allow.files.length === 0) return item
    return scopeOwnerJob(item, scan.snapshot.files, scan.snapshot.appRoot)
  })
  const unique = new Map<string, ChecklistItem>()
  for (const item of items) if (!unique.has(item.id)) unique.set(item.id, item)
  const sorted = [...unique.values()].sort((a, b) => a.n - b.n || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return withDistinctTitles(sorted)
}

/**
 * §3x.3 No two items share a title: any job still holding two items of one title names each by its target. The plan
 * step runs it again over the detector candidates AND the plan's own improve seeds (a seed is titled by its job).
 */
export function withDistinctTitles(items: readonly ChecklistItem[]): ChecklistItem[] {
  const perJob = new Map<string, number>()
  for (const item of items) perJob.set(item.jobId, (perJob.get(item.jobId) ?? 0) + 1)
  return items.map((item) =>
    item.jobId in JOB_TABLE && item.title === JOB_TABLE[item.jobId as keyof typeof JOB_TABLE].title && (perJob.get(item.jobId) ?? 0) > 1 ? { ...item, title: `${item.title}: ${itemTarget(item)}` } : item
  )
}

// ---------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------

/**
 * Plan-wide decision lines: one line covers every candidate of its kind, so a line of that kind with NO
 * `jobIds` still governs them (O7's `server_lane` line names no items; declining it must still drop job 1).
 * A line that does list `jobIds` governs only those.
 */
const PLAN_WIDE_KINDS: ReadonlySet<PlanLineKind> = new Set(["server_lane", "conversion_names", "privacy_text"])

/**
 * §3e.7 `applyApprovals`, as a pure function.
 * - A candidate named by a declined line is dropped.
 * - A candidate whose job needs a line kind is kept only under a line of that kind: unanswered →
 *   `blocked:needs_you`; no such line → never seeded.
 * - Jobs 8 and 10 are kept only for a conversion type the user approved a NAME for (review P1-5): a type
 *   with no bound approved name is dropped, whatever the line says. Job 14 needs the approved paragraph.
 */
export function applyApprovalsTo(candidates: readonly ChecklistItem[], plan: PlanModel, approvals: PlanApprovals): ChecklistItem[] {
  const automatic = plan.lines.filter(isContinuedWork).map(line => line.id)
  const exclusions = planExclusions(plan, approvals.declined)
  const declined = exclusions.lineIds
  const approved = new Set([...approvals.approved, ...automatic].filter(id => !declined.has(id)))
  const conversionNames = approvedConversionNames(plan, approvals)
  const out: ChecklistItem[] = []
  for (const candidate of candidates) {
    if (exclusions.blocksJob(candidate)) continue
    if (candidate.jobId === "privacy_paragraph") continue // Retired; never revive an old approved job.
    if (candidate.state === "left_for_you") {
      const instruction = plan.lines.find(line => line.id === `owner_only:${candidate.id}`)?.text
      const guard = instruction ? /\n```js\n([\s\S]*?)\n```/.exec(instruction)?.[1] : undefined
      out.push(instruction ? { ...candidate, trigger: { ...candidate.trigger, finding: instruction }, ...(candidate.ownerBoundary ? { ownerBoundary: { ...candidate.ownerBoundary, ...(guard ? { guard } : {}) } } : {}) } : candidate)
      continue
    }
    const lines = plan.lines.filter((line) => line.jobIds?.includes(candidate.id))
    if (lines.some((line) => declined.has(line.id))) continue
    const kind = requiredLineKind(candidate)
    const item = JSON.parse(JSON.stringify(candidate)) as ChecklistItem
    if (kind !== null) {
      let relevant = lines.filter((line) => line.kind === kind)
      if (relevant.length === 0 && PLAN_WIDE_KINDS.has(kind)) relevant = plan.lines.filter((line) => line.kind === kind && (line.jobIds?.length ?? 0) === 0)
      if (relevant.length === 0) continue
      if (relevant.some((line) => declined.has(line.id))) continue
      if (!relevant.some((line) => approved.has(line.id))) {
        item.state = "blocked"
        item.blockedReason = "needs_you"
      } else if (kind === "conversion_names" && boundConversionNames(itemTarget(candidate), conversionNames).length === 0) {
        continue
      }
    }
    out.push(item)
  }
  return withoutCoveredSetupFixes(out)
}

/** §3x.3 (B4) The setup findings another job fixes: a setup code → the job that owns its fix. */
const SETUP_CODE_OWNER: ReadonlyArray<{ code: RegExp; jobId: JobId }> = [
  { code: /INF_SETUP_PROVIDER_DUPLICATE_INIT|DUPLICATE/, jobId: "duplicates_remove" },
  { code: /HOST_GUARD|PREVIEW/, jobId: "preview_guard" },
  { code: /CSP/, jobId: "csp" },
  { code: /REDIRECT|UTM/, jobId: "redirect_utms" }
]

/**
 * §3x.3 (B4) Job 11 is not seeded for a setup finding an approved, open item of another job already covers: its code
 * names that job (a duplicate init → `duplicates_remove`, a missing host guard → `preview_guard`, …) and they point at
 * the same file. A shared evidence line alone proves nothing (a guard job and a duplicate share the init's line). Run 3's `setup_check_fixes:provider_census`
 * repeated job 6 and made the agent do one edit for two jobs.
 */
function withoutCoveredSetupFixes(items: readonly ChecklistItem[]): ChecklistItem[] {
  const owners = items.filter((item) => item.jobId !== "setup_check_fixes" && item.state !== "blocked")
  const fileLines = (item: ChecklistItem) => item.trigger.evidence.filter((entry): entry is { file: string; line: number } => "file" in entry)
  return items.filter((item) => {
    if (item.jobId !== "setup_check_fixes") return true
    const evidence = fileLines(item)
    const code = /INF_SETUP_[A-Z_]+/.exec(item.trigger.finding)?.[0] ?? ""
    const byCode = SETUP_CODE_OWNER.filter((entry) => entry.code.test(code)).map((entry) => entry.jobId)
    const covered = owners.some((owner) => {
      const ownerLines = fileLines(owner)
      return byCode.includes(owner.jobId as JobId) && evidence.some((entry) => ownerLines.some((other) => other.file === entry.file))
    })
    return !covered
  })
}

// ---------------------------------------------------------------------------------------------
// Re-verifying a `not_needed` claim
// ---------------------------------------------------------------------------------------------

/**
 * The files of this item the agent's turn changed: a recorded edit on the item (lane O3's fence), or an
 * allowlisted file whose text differs from the tree the item was seeded from.
 */
function changedItemFiles(item: ChecklistItem, scan: JobScan, seed: RepoSnapshot | null): string[] {
  const allowed = new Set([...item.allow.files, ...item.allow.create])
  const changed = new Set<string>((item.edits ?? []).map((edit) => edit.file))
  if (seed) {
    for (const file of allowed) {
      if (seed.files.get(file) !== scan.snapshot.files.get(file)) changed.add(file)
    }
  }
  return [...changed].sort()
}

/**
 * The wizard's own detector for one item, against a FRESH JobScan of the edited tree. It agrees with
 * `not_needed` only when the trigger is gone AND the agent did not change this item's own files: a
 * trigger the agent deleted is work, and goes through `claimed` and the checks (review P2-3). A job whose
 * trigger is live or check-based (CSP, redirects, setup checks, builds, review comments, the census-based
 * provider jobs) cannot be re-checked statically, so the wizard never agrees there: the item stays open
 * with its evidence.
 */
export function reverifyNotNeededIn(item: ChecklistItem, scan: JobScan, seed: RepoSnapshot | null = null): { agrees: boolean; evidence: Evidence[] } {
  const d = scan.detections
  const target = itemTarget(item)
  const changed = changedItemFiles(item, scan, seed)
  const fresh = (evidence: Evidence[]) => {
    if (evidence.length > 0) return { agrees: false, evidence }
    if (changed.length > 0) return { agrees: false, evidence: changed.map((file) => ({ file, line: 1 })) }
    return { agrees: true, evidence }
  }
  switch (item.jobId) {
    case "server_lane_mount":
      return fresh(fileEvidence(d.serverMount.filter((finding) => pathSlug(finding.file) === target)))
    case "unusual_layout":
      return fresh(fileEvidence(d.layout.filter((finding) => finding.kind === target)))
    case "server_conversions":
      return fresh(fileEvidence(d.outcomes.filter((finding) => finding.conversionType === target)))
    case "identify_reset":
      return fresh(fileEvidence(d.auth.login))
    case "conversions_to_tools":
      if (OUTCOME_CONVERSION_TYPES.has(target as ConversionType)) return fresh(fileEvidence(d.successPaths.filter((finding) => finding.conversionType === target)))
      return fresh(fileEvidence([...d.conversionElements, ...d.outcomes].filter((finding) => finding.conversionType === target)))
    case "meta_improve":
      if (target === "retire_fbc_writer") return fresh(fileEvidence(d.fbcWriters.filter((finding) => finding.hostOnly)))
      if (target === "mirror") return fresh(fileEvidence(d.metaBrowserStandardEvents))
      return { agrees: false, evidence: item.trigger.evidence }
    default:
      // Live / check-based triggers: no static re-check exists, so the wizard never agrees.
      return { agrees: false, evidence: item.trigger.evidence }
  }
}

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

export interface JobRegistryOptions {
  /** Current run literals and public IDs, used before check reasons enter stored job state. */
  scanner?(): Scanner
  /**
   * The brief's context for the current run (the engine reads it from the run state). A brief without a
   * run id is a programming error, so the registry throws instead of writing one.
   */
  briefFacts(): BriefFacts | null
  /**
   * The merge / deploy-ready time of this run's PR, once known (null before). A production reading (T1,
   * PV) taken before it never proves an item (review P2-2). Absent = only the item's claim bounds it.
   */
  liveSince?(): string | null
}

/** The union of the run's agent allowlists (jobs 15 and 16 work inside it; widening = ASK). */
export function unionAllowedFiles(items: readonly ChecklistItem[], cmpFiles: readonly string[], appRoot = "."): AllowSpec {
  return unionAllow(
    items.filter((item) => item.owner === "agent").map((item) => item.allow),
    cmpFiles,
    appRoot
  )
}

/** A JobScan as is, or built from a bare ScanResult by reading the tree (bounded, read-only). */
export function toJobScan(scan: ScanResult): JobScan {
  return isJobScan(scan) ? scan : scanForJobs(scan)
}

/** Lane O8's `JobRegistry`, plus the CMP files the run's allowlists are filtered against. */
export interface O8JobRegistry extends JobRegistry {
  /** The CMP / banner files of the latest scan this registry saw (never an agent's to touch). */
  cmpFiles(): string[]
}

/**
 * Lane O8's `JobRegistry`. `seedCandidates` and `reverifyNotNeeded` take F0's ScanResult: a JobScan is
 * used as is, a bare ScanResult is scanned (review P1-3). The registry remembers, in memory, the tree it
 * seeded from (to tell a deleted trigger from a vanished one) and the CMP files (so every re-filter keeps
 * them out, review P3-2). A resumed process re-learns the CMP files on its first scan; `item.edits`
 * stands in for the seed tree there.
 */
export function createJobRegistry(options: JobRegistryOptions): O8JobRegistry {
  let seedSnapshot: RepoSnapshot | null = null
  let cmpFiles: string[] = []
  return {
    seedCandidates(scan: ScanResult, beforeFacts: BeforeFacts): ChecklistItem[] {
      const jobScan = toJobScan(scan)
      seedSnapshot = jobScan.snapshot
      cmpFiles = [...jobScan.detections.cmp.files]
      return seedCandidatesFrom(jobScan, beforeFacts)
    },
    applyApprovals(candidates, plan, approvals) {
      return applyApprovalsTo(candidates, plan, approvals)
    },
    allowedFiles(item) {
      // Re-filtered through the global deny and the CMP files every time: a stored list can never widen past them.
      return buildAllow(item.allow.files, item.allow.create, cmpFiles, seedSnapshot?.appRoot ?? options.briefFacts()?.appRoot ?? ".")
    },
    brief(items) {
      const facts = options.briefFacts()
      if (facts === null) throw new Error("JobRegistry.brief needs the run's brief facts (run id, framework)")
      return buildBrief(items, facts)
    },
    prescribedPaste(item) {
      const facts = options.briefFacts()
      return facts === null ? null : prescribedPasteOf(item, facts)
    },
    checksFor(item, tier): JobCheckSpec[] {
      return item.checks.filter((check) => check.tier === tier).map((check) => ({ tier: check.tier, checkId: check.id }))
    },
    apply(items, results, runId, applyOptions) {
      const liveSince = options.liveSince?.() ?? null
      const scanner = options.scanner?.()
      return items.map((item) => applyResults(item, results, runId, { budgetLeft: true, liveSince, scanner, ...applyOptions }).item)
    },
    reverifyNotNeeded(item, scan) {
      const jobScan = toJobScan(scan)
      for (const file of jobScan.detections.cmp.files) if (!cmpFiles.includes(file)) cmpFiles.push(file)
      return reverifyNotNeededIn(item, jobScan, seedSnapshot)
    },
    cmpFiles() {
      return [...cmpFiles]
    }
  }
}
