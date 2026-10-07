import { planExclusions } from "./plan-exclusions.js"
import { configRewriteJobs } from "./config-rewrite-jobs.js"
import { sensitivePosthogOptions } from "./posthog-sensitive.js"
import type { ManagedCapturePlan } from "./managed-capture.js"
import { consentHandoff, recognizedConsentHandling } from "./consent-handoff.js"
import type { OwnerWiringPreview } from "../frameworks/owner-wiring-preview.js"
import { scopeOwnerJob } from "../jobs/owner-scope.js"
import { isRepositoryWork, isContinuedWork } from "./plan-permission.js"
// §3d.3–§3d.4 and step 4 of the wizard: the ONE plan screen.
//
// The plan model ASKS ONLY THREE THINGS — consent mode, conversion names and the npm
// line. Those four are the only `editable` lines. Everything else is a line the user approves or
// declines (or an info / user-action line shown only). Rules it enforces (R2-10, R2-11, R2-21):
//   • every agent job that touches an ADOPTED provider (jobs 3, 4, 5, 6, 7) is seeded only behind an
//     approved line, linked by `jobIds`; a reduction (one init, one config per id, removing a
//     hand-written gtag) is ONLY job 6 under an approved `remove_duplicate` line, never jobs 3–5;
//   • an adopted Meta pixel without a guard gets a `preview_guard_adopted` line naming Meta, with the
//     measured preview share from the baseline;
//   • the preview guard's exempt list = union(site-source hosts, hosting domains + aliases, the host
//     observed in `before`); when the observed production host would be silenced by a deny rule and
//     Infinite does not list it, NO guard is emitted and a blocking line says why;
//   • the server-lane line carries the probe disclosure (§3h.6);
//   • nothing here is computed from agent output.
import { buildHostGuardExpression } from "../host-guard.js"
import { ownerGuardHandoff } from "../jobs/owner-boundary.js"
import { automaticEventsPerVisitOf } from "../checks/grade-test-run.js"
import { applyApprovalsTo, itemChecksFor, requiredLineKind } from "../jobs/registry.js"
import { createHash } from "node:crypto"

import type { ImproveLine, ImproveLineKind, ProviderId } from "../types.js"
import type { AgentKind, WhoPays } from "../wizard/contracts/agents.js"
import { AGENT_LIMITS, AGENT_MODELS } from "../wizard/contracts/agents.js"
import type { AskAnswers, PlanLine, PlanLineKind } from "../wizard/contracts/asks.js"
import type { BaselineResponseFields } from "../wizard/contracts/report.js"
import type { TagHosting, TagKeys } from "../wizard/contracts/bridge.js"
import { CONVERSION_NAME_PATTERN } from "../wizard/contracts/bridge.js"
import { HOST_DENY_V1, normalizeHost } from "../wizard/contracts/host-deny.js"
import type { BeforeFacts, BuildResult, ChecklistItem, JobId, PlanModel } from "../wizard/contracts/jobs.js"
import { JOB_TABLE } from "../wizard/contracts/jobs.js"
import type { SiteState } from "../wizard/contracts/state.js"
import { isPreviewShapedHost, resolveProductionHost } from "../wizard/site-host.js"

import { artifactsFromKeysDetailed } from "./keys-adapter.js"

export type { PlanLine, PlanLineKind }

/** The `plan` ask's answer shape (§3d.3). */
export type PlanApprovalsLike = AskAnswers["plan"]

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/**
 * What `before` measured, plus the two optional facts the plan uses that F0's `BeforeFacts` does not
 * carry yet: the 28-day baseline (C3's `GET baseline`, for measured preview shares) and the baseline
 * build (for "new build failures"). Both optional: a missing one shows "—", never 0.
 */
export interface WizardBeforeFacts extends BeforeFacts {
  baseline?: BaselineResponseFields | null
  baselineBuild?: BuildResult | null
  localValidation?: "measured" | "not_measured"
}

/** The scan facts the plan reads (the installer's `WizardScanResult` carries them). */
export interface PlanScanFacts {
  managedCapture?: ManagedCapturePlan
  ownerWiring?: OwnerWiringPreview
  sources?: Readonly<Record<string, string>>
  framework: string
  /** Providers this install manages already (from the receipt). */
  managedProviders: ProviderId[]
  /** Providers found in the repo, not managed (adopted), with their improve lines. */
  adopted: Array<{ provider: ProviderId; via: "snippet" | "gtm"; file: string; line: number; key: string | null }>
  improve: ImproveLine[]
  /** The server-lane target the plan would install (null = no supported target). */
  serverLane: { targetLabel: string; installPackages: string[] } | null
  /** The npm command line for the server-lane packages, or why there is none. */
  npm: { commandLine: string } | { refused: string } | null
  /** D17 detector output (O6): sensitive paths, e.g. `/account`. */
  sensitivePaths: string[]
  /** Repo-root-relative app root (the files of items this plan seeds are repo-relative). Default ".". */
  appRoot?: string
  /**
   * A NEW PostHog can be served through `/ingest` on the site's own domain: Next (its own rewrites, any
   * host), or a static/Vite site Vercel serves (vercel.json). Elsewhere it installs straight to its
   * region (an `/ingest` api_host would 404). Default true.
   */
  posthogProxy?: boolean
  /**
   * Why Infinite's pixel cannot be installed by the wizard on this site (null = it can). A static/Vite
   * site not served by Vercel has no same-origin collect path the wizard can write.
   */
  infiniteBlocked?: string | null
  /**
   * Review I1 P1-2: a Next app's own config (repo-relative) that lacks Infinite's collect rewrite. The installer
   * never edits it; the plan says the rewrite is an agent job (checked by the wizard) before anything is written.
   */
  nextConfigRewrites?: { path: string; snippet?: string } | null
  /** Review I1 P1-2: why the install cannot be applied as planned (a dry plan's blocker), or null. */
  installBlocked?: string | null
}

export interface PlanAgentSummary {
  worker: AgentKind | null
  whoPays: WhoPays | null
}

/** O5's `productionDeniedConflict(observedHosts, exempt)`: observed hosts a deny rule would silence and `exempt` does not cover. */
export type ProductionDeniedConflict = (observedHosts: readonly string[], exempt: readonly string[]) => string[]

export interface PlanModelInput {
  scan: PlanScanFacts
  keys: TagKeys
  before: WizardBeforeFacts
  candidates: readonly ChecklistItem[]
  agent: PlanAgentSummary | null
  /** `--consent-mode` (the only way `--yes` gets a consent answer). */
  consentFlag: "required" | "not_required" | null
  productionDeniedConflict: ProductionDeniedConflict
  /**
   * §3y.5: the run facts the runnability rule reads beyond the keys and hosting: this run's site state (the
   * answered host, a pending site-file claim) and whether the Infinite app offers `tag.site-claim.v1`. Absent =
   * no answered host and no claim capability (the host is then Infinite's own, if any).
   */
  run?: PlanRunFacts | null
}

export interface PlanRunFacts {
  site?: SiteState | null
  /** The bridge advertises `tag.site-claim.v1` (the site-file proof path exists). */
  siteClaim: boolean
}

/** The preview-guard decision for a wizard install (§3h.9). */
export type GuardDecision =
  | { emit: true; exempt: string[]; deny: string[] }
  | { emit: false; reason: "no_new_guarded_tool" }
  | { emit: false; reason: "production_denied"; hosts: string[] }
  | { emit: false; reason: "no_production_host" }

/** The plan model plus what `apply` needs (never shown, never hashed separately). */
export interface WizardPlanModel extends PlanModel {
  scopedCandidates?: ChecklistItem[]
  approvalMode?: "shown_and_continued"
  ownerWiring?: OwnerWiringPreview
  guard: GuardDecision
  /** The tools this plan installs or updates (each behind its `install_provider` line). */
  installTools: ProviderId[]
  /** Tools this install already manages (an unapproved update keeps them as they are, never drops them). */
  managedTools: ProviderId[]
  /**
   * Items this plan seeds itself, for an improve line no detector candidate links (each linked by its
   * line's `jobIds`, so it passes the same gate): an approved line always has a job or a code edit
   * behind it, never nothing.
   */
  seeds: ChecklistItem[]
  /** D16's recommendation as DATA (null = none: the meta_goal line is then info, never an answer). */
  metaGoal: "StartTrial" | "Purchase" | null
  /** The server lane is offered (its privacy sentence depends on the `server_lane` line's answer). */
  serverLaneOffered: boolean
  /**
   * §3y.5 (P3-13): candidate ids this plan never seeds as agent jobs because nothing would run them (job 10 when
   * this run installs neither Infinite's tag nor a connected tool). Each is said by one `user_action` line.
   */
  withheld: string[]
}

// ---------------------------------------------------------------------------------------------
// §3y.5 Runnability: no approvable line without an executor that will run on the current facts
// ---------------------------------------------------------------------------------------------

/** The facts `lineRunnable` reads (all from Infinite or this run's own answers; never from the repo). */
export interface LineFacts {
  /** §3y.1 `resolveProductionHost` (Infinite's host, an answer, or `--production-host`). */
  productionHost: string | null
  /** Infinite already has a site source for this workspace (keys `infinite.status === "ready"`). */
  infiniteReady: boolean
  /** A site-file claim is pending for this run: the source is reserved, not verified yet. */
  claimPending: boolean
  /**
   * Infinite's Vercel connection serves the production host as a production DOMAIN (or its www twin) — exactly the
   * set the cloud proves through Vercel (`proveHostsThroughVercel` reads `productionDomains`). A `*.vercel.app`
   * production alias is NOT counted: the cloud takes the site-file claim path for it (review-2 P2-2), so the plan
   * must too (the claim wording, no server lane until the claim is proven).
   */
  vercelServesHost: boolean
  /** The Infinite app offers `tag.site-claim.v1`. */
  siteClaim: boolean
  /** The framework has a supported server-lane target. */
  serverLaneTarget: boolean
  /** Infinite hosting is Vercel. */
  hostingVercel: boolean
  /** Infinite's Vercel connection may write env vars. */
  envWriteGranted: boolean
}

