// §3d.3–§3d.4 and step 4 of the wizard: the ONE plan screen.
//
// The plan model ASKS ONLY FOUR THINGS — consent mode, conversion names, privacy text and the npm
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
import { createHash } from "node:crypto"

import type { ImproveLine, ImproveLineKind, ProviderId } from "../types.js"
import type { AgentKind, WhoPays } from "../wizard/contracts/agents.js"
import { AGENT_LIMITS } from "../wizard/contracts/agents.js"
import type { AskAnswers, PlanLine, PlanLineKind } from "../wizard/contracts/asks.js"
import type { BaselineResponseFields } from "../wizard/contracts/report.js"
import type { TagHosting, TagKeys } from "../wizard/contracts/bridge.js"
import { CONVERSION_NAME_PATTERN } from "../wizard/contracts/bridge.js"
import { HOST_DENY_V1, normalizeHost } from "../wizard/contracts/host-deny.js"
import type { BeforeFacts, BuildResult, ChecklistItem, JobId, PlanModel } from "../wizard/contracts/jobs.js"
import { JOB_TABLE } from "../wizard/contracts/jobs.js"

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
}

/** The scan facts the plan reads (the installer's `WizardScanResult` carries them). */
export interface PlanScanFacts {
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
}

/** The preview-guard decision for a wizard install (§3h.9). */
export type GuardDecision =
  | { emit: true; exempt: string[]; deny: string[] }
  | { emit: false; reason: "no_new_guarded_tool" }
  | { emit: false; reason: "production_denied"; hosts: string[] }
  | { emit: false; reason: "no_production_host" }

