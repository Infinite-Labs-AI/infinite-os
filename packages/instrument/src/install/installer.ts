// §3e.7 `Installer`: the wizard's install, composed from the SAME harness phases `runHarness` runs
// (`src/harness/run.ts`), plus the wizard's own pieces — improve-in-place edits on approved lines,
// the npm line, the build check with a full rollback, and the edit receipt.
//
// What it never does: emit browser bytes of its own (O5's builders and the managed adapters do), spawn
// `vercel`, auto-approve a line that reduces an adopted provider, or call the cloud (the steps call
// the bridge; this module only reads and writes the repo).
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { restoreSnapshot, snapshotFiles, type FileSnapshot } from "../apply.js"
import { frameworkAdapters, isSupportedFramework } from "../frameworks/index.js"
import { resolveAppRoot, type AppRootSource, type DetectedProviderEvidence } from "../harness/inspect.js"
import {
  applyPhase,
  classifyPhase,
  harnessRepoStatus,
  inspectPhase,
  planPhase,
  type InspectPhaseResult
} from "../harness/run.js"
import { scanSourceFiles } from "../harness/scan.js"
import type { ResolvedKeys } from "../harness/types.js"
import {
  computeContentHash,
  computeContentHashes,
  installManifestRelativePath,
  readInstallManifest,
  rebuildInstallManifestFromMarkers,
  writeInstallManifest
} from "../manifest.js"
import { packageInstallCommandLine, type CommandSpawner } from "../package-manager.js"
import { planServerLane } from "../server-lane/install.js"
import type {
  DeferredConfigRewrite,
  ImproveLine,
  InspectResult,
  InstallManifest,
  ProviderId,
  SupportedFramework,
  WorkspaceInstallArtifacts
} from "../types.js"
import { uninstallInstallation } from "../uninstall.js"
import { HARNESS_OUTPUTS_RELATIVE_PATH } from "../harness/outputs.js"
import type { TagHosting, TagKeys } from "../wizard/contracts/bridge.js"
import type {
  BeforeFacts,
  BuildResult,
  ChecklistItem,
  Installer,
  InstallerApplyResult,
  PlanApprovals,
  PlanModel,
  ScanResult,
  UninstallReport,
  WizardEditRecord
} from "../wizard/contracts/jobs.js"

import { beforeTextOf, makeEditRecord, refreshFromHead } from "./edits.js"
import { applyImproveEdit, detectAdoptedFacts, improveLinesFor, withSensitivePaths, type AdoptedFacts } from "./improve.js"
import { artifactsFromKeys, manifestIdsFor, posthogProxyFor, wizardInstallWorkspaceId, type WizardInstallArtifacts } from "./keys-adapter.js"
import { SERVER_LANE_GUIDE_FILE } from "../server-lane/copy.js"
import { normalizeAppRelativePath } from "../frameworks/shared.js"
import { DEFAULT_POSTHOG_PROXY_PATH, INFINITE_API_ORIGIN, infiniteCollectDestination } from "../workspace-artifacts.js"
import { hasExactNextConfigRewrites, type ManagedProxySpec } from "../frameworks/vercel-config.js"
import { isManagedInfiniteFile } from "../frameworks/managed-files.js"
import { findLockfile, runNpmJob } from "./npm.js"
import {
  buildPlanModel,
  DECISION_LINE_IDS,
  planAskPayload,
  resolvePlanAnswers,
  type PlanAgentSummary,
  type PlanScanFacts,
  type ProductionDeniedConflict,
  type WizardBeforeFacts,
  type WizardPlanModel
} from "./plan-model.js"

/**
 * True when every uncommitted path in the repo is the wizard's own bookkeeping: the fence's record
 * `.infinite/harness.json` (never committed, §3z.12) and the gitignored run directory `.infinite/wizard/`.
 * Anything else (a user edit, a staged file, a rename) → false, so the uninstall's dirty-tree gate holds.
 */
export function onlyWizardBookkeepingDirty(root: string): boolean {
  const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8" })
  if (status.status !== 0) return false
  const entries = status.stdout.split("\0").filter(Boolean)
  return entries.length > 0 && entries.every((entry) => {
    const path = entry.slice(3)
    return entry.startsWith("?? ") && (path === HARNESS_OUTPUTS_RELATIVE_PATH || path.startsWith(".infinite/wizard/"))
  })
}

/** The check id O6's D17 detector reports sensitive pages under (its evidence carries the page URLs). */
export const SENSITIVE_PAGES_CHECK_ID = "sensitive_pages" as const

/** `Installer.scan` plus everything the plan and the install read (lanes may add optional fields). */
export interface WizardScanResult extends ScanResult {
  appRootSource: AppRootSource
  /** Workspace packages that look like web apps (more than one = an ambiguous monorepo: job 2). */
  appRootCandidates: string[]
  ambiguousAppRoot: boolean
  inspect: InspectResult
  hosting: string
  detected: DetectedProviderEvidence[]
  manifest: InstallManifest | null
  /** Set when the receipt was corrupt and was rebuilt from the managed markers (what could not be recovered). */
  receiptRebuilt: { lost: string[] } | null
  facts: AdoptedFacts
  serverLane: { targetLabel: string; installPackages: string[] } | null
  npm: { commandLine: string } | { refused: string } | null
  warnings: string[]
  /**
   * A Next app's own config (repo-relative), when exactly one exists and the installer did not create it
   * (review I1 P1-2: the installer never edits it; the rewrites it lacks become a checked agent job).
   */
  unmanagedNextConfig?: string | null
}