/** The line kinds the rule decides; every other PlanLineKind is runnable whenever the plan emits it. */
export type RunnableLineKey = PlanLineKind | "install_provider:infinite"

export const RUNNABILITY_TEXT = {
  infiniteNoHost: "Infinite: tell the wizard your live domain (npx infinite-tag --production-host acme.com) to add Infinite's tag.",
  infiniteNoProof: (host: string) =>
    `Infinite: update the Infinite app (or connect your website in Infinite › Connections › GitHub · Website) so it can confirm ${host}; then run again.`,
  serverLaneNoConnection: "Server lane (counts visits ad blockers hide): connect your Vercel project in Infinite (Connections › GitHub · Website), then run npx infinite-tag again.",
  serverLaneNoScope: "Server lane: reconnect Vercel in Infinite and allow environment variables, then run again.",
  claimWording: (host: string) =>
    `Infinite confirms ${host} is yours after your merge, from a one-line file this pull request adds (/.well-known/infinite-site-verification.txt). Until then it records nothing.`,
  conversionsUnwired: (names: readonly string[]) =>
    `Conversions (${names.join(", ") || "none named"}): not wired in this run because their required browser helper or server lane is unavailable.`
} as const

/** The source is verified: an existing site source (not a pending claim), or a Vercel connection serving the host. */
function verifiedPath(facts: LineFacts): boolean {
  return (facts.infiniteReady && !facts.claimPending) || facts.vercelServesHost
}

/**
 * §3y.5 / DECISIONS §1.6: whether a line can be approvable. `{ok:false, line}` = emit it as `user_action` with that
 * text (an empty text = no line at all). A test enumerates every PlanLineKind against unrunnable facts.
 */
export function lineRunnable(kind: RunnableLineKey, facts: LineFacts): { ok: true } | { ok: false; line: string } {
  switch (kind) {
    case "install_provider:infinite": {
      if (facts.infiniteReady) return { ok: true }
      if (facts.productionHost === null || isPreviewShapedHost(facts.productionHost)) return { ok: false, line: RUNNABILITY_TEXT.infiniteNoHost }
      if (facts.vercelServesHost || facts.siteClaim) return { ok: true }
      return { ok: false, line: RUNNABILITY_TEXT.infiniteNoProof(facts.productionHost) }
    }
    case "server_lane": {
      if (!facts.serverLaneTarget) return { ok: false, line: "" }
      const infinite = lineRunnable("install_provider:infinite", facts)
      if (!infinite.ok || !verifiedPath(facts) || !facts.hostingVercel) return { ok: false, line: RUNNABILITY_TEXT.serverLaneNoConnection }
      if (!facts.envWriteGranted) return { ok: false, line: RUNNABILITY_TEXT.serverLaneNoScope }
      return { ok: true }
    }
    case "npm_install":
      // The package exists only for the server lane: no approvable lane, no line.
      return lineRunnable("server_lane", facts).ok ? { ok: true } : { ok: false, line: "" }
    case "preview_guard_managed":
      return facts.productionHost !== null ? { ok: true } : { ok: false, line: GUARD_NO_HOST_TEXT }
    default:
      return { ok: true }
  }
}

export const GUARD_NO_HOST_TEXT = "Infinite does not know your production domain yet, so no preview guard is added; tell the wizard your live domain (--production-host)."

/** The facts for this plan (keys, hosting, the scan, the run's site state and the bridge's claim capability). */
export function lineFactsFor(input: Pick<PlanModelInput, "keys" | "before" | "scan" | "run">): LineFacts {
  const hosting = input.before.hosting
  const site = input.run?.site ?? null
  const productionHost = resolveProductionHost({ keys: input.keys, hosting, site }).host
  // Domains only, never `productionAliases`: the cloud's Vercel proof reads the same set (review-2 P2-2).
  const served = new Set((hosting.vercel?.productionDomains ?? []).map(normalizeHost))
  const twin = (host: string) => (host.startsWith("www.") ? host.slice(4) : `www.${host}`)
  return {
    productionHost,
    infiniteReady: input.keys.infinite.status === "ready" && input.keys.infinite.siteSourceKey !== null,
    claimPending: site?.claim?.state === "pending_proof",
    vercelServesHost: hosting.provider === "vercel" && productionHost !== null && (served.has(productionHost) || served.has(twin(productionHost))),
    siteClaim: input.run?.siteClaim === true,
    serverLaneTarget: input.scan.serverLane !== null,
    hostingVercel: hosting.provider === "vercel" && hosting.vercel !== null,
    envWriteGranted: hosting.vercel?.envWriteGranted === true
  }
}

// ---------------------------------------------------------------------------------------------
// §3y.5 Counts: ONE function feeds the budget line, "Plan approved" and the jobs step's "Job i/N"
// ---------------------------------------------------------------------------------------------

/** The items a plan seeds for these approvals: the registry's gate, then the plan's own gate (blocked kept). */
export function seedItemsAfterApprovals(
  candidates: readonly ChecklistItem[],
  seeds: readonly ChecklistItem[],
  plan: PlanModel,
  approvals: PlanApprovalsLike,
  lines?: ReadonlyArray<{ id: string; approved: boolean | null }>
): ChecklistItem[] {
  const withheld = new Set((plan as Partial<WizardPlanModel>).withheld ?? [])
  candidates = (plan as Partial<WizardPlanModel>).scopedCandidates ?? candidates
  const pool = [...candidates, ...seeds.filter((seed) => !candidates.some((item) => item.id === seed.id))].filter((item) => !withheld.has(item.id))
  const applied = applyApprovalsTo(pool, plan, approvals)
  const lineStates =
    lines ??
    plan.lines.map((planLine) => ({
      id: planLine.id,
      approved: approvals.declined.includes(planLine.id) ? false : isContinuedWork(planLine) ? true : planLine.requires !== "approval" ? null : approvals.approved.includes(planLine.id) ? true : null
    }))
  return gateSeededItems(plan, { lines: [...lineStates] }, applied)
}

/** The agent jobs that will run: an agent item that is open (not blocked waiting for the user). */
export function runnableAgentJobs(items: readonly ChecklistItem[]): ChecklistItem[] {
  return items.filter((item) => item.owner === "agent" && (item.state === "pending" || item.state === "claimed"))
}

/** The budget line's "up to N": the agent jobs that run when every approvable line of `plan` is approved. */
export function agentJobsUpTo(candidates: readonly ChecklistItem[], seeds: readonly ChecklistItem[], plan: PlanModel, consentFlag: "required" | "not_required" | null): number {
  const approved = plan.lines.filter((entry) => entry.requires === "approval").map((entry) => entry.id)
  const all = resolvePlanAnswers(plan, { approved, declined: [], edits: {} }, { consentFlag: consentFlag ?? plan.decisions.consentMode ?? "not_required" })
  return agentJobsAfterApprovals(candidates, seeds, plan, all.approvals).length
}

/** DECISIONS §1.6 "Counts": the agent jobs these approvals run (the budget line, "Plan approved" and "Job i/N"). */
export function agentJobsAfterApprovals(candidates: readonly ChecklistItem[], seeds: readonly ChecklistItem[], plan: PlanModel, approvals: PlanApprovalsLike): ChecklistItem[] {
  return runnableAgentJobs(seedItemsAfterApprovals(candidates, seeds, plan, approvals))
}

// ---------------------------------------------------------------------------------------------
// Constants and copy
// ---------------------------------------------------------------------------------------------

export const DECISION_LINE_IDS = {
  consentMode: "consent_mode",
  conversionNames: "conversion_names",
  privacyText: "privacy_text",
  npmInstall: "npm_install"
} as const

/** The ONLY editable lines (the four user decisions). */
export const EDITABLE_LINE_IDS: readonly string[] = Object.values(DECISION_LINE_IDS).filter(id => id !== "privacy_text")

/** §3h.6 (R1-34): the server-lane probe disclosure, on the plan line and in the report. */
export const SERVER_LANE_PROBE_DISCLOSURE =
  "After your merge, Infinite makes one real visit to prove it. Infinite marks it as its own test, so it never counts in your Infinite numbers; GA4, PostHog and Meta (whichever your site runs) record it as one normal page view, and the report prints how to filter it."

const TOOL_NAME: Record<ProviderId, string> = { infinite: "Infinite", ga4: "GA4", posthog: "PostHog", x: "X", meta: "Meta" }

/** A public id as the plan prints it: recognisable, never whole (`G-TEST…0000`). */
function maskPublicId(id: string): string {
  return id.length <= 10 ? `${id.slice(0, 3)}…` : `${id.slice(0, 6)}…${id.slice(-4)}`
}

/** Jobs that touch an ADOPTED provider: seeded only behind an approved line (R2-10). */
export const ADOPTED_PROVIDER_JOBS: readonly JobId[] = ["posthog_improve", "ga4_improve", "meta_improve", "duplicates_remove", "preview_guard"]

const JOB_PROVIDER: Partial<Record<JobId, ProviderId>> = { posthog_improve: "posthog", ga4_improve: "ga4", meta_improve: "meta" }

const IMPROVE_KINDS: readonly ImproveLineKind[] = [
  "improve_additive",
  "remove_duplicate",
  "preview_guard_adopted",
  "autoconfig_off_adopted",
  "sensitive_pages",
  "posthog_defaults_bump_adopted",
  "capture_beside_adopted_pixel",
  "retire_fbc_writer"
]