/** The plan model plus what `apply` needs (never shown, never hashed separately). */
export interface WizardPlanModel extends PlanModel {
  guard: GuardDecision
  /** The tools this plan installs new (each behind its `install_provider` line). */
  installTools: ProviderId[]
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
export const EDITABLE_LINE_IDS: readonly string[] = Object.values(DECISION_LINE_IDS)

/** §3h.6 (R1-34): the server-lane probe disclosure, on the plan line and in the report. */
export const SERVER_LANE_PROBE_DISCLOSURE =
  "After you merge, the one real test visit lands TWO bot-flagged page rows in your Infinite ledger (the visit itself and a server-lane probe). The no-send checks before that land none."

const TOOL_NAME: Record<ProviderId, string> = { infinite: "Infinite", ga4: "GA4", posthog: "PostHog", x: "X", meta: "Meta" }

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
 * The plan line kind a candidate needs, or null when its job needs no line. A target that starts with
 * an improve kind (`retire_fbc_writer:…`, `capture_beside_adopted_pixel`) names it; otherwise the
 * job's own required kind (JOB_TABLE).
 */
export function lineKindForCandidate(item: ChecklistItem): PlanLineKind | null {
  const target = itemTarget(item)
  const named = IMPROVE_KINDS.find((kind) => target === kind || target.startsWith(`${kind}:`) || target.startsWith(`${kind}-`))
  if (named) return named
  const spec = JOB_TABLE[item.jobId as JobId]
  if (!spec || spec.requiresApprovedLine.length === 0) return null
  return spec.requiresApprovedLine[0] ?? null
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

/** D10: automatic Meta events per visit in `before`'s no-click load (`tr` events other than PageView). Null = not measured. */
export function automaticMetaEventsPerVisit(before: BeforeFacts): number | null {
  const dry = before.dryLive
  if (!dry || dry.loads.length === 0) return null
  const automatic = dry.meta.tr.filter((event) => event.ev !== "PageView").length
  return Math.round((automatic / dry.loads.length) * 10) / 10
}

// ---------------------------------------------------------------------------------------------
// The preview guard (§3h.9, R2-21)
// ---------------------------------------------------------------------------------------------

/** O5's deny-list shape: exact hosts and suffixes, from `contracts/host-deny-v1.json`. */
export const GUARD_DENY_LIST: readonly string[] = [...HOST_DENY_V1.deny.exact, ...HOST_DENY_V1.deny.suffix]

export function guardDecision(input: {
  keys: TagKeys
  hosting: TagHosting
  observedProductionHost: string | null
  newGuardedTools: readonly ProviderId[]
  adoptedGuardWanted: boolean
  productionDeniedConflict: ProductionDeniedConflict
}): GuardDecision {
  if (input.newGuardedTools.length === 0 && !input.adoptedGuardWanted) return { emit: false, reason: "no_new_guarded_tool" }
  const configured = [
    ...input.keys.infinite.productionHosts,
    ...(input.hosting.vercel?.productionDomains ?? []),
    ...(input.hosting.vercel?.productionAliases ?? [])
  ].map(normalizeHost)
  const observed = input.observedProductionHost ? [normalizeHost(input.observedProductionHost)] : []
  // The observed host is trusted only once Infinite lists it: a production served on a denied suffix
  // (`acme.vercel.app`) that the site source does not name would be silenced by the guard.
  const conflict = input.productionDeniedConflict(observed, configured)
  if (conflict.length > 0) return { emit: false, reason: "production_denied", hosts: conflict }
  const exempt = [...new Set([...configured, ...observed])].filter((host) => host !== "")
  if (exempt.length === 0) return { emit: false, reason: "no_production_host" }
  return { emit: true, exempt, deny: [...GUARD_DENY_LIST] }
}

// ---------------------------------------------------------------------------------------------
// Privacy text
// ---------------------------------------------------------------------------------------------

/**
 * The privacy draft: one plain sentence per NEWLY installed tool (job 14 inserts it verbatim after
 * the user approves it). The Infinite sentences say what the installed lanes send, from the same
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
function newTools(input: PlanModelInput): { tools: ProviderId[]; ids: Partial<Record<ProviderId, string>> } {
  const adopted = new Set(input.scan.adopted.map((entry) => entry.provider))
  const { artifacts } = artifactsFromKeysDetailed(input.keys, { consentMode: "not_required", conversionNames: [], privacyText: null, npmInstall: null })
  const tools: ProviderId[] = []
  const ids: Partial<Record<ProviderId, string>> = {}
  if (!adopted.has("infinite")) tools.push("infinite")
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
  return { tools, ids }
}

function line(partial: Omit<PlanLine, "editable"> & { editable?: boolean }): PlanLine {
  return { editable: false, ...partial }
}

/** sha256 over the lines + decisions (the plan's identity; a resume re-confirms a changed one). */
export function planHash(lines: readonly PlanLine[], decisions: PlanModel["decisions"]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ lines, decisions }), "utf8").digest("hex")}`
}

export function buildPlanModel(input: PlanModelInput): WizardPlanModel {
  const { keys, before, scan, candidates } = input
  const lines: PlanLine[] = []
  const { tools, ids: toolIds } = newTools(input)
  const hosting = before.hosting

  // ---- the four decisions ----
  const consentProposed = input.consentFlag ?? keys.infinite.consentMode ?? null
  lines.push(
    line({
      id: DECISION_LINE_IDS.consentMode,
      kind: "consent_mode",
      text:
        consentProposed === "required"
          ? "Consent: wait for your cookie banner's yes before Infinite collects (covers Infinite only)"
          : consentProposed === "not_required"
            ? "Consent: collect by default; Do-Not-Track and GPC visitors are still skipped (covers Infinite only)"
            : "Consent: choose — collect by default, or wait for your cookie banner's yes (covers Infinite only)",
      requires: "approval",
      editable: true
    })
  )
  const conversionNames = proposedConversionNames(candidates)
  const conversionJobs = candidates.filter((item) => item.jobId === "server_conversions" || item.jobId === "conversions_to_tools").map((item) => item.id)
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
  const privacyText = draftPrivacyParagraph(tools, scan.serverLane !== null && tools.includes("infinite"))
  if (privacyText) {
    const privacyJobs = candidates.filter((item) => item.jobId === "privacy_paragraph").map((item) => item.id)
    const where = candidates.find((item) => item.jobId === "privacy_paragraph")?.trigger.evidence.find((entry) => "file" in entry)
    lines.push(
      line({
        id: DECISION_LINE_IDS.privacyText,
        kind: "privacy_text",
        text: `Privacy: ${privacyText.split("\n").length} drafted lines for ${where && "file" in where ? where.file : "your privacy page"}`,
        requires: "approval",
        editable: true,
        ...(privacyJobs.length > 0 ? { jobIds: privacyJobs } : {})
      })
    )
  }
  let npmInstall: string | null = null
  if (scan.serverLane && scan.serverLane.installPackages.length > 0 && tools.includes("infinite")) {
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
        text: `${managed ? "Update" : "Install"} ${TOOL_NAME[tool]}${id ? ` (${id}, from your Infinite connection)` : ""}${tool === "posthog" && keys.posthog.region !== "self_hosted" ? " through /ingest on your own domain" : ""}`,
        requires: "approval",
        ownership: "managed"
      })
    )
  }
  if (scan.serverLane && tools.includes("infinite")) {
    lines.push(
      line({
        id: "server_lane",
        kind: "server_lane",
        text: `Server lane (${scan.serverLane.targetLabel}): counts every page request on your server, even with ad blockers. ${SERVER_LANE_PROBE_DISCLOSURE}`,
        requires: "approval",
        ownership: "managed"
      })
    )
  }

  // ---- the preview guard ----
  const guardedNew = tools.filter((tool): tool is "ga4" | "posthog" | "meta" => tool === "ga4" || tool === "posthog" || tool === "meta")
  const adoptedGuardLines = scan.improve.filter((entry) => entry.kind === "preview_guard_adopted")
  const guard = guardDecision({
    keys,
    hosting,
    observedProductionHost: before.observedProductionHost,
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
        text: `Your live site is served on ${guard.hosts.join(", ")}, which the preview guard would silence; add it in Infinite first. No preview guard is added until then.`,
        requires: "user_action"
      })
    )
  } else if (!guard.emit && guard.reason === "no_production_host") {
    lines.push(
      line({
        id: "preview_guard_blocked",
        kind: "user_action",
        text: "Infinite does not know your production domain yet, so no preview guard is added; add the domain in Infinite first.",
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
  const improveLines = scan.improve.filter((entry) => entry.kind !== "preview_guard_adopted" || guard.emit)
  /** Lines a candidate can link to, by kind + provider + target. */
  const linked: Array<{ kind: PlanLineKind; provider: ProviderId | null; target: string; line: PlanLine }> = []
  const findLinked = (kind: PlanLineKind, provider: ProviderId | null, target: string): PlanLine | undefined => {
    const sameKind = linked.filter((entry) => entry.kind === kind && (provider === null || entry.provider === provider))
    return (sameKind.find((entry) => entry.target === target || target.startsWith(`${entry.target}`) || entry.target.startsWith(target)) ?? sameKind[0])?.line
  }
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

  // Duplicates and conflicts, from the census and the no-send load.
  for (const finding of duplicateFindings(before)) {
    if (finding.kind === "duplicate") {
      const planLine = line({ id: finding.id, kind: "remove_duplicate", text: finding.text, requires: "approval", ownership: "adopted" })
      lines.push(planLine)
      linked.push({ kind: "remove_duplicate", provider: finding.provider, target: finding.id, line: planLine })
    } else {
      lines.push(line({ id: finding.id, kind: "user_action", text: finding.text, requires: "user_action" }))
    }
  }

  // Every candidate whose job needs a line is linked to exactly one (created from the candidate when
  // no detector line exists). A candidate of an adopted-provider job is NEVER left unlinked.
  for (const item of candidates) {
    const kind = lineKindForCandidate(item)
    if (kind === null || kind === "conversion_names" || kind === "privacy_text") continue
    if (kind === "preview_guard_adopted" && !guard.emit) continue
    const provider = candidateProvider(item)
    const targetName = itemTarget(item) || item.jobId
    let target = findLinked(kind, provider, targetName)
    if (!target) {
      target = line({
        id: `${kind}:${provider ?? "site"}:${targetName}`,
        kind,
        text: item.trigger.finding,
        requires: "approval",
        ownership: "adopted"
      })
      lines.push(target)
      linked.push({ kind, provider, target: targetName, line: target })
    }
    target.jobIds = [...new Set([...(target.jobIds ?? []), item.id])]
  }

  // ---- Meta: the goal (D16) and the server-events relay (D11) ----
  const metaPresent = tools.includes("meta") || scan.adopted.some((entry) => entry.provider === "meta")
  if (metaPresent) {
    const goal = recommendMetaGoal(conversionNames)
    lines.push(
      line({
        id: "meta_goal",
        kind: "meta_goal",
        text: goal
          ? `Meta goal: ${goal} (${goal === "StartTrial" ? "a SaaS sign-up starts a trial" : "a shop sale"}); change it in Meta any time.`
          : "Meta goal: StartTrial if you sell subscriptions, Purchase if you sell products.",
        requires: "approval"
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
    const adopted = scan.adopted.some((entry) => entry.provider === tool)
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

  // ---- the agent's budget (the cost line in the go-ahead) ----
  const agentJobs = candidates.filter((item) => item.owner === "agent").length
  if (agentJobs > 0) {
    const name = input.agent?.worker === "claude_code" ? "Claude Code" : input.agent?.worker === "codex" ? "Codex" : null
    lines.push(
      line({
        id: "agent_budget",
        kind: "agent_budget",
        text: name
          ? `${name}: ${agentJobs} job${agentJobs === 1 ? "" : "s"} · up to ${AGENT_LIMITS.jobs.maxTurns} turns or ${Math.round(AGENT_LIMITS.jobs.wallMs / 60_000)} min · ${input.agent?.whoPays?.label ?? "who pays: unknown"}`
          : `No agent found: the ${agentJobs} agent job${agentJobs === 1 ? "" : "s"} are listed for you to do by hand.`,
        requires: name ? "approval" : "info"
      })
    )
  }

  const decisions: PlanModel["decisions"] = {
    consentMode: consentProposed,
    conversionNames,
    privacyText,
    npmInstall
  }
  return { hash: planHash(lines, decisions), lines, decisions, guard, installTools: tools }
}

// ---------------------------------------------------------------------------------------------
// Duplicates (job 6) and conflicts, from `before` (never from rehearsal data, which does not exist yet)
// ---------------------------------------------------------------------------------------------

export interface DuplicateFinding {
  id: string
  kind: "duplicate" | "conflict"
  provider: ProviderId
  text: string
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
      if (event.en !== "page_view") continue
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
      findings.push({ id: `remove_duplicate:ga4:${id}`, kind: "duplicate", provider: "ga4", text: `GA4: ${id} is set up ${count} times in your code, so page views count more than once. Keep one.` })
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
      text: `GA4: two different ids fire on your site (${[...ids].sort().join(", ")}). Decide which one is this site's; the wizard does not pick.`
    })
  }
  for (const tool of ["posthog", "meta"] as const) {
    const kind = tool === "posthog" ? "posthog_init" : "fbq_init"
    const counts = new Map<string, number>()
    for (const entry of entries) if (entry.tool === tool && entry.kind === kind && entry.id) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1)
    for (const [id, count] of counts) {
      if (count > 1) {
        findings.push({ id: `remove_duplicate:${tool}:${id}`, kind: "duplicate", provider: tool, text: `${TOOL_NAME[tool]}: ${id} starts ${count} times in your code. Keep one start.` })
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
  const declined = new Set((answer?.declined ?? []).filter((id) => known.has(id)))
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

  let consentMode: ResolvedPlanAnswers["consentMode"] = null
  if (options.consentFlag) {
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

  const privacyAsked = known.has(DECISION_LINE_IDS.privacyText)
  let privacyText = plan.decisions.privacyText
  if (approved.has(DECISION_LINE_IDS.privacyText) && edits[DECISION_LINE_IDS.privacyText] !== undefined) {
    const edited = edits[DECISION_LINE_IDS.privacyText]!.trim()
    if (edited === "") approved.delete(DECISION_LINE_IDS.privacyText)
    else privacyText = edited
  }

  const npmAsked = known.has(DECISION_LINE_IDS.npmInstall)
  const lines = plan.lines.map((planLine) => ({
    id: planLine.id,
    approved: planLine.requires !== "approval" ? null : approved.has(planLine.id) ? true : declined.has(planLine.id) ? false : null
  }))
  const metaGoalLine = known.get("meta_goal")
  return {
    consentMode,
    conversions,
    privacyApproved: !privacyAsked ? null : approved.has(DECISION_LINE_IDS.privacyText) ? true : declined.has(DECISION_LINE_IDS.privacyText) ? false : null,
    privacyText: approved.has(DECISION_LINE_IDS.privacyText) ? privacyText : null,
    npmInstall: !npmAsked ? null : approved.has(DECISION_LINE_IDS.npmInstall) ? true : declined.has(DECISION_LINE_IDS.npmInstall) ? false : null,
    metaGoal: metaGoalLine && approved.has("meta_goal") ? metaGoalLine.text.replace(/^Meta goal: (\w+).*$/, "$1") : null,
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
  const lineOf = new Map<string, PlanLine>()
  for (const planLine of plan.lines) for (const jobId of planLine.jobIds ?? []) lineOf.set(jobId, planLine)
  const out: ChecklistItem[] = []
  for (const item of items) {
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