export interface InstallerOptions {
  /** The repo root. Lets `recordEdits` / `refreshEditReceiptFromHead` work in a fresh process (they scan it first). */
  root?: string
  /** `sha256:<64 hex>` of the normalised remote + app root (§3a.3, computed by the `link` step). */
  repoFingerprint: string
  /** The cloud run id (records carry it); null before the `agent` step. */
  runId(): string | null
  agent(): PlanAgentSummary | null
  /** `--consent-mode`. */
  consentFlag(): "required" | "not_required" | null
  /** O5's `productionDeniedConflict` (wired at integration). */
  productionDeniedConflict: ProductionDeniedConflict
  /** O6's `CheckRunner.build` (the build runs sandboxed there). Absent = no build check (said so). */
  build?: () => Promise<BuildResult>
  /** The npm job's spawner (tests pass a fake). */
  spawn?: CommandSpawner
  /** Reads a committed blob (`git show <rev>:<path>`); tests pass a fake. */
  readBlob?: (root: string, rev: string, path: string) => string | null
}

/**
 * Each recorded edit's exact "before" text, cached beside the run state (gitignored, 0600) when the
 * record is made, so a commit hook's rewrite can be rebased later (§3e.6) without guessing.
 */
export const EDIT_BASES_RELATIVE_PATH = ".infinite/wizard/edit-bases.json"

function readEditBases(root: string): Record<string, string | null> {
  try {
    const parsed = JSON.parse(readFileSync(join(root, EDIT_BASES_RELATIVE_PATH), "utf8")) as unknown
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, string | null>) : {}
  } catch {
    return {}
  }
}

/** Walks each file's new records newest → oldest from the file on disk (the uninstall walk) and caches each "before". */
function cacheEditBefores(root: string, records: readonly WizardEditRecord[]): void {
  if (records.length === 0) return
  const bases = readEditBases(root)
  for (const file of [...new Set(records.map((record) => record.file))]) {
    const path = join(root, file)
    let content: string | null | undefined = existsSync(path) ? readFileSync(path, "utf8") : undefined
    for (const record of records.filter((entry) => entry.file === file).reverse()) {
      if (content === undefined || content === null) break
      content = beforeTextOf(content, record)
      if (content !== undefined) bases[record.id] = content
    }
  }
  mkdirSync(join(root, ".infinite/wizard"), { recursive: true, mode: 0o700 })
  const target = join(root, EDIT_BASES_RELATIVE_PATH)
  writeFileSync(`${target}.tmp`, `${JSON.stringify(bases)}\n`, { mode: 0o600 })
  renameSync(`${target}.tmp`, target)
}

export interface WizardApplyResult extends InstallerApplyResult {
  /** Repo-root-relative files written this run (managed + improve + npm), for the status line. */
  changedFiles: string[]
  warnings: string[]
  /** Why the install did not land (set when `ok` is false). */
  reason: string | null
  /** True when an `npm` line was approved and the package was installed. */
  npmInstalled: boolean
  /** "passed" | "failed_baseline" (red before this run too) | "not_run" (no build check wired). */
  build: "passed" | "failed_baseline" | "not_run"
  /** The resolved artifacts the managed bytes were written from (public ids only). */
  artifacts: WizardInstallArtifacts
  /** Review I1 P1-2: the user's own config(s) the managed rewrites must still be added to (an agent job each). */
  deferredConfigRewrites?: DeferredConfigRewrite[]
}

interface PlanInternals {
  scan: WizardScanResult
  keys: TagKeys
  before: WizardBeforeFacts
  candidates: readonly ChecklistItem[]
  improve: ImproveLine[]
}