// ---------------------------------------------------------------------------------------------
// Candidates → lines
// ---------------------------------------------------------------------------------------------

/** `<jobId>:<target>` → the target. */
function itemTarget(item: ChecklistItem): string {
  const colon = item.id.indexOf(":")
  return colon < 0 ? "" : item.id.slice(colon + 1)
}

/** The provider a candidate touches: from its job, else named in its target. */
export function candidateProvider(item: ChecklistItem): ProviderId | null {
  const fromJob = JOB_PROVIDER[item.jobId as JobId]
  if (fromJob) return fromJob
  const target = itemTarget(item).toLowerCase()
  for (const provider of ["posthog", "ga4", "meta", "infinite"] as const) if (target.includes(provider)) return provider
  return null
}

/**
 * The plan line kind a candidate needs, or null when its job needs no line: the ONE per-target table the
 * registry's seeding gate uses (`requiredLineKind`, §3z.12 B13), so a line and the gate never disagree.
 */
export function lineKindForCandidate(item: ChecklistItem): PlanLineKind | null {
  return requiredLineKind(item)
}

/** Conversion names proposed from the detectors' candidates (jobs 8 and 10): the item target when it is a valid name. */
export function proposedConversionNames(candidates: readonly ChecklistItem[]): string[] {
  const names: string[] = []
  for (const item of candidates) {
    if (item.jobId !== "server_conversions" && item.jobId !== "conversions_to_tools") continue
    const name = itemTarget(item)
    if (CONVERSION_NAME_PATTERN.test(name) && !names.includes(name)) names.push(name)
  }
  return names
}

/** D16: SaaS → StartTrial, ecom → Purchase, from the conversion vocabulary (never a guess when it says neither). */
export function recommendMetaGoal(conversionNames: readonly string[]): "StartTrial" | "Purchase" | null {
  const names = conversionNames.join(" ")
  const saas = /(trial|subscri|sign_?up|signup|demo)/.test(names)
  const ecom = /(purchase|checkout|cart|order)/.test(names)
  if (saas && !ecom) return "StartTrial"
  if (ecom && !saas) return "Purchase"
  return null
}

// ---------------------------------------------------------------------------------------------
// Measured values (raw counts below 50, never 0 for unmeasured)
// ---------------------------------------------------------------------------------------------

/** §3i.3 rule 4: below 50 page views show raw counts ("3 of 41"), else a percentage. Null = unmeasured. */
export function previewShare(baseline: BaselineResponseFields | null | undefined): { value: string; window: string } | null {
  if (!baseline) return null
  const source =
    baseline.ga4.status === "ok" && baseline.ga4.pageViews
      ? baseline.ga4.pageViews
      : baseline.posthog.status === "ok" && baseline.posthog.pageViews
        ? baseline.posthog.pageViews
        : null
  if (!source) return null
  const total = source.production + source.preview + source.other
  const window = `${baseline.window.days} days`
  if (total < 50) return { value: `${source.preview} of ${total} page views were previews`, window }
  return { value: `${((source.preview / total) * 100).toFixed(1)}% of page views were previews`, window }
}

/**
 * D10: automatic Meta events per visit in `before`'s no-click load. B12: ONE count, lane O6's
 * `meta_automatic_events` result that `before` stored in its checks; the plan reads it and never counts `tr`
 * events itself. Null ("—") when not measured (no dry load, a silent or blocked pixel, Traffic Permissions):
 * undetermined, never "0" (§3h.8).
 */
export function automaticMetaEventsPerVisit(before: BeforeFacts): number | null {
  return automaticEventsPerVisitOf(before.checks)
}

// ---------------------------------------------------------------------------------------------
// The preview guard (§3h.9, R2-21)
// ---------------------------------------------------------------------------------------------

/**
 * What the guard silences, for DISPLAY only (the job-7 brief): the contract's exact hosts and suffixes,
 * from `contracts/host-deny-v1.json`. Never a guard spec's `deny`: that list holds exact host literals
 * (O5's `guardHostLiteral` rejects a suffix such as ".vercel.app"); the emitted expression applies the
 * contract's suffixes itself.
 */
export const GUARD_DENY_LIST: readonly string[] = [...HOST_DENY_V1.deny.exact, ...HOST_DENY_V1.deny.suffix]

/** The exact deny literals a guard spec carries (the contract's exact hosts; its suffixes are built in). */
export const GUARD_DENY_EXACT: readonly string[] = [...HOST_DENY_V1.deny.exact]

export function guardDecision(input: {
  keys: TagKeys
  hosting: TagHosting
  observedProductionHost: string | null
  /** §3y.1 / D3: this run's answered (or flagged) production host is ALWAYS exempt. */
  runProductionHost?: string | null
  newGuardedTools: readonly ProviderId[]
  adoptedGuardWanted: boolean
  productionDeniedConflict: ProductionDeniedConflict
}): GuardDecision {
  if (input.newGuardedTools.length === 0 && !input.adoptedGuardWanted) return { emit: false, reason: "no_new_guarded_tool" }
  const configured = [
    ...input.keys.infinite.productionHosts,
    ...(input.hosting.vercel?.productionDomains ?? []),
    ...(input.hosting.vercel?.productionAliases ?? []),
    ...(input.runProductionHost ? [input.runProductionHost] : [])
  ].map(normalizeHost)
  const observed = input.observedProductionHost ? [normalizeHost(input.observedProductionHost)] : []
  // The observed host is trusted only once Infinite lists it: a production served on a denied suffix
  // (`acme.vercel.app`) that the site source does not name would be silenced by the guard.
  const conflict = input.productionDeniedConflict(observed, configured)
  if (conflict.length > 0) return { emit: false, reason: "production_denied", hosts: conflict }
  const exempt = [...new Set([...configured, ...observed])].filter((host) => host !== "")
  if (exempt.length === 0) return { emit: false, reason: "no_production_host" }
  return { emit: true, exempt, deny: [...GUARD_DENY_EXACT] }
}

// ---------------------------------------------------------------------------------------------
// Privacy text
// ---------------------------------------------------------------------------------------------

/**
 * Optional copy-only disclosure wording for the site owner. Never a plan question or agent instruction. The Infinite sentences say what the installed lanes send, from the same
 * facts as the harness's disclosure notice.
 */
export function draftPrivacyParagraph(tools: readonly ProviderId[], serverLane: boolean): string | null {
  const lines: string[] = []
  if (tools.includes("infinite")) {
    lines.push(
      "We use Infinite (Ultima Inc.) to measure visits. Each page view sends Infinite the page address without its query string, a random visitor id, and your browser's IP address and user agent."
    )
    if (serverLane) {
      lines.push(
        "Our server also tells Infinite which pages were requested, with a coarse browser type and a visit key that changes every 30 minutes; your IP address and full user agent stay on our server."
      )
    }
  }
  if (tools.includes("ga4")) lines.push("We use Google Analytics 4 (Google) to measure how visitors use this site.")
  if (tools.includes("posthog")) lines.push("We use PostHog to understand how visitors use this site, including page views and clicks.")
  if (tools.includes("meta")) lines.push("We use the Meta Pixel (Meta Platforms) to measure our ads; it can store an ad-click id in a cookie (_fbc).")
  return lines.length === 0 ? null : lines.join("\n")
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

/**
 * The tools this plan installs NEW (managed): connected, resolvable to exactly one id by the keys
 * adapter, and not already in the repo as someone else's tag (an adopted tool is improved, never
 * reinstalled). Infinite is always installable: its site source is created at `install`.
 */
function newTools(input: PlanModelInput, facts: LineFacts): { tools: ProviderId[]; ids: Partial<Record<ProviderId, string>>; infiniteUnrunnable: string | null } {
  // Adopted = the installer's own evidence OR lane O6's census (which also reads an init inside a
  // `<Script>{`…`}</Script>` template literal, the common Next pattern the installer's string-masked
  // scan skips): a pixel the census already found on the page is improved in place, never installed twice.
  const adopted = new Set<string>([
    ...input.scan.adopted.map((entry) => entry.provider),
    ...(input.before.census?.entries ?? []).filter((entry) => entry.owner === "adopted").map((entry) => entry.tool)
  ])
  const { artifacts } = artifactsFromKeysDetailed(
    input.keys,
    { consentMode: "not_required", conversionNames: [], privacyText: null, npmInstall: null },
    { posthogProxy: input.scan.posthogProxy ?? true }
  )
  const tools: ProviderId[] = []
  const ids: Partial<Record<ProviderId, string>> = {}
  // §3y.5: Infinite's line is approvable only when its install will run (a host, and a source or a proof path).
  let infiniteUnrunnable: string | null = null
  if (!adopted.has("infinite") && !input.scan.infiniteBlocked) {
    const runnable = lineRunnable("install_provider:infinite", facts)
    if (runnable.ok) tools.push("infinite")
    else infiniteUnrunnable = runnable.line
  }
  if (artifacts.ga4 && !adopted.has("ga4")) {
    tools.push("ga4")
    ids.ga4 = artifacts.ga4.measurementId
  }
  if (artifacts.posthog && !adopted.has("posthog")) {
    tools.push("posthog")
    ids.posthog = artifacts.posthog.projectKey
  }
  if (artifacts.meta && !adopted.has("meta")) {
    tools.push("meta")
    ids.meta = artifacts.meta.pixelId
  }
  return { tools, ids, infiniteUnrunnable }
}

function line(partial: Omit<PlanLine, "editable"> & { editable?: boolean }): PlanLine {
  return { editable: false, ...partial }
}

/** sha256 over the lines + decisions (the plan's identity; a resume re-confirms a changed one). */
export function planHash(lines: readonly PlanLine[], decisions: PlanModel["decisions"]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ lines, decisions }), "utf8").digest("hex")}`
}

/** R2-6: true when the plan asks the consent decision (it is left out when nothing it governs exists this run). */
export function planAsksConsent(plan: Pick<PlanModel, "lines">): boolean {
  return plan.lines.some((line) => line.kind === "consent_mode")
}

export function buildPlanModel(input: PlanModelInput): WizardPlanModel {
  const { keys, before, scan } = input
  const lines: PlanLine[] = []
  const facts = lineFactsFor(input)
  const { tools: proposedTools, ids: toolIds, infiniteUnrunnable } = newTools(input, facts)
  const tools = scan.ownerWiring?.canWire === false ? [] : proposedTools
  const hosting = before.hosting
  const serverLaneRule = lineRunnable("server_lane", facts)
  const serverLaneApprovable = serverLaneRule.ok && scan.serverLane !== null && tools.includes("infinite")
  // §3y.5 (P3-13): job 10 is seeded only when this install emits the conversion helpers (a new or managed tool).
  const helpersEmitted = tools.length > 0 || scan.managedProviders.length > 0
  const infiniteRecordable = tools.includes("infinite") || scan.managedProviders.includes("infinite") || keys.infinite.status === "ready"
  // Server outcomes need the server lane's reportInfiniteOutcome export. Browser helpers alone do not provide it.
  const withheldItems = input.candidates.filter((item) =>
    (item.jobId === "server_conversions" && !serverLaneApprovable) ||
    (item.jobId === "conversions_to_tools" && !helpersEmitted)
  )
  const withheld = withheldItems.map((item) => item.id)
  const sources = scan.sources ? new Map(Object.entries(scan.sources)) : null
  const captureScope = (item: ChecklistItem): ChecklistItem => {
    const capture = scan.managedCapture
    if (!capture || item.jobId !== "meta_improve" || !/^meta_improve:capture(?::|$)/.test(item.id)) return item
    if (!capture.canWire) {
      const requirement = capture.requirements[0]
      return { ...item, owner: "code", state: "left_for_you", blockedReason: undefined, checks: [], claim: undefined,
        note: `Not changed by us: the app entry cannot load the capture safely. This run does not save the landing ad-click id. ${requirement?.reason ?? "Add the entry wiring yourself."}`,
        ownerBoundary: { ...(requirement?.ownerBoundary ?? { kind: "unproven_wiring" as const }), wiring: capture.requirements.map(entry => `${entry.path}:\n${entry.snippet}`).join("\n\n") },
        allow: { files: [], create: [] } }
    }
    return { ...item, owner: "code", state: "pending", blockedReason: undefined, ownerBoundary: undefined, claim: undefined, checks: itemChecksFor("meta_improve", "capture", scan.framework),
      note: undefined, title: "Save Meta landing click ids in a managed module",
      allow: { files: [...capture.editEntrypoints], create: [capture.module] },
      trigger: { finding: `The installer adds ${capture.module} and wires it before the pixel from ${capture.entrypoints.join(", ")}. The pixel's own file is unchanged. Capture follows the Infinite consent choice below, independently of other banners until you connect their yes/no signal.`, evidence: capture.editEntrypoints.map(file => ({ file, line: 1 })) } }
  }
  const sensitiveNeeded = (file: string | undefined) => sensitivePosthogOptions(file ? scan.sources?.[file] : undefined, scan.sensitivePaths) !== null
  let candidates = input.candidates.filter(item => item.id !== "posthog_improve:sensitive_pages" || sensitiveNeeded(item.allow.files[0])).filter((item) => !withheld.includes(item.id)).map(captureScope).map(item => sources ? scopeOwnerJob(item, sources, scan.appRoot) : item)

  // ---- the four decisions ----
  // R2-6 (live run 2): a decision is asked only when something it governs can be installed or recorded this run.
  // Consent governs Infinite's collection (an install, a managed tag, or a site source it is recorded on) and the
  // consent gate of the managed tags and the Meta click-id capture. Conversion names govern the conversion jobs, the
  // emitted helpers and Infinite's declared conversions. Neither is asked, or pre-checked, when none of that exists.
  const ownerConsentFound = recognizedConsentHandling(scan.sources)
  const consentProposed = input.consentFlag ?? (ownerConsentFound ? "required" : keys.infinite.consentMode ?? "not_required")
  const consentLine = line({
      id: DECISION_LINE_IDS.consentMode,
      kind: "consent_mode",
      text:
        consentProposed === "required"
          ? `Consent for Infinite's tag and the Meta ad-click cookie this run adds: wait for my banner's yes.${ownerConsentFound ? " Default: found consent handling or a banner." : ""} You must connect the yes/no signal below.`
          : consentProposed === "not_required"
            ? `Consent for Infinite's tag and the Meta ad-click cookie this run adds: collect by default; DNT/GPC visitors are skipped unless they explicitly opted in.${!ownerConsentFound ? " Default: no banner or consent call was recognized." : ""} This is independent of your other banner until you connect it.`
            : "Consent for Infinite's tag and the Meta ad-click cookie this run adds: choose collect by default, or wait for my banner's yes. Other banners do not control them until you connect their yes/no signal.",
      requires: "approval",
      editable: true
    })
  lines.push(consentLine)
  // The names are the user's decision for Infinite whatever runs this time (a withheld job-10 type still names one).
  const conversionNames = proposedConversionNames(input.candidates)
  const conversionJobs = candidates.filter((item) => item.jobId === "server_conversions" || item.jobId === "conversions_to_tools").map((item) => item.id)
  if (conversionJobs.length > 0 || helpersEmitted || infiniteRecordable) {
    lines.push(
      line({
        id: DECISION_LINE_IDS.conversionNames,
        kind: "conversion_names",
        text: conversionNames.length > 0 ? `Conversions: ${conversionNames.join(" · ")}` : "Conversions: none found — add names, or skip",
        requires: "approval",
        editable: true,
        ...(conversionJobs.length > 0 ? { jobIds: conversionJobs } : {})
      })
    )
  }
  for (const item of candidates) {
    if (item.jobId !== "conversions_to_tools" || item.state !== "blocked" || item.blockedReason !== "needs_you" || item.allow.files.length > 0 || item.allow.create.length > 0) continue
    item.note = `${item.title}: not wired. No successful completion handler was found in the browser code; add or identify that success handler before this conversion can be sent. A link or button click alone is not a completed outcome.`
    lines.push(line({ id: `user_action:conversion_target:${item.id}`, kind: "user_action", requires: "user_action", text: item.note }))
  }
  const privacyText = null // Owner-only; suggested wording is copy-only report material.
  let npmInstall: string | null = null
  if (scan.serverLane && scan.serverLane.installPackages.length > 0 && serverLaneApprovable && lineRunnable("npm_install", facts).ok) {
    if (scan.npm && "commandLine" in scan.npm) {
      npmInstall = scan.npm.commandLine
      lines.push(
        line({
          id: DECISION_LINE_IDS.npmInstall,
          kind: "npm_install",
          text: `Install the server-lane package (runs its install scripts): ${scan.npm.commandLine}`,
          requires: "approval",
          editable: true,
          ownership: "managed"
        })
      )
    } else {
      lines.push(
        line({
          id: "user_action:npm",
          kind: "user_action",
          text: `Install ${scan.serverLane.installPackages.join(", ")} yourself before you merge${scan.npm && "refused" in scan.npm ? ` (${scan.npm.refused})` : ""}; the server lane imports it.`,
          requires: "user_action"
        })
      )
    }
  }

  // ---- what gets installed (new tools, managed) ----
  for (const tool of tools) {
    const managed = scan.managedProviders.includes(tool)
    const id = toolIds[tool] ?? null
    lines.push(
      line({
        // The public id is part of the line id: approving "GA4 (G-A)" never installs G-B.
        id: id ? `install_provider:${tool}:${id}` : `install_provider:${tool}`,
        kind: "install_provider",
        text: `${managed ? "Update" : "Install"} ${TOOL_NAME[tool]}${id ? ` (${id}, from your Infinite connection)` : ""}${tool === "posthog" && (scan.posthogProxy ?? true) && (keys.posthog.region === "us" || keys.posthog.region === "eu") ? " through /ingest on your own domain" : ""}`,
        requires: "approval",
        ownership: "managed"
      })
    )
  }
  if (tools.includes("infinite") && !facts.infiniteReady && !facts.vercelServesHost && facts.productionHost) {
    // The claim path (§3y.2): said right under the Infinite line, before anything is approved.
    lines.push(line({ id: "info:infinite_site_file", kind: "user_action", text: RUNNABILITY_TEXT.claimWording(facts.productionHost), requires: "info" }))
  }
  if (infiniteUnrunnable) {
    lines.push(line({ id: "user_action:infinite", kind: "user_action", text: infiniteUnrunnable, requires: "user_action" }))
  }
  if (scan.infiniteBlocked && !scan.adopted.some((entry) => entry.provider === "infinite")) {
    lines.push(line({ id: "user_action:infinite_blocked", kind: "user_action", text: `Infinite: ${scan.infiniteBlocked}`, requires: "user_action" }))
  }
  if (scan.installBlocked) {
    lines.push(
      line({
        id: "user_action:install_blocked",
        kind: "user_action",
        text: `The install cannot be applied as planned until this is fixed: ${scan.installBlocked.slice(0, 300)}`,
        requires: "user_action"
      })
    )
  }
  if (scan.nextConfigRewrites && tools.includes("infinite")) {
    lines.push(
      line({
        id: "user_action:next_config_rewrites",
        kind: "improve_additive",
        ownership: "managed",
        jobIds: ["unusual_layout:next_config_rewrites"],
        text: `Your own ${scan.nextConfigRewrites.path} is never edited by the installer: Infinite's collect rewrite goes in it as an agent job the wizard checks (or you add it). Until it is there, Infinite's tag records nothing.`,
        requires: "info"
      })
    )
  }
  if (serverLaneApprovable && scan.serverLane) {
    lines.push(
      line({
        id: "server_lane",
        kind: "server_lane",
        text: `Server lane (${scan.serverLane.targetLabel}): counts every page request on your server, even with ad blockers. ${SERVER_LANE_PROBE_DISCLOSURE}`,
        requires: "approval",
        ownership: "managed",
        jobIds: candidates.filter((item) => item.jobId === "server_conversions").map((item) => item.id)
      })
    )
  } else if (scan.serverLane && (tools.includes("infinite") || infiniteUnrunnable) && !serverLaneRule.ok && serverLaneRule.line) {
    // §3y.5: never pre-checked when it cannot run; it says what is needed instead.
    lines.push(line({ id: "user_action:server_lane", kind: "user_action", text: serverLaneRule.line, requires: "user_action" }))
  }

  // ---- the preview guard ----
  const guardedNew = tools.filter((tool): tool is "ga4" | "posthog" | "meta" => tool === "ga4" || tool === "posthog" || tool === "meta")
  const consentObstructed = new Set(candidates.filter(item => item.jobId === "preview_guard" && item.state === "left_for_you").map(item => itemTarget(item)))
  const adoptedGuardLines = scan.improve.filter((entry) => entry.kind === "preview_guard_adopted" && !consentObstructed.has(entry.provider))
  const guard = guardDecision({
    keys,
    hosting,
    observedProductionHost: before.observedProductionHost,
    runProductionHost: facts.productionHost,
    newGuardedTools: guardedNew,
    adoptedGuardWanted: adoptedGuardLines.length > 0 || candidates.some((item) => item.jobId === "preview_guard"),
    productionDeniedConflict: input.productionDeniedConflict
  })
  if (guard.emit && guardedNew.length > 0) {
    lines.push(
      line({
        id: "preview_guard_managed",
        kind: "preview_guard_managed",
        text: `Previews stay silent for the new ${guardedNew.map((tool) => TOOL_NAME[tool]).join(", ")} tags; ${guard.exempt.join(", ")} always fire${guard.exempt.length === 1 ? "s" : ""}.`,
        requires: "approval",
        ownership: "managed"
      })
    )
  } else if (!guard.emit && guard.reason === "production_denied") {
    lines.push(
      line({
        id: "preview_guard_blocked",
        kind: "user_action",
        text: `Your live site is served on ${guard.hosts.join(", ")}, which the preview guard would silence; tell the wizard your live domain (--production-host). No preview guard is added until then.`,
        requires: "user_action"
      })
    )
  } else if (!guard.emit && guard.reason === "no_production_host") {
    lines.push(
      line({
        id: "preview_guard_blocked",
        kind: "user_action",
        text: GUARD_NO_HOST_TEXT,
        requires: "user_action"
      })
    )
  }

  // D17 on a NEW (managed) PostHog: the managed init turns replay + autocapture off on these paths.
  if (tools.includes("posthog") && scan.sensitivePaths.length > 0) {
    lines.push(
      line({
        id: "sensitive_pages:posthog:managed",
        kind: "sensitive_pages",
        text: `PostHog: no session replay and no autocapture on sensitive pages (${scan.sensitivePaths.join(", ")}).`,
        requires: "approval",
        ownership: "managed"
      })
    )
  }

  // ---- adopted providers: improve lines, linked to the candidates that need them ----
  const improveLines = scan.improve.filter(entry => entry.kind !== "sensitive_pages" || sensitiveNeeded(entry.evidence?.file)).filter((entry) => entry.kind !== "preview_guard_adopted" || (guard.emit && !consentObstructed.has(entry.provider)))
  /**
   * Lines a candidate links to, by EXACT identity (kind + provider + normalised target). There is no
   * "first line of the kind" fallback: a candidate that matches no line gets a line of its own, so
   * declining one line can never leave another line's job seeded (P0-1).
   */
  const linked: Array<{ kind: PlanLineKind; provider: ProviderId | null; target: string; line: PlanLine }> = []
  const findLinked = (kind: PlanLineKind, provider: ProviderId | null, target: string): PlanLine | undefined =>
    linked.find((entry) => entry.kind === kind && entry.provider === provider && entry.target === target)?.line
  const share = previewShare(before.baseline)
  const automatic = automaticMetaEventsPerVisit(before)
  for (const entry of improveLines) {
    const measured =
      entry.kind === "preview_guard_adopted"
        ? share ?? undefined
        : entry.kind === "autoconfig_off_adopted"
          ? automatic === null
            ? undefined
            : { value: `${automatic} automatic events per visit, no clicks`, window: "the no-send test load" }
          : undefined
    const planLine = line({
      id: entry.id,
      kind: entry.kind,
      text:
        entry.kind === "preview_guard_adopted" && entry.provider === "meta"
          ? `${entry.text} Preview share: ${share ? share.value : "—"}.`
          : entry.kind === "autoconfig_off_adopted"
            ? `${entry.text} Measured: ${automatic === null ? "—" : `${automatic} per visit`}.`
            : entry.text,
      requires: "approval",
      ownership: "adopted",
      ...(measured ? { measured } : {})
    })
    lines.push(planLine)
    linked.push({ kind: entry.kind, provider: entry.provider, target: entry.target, line: planLine })
  }

  // Conflicts (two ids), from the census and the no-send load: the user resolves them.
  const findings = duplicateFindings(before)
  for (const finding of findings) {
    if (finding.kind === "conflict") lines.push(line({ id: finding.id, kind: "user_action", text: finding.text, requires: "user_action" }))
  }

  // Every candidate whose job needs a line is linked to exactly ONE line of its own identity (created
  // from the candidate when no improve line matches). A candidate of an adopted-provider job is NEVER
  // left unlinked. A duplicate (job 6) is always its own line, one per candidate: the measured wording
  // comes from `before` when the same tool + id was found there.
  for (const item of candidates) {
    if (item.state === "left_for_you" || item.jobId === "privacy_paragraph") continue
    const kind = lineKindForCandidate(item)
    // Plan-wide kinds are decided by their own one line (consent/names/privacy/server lane), never per candidate.
    if (kind === null || kind === "conversion_names" || kind === "privacy_text" || kind === "server_lane") continue
    if (kind === "preview_guard_adopted" && !guard.emit) continue
    const provider = candidateProvider(item)
    const targetName = itemTarget(item) || item.jobId
    const linkTarget = candidateLinkTarget(item, kind, targetName)
    let target = findLinked(kind, provider, linkTarget)
    if (!target) {
      const measured = kind === "remove_duplicate" ? duplicateTextFor(findings, provider, targetName) : null
      target = line({
        id: `${kind}:${provider ?? "site"}:${targetName}`,
        kind,
        // R4-8 (live run 4): the headline named GA4's missed page changes and no line offered the fix; the line says
        // the change the user approves (the finding stays the job's "Why").
        text: kind === "ga4_spa_page_views" ? GA4_SPA_LINE_TEXT : (measured ?? item.trigger.finding),
        requires: "approval",
        ownership: "adopted"
      })
      lines.push(target)
      linked.push({ kind, provider, target: linkTarget, line: target })
    }
    target.jobIds = [...new Set([...(target.jobIds ?? []), item.id])]
  }

  // An improve line no candidate links, whose change is (partly) the agent's, gets its own item, so an
  // approved line always has a job or a code edit behind it (P2-14).
  let seeds: ChecklistItem[] = scan.nextConfigRewrites && tools.includes("infinite")
    ? configRewriteJobs([{ path: scan.nextConfigRewrites.path, snippet: scan.nextConfigRewrites.snippet ?? "Add the Infinite collect rewrite named by the install plan." }], candidates) : []
  const takenIds = new Set(candidates.map((item) => item.id))
  for (const entry of improveLines) {
    const planLine = lines.find((candidateLine) => candidateLine.id === entry.id)
    if (!planLine || (planLine.jobIds?.length ?? 0) > 0) continue
    const rawSeed = seedForImproveLine(entry.kind === "capture_beside_adopted_pixel" && scan.managedCapture ? { ...entry, owner: "agent" } : entry, scan.appRoot ?? ".", scan.framework)
    const seed = rawSeed ? captureScope(rawSeed) : null
    if (!seed) continue
    // An already-scoped detector candidate still owns this line, even when the owner must do it.
    planLine.jobIds = [seed.id]
    if (takenIds.has(seed.id)) continue
    takenIds.add(seed.id)
    seeds.push(seed)
  }

  // ---- Meta: the goal (D16) and the server-events relay (D11) ----
  const metaPresent = tools.includes("meta") || scan.adopted.some((entry) => entry.provider === "meta")
  const goal = metaPresent ? recommendMetaGoal(conversionNames) : null
  if (metaPresent) {
    lines.push(
      line({
        id: "meta_goal",
        kind: "meta_goal",
        text: goal
          ? `Meta goal: ${goal} (${goal === "StartTrial" ? "a SaaS sign-up starts a trial" : "a shop sale"}); change it in Meta any time.`
          : "Meta goal: StartTrial if you sell subscriptions, Purchase if you sell products.",
        // With no recommendation there is nothing to approve: the line only informs (never an answer).
        requires: "info"
      })
    )
  }
  if (keys.meta.status === "connected" && keys.meta.pixels.length === 1) {
    lines.push(
      line({
        id: "meta_relay",
        kind: "meta_relay",
        text: "Meta server events: send your server-side conversions to Meta through Infinite, with ONE shared event id so the browser and server never count twice.",
        requires: "approval"
      })
    )
  }

  // §3x.3 (F6): the site's own Meta pixel counted only the first page of the test load's visit. A change to the
  // customer's own tag, so it is a line the user approves (never done on the wizard's say-so).
  const metaSpaItems = candidates.filter((item) => item.id === "meta_improve:spa_page_view")
  if (metaSpaItems.length > 0 && scan.adopted.some((entry) => entry.provider === "meta")) {
    lines.push(
      line({
        id: "meta_spa_page_views",
        kind: "meta_spa_page_views",
        text: "Meta: send one PageView per page change in your app (today it counts only the first page of each visit).",
        requires: "approval",
        jobIds: metaSpaItems.map((item) => item.id)
      })
    )
  }

  if (sources) {
    candidates = candidates.map(item => scopeOwnerJob(item, sources, scan.appRoot))
    seeds = seeds.map(item => scopeOwnerJob(item, sources, scan.appRoot))
  }
  {
    // Capture planning and the registry may already have scoped items without scan source text.
    const left = new Map([...candidates, ...seeds].filter(item => item.state === "left_for_you").map(item => [item.id, item]))
    for (const planLine of lines) {
      if (!planLine.jobIds?.some(id => left.has(id))) continue
      const runnable = planLine.jobIds.filter(id => !left.has(id))
      if (runnable.length) planLine.jobIds = runnable
      else { planLine.requires = "user_action"; planLine.editable = false; planLine.text = planLine.jobIds.map(id => left.get(id)?.note ?? "Left for the owner").join("\n"); planLine.jobIds = [...planLine.jobIds] }
    }
  }
  if (scan.managedCapture?.canWire) {
    for (const planLine of lines) if (planLine.kind === "capture_beside_adopted_pixel") planLine.text = `Meta: save landing ad-click ids in ${scan.managedCapture.module}, loaded first from ${scan.managedCapture.entrypoints.join(", ")}. The pixel's own file is unchanged. Capture follows Infinite's consent setting: required mode stays off until your banner sends the yes signal; default collection is independent of other banners until you connect them. Offline checks show only that it works when consent is granted.`
  }
  for (const item of [...candidates, ...seeds].filter(entry => entry.state === "left_for_you")) {
    if (item.id === "posthog_improve:sensitive_pages" && item.ownerBoundary) {
      const options = sensitivePosthogOptions(sources?.get(item.ownerBoundary.file ?? ""), scan.sensitivePaths)
      item.note = `${item.note ?? "Not changed by us."} Keep existing exclusions; this addition only turns collection off on the listed pages.`
      if (options) item.ownerBoundary.wiring = `// Add last inside the existing posthog.init options object.\n${options}`
    }
    const handoff = item.jobId === "preview_guard" && item.ownerBoundary && guard.emit
      ? ownerGuardHandoff(item.note ?? item.trigger.finding, item.ownerBoundary, buildHostGuardExpression({ mode: "deny", exempt: guard.exempt, deny: guard.deny }), sources?.get(item.ownerBoundary.file ?? "")) : null
    if (handoff && item.ownerBoundary) item.ownerBoundary.guard = handoff.guard
    const text = handoff?.text ?? [item.note ?? item.trigger.finding, item.ownerBoundary?.wiring ? `Owner-only wiring:\n${item.ownerBoundary.wiring}` : null].filter(Boolean).join("\n\n")
    const prior = lines.find(planLine => planLine.requires === "user_action" && planLine.id !== "user_action:owner_wiring" && (planLine.jobIds?.includes(item.id) || planLine.text === item.note))
    if (prior) prior.text = text
    else lines.push(line({ id: `owner_only:${item.id}`, kind: "user_action", text, requires: "user_action" }))
  }

  if (keys.ga4.status === "connected") lines.push(line({ id: "account_settings:ga4", kind: "account_settings", requires: "approval", text: "Allow Infinite to mark the selected, click-tested conversions as key events in your connected GA4 property." }))
  if (serverLaneApprovable) lines.push(line({ id: "account_settings:hosting", kind: "account_settings", requires: "approval", text: "Allow Infinite to save server-lane environment settings in your connected hosting project." }))

  // ---- things only the user can do ----
  if (scan.adopted.some((entry) => entry.via === "gtm")) {
    lines.push(line({ id: "user_action:gtm", kind: "user_action", text: "Google Tag Manager runs some of your tags: changes there are yours to make (the wizard never edits GTM).", requires: "user_action" }))
  }
  if (metaPresent) {
    lines.push(
      line({
        id: "user_action:meta_traffic_permissions",
        kind: "user_action",
        text: "Meta: in Events Manager → Settings → Traffic permissions, allow only your own domains, so previews and copies of your site cannot send to your pixel.",
        requires: "user_action"
      })
    )
  }
  for (const [tool, status] of [
    ["ga4", keys.ga4.status],
    ["posthog", keys.posthog.status],
    ["meta", keys.meta.status]
  ] as const) {
    const adopted = scan.adopted.find((entry) => entry.provider === tool)
    // §3x.6 (R3-4): an ADOPTED tool that is not connected is said too, with the id in the code: its id cannot be
    // compared with a connection, so the run can only ever be "unconfirmed" for it.
    if (adopted && (status === "not_connected" || status === "no_pixel")) {
      lines.push(
        line({
          id: `user_action:connect_${tool}`,
          kind: "user_action",
          text: `${TOOL_NAME[tool]} (${adopted.key ? `${maskPublicId(adopted.key)} in your code` : "in your code"}): connect it in Infinite so the wizard can check that ID is yours. The repository changes shown in this plan can still run.`,
          requires: "user_action"
        })
      )
      continue
    }
    if (!adopted && (status === "not_connected" || status === "read_failed" || status === "no_pixel")) {
      lines.push(
        line({
          id: `user_action:connect_${tool}`,
          kind: "user_action",
          text: `${TOOL_NAME[tool]}: ${status === "read_failed" ? "Infinite could not read the connection" : "not connected"} — connect it in Infinite and run the wizard again to add it. No id is made up.`,
          requires: "user_action"
        })
      )
    }
  }

  if (withheldItems.length > 0) {
    lines.push(line({ id: "user_action:conversions_unwired", kind: "user_action", text: RUNNABILITY_TEXT.conversionsUnwired(proposedConversionNames(withheldItems)), requires: "user_action" }))
  }

  // R2-6: the consent line stays only when it governs something on THIS plan (see above).
  const consentGoverns = infiniteRecordable || helpersEmitted || lines.some((entry) => entry.kind === "capture_beside_adopted_pixel")
  if (!consentGoverns) lines.splice(lines.indexOf(consentLine), 1)
  if (consentGoverns) {
    const handoff = consentHandoff({ mode: "required", infinite: tools.includes("infinite") || scan.managedProviders.includes("infinite"), capture: scan.managedCapture?.canWire === true || tools.includes("meta") })
    // Keep the handoff visible when the decision is edited interactively after this plan was built.
    if (handoff) {
      const firstOwner = lines.findIndex(entry => entry.requires === "user_action")
      lines.splice(firstOwner < 0 ? lines.length : firstOwner, 0, line({ id: "user_action:banner_signal", kind: "user_action", requires: "user_action", text: `${consentProposed === "required" ? "" : "If you choose wait for my banner's yes: "}${handoff}` }))
    }
  }

  // ---- B28: the 7-day check-in (on by default, BUILD-PLAN §1.4; the plan says so, nothing to answer) ----
  lines.push(
    line({
      id: "checkin",
      kind: "checkin",
      text: "Infinite checks your site again 7 days after the deploy and shows you what it finds.",
      requires: "info"
    })
  )

  if (scan.ownerWiring?.canWire === false) {
    const why = scan.ownerWiring.requirements.some(item => item.ownerBoundary?.kind === "frozen_unit") ? "We could not install here without editing a file that holds your consent code" : "We could not safely wire the tag from this app entry"
    lines.unshift(line({ id: "user_action:owner_wiring", kind: "user_action", requires: "user_action", text: `Infinite's tag is NOT installed by this run. ${why} (${scan.ownerWiring.requirements.map(item => item.path).join(", ")}). Add these lines yourself, then run npx infinite-tag again:\n${scan.ownerWiring.requirements.map(item => `${item.path}:\n${item.snippet}`).join("\n\n")}` }))
  }
  for (const requirement of scan.ownerWiring?.requirements ?? []) {
    if (scan.ownerWiring?.canWire === false) continue
    lines.push(line({ id: `owner_wiring:${requirement.path}`, kind: "user_action", requires: "user_action", text: `${requirement.reason}\n${requirement.path}:\n${requirement.snippet}` }))
  }

  // ---- the agent's budget (the cost line in the go-ahead) ----
  // §3y.5: "up to N" = the agent jobs that run when every approvable line is approved (the one count function).
  for (const planLine of lines) if (planLine.requires === "approval" && isRepositoryWork(planLine)) planLine.requires = "info"
  const provisionalDecisions: PlanModel["decisions"] = { consentMode: consentProposed, conversionNames, privacyText, npmInstall }
  const provisional = { hash: "", lines, decisions: provisionalDecisions, installTools: tools, managedTools: [...scan.managedProviders], serverLaneOffered: serverLaneApprovable, withheld, scopedCandidates: candidates } as unknown as PlanModel
  const agentJobs = agentJobsUpTo(candidates, seeds, provisional, input.consentFlag)
  if (agentJobs > 0) {
    const name = input.agent?.worker === "claude_code" ? "Claude Code" : input.agent?.worker === "codex" ? "Codex" : null
    lines.push(
      line({
        id: "agent_budget",
        kind: "agent_budget",
        text: name
          ? `${name}: up to ${agentJobs} job${agentJobs === 1 ? "" : "s"} · ${AGENT_MODELS[input.agent!.worker!].label} at ${AGENT_MODELS[input.agent!.worker!].effort} effort · up to ${AGENT_LIMITS.jobs.maxTurns} turns or ${Math.round(AGENT_LIMITS.jobs.wallMs / 60_000)} min · ${input.agent?.whoPays?.label ?? "who pays: unknown"}`
          : `No agent found: the ${agentJobs} agent job${agentJobs === 1 ? "" : "s"} are listed for you to do by hand.`,
        requires: name && input.agent?.whoPays?.payer !== "plan" ? "approval" : "info"
      })
    )
  }

  const decisions: PlanModel["decisions"] = {
    consentMode: consentProposed,
    conversionNames,
    privacyText,
    npmInstall
  }
  return {
    approvalMode: "shown_and_continued",
    ownerWiring: scan.ownerWiring,
    scopedCandidates: candidates,
    hash: planHash(lines, decisions),
    lines,
    decisions,
    guard,
    installTools: tools,
    managedTools: [...scan.managedProviders],
    seeds,
    metaGoal: goal,
    serverLaneOffered: serverLaneApprovable,
    withheld
  }
}