function gitShow(root: string, rev: string, path: string): string | null {
  const result = spawnSync("git", ["-C", root, "show", `${rev}:${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : null
}

const repoRelative = (appRoot: string, file: string): string => (appRoot === "." ? file : `${appRoot}/${file}`)

/** The D17 detector's sensitive paths (O6), read from its check result's URL evidence. */
export function sensitivePathsFrom(before: BeforeFacts): string[] {
  const paths = new Set<string>()
  for (const check of before.checks) {
    if (check.checkId !== SENSITIVE_PAGES_CHECK_ID || check.state === "pass") continue
    for (const evidence of check.evidence ?? []) {
      if (!("url" in evidence)) continue
      try {
        paths.add(new URL(evidence.url, "https://placeholder.invalid").pathname)
      } catch {
        // not a URL: skipped, never guessed
      }
    }
  }
  return [...paths].sort()
}

export class WizardInstaller implements Installer {
  private readonly internals = new WeakMap<PlanModel, PlanInternals>()
  private lastScan: WizardScanResult | null = null

  constructor(private readonly options: InstallerOptions) {}

  // ---------------------------------------------------------------------------------------------
  // scan
  // ---------------------------------------------------------------------------------------------

  async scan(opts: { root: string; appRoot?: string; hosting?: TagHosting }): Promise<WizardScanResult> {
    const resolved = resolveAppRoot(opts.root, { flag: opts.appRoot, vercelRootDirectory: opts.hosting?.vercel?.rootDirectory ?? null })
    const warnings: string[] = []
    let phase: InspectPhaseResult
    let receiptRebuilt: WizardScanResult["receiptRebuilt"] = null
    try {
      phase = inspectPhase({ root: opts.root, appRoot: resolved.appRoot, includePublicForStatic: true })
    } catch (error) {
      // Only a receipt that is not JSON at all is rebuilt. One that parses but fails the shape check may
      // be a NEWER tag's receipt: it is never overwritten (the error stands; the user decides).
      if (!(error instanceof Error) || !error.message.startsWith("Corrupt .infinite/install.json — cannot parse")) throw error
      // A corrupt receipt is rebuilt from the managed markers (never a silent reset), then read.
      receiptRebuilt = rebuildCorruptReceipt(opts.root, resolved.appRoot, wizardInstallWorkspaceId(this.options.repoFingerprint))
      warnings.push(
        `The install receipt (.infinite/install.json) was corrupt; it was rebuilt from the managed markers. Lost: ${receiptRebuilt.lost.join(", ")} (an earlier run's recorded edits cannot be reversed automatically).`
      )
      phase = inspectPhase({ root: opts.root, appRoot: resolved.appRoot, includePublicForStatic: true })
    }
    const framework = phase.inspect.framework
    const source = scanSourceFiles(phase.appRootAbsolute, { includePublic: framework === "static-html" })
    if (source.warning) warnings.push(source.warning)
    if (resolved.ambiguous) {
      warnings.push(`This repo has ${resolved.candidates.length} web apps (${resolved.candidates.join(", ")}); the wizard used ${phase.inspect.appRoot}. Pass --app-root to choose.`)
    }
    let serverLane: WizardScanResult["serverLane"] = null
    if (isSupportedFramework(framework)) {
      const draft = planServerLane({
        root: opts.root,
        appRoot: phase.inspect.appRoot,
        appRootAbsolute: phase.appRootAbsolute,
        framework,
        previousManifest: phase.manifest
      })
      if (draft.mode !== "brief" && draft.blockers.length === 0) {
        serverLane = { targetLabel: draft.targetLabel ?? draft.mode, installPackages: [...(draft.installPackages ?? [])] }
      }
    }
    let npm: WizardScanResult["npm"] = null
    if (serverLane && serverLane.installPackages.length > 0) {
      const lockfile = findLockfile(opts.root, phase.inspect.appRoot)
      npm = lockfile.ok
        ? { commandLine: packageInstallCommandLine(lockfile.lockfile.manager, serverLane.installPackages) }
        : { refused: lockfile.reason === "no_lockfile" ? "no lockfile, so the package manager is unknown" : `${lockfile.reason.replace("_", " ")}: ${lockfile.detail}` }
    }
    const result: WizardScanResult = {
      unmanagedNextConfig: unmanagedNextConfigOf(phase.appRootAbsolute, phase.inspect.appRoot, framework),
      root: opts.root,
      appRoot: phase.inspect.appRoot,
      framework,
      packageManager: phase.inspect.packageManager === "unknown" ? null : phase.inspect.packageManager,
      fileCount: source.files.length,
      truncated: source.truncated,
      appRootSource: resolved.appRoot === undefined ? "default" : resolved.source,
      appRootCandidates: resolved.candidates,
      ambiguousAppRoot: resolved.ambiguous,
      inspect: phase.inspect,
      hosting: phase.hosting,
      detected: phase.detected,
      manifest: phase.manifest,
      receiptRebuilt,
      facts: detectAdoptedFacts(phase.appRootAbsolute, phase.detected),
      serverLane,
      npm,
      warnings
    }
    this.lastScan = result
    return result
  }

  // ---------------------------------------------------------------------------------------------
  // keys and the plan
  // ---------------------------------------------------------------------------------------------

  artifactsFromKeys(keys: TagKeys, answers: PlanModel["decisions"]): WorkspaceInstallArtifacts {
    return artifactsFromKeys(keys, answers)
  }

  buildPlan(scan: ScanResult, keys: TagKeys, before: BeforeFacts, candidates: readonly ChecklistItem[]): WizardPlanModel {
    const wizardScan = this.requireWizardScan(scan)
    const beforeFacts = before as WizardBeforeFacts
    const sensitivePaths = sensitivePathsFrom(before)
    const served = siteServing(wizardScan, beforeFacts, keys)
    const improve = improveLinesFor(wizardScan.facts, { framework: wizardScan.framework, keys, sensitivePaths, vercelServed: served.vercelServed })
    const managed = new Set<ProviderId>((wizardScan.manifest?.providers ?? []) as ProviderId[])
    const facts: PlanScanFacts = {
      framework: wizardScan.framework,
      managedProviders: [...managed],
      adopted: wizardScan.detected
        .filter((entry) => !managed.has(entry.provider))
        .map((entry) => ({ provider: entry.provider, via: entry.via, file: entry.file, line: entry.line, key: entry.key ?? null })),
      improve,
      serverLane: wizardScan.serverLane,
      npm: wizardScan.npm,
      sensitivePaths,
      appRoot: wizardScan.appRoot,
      posthogProxy: served.posthogProxy,
      infiniteBlocked: served.infiniteBlocked,
      nextConfigRewrites: nextConfigRewritesNeeded(wizardScan, keys),
      // Review I1 P1-2: an installer blocker is said on the plan screen, before anything is approved or written.
      installBlocked: this.dryInstallFailure(
        wizardScan,
        artifactsFromKeys(keys, { consentMode: "not_required", conversionNames: [], privacyText: null, npmInstall: null }, { posthogProxy: served.posthogProxy }),
        wizardScan.serverLane !== null,
        beforeFacts
      )
    }
    const model = buildPlanModel({
      scan: facts,
      keys,
      before: beforeFacts,
      candidates,
      agent: this.options.agent(),
      consentFlag: this.options.consentFlag(),
      productionDeniedConflict: this.options.productionDeniedConflict
    })
    this.internals.set(model, { scan: wizardScan, keys, before: beforeFacts, candidates, improve })
    return model
  }

  planAsk(plan: PlanModel): { lines: PlanModel["lines"]; decisions: PlanModel["decisions"] } {
    return planAskPayload(plan)
  }

  /** Review I1 P1-2: the approved install's blocker, if any, from a dry plan (nothing is written). */
  preflight(plan: PlanModel, approvals: PlanApprovals): string | null {
    const internals = this.internals.get(plan)
    if (!internals) return null
    const { scan, keys } = internals
    const answers = resolvePlanAnswers(plan, approvals, { consentFlag: this.options.consentFlag() })
    const approved = new Set(answers.lines.filter((entry) => entry.approved === true).map((entry) => entry.id))
    const served = siteServing(scan, internals.before, keys)
    const all = artifactsFromKeys(keys, { ...plan.decisions, consentMode: answers.consentMode ?? "not_required" }, { posthogProxy: served.posthogProxy })
    const artifacts: WizardInstallArtifacts = { ...(all.productionHosts ? { productionHosts: all.productionHosts } : {}) }
    for (const tool of ["infinite", "ga4", "posthog", "meta"] as const) {
      const lineForTool = plan.lines.find((entry) => entry.kind === "install_provider" && (entry.id === `install_provider:${tool}` || entry.id.startsWith(`install_provider:${tool}:`)))
      if (lineForTool && approved.has(lineForTool.id) && all[tool]) (artifacts as Record<string, unknown>)[tool] = all[tool]
    }
    return this.dryInstallFailure(scan, artifacts, approved.has("server_lane") && artifacts.infinite !== undefined && scan.serverLane !== null, internals.before)
  }

  /** The harness plan's failure for these artifacts, planned exactly as `apply` plans them, with no write. */
  private dryInstallFailure(scan: WizardScanResult, input: WizardInstallArtifacts, serverLane: boolean, before?: WizardBeforeFacts): string | null {
    const served = siteServing(scan, before ?? { hosting: { provider: "none" } as WizardBeforeFacts["hosting"] })
    // As `apply`: a static / Vite site Vercel serves gets Infinite's collect path through vercel.json.
    let artifacts: WizardInstallArtifacts =
      input.infinite && served.vercelServed && (scan.framework === "static-html" || scan.framework === "vite-react") ? { ...input, infinite: { ...input.infinite, staticProxy: "vercel" } } : input
    // Before `install` writes the site source, Infinite's hosts are not final: the dry plan uses the hosts the
    // site source will carry (as `siteSourceHosts`), and leaves Infinite out when none is known yet.
    if (artifacts.infinite && artifacts.infinite.productionHosts.length === 0) {
      const hosts = [...new Set([...(before?.hosting.vercel?.productionDomains ?? []), ...(before?.observedProductionHost ? [before.observedProductionHost] : [])])]
      const { infinite, ...rest } = artifacts
      artifacts = hosts.length > 0 ? { ...rest, infinite: { ...infinite, productionHosts: hosts } } : rest
    }
    try {
      const phase = inspectPhase({ root: scan.root, appRoot: scan.appRoot })
      const resolvedKeys: ResolvedKeys = { artifacts, sources: {} }
      for (const tool of ["infinite", "ga4", "posthog", "meta"] as const) if (artifacts[tool]) resolvedKeys.sources[tool] = "infinite-connection"
      const classifications = classifyPhase({ manifest: phase.manifest, detected: phase.detected, keys: resolvedKeys, adoptExisting: true, serverLane, improve: {} })
      const result = planPhase({ root: scan.root, inspect: phase.inspect, classifications, keys: resolvedKeys, workspaceId: wizardInstallWorkspaceId(this.options.repoFingerprint), serverLane, deferUnmanagedNextConfig: true })
      return result.failure && !result.nothingToInstall ? result.failure.message : null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // apply
  // ---------------------------------------------------------------------------------------------

  async apply(plan: PlanModel, approvals: PlanApprovals): Promise<WizardApplyResult> {
    const internals = this.internals.get(plan)
    if (!internals) throw new Error("apply needs a plan built by this installer (buildPlan) in this process.")
    const model = plan as WizardPlanModel
    const { scan, keys } = internals
    const root = scan.root
    const runId = this.requireRunId()
    const answers = resolvePlanAnswers(plan, approvals, { consentFlag: this.options.consentFlag() })
    if (answers.consentMode === null) throw new Error("apply needs an answered consent mode (the run parks at `plan` without one).")
    const approved = new Set(answers.lines.filter((entry) => entry.approved === true).map((entry) => entry.id))
    const warnings: string[] = [...scan.warnings]
    const served = siteServing(scan, internals.before, keys)

    // ---- the artifacts: approved tools from the connections; an already-managed tool whose update
    // was not approved is KEPT exactly as the receipt recorded it (never dropped from the page) ----
    const all = artifactsFromKeys(keys, { ...plan.decisions, consentMode: answers.consentMode }, { posthogProxy: served.posthogProxy })
    const installLine = (tool: ProviderId) =>
      plan.lines.find((entry) => entry.kind === "install_provider" && (entry.id === `install_provider:${tool}` || entry.id.startsWith(`install_provider:${tool}:`)))
    const previous = scan.manifest
    let artifacts: WizardInstallArtifacts = { ...(all.productionHosts ? { productionHosts: all.productionHosts } : {}) }
    for (const tool of ["infinite", "ga4", "posthog", "meta"] as const) {
      const lineForTool = installLine(tool)
      if (lineForTool && approved.has(lineForTool.id) && all[tool]) {
        ;(artifacts as Record<string, unknown>)[tool] = all[tool]
        continue
      }
      if (!previous?.providers.includes(tool)) continue
      const kept = keptArtifact(tool, previous, keys, answers.consentMode)
      if (typeof kept === "string") {
        return this.failed(artifacts, warnings, `${TOOL_LABEL[tool]} is already installed here and its update was not approved, but ${kept}. Approve "Update ${TOOL_LABEL[tool]}", or remove it with uninstall first.`, false)
      }
      ;(artifacts as Record<string, unknown>)[tool] = kept
    }
    // A static / Vite site served by Vercel gets Infinite's same-origin collect path through vercel.json
    // — the "proven same-origin proxy" the static adapters require.
    if (artifacts.infinite && served.vercelServed && (scan.framework === "static-html" || scan.framework === "vite-react")) {
      artifacts.infinite = { ...artifacts.infinite, staticProxy: "vercel" }
    }
    if (model.guard.emit && approved.has("preview_guard_managed")) {
      artifacts.hostGuard = { mode: "deny", exempt: [...model.guard.exempt], deny: [...model.guard.deny] }
    }
    if (approved.has("sensitive_pages:posthog:managed")) artifacts = withSensitivePaths(artifacts, sensitivePathsFrom(internals.before))
    const serverLane = approved.has("server_lane") && artifacts.infinite !== undefined && scan.serverLane !== null

    // ---- snapshot everything this install can touch (full rollback on any failure) ----
    const approvedImprove = internals.improve.filter((entry) => approved.has(entry.id))
    const codeImprove = approvedImprove.filter((entry) => entry.owner === "code")
    // The package exists only for the server lane: without an approved lane (and Infinite) it is never installed.
    const npmApproved = serverLane && approved.has(DECISION_LINE_IDS.npmInstall) && scan.serverLane !== null && scan.serverLane.installPackages.length > 0
    const lockfile = npmApproved ? findLockfile(root, scan.appRoot) : null

    const workspaceId = wizardInstallWorkspaceId(this.options.repoFingerprint)

    const phase = inspectPhase({ root, appRoot: scan.appRoot })
    const resolvedKeys: ResolvedKeys = { artifacts, sources: {} }
    for (const tool of ["infinite", "ga4", "posthog", "meta"] as const) if (artifacts[tool]) resolvedKeys.sources[tool] = "infinite-connection"
    const improveByProvider: Partial<Record<ProviderId, ImproveLine[]>> = {}
    for (const entry of approvedImprove) (improveByProvider[entry.provider] ??= []).push(entry)
    const classifications = classifyPhase({
      manifest: phase.manifest,
      detected: phase.detected,
      keys: resolvedKeys,
      adoptExisting: true,
      serverLane,
      improve: improveByProvider
    })
    // Review I1 P1-2: the user's own next.config is never edited and never blocks the install; the rewrites it
    // lacks are an agent job (`deferredConfigRewrites`, checked by `next_rewrites_exact`).
    let planResult = planPhase({ root, inspect: phase.inspect, classifications, keys: resolvedKeys, workspaceId, serverLane, deferUnmanagedNextConfig: true })
    if (planResult.failure && artifacts.posthog?.proxy && /next\.config|rewrites/.test(planResult.failure.message)) {
      // An existing next.config the installer will not edit: PostHog installs direct to its region,
      // and the proxy is left to a line the user sees (never a silent downgrade).
      const direct = keys.posthog.ingestHost
      if (direct) {
        artifacts = { ...artifacts, posthog: { projectKey: artifacts.posthog.projectKey, apiHost: direct, ...(artifacts.posthog.uiHost ? { uiHost: artifacts.posthog.uiHost } : {}) } }
        resolvedKeys.artifacts = artifacts
        planResult = planPhase({ root, inspect: phase.inspect, classifications, keys: resolvedKeys, workspaceId, serverLane, deferUnmanagedNextConfig: true })
        warnings.push("PostHog was installed straight to its region: your existing next.config is not edited by the installer, so the /ingest proxy is an agent job (add the rewrites to next.config).")
      }
    }
    if (planResult.failure) {
      return this.failed(artifacts, warnings, `The install plan is blocked: ${planResult.failure.message}`, false)
    }

    const improveFiles = codeImprove.flatMap((entry) =>
      entry.kind === "improve_additive" ? [repoRelative(scan.appRoot, "vercel.json")] : entry.evidence ? [repoRelative(scan.appRoot, entry.evidence.file)] : []
    )
    const npmFiles =
      lockfile?.ok === true ? [repoRelative(scan.appRoot, "package.json"), lockfile.lockfile.file] : []
    const p = planResult.plan
    // Every file the server lane can write (brief, guide, module, middleware, created entries) is in the
    // snapshot too, so a rollback leaves nothing half-installed (P3-21).
    const laneFiles = p.serverLane
      ? [
          p.serverLane.briefPath,
          normalizeAppRelativePath(scan.appRoot, SERVER_LANE_GUIDE_FILE),
          ...(p.serverLane.modulePath ? [p.serverLane.modulePath] : []),
          ...(p.serverLane.middleware ? [p.serverLane.middleware.path] : []),
          ...(p.serverLane.created ?? []).map((entry) => entry.path)
        ]
      : []
    const carriedEdits = previous?.edits ?? []
    const carriedFiles = [...new Set(carriedEdits.map((edit) => edit.file))]
    const snapshot: FileSnapshot[] = snapshotFiles(root, [
      ...new Set([...p.files, ...laneFiles, installManifestRelativePath, ...improveFiles, ...npmFiles, ...carriedFiles])
    ])
    const rollback = (): boolean => {
      try {
        restoreSnapshot(root, snapshot)
        return true
      } catch {
        return false
      }
    }

    const edits: WizardEditRecord[] = []
    const changedFiles: string[] = []
    let openJobs: string[] = []
    let seq = 0
    try {
      // 1. the managed install (the harness's own apply + static verification + rollback)
      if (!planResult.nothingToInstall) {
        const applied = applyPhase({ root, workspaceId, plan: p, allowDirty: harnessRepoStatus(root) !== "dirty" })
        if (applied.outcome !== "applied") {
          const drift = applied.staticVerify.routeChecks.filter((check) => /Missing|drifted|forbidden/.test(check)).join("; ")
          return this.failed(artifacts, warnings, `Static verification failed${drift ? ` — ${drift}` : ""}; ${applied.outcome === "rolled_back" ? "rolled back" : "left as written"}.`, applied.outcome === "rolled_back" && rollback())
        }
        changedFiles.push(...(applied.applyResult?.changedFiles ?? []))
        warnings.push(...(applied.applyResult?.warnings ?? []))
        openJobs = applied.openJobs.map((requirement) => requirement.path)
        // A file an EARLIER run's recorded edits live in, changed by this run's managed re-render: that
        // change is recorded too, so uninstall (newest first) walks back through it to the earlier
        // edits instead of finding them "changed since" (P1-3).
        for (const file of carriedFiles) {
          const before = snapshot.find((entry) => entry.relativePath === file)?.contents ?? null
          const path = join(root, file)
          const after = existsSync(path) ? readFileSync(path, "utf8") : null
          if (before === null || after === null || before === after) continue
          edits.push(makeEditRecord({ file, before, after, jobId: null, planLineId: "managed_rerender", by: "wizard", runId, seq: seq++ }))
        }
      }

      // 2. approved improve-in-place code edits (each recorded, reversible)
      for (const entry of codeImprove) {
        const result = applyImproveEdit({
          root,
          appRoot: scan.appRoot,
          framework: scan.framework,
          line: entry,
          keys,
          consentMode: answers.consentMode,
          runId,
          seq: seq++,
          vercelServed: served.vercelServed
        })
        if (!result.ok) {
          warnings.push(`${entry.id}: not changed — ${result.reason}`)
          continue
        }
        if (result.record) {
          edits.push(result.record)
          changedFiles.push(result.record.file)
        }
      }

      // 3. the npm line (decision 5)
      let npmInstalled = false
      if (npmApproved && scan.serverLane) {
        const npm = await this.npmInstall(scan.serverLane.installPackages)
        if (npm.ok) {
          npmInstalled = true
          edits.push(...npm.edits)
          changedFiles.push(...npm.edits.map((edit) => edit.file))
        } else {
          warnings.push(`The server-lane package was not installed (${npm.reason}); package.json and the lockfile are unchanged.`)
        }
      }

      // 4. the build check: a failure NEW against the baseline rolls everything back
      let build: WizardApplyResult["build"] = "not_run"
      if (this.options.build) {
        const result = await this.options.build()
        if (result.ok) build = "passed"
        else {
          const baseline = new Set(internals.before.baselineBuild?.failureSignature ?? [])
          const fresh = result.failureSignature.filter((signature) => !baseline.has(signature))
          if (internals.before.baselineBuild && !internals.before.baselineBuild.ok && fresh.length === 0) build = "failed_baseline"
          else {
            const restored = rollback()
            return this.failed(artifacts, warnings, `The build failed after the install${fresh.length > 0 ? ` (${fresh.slice(0, 3).join("; ")})` : ""}; every change was rolled back.`, restored)
          }
        }
      } else {
        warnings.push("No build check ran (none wired); the build is checked again in the draft pull request.")
      }

      // 5. the receipt: the earlier runs' edits carried over, this run's edits, and the public ids the
      // page now carries (this run's approvals plus every kept tool)
      this.writeReceipt(root, scan, workspaceId, edits, manifestIdsFor(artifacts), carriedEdits)
      return {
        ok: true,
        rolledBack: false,
        edits,
        openJobs,
        changedFiles: [...new Set(changedFiles)],
        warnings,
        reason: null,
        npmInstalled,
        build,
        artifacts,
        deferredConfigRewrites: [...(p.deferredConfigRewrites ?? [])]
      }
    } catch (error) {
      const restored = rollback()
      return this.failed(artifacts, warnings, error instanceof Error ? error.message : String(error), restored)
    }
  }

  async npmInstall(pkgs: readonly string[]): Promise<{ ok: boolean; edits: WizardEditRecord[]; reason?: string }> {
    const scan = await this.ensureScan("npmInstall")
    const result = await runNpmJob({
      root: scan.root,
      appRoot: scan.appRoot,
      packages: pkgs,
      runId: this.requireRunId(),
      planLineId: DECISION_LINE_IDS.npmInstall,
      spawn: this.options.spawn
    })
    return result.ok ? { ok: true, edits: result.edits } : { ok: false, edits: [], reason: result.reason }
  }

  // ---------------------------------------------------------------------------------------------
  // the receipt
  // ---------------------------------------------------------------------------------------------

  /** Appends edits (O3's agent edits, O4's hook refreshes) to `.infinite/install.json` `edits`. */
  async recordEdits(edits: readonly WizardEditRecord[]): Promise<void> {
    if (edits.length === 0) return
    const scan = await this.ensureScan("recordEdits")
    this.writeReceipt(scan.root, scan, wizardInstallWorkspaceId(this.options.repoFingerprint), [...edits], null)
  }

  /**
   * §3e.6: after a commit's hooks ran, rebase each file's newest record onto the committed blob
   * (and refresh the managed files' content hashes). `refreshed: true` = the receipt changed and
   * O4 commits it once (`infinite-tag: refresh edit receipt after hooks`).
   */
  async refreshEditReceiptFromHead(): Promise<{ refreshed: boolean }> {
    const root = (await this.ensureScan("refreshEditReceiptFromHead")).root
    const manifest = readInstallManifest(root)
    if (!manifest) return { refreshed: false }
    const readBlob = this.options.readBlob ?? gitShow
    let changed = false
    let edits = manifest.edits ?? []
    if (edits.length > 0) {
      const bases = readEditBases(root)
      const result = refreshFromHead(edits, {
        readHead: (file) => readBlob(root, "HEAD", file),
        beforeOf: (record) => (Object.prototype.hasOwnProperty.call(bases, record.id) ? bases[record.id] : undefined)
      })
      if (result.refreshed.length > 0) {
        edits = result.records
        changed = true
      }
    }
    const headHashes = Object.fromEntries(
      Object.keys(manifest.contentHashes).flatMap((file) => {
        const blob = readBlob(root, "HEAD", file)
        return blob === null ? [] : [[file, computeContentHash(blob)]]
      })
    )
    const contentHashes = { ...manifest.contentHashes, ...headHashes }
    if (Object.entries(headHashes).some(([file, hash]) => manifest.contentHashes[file] !== hash)) changed = true
    if (changed) writeInstallManifest(root, { ...manifest, contentHashes, ...(edits.length > 0 ? { edits } : {}) })
    return { refreshed: changed }
  }

  async uninstall(opts: { root: string; dryRun: boolean }): Promise<UninstallReport> {
    // The wizard's own bookkeeping (`.infinite/harness.json`, never committed; `.infinite/wizard/`) is not
    // the user's work: it never makes the tree "dirty" here (I1b: a finished run left harness.json
    // untracked, so every `uninstall --pr` stopped with "Refusing to uninstall on a dirty git tree").
    const result = uninstallInstallation({ root: opts.root, dryRun: opts.dryRun, allowDirty: onlyWizardBookkeepingDirty(opts.root) })
    return {
      reversed: [...new Set([...(result.editsReversed ?? []), ...result.restoredFiles, ...result.removedFiles])],
      leftAsIs: result.editsLeftAsIs ?? []
    }
  }

  // ---------------------------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------------------------

  private writeReceipt(
    root: string,
    scan: WizardScanResult,
    workspaceId: string,
    edits: WizardEditRecord[],
    ids: InstallManifest["ids"] | null,
    /** An earlier run's records the managed apply's fresh manifest does not carry (kept, oldest first). */
    carried: readonly WizardEditRecord[] = []
  ): void {
    const current = readInstallManifest(root)
    const base: InstallManifest =
      current ??
      ({
        workspaceId,
        appRoot: scan.appRoot,
        framework: scan.framework as SupportedFramework,
        providers: [],
        files: [],
        envKeys: [],
        contentHashes: {},
        wiringVersion: 1,
        verifiedAt: null
      } satisfies InstallManifest)
    const prior = [...(base.edits ?? [])]
    for (const edit of carried) if (!prior.some((entry) => entry.id === edit.id)) prior.push(edit)
    const known = new Set(prior.map((edit) => edit.id))
    const fresh = edits.filter((edit) => !known.has(edit.id))
    // Nothing installed and nothing edited: no receipt is created for an install that changed nothing.
    if (!current && fresh.length === 0 && carried.length === 0) return
    cacheEditBefores(root, fresh)
    const merged = [...prior, ...fresh]
    if (merged.length === 0 && ids === null && current) return
    writeInstallManifest(root, {
      ...base,
      contentHashes: { ...base.contentHashes, ...computeContentHashes(root, base.files) },
      ...(merged.length > 0 ? { edits: merged } : {}),
      ...(ids ? { ids } : base.ids ? { ids: base.ids } : {})
    })
  }

  private failed(artifacts: WizardInstallArtifacts, warnings: string[], reason: string, rolledBack: boolean): WizardApplyResult {
    return { ok: false, rolledBack, edits: [], openJobs: [], changedFiles: [], warnings, reason, npmInstalled: false, build: "not_run", artifacts }
  }

  /** The last scan, or a fresh one of `options.root` (a resumed process has not scanned yet). */
  private async ensureScan(caller: string): Promise<WizardScanResult> {
    if (this.lastScan) return this.lastScan
    if (!this.options.root) throw new Error(`${caller} needs a scan first (or the installer's root).`)
    return this.scan({ root: this.options.root })
  }

  private requireRunId(): string {
    const runId = this.options.runId()
    if (!runId) throw new Error("The install needs the cloud run id (the `agent` step creates it).")
    return runId
  }

  private requireWizardScan(scan: ScanResult): WizardScanResult {
    const candidate = scan as Partial<WizardScanResult>
    if (!candidate.facts || !candidate.inspect || !candidate.detected) throw new Error("buildPlan needs a scan from this installer.")
    return scan as WizardScanResult
  }
}

/**
 * A corrupt receipt is rebuilt from the managed markers BEFORE inspecting (inspect reads the receipt
 * and would throw). The framework comes from the same adapters inspect uses, over the same candidate
 * roots; when none matches, nothing is rebuilt and the original error stands.
 */
function rebuildCorruptReceipt(root: string, appRoot: string | undefined, workspaceId: string): { lost: string[] } {
  const candidates = appRoot ? [appRoot] : [".", ...appsDirectories(root)]
  let best: { appRoot: string; framework: SupportedFramework; confidence: number } | null = null
  for (const candidate of candidates) {
    const absolute = candidate === "." ? root : join(root, candidate)
    for (const adapter of frameworkAdapters) {
      const match = adapter.detect(absolute)
      if (match && (!best || match.confidence > best.confidence)) best = { appRoot: candidate, framework: match.framework, confidence: match.confidence }
    }
  }
  if (!best) throw new Error("Corrupt .infinite/install.json — and no supported framework to rebuild it for. Remove it manually to reset.")
  const rebuilt = rebuildInstallManifestFromMarkers({ root, appRoot: best.appRoot, framework: best.framework, workspaceId })
  writeInstallManifest(root, rebuilt.manifest)
  return { lost: rebuilt.lost }
}

function appsDirectories(root: string): string[] {
  try {
    return readdirSync(join(root, "apps"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `apps/${entry.name}`)
      .sort()
  } catch {
    return []
  }
}

const TOOL_LABEL: Record<"infinite" | "ga4" | "posthog" | "meta", string> = { infinite: "Infinite", ga4: "GA4", posthog: "PostHog", meta: "Meta" }

/**
 * How the site is served, for what the wizard can write: a `vercel.json` rewrite is served only when
 * Vercel serves the site (the hosting verb, or the repo's own vercel.json / .vercel link).
 */
export function siteServing(
  scan: Pick<WizardScanResult, "framework" | "hosting" | "root"> & { unmanagedNextConfig?: string | null },
  before: Pick<BeforeFacts, "hosting">,
  keys?: TagKeys
): { vercelServed: boolean; posthogProxy: boolean; infiniteBlocked: string | null } {
  const vercelServed = before.hosting.provider === "vercel" || scan.hosting === "vercel"
  const html = scan.framework === "static-html" || scan.framework === "vite-react"
  // Review I1 P1-2: a Next app's OWN config is never edited, so a NEW PostHog proxies through /ingest only
  // when that config already carries PostHog's exact rewrites; otherwise it installs straight to its region
  // (an /ingest api_host with no rewrite behind it would 404 every event).
  const ownConfigLacksPosthog = !html && !!scan.unmanagedNextConfig && !ownConfigHas(scan.root, scan.unmanagedNextConfig, keys ? { posthog: posthogProxyFor(keys.posthog) ?? undefined } : null)
  return {
    vercelServed,
    // Next proxies through its own rewrites on any host; a static/Vite page only through vercel.json.
    posthogProxy: html ? vercelServed : !ownConfigLacksPosthog,
    infiniteBlocked:
      html && !vercelServed
        ? "your site is not served through Vercel, so the wizard cannot add the same-origin collect path a static page needs; Infinite is not installed this run. Host the site on Vercel (or add the collect path by hand), then run npx infinite-tag again."
        : null
  }
}

/**
 * The artifact an already-managed tool keeps when its update was not approved: exactly the public ids
 * the receipt recorded (§3e.6 `ids`), never the connection's newer ones. A reason string when the
 * receipt cannot say (an older receipt without ids, or a value it never recorded).
 */
function keptArtifact(
  tool: "infinite" | "ga4" | "posthog" | "meta",
  previous: InstallManifest,
  keys: TagKeys,
  consentMode: "required" | "not_required"
): NonNullable<WizardInstallArtifacts[typeof tool]> | string {
  const ids = previous.ids
  if (!ids) return "its receipt does not record the installed ids"
  switch (tool) {
    case "ga4":
      return ids.ga4.length === 1 ? { measurementId: ids.ga4[0]! } : "its receipt does not record exactly one GA4 id"
    case "meta":
      return ids.meta.length === 1 ? { pixelId: ids.meta[0]! } : "its receipt does not record exactly one pixel id"
    case "posthog": {
      if (!ids.posthog) return "its receipt does not record the PostHog project"
      const { projectKey, apiHost } = ids.posthog
      // ui_host is the project's own app host (links only, nothing is sent there): the connection's, when
      // it is still the same project.
      const uiHost = keys.posthog.status === "connected" && keys.posthog.projectKey === projectKey && keys.posthog.uiHost ? { uiHost: keys.posthog.uiHost } : {}
      if (!apiHost.startsWith("/")) return { projectKey, apiHost, ...uiHost }
      const region = keys.posthog.region === "us" || keys.posthog.region === "eu" ? keys.posthog.region : null
      if (!region) return "PostHog's region is unknown, so its /ingest proxy cannot be kept (connect PostHog in Infinite)"
      return {
        projectKey,
        apiHost,
        ...uiHost,
        proxy: { path: apiHost === DEFAULT_POSTHOG_PROXY_PATH ? DEFAULT_POSTHOG_PROXY_PATH : apiHost, ingestHost: `https://${region}.i.posthog.com`, assetsHost: `https://${region}-assets.i.posthog.com` }
      }
    }
    case "infinite": {
      if (!ids.infinite) return "its receipt does not record the site source"
      if (!keys.infinite.collectPath) return "Infinite's collect path is unknown (the site source is not provisioned)"
      return { siteSourceKey: ids.infinite.siteSourceKey, collectPath: keys.infinite.collectPath, productionHosts: [...keys.infinite.productionHosts], consentMode }
    }
  }
}

export function createWizardInstaller(options: InstallerOptions): WizardInstaller {
  return new WizardInstaller(options)
}

const NEXT_CONFIG_NAMES = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"] as const

/** The Next app's own config (repo-relative) when exactly one exists and it is not the installer's managed file. */
export function unmanagedNextConfigOf(appRootAbsolute: string, appRoot: string, framework: string): string | null {
  if (framework !== "next-app-router" && framework !== "next-pages-router") return null
  const present = NEXT_CONFIG_NAMES.filter((name) => existsSync(join(appRootAbsolute, name)))
  if (present.length !== 1) return null
  const source = readFileSync(join(appRootAbsolute, present[0]!), "utf8")
  return isManagedInfiniteFile(source) ? null : normalizeAppRelativePath(appRoot, present[0]!)
}

/** True when the user's own config already has every rewrite of `proxy` exactly (null proxy / no spec = false). */
function ownConfigHas(root: string, file: string, proxy: ManagedProxySpec | null): boolean {
  if (!proxy || (!proxy.posthog && !proxy.infinite)) return false
  try {
    return hasExactNextConfigRewrites(readFileSync(join(root, file), "utf8"), proxy)
  } catch {
    return false
  }
}

/**
 * Review I1 P1-2: the plan line's fact. A Next app with its own config that lacks Infinite's collect rewrite:
 * the installer leaves the file as it is and the rewrite is an agent job, so the plan says so up front.
 */
export function nextConfigRewritesNeeded(scan: Pick<WizardScanResult, "root"> & { unmanagedNextConfig?: string | null }, keys: TagKeys): { path: string } | null {
  if (!scan.unmanagedNextConfig || !keys.infinite.collectPath) return null
  const infinite = { path: keys.infinite.collectPath, destination: infiniteCollectDestination(INFINITE_API_ORIGIN) }
  return ownConfigHas(scan.root, scan.unmanagedNextConfig, { infinite }) ? null : { path: scan.unmanagedNextConfig }
}