/** The target a candidate links by: job 7's line is per provider (`init`); job 5's capture is `capture`. */
function candidateLinkTarget(item: ChecklistItem, kind: PlanLineKind, targetName: string): string {
  if (item.jobId === "preview_guard" || kind === "preview_guard_adopted") return "init"
  if (kind === "capture_beside_adopted_pixel") return "capture"
  return targetName
}

/** A public id in a duplicate target (`ga4_config:G-X`, `meta_init:<id>`, `ga4_gtag:G-X`), else null. */
function duplicateTargetId(targetName: string): string | null {
  const colon = targetName.indexOf(":")
  return colon < 0 ? null : targetName.slice(colon + 1)
}

/** The measured wording for a job-6 candidate, from `before`'s finding of the same tool AND id. */
function duplicateTextFor(findings: readonly DuplicateFinding[], provider: ProviderId | null, targetName: string): string | null {
  const id = duplicateTargetId(targetName)
  const sameTool = findings.filter((finding) => finding.kind === "duplicate" && finding.provider === provider)
  if (id !== null) return sameTool.find((finding) => finding.publicId === id)?.text ?? null
  if (targetName === "ga4_gtag") {
    const gtm = sameTool.filter((finding) => finding.shape === "gtm_and_gtag")
    return gtm.length === 1 ? gtm[0]!.text : null
  }
  return null
}

/** R4-8: the approvable line for an adopted GA4 that misses client-side page changes. */
export const GA4_SPA_LINE_TEXT = "GA4: send one page_view per page change in your app (today GA4 counts only the first page of each visit)."

/** The job + target an improve line's own item uses (null: the line's change is all code, or no job fits). */
function seedJobFor(entry: ImproveLine): { jobId: JobId; target: string } | null {
  switch (entry.kind) {
    case "preview_guard_adopted":
      return entry.provider === "infinite" || entry.provider === "x" ? null : { jobId: "preview_guard", target: entry.provider }
    case "improve_additive":
      if (entry.owner === "code" && !(entry.provider === "posthog" && entry.target === "proxy")) return null
      return entry.provider === "posthog"
        ? { jobId: "posthog_improve", target: entry.target }
        : entry.provider === "ga4"
          ? { jobId: "ga4_improve", target: entry.target }
          : entry.provider === "meta"
            ? { jobId: "meta_improve", target: entry.target }
            : null
    case "posthog_defaults_bump_adopted":
      return { jobId: "posthog_improve", target: "defaults" }
    case "sensitive_pages":
      return entry.provider === "posthog" ? { jobId: "posthog_improve", target: "sensitive_pages" } : null
    case "capture_beside_adopted_pixel":
      return entry.owner === "agent" ? { jobId: "meta_improve", target: "capture" } : null
    case "autoconfig_off_adopted":
      return entry.owner === "agent" ? { jobId: "meta_improve", target: "autoconfig_off_adopted" } : null
    case "retire_fbc_writer":
      return { jobId: "meta_improve", target: "retire_fbc_writer" }
    default:
      return null
  }
}

function seedForImproveLine(entry: ImproveLine, appRoot: string, framework: string): ChecklistItem | null {
  const job = seedJobFor(entry)
  if (!job) return null
  const spec = JOB_TABLE[job.jobId]
  const file = entry.evidence ? (appRoot === "." ? entry.evidence.file : `${appRoot}/${entry.evidence.file}`) : null
  return {
    id: `${job.jobId}:${job.target}`,
    jobId: job.jobId,
    n: spec.n,
    title: spec.title,
    owner: "agent",
    trigger: { finding: entry.text, evidence: file && entry.evidence ? [{ file, line: entry.evidence.line }] : [] },
    allow: { files: file ? [file] : [], create: [] },
    // R4-2: the item's OWN checks (its target's), never every check of its job: run 4's capture item carried the
    // whole Meta table and was graded by checks about other targets.
    checks: itemChecksFor(job.jobId, job.target, framework),
    state: "pending"
  }
}

// ---------------------------------------------------------------------------------------------
// Duplicates (job 6) and conflicts, from `before` (never from rehearsal data, which does not exist yet)
// ---------------------------------------------------------------------------------------------

export interface DuplicateFinding {
  id: string
  kind: "duplicate" | "conflict"
  provider: ProviderId
  text: string
  /** The public id the finding is about (null for a conflict). */
  publicId: string | null
  /** `repeated_init` (one id set up twice) or `gtm_and_gtag` (Tag Manager + a hand-written gtag). */
  shape: "repeated_init" | "gtm_and_gtag" | null
}

export function duplicateFindings(before: BeforeFacts): DuplicateFinding[] {
  const findings: DuplicateFinding[] = []
  const entries = before.census.entries
  const ga4Configs = entries.filter((entry) => entry.tool === "ga4" && entry.kind !== "gtm")
  const hasGtm = entries.some((entry) => entry.kind === "gtm")
  const liveTids = new Map<string, number>()
  if (before.dryLive) {
    const perLoad = new Map<string, number>()
    for (const event of before.dryLive.ga4.events) {
      // Only the page view of the load itself: an SPA's after-navigation page view is not a duplicate.
      if (event.en !== "page_view" || event.afterNav) continue
      const key = `${event.loadLabel}\n${event.tid}`
      perLoad.set(key, (perLoad.get(key) ?? 0) + 1)
    }
    for (const [key, count] of perLoad) {
      const tid = key.split("\n")[1]!
      liveTids.set(tid, Math.max(liveTids.get(tid) ?? 0, count))
    }
  }

  // One id configured more than once in the code.
  const byId = new Map<string, number>()
  for (const entry of ga4Configs) if (entry.id) byId.set(entry.id, (byId.get(entry.id) ?? 0) + 1)
  for (const [id, count] of byId) {
    if (count > 1) {
      findings.push({
        id: `remove_duplicate:ga4:${id}`,
        kind: "duplicate",
        provider: "ga4",
        publicId: id,
        shape: "repeated_init",
        // §3x.6 (A7): say only what was measured. The code holds the id `count` times; the effect on page views is
        // claimed only when the test load itself counted more than one page view for it.
        text: `GA4: ${id} is set up ${count} times in your code. Keep one.${(liveTids.get(id) ?? 0) > 1 ? ` The test load counted every page view ${liveTids.get(id)} times.` : ""}`
      })
    }
  }
  // GTM + a hand-written gtag sending the SAME id (the live load counted 2+ page views for it).
  for (const entry of ga4Configs) {
    if (!hasGtm || !entry.id || entry.owner !== "adopted" || (byId.get(entry.id) ?? 0) > 1) continue
    if ((liveTids.get(entry.id) ?? 0) > 1) {
      findings.push({
        id: `remove_duplicate:ga4:${entry.id}`,
        kind: "duplicate",
        provider: "ga4",
        publicId: entry.id,
        shape: "gtm_and_gtag",
        text: `GA4: Google Tag Manager and a hand-written gtag (${entry.file}) both send ${entry.id}; the live site counted ${liveTids.get(entry.id)} page views per visit. Remove the hand-written one.`
      })
    }
  }
  // Two different GA4 ids on the site: a conflict the user resolves (never picked by the wizard).
  const ids = new Set<string>([...ga4Configs.flatMap((entry) => (entry.id ? [entry.id] : [])), ...liveTids.keys()])
  if (ids.size > 1) {
    findings.push({
      id: "conflict:ga4",
      kind: "conflict",
      provider: "ga4",
      publicId: null,
      shape: null,
      text: `GA4: two different ids fire on your site (${[...ids].sort().join(", ")}). Decide which one is this site's; the wizard does not pick.`
    })
  }
  for (const tool of ["posthog", "meta"] as const) {
    const kind = tool === "posthog" ? "posthog_init" : "fbq_init"
    const counts = new Map<string, number>()
    for (const entry of entries) if (entry.tool === tool && entry.kind === kind && entry.id) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1)
    for (const [id, count] of counts) {
      if (count > 1) {
        findings.push({
          id: `remove_duplicate:${tool}:${id}`,
          kind: "duplicate",
          provider: tool,
          publicId: id,
          shape: "repeated_init",
          text: `${TOOL_NAME[tool]}: ${id} starts ${count} times in your code. Keep one start.`
        })
      }
    }
  }
  return dedupeFindings(findings)
}

function dedupeFindings(findings: DuplicateFinding[]): DuplicateFinding[] {
  const seen = new Set<string>()
  return findings.filter((finding) => (seen.has(finding.id) ? false : (seen.add(finding.id), true)))
}

// ---------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------

export interface ResolvedPlanAnswers {
  consentMode: "required" | "not_required" | null
  conversions: string[]
  /** null = not asked or not answered. */
  privacyApproved: boolean | null
  privacyText: string | null
  npmInstall: boolean | null
  metaGoal: string | null
  /** Per line: true approved, false declined, null unanswered (info / user-action lines are always null). */
  lines: Array<{ id: string; approved: boolean | null }>
  /** The answer normalised for `JobRegistry.applyApprovals` (consent flag folded in, unknown ids dropped). */
  approvals: PlanApprovalsLike
}

const CONSENT_VALUES = new Set(["required", "not_required"])

function parseConversionEdit(value: string): string[] | null {
  const names = value
    .split(/[\s,·]+/)
    .map((name) => name.trim())
    .filter((name) => name !== "")
  if (names.length === 0 || !names.every((name) => CONVERSION_NAME_PATTERN.test(name))) return null
  return [...new Set(names)]
}

/**
 * Turns the `plan` ask's answer into the run's answers. Strict: unknown line ids are ignored; an edit
 * counts only on an editable line and only with a valid value (else that line stays unanswered);
 * declined beats approved; `--consent-mode` answers the consent line. `--yes` is NOT applied here:
 * the engine (O1) answers the ask under `YES_POLICY`, so there is one policy, not two.
 */
export function resolvePlanAnswers(
  plan: PlanModel,
  answer: PlanApprovalsLike | null,
  options: { consentFlag: "required" | "not_required" | null }
): ResolvedPlanAnswers {
  const known = new Map(plan.lines.map((planLine) => [planLine.id, planLine]))
  const declined = new Set([...planExclusions(plan, answer?.declined ?? []).lineIds].filter(id => known.has(id)))
  const edits: Record<string, string> = {}
  for (const [id, value] of Object.entries(answer?.edits ?? {})) {
    const planLine = known.get(id)
    if (!planLine?.editable || typeof value !== "string" || declined.has(id)) continue
    edits[id] = value
  }
  const approved = new Set(
    [...(answer?.approved ?? []), ...Object.keys(edits)]
      .filter((id) => known.has(id) && !declined.has(id))
      .filter((id) => known.get(id)!.requires === "approval")
  )

  for (const planLine of plan.lines) if (isContinuedWork(planLine) && !declined.has(planLine.id)) approved.add(planLine.id)
  let consentMode: ResolvedPlanAnswers["consentMode"] = null
  if (options.consentFlag && !declined.has(DECISION_LINE_IDS.consentMode)) {
    consentMode = options.consentFlag
    approved.add(DECISION_LINE_IDS.consentMode)
    declined.delete(DECISION_LINE_IDS.consentMode)
  } else if (approved.has(DECISION_LINE_IDS.consentMode)) {
    const edited = edits[DECISION_LINE_IDS.consentMode]?.replace("-", "_")
    if (edited !== undefined) consentMode = CONSENT_VALUES.has(edited) ? (edited as "required" | "not_required") : null
    else consentMode = plan.decisions.consentMode
    if (consentMode === null) approved.delete(DECISION_LINE_IDS.consentMode)
  }

  let conversions: string[] = []
  if (approved.has(DECISION_LINE_IDS.conversionNames)) {
    const edited = edits[DECISION_LINE_IDS.conversionNames]
    const names = edited === undefined ? plan.decisions.conversionNames : parseConversionEdit(edited)
    if (names === null || names.length === 0) approved.delete(DECISION_LINE_IDS.conversionNames)
    else conversions = names
  }

  // Ignore even legacy approvals: the wizard never sends policy copy to an agent.
  approved.delete(DECISION_LINE_IDS.privacyText)
  const privacyAsked = false
  const privacyText = null

  const wizardPlan = plan as Partial<WizardPlanModel>
  const npmAsked = known.has(DECISION_LINE_IDS.npmInstall)
  const lines = plan.lines.map((planLine) => ({
    id: planLine.id,
    approved: declined.has(planLine.id) ? false : isContinuedWork(planLine) ? true : planLine.requires !== "approval" ? null : approved.has(planLine.id) ? true : null
  }))
  return {
    consentMode,
    conversions,
    privacyApproved: !privacyAsked ? null : approved.has(DECISION_LINE_IDS.privacyText) ? true : declined.has(DECISION_LINE_IDS.privacyText) ? false : null,
    privacyText: approved.has(DECISION_LINE_IDS.privacyText) ? privacyText : null,
    npmInstall: !npmAsked ? null : approved.has(DECISION_LINE_IDS.npmInstall) ? true : declined.has(DECISION_LINE_IDS.npmInstall) ? false : null,
    // The recommendation is data on the plan, never parsed back out of its copy (P2-10).
    metaGoal: wizardPlan.metaGoal ?? null,
    lines,
    approvals: {
      approved: [...approved],
      declined: [...declined],
      edits: {
        ...edits,
        ...(consentMode ? { [DECISION_LINE_IDS.consentMode]: consentMode } : {}),
        ...(conversions.length > 0 ? { [DECISION_LINE_IDS.conversionNames]: conversions.join(",") } : {})
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The seeding gate (defence in depth over JobRegistry.applyApprovals)
// ---------------------------------------------------------------------------------------------

/**
 * After `applyApprovals`: an item linked to a line (`jobIds`) is kept only when that line is approved;
 * a declined line drops it; an unanswered one leaves it `blocked:needs_you`. An item of an
 * adopted-provider job (3–7) that NO line links is dropped: it can never be seeded without an approved
 * line (R2-10). Items whose job needs no line pass through unchanged.
 */
export function gateSeededItems(plan: PlanModel, answers: Pick<ResolvedPlanAnswers, "lines">, items: readonly ChecklistItem[]): ChecklistItem[] {
  const approval = new Map(answers.lines.map((entry) => [entry.id, entry.approved]))
  const exclusions = planExclusions(plan, answers.lines.filter(entry => entry.approved === false).map(entry => entry.id))
  for (const id of exclusions.lineIds) approval.set(id, false)
  // §3y.5: an item the plan withheld (nothing would run it) is never seeded, whatever the lines say.
  const withheld = new Set((plan as Partial<WizardPlanModel>).withheld ?? [])
  const gated = gateByLines(plan, approval, items.filter((item) => !withheld.has(item.id) && !exclusions.blocksJob(item)))
  // The go-ahead cost line (P2-18): unless it is approved, no agent job runs — each waits for the user.
  const budget = plan.lines.find((planLine) => planLine.id === "agent_budget" && planLine.requires === "approval")
  if (!budget || approval.get(budget.id) === true) return gated
  return gated.map((item) => (item.owner === "agent" && item.state !== "blocked" && item.state !== "left_for_you" ? { ...item, state: "blocked" as const, blockedReason: "needs_you" as const } : item))
}

function gateByLines(plan: PlanModel, approval: Map<string, boolean | null>, items: readonly ChecklistItem[]): ChecklistItem[] {
  const lineOf = new Map<string, PlanLine>()
  for (const planLine of plan.lines) for (const jobId of planLine.jobIds ?? []) lineOf.set(jobId, planLine)
  const out: ChecklistItem[] = []
  for (const item of items) {
    if (item.state === "left_for_you" && item.ownerBoundary) { out.push(item); continue }
    const planLine = lineOf.get(item.id)
    if (!planLine) {
      if (ADOPTED_PROVIDER_JOBS.includes(item.jobId as JobId)) continue
      out.push(item)
      continue
    }
    const state = approval.get(planLine.id) ?? null
    if (state === false) continue
    if (state === null && planLine.requires === "approval") {
      out.push({ ...item, state: "blocked", blockedReason: "needs_you" })
      continue
    }
    out.push(item)
  }
  return out
}

/**
 * Job 7 (the agent's preview guard on an ADOPTED init) gets the plan's exact guard: the production
 * hosts that must always fire and the deny list, the same ones the managed guard uses (P2-19). With no
 * guard (`production_denied` / no production host) the plan emits no job-7 line, so nothing is seeded.
 */
export function withGuardHosts(items: readonly ChecklistItem[], guard: GuardDecision | null): ChecklistItem[] {
  if (!guard || !guard.emit) return [...items]
  const note = ` Production hosts that must ALWAYS fire (exempt first): ${guard.exempt.join(", ")}. Silence only these preview hosts: ${GUARD_DENY_LIST.join(", ")}.`
  return items.map((item) =>
    item.jobId === "preview_guard" && !item.trigger.finding.includes("must ALWAYS fire")
      ? { ...item, trigger: { ...item.trigger, finding: `${item.trigger.finding}${note}` } }
      : item
  )
}

/** `Installer.planAsk`: exactly the §3d.3 `plan` payload (strict PlanLine keys, no internals). */
export function planAskPayload(plan: PlanModel): { lines: PlanLine[]; decisions: PlanModel["decisions"] } {
  return {
    lines: plan.lines.map((planLine) => ({
      id: planLine.id,
      kind: planLine.kind,
      text: planLine.text,
      requires: planLine.requires,
      editable: planLine.editable,
      ...(planLine.measured ? { measured: { ...planLine.measured } } : {}),
      ...(planLine.jobIds ? { jobIds: [...planLine.jobIds] } : {}),
      ...(planLine.ownership ? { ownership: planLine.ownership } : {})
    })),
    decisions: { ...plan.decisions, conversionNames: [...plan.decisions.conversionNames] }
  }
}
