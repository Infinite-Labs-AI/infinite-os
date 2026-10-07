// §3e.7 `Installer`: the wizard's install, composed from the SAME harness phases `runHarness` runs
// (`src/harness/run.ts`), plus the wizard's own pieces — improve-in-place edits on approved lines,
// the npm line, the build check with a full rollback, and the edit receipt.
//
// What it never does: emit browser bytes of its own (O5's builders and the managed adapters do), spawn
// `vercel`, auto-approve a line that reduces an adopted provider, or call the cloud (the steps call
// the bridge; this module only reads and writes the repo).
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { recordGeneratedApi } from "../jobs/generated-api.js"
import { previewOwnerWiring, type OwnerWiringPreview } from "../frameworks/owner-wiring-preview.js"
import { planManagedCapture, applyManagedCapture, type ManagedCapturePlan } from "./managed-capture.js"
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
import { buildVerdict } from "../checks/build.js"
import { detectSensitivePages, readAppSources } from "../setup-checks/index.js"
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
import { planServerLane, serverLaneTargetForMode, SERVER_LANE_MODULE_IMPORT_PATH } from "../server-lane/install.js"
import type {
  DeferredConfigRewrite,
  ImproveLine,
  InspectResult,
  InstallManifest,
  ManualRequirement,
  ManagedCaptureRecord,
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
import { artifactsFromKeys, manifestIdsFor, posthogProxyFor, withConversionHelpers, wizardInstallWorkspaceId, type WizardInstallArtifacts } from "./keys-adapter.js"
import { buildCreatedMiddlewareSource, buildServerLaneModuleSource } from "../server-lane/runtime-source.js"
import { SERVER_LANE_GUIDE_FILE } from "../server-lane/copy.js"
import { normalizeAppRelativePath, writeFileAtomic } from "../frameworks/shared.js"
import { DEFAULT_POSTHOG_PROXY_PATH, INFINITE_API_ORIGIN, infiniteCollectDestination } from "../workspace-artifacts.js"
import { buildManualNextConfigInstruction, hasExactNextConfigRewrites, type ManagedProxySpec } from "../frameworks/vercel-config.js"
import { buildAnalyticsModuleSource, buildClientComponentSource, isManagedInfiniteFile } from "../frameworks/managed-files.js"
import { findLockfile, runNpmJob } from "./npm.js"
import { proofFileBlockedText, proofFileTarget } from "./proof-file.js"
import {
  buildPlanModel,
  DECISION_LINE_IDS,
  planAsksConsent,
  lineFactsFor,
  planAskPayload,
  resolvePlanAnswers,
  type PlanAgentSummary,
  type PlanRunFacts,
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
  ownerWiring?: OwnerWiringPreview
  managedCapture?: ManagedCapturePlan
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
  /** D17: the app's sensitive routes (`detectSensitivePages`), for the sensitive-pages plan lines. */
  sensitivePaths?: string[]
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
  /**
   * §3y.5: the run facts the runnability rule reads (this run's site state, the `tag.site-claim.v1` capability).
   * Absent = no answered host and no claim capability.
   */
  runFacts?: () => PlanRunFacts | null
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
  managedCapture?: ManagedCaptureRecord
  /** Deterministic edits refused before writing owner source; never dispatched to a worker. */
  ownerRequirements?: ManualRequirement[]
  /** Repo-root-relative files written this run (managed + improve + npm), for the status line. */
  changedFiles: string[]
  warnings: string[]
  /** Why the install did not land (set when `ok` is false). */
  reason: string | null
  /** True when an `npm` line was approved and the package was installed. */
  npmInstalled: boolean
  /** "passed" | "failed_baseline" (red before this run too) | "not_run" (no build check wired, or the build could not run: B26). */
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

/** The D17 detector's routes (`detectSensitivePages`) over the app's own source: login, checkout, … pages. */
export function sensitiveRoutesOf(appRootAbsolute: string): string[] {
  return [...new Set(detectSensitivePages(readAppSources(appRootAbsolute)).map((entry) => entry.route))].sort()
}

/**
 * The sensitive paths the D17 plan lines name (decision 17: a plan line from a detector, never automatic):
 * the detector's routes from the scan, unless the setup check found the site's PostHog init already turns
 * replay and autocapture off there (`sensitive_pages` = pass). A NEW managed PostHog has no init in the code
 * yet, so the check has nothing to say and the detector's routes stand. (The check's evidence is a file and
 * line, never a URL: reading paths from it found none, so neither D17 line could ever appear.)
 */
export function sensitivePathsFor(scan: Pick<WizardScanResult, "sensitivePaths">, before: BeforeFacts): string[] {
  const handled = before.checks.some((check) => check.checkId === SENSITIVE_PAGES_CHECK_ID && check.state === "pass")
  return handled ? [] : [...(scan.sensitivePaths ?? [])]
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
        serverLane = { targetLabel: draft.targetLabel ?? (draft.mode === "next-middleware" ? "Next.js middleware" : draft.mode), installPackages: [...(draft.installPackages ?? [])] }
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
      sensitivePaths: sensitiveRoutesOf(phase.appRootAbsolute),
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
    result.managedCapture = planManagedCapture({ root: result.root, appRoot: result.appRoot, framework: result.framework, pixels: result.facts.meta, htmlPages: result.inspect.detectedFiles.filter(file => /\.html?$/i.test(file)) })
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
    const sensitivePaths = sensitivePathsFor(wizardScan, before)
    const served = siteServing(wizardScan, beforeFacts, keys)
    const improve = improveLinesFor(wizardScan.facts, { framework: wizardScan.framework, keys, sensitivePaths, vercelServed: served.vercelServed }).map(entry => entry.kind === "capture_beside_adopted_pixel" && wizardScan.managedCapture ? { ...entry, owner: "code" as const } : entry)
    const managed = new Set<ProviderId>((wizardScan.manifest?.providers ?? []) as ProviderId[])
    const run = this.options.runFacts?.() ?? null
    // §3y.2: on the claim path the proof file must be served at the site's root; a static site that builds into
    // another directory cannot be, so Infinite's line says where to put it (before anything is approved).
    let infiniteBlocked = served.infiniteBlocked
    if (!infiniteBlocked && run?.siteClaim && keys.infinite.status !== "ready" && !lineFactsFor({ keys, before: beforeFacts, scan: { serverLane: wizardScan.serverLane } as PlanScanFacts, run }).vercelServesHost) {
      const target = proofFileTarget(wizardScan.root, wizardScan.appRoot, wizardScan.framework)
      if ("blocked" in target) infiniteBlocked = proofFileBlockedText(target.blocked)
    }
    const facts: PlanScanFacts & { ownerWiring?: OwnerWiringPreview; managedCapture?: ManagedCapturePlan } = {
      managedCapture: wizardScan.managedCapture,
      sources: Object.fromEntries(scanSourceFiles(join(wizardScan.root, wizardScan.appRoot), { includePublic: wizardScan.framework === "static-html" }).files.map(file => [normalizeAppRelativePath(wizardScan.appRoot, file), readFileSync(join(wizardScan.root, wizardScan.appRoot, file), "utf8")])),
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
      infiniteBlocked,
      nextConfigRewrites: nextConfigRewritesNeeded(wizardScan, keys),
      // Review I1 P1-2: an installer blocker is said on the plan screen, before anything is approved or written.
      installBlocked: this.dryInstallFailure(
        wizardScan,
        artifactsFromKeys(keys, { consentMode: "not_required", conversionNames: [], privacyText: null, npmInstall: null }, { posthogProxy: served.posthogProxy }),
        wizardScan.serverLane !== null,
        beforeFacts
      )
    }
    facts.ownerWiring = wizardScan.ownerWiring
    const model = buildPlanModel({
      scan: facts,
      keys,
      before: beforeFacts,
      candidates,
      agent: this.options.agent(),
      consentFlag: this.options.consentFlag(),
      productionDeniedConflict: this.options.productionDeniedConflict,
      run
    })
    this.internals.set(model, { scan: wizardScan, keys, before: beforeFacts, candidates: model.scopedCandidates ?? candidates, improve })
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
      scan.ownerWiring = previewOwnerWiring({ root: scan.root, appRoot: scan.appRoot, framework: scan.framework, plan: result.plan })
      return result.failure && !result.nothingToInstall ? result.failure.message : null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // apply
  // ---------------------------------------------------------------------------------------------

  private prepareApply(plan: PlanModel, approvals: PlanApprovals) {
    const internals = this.internals.get(plan)
    if (!internals) throw new Error("apply needs a plan built by this installer (buildPlan) in this process.")
    const model = plan as WizardPlanModel
    const { scan, keys } = internals
    const root = scan.root
    const runId = this.requireRunId()
    const answers = resolvePlanAnswers(plan, approvals, { consentFlag: this.options.consentFlag() })
    // R2-6: a plan that does not ask consent installs nothing consent governs (no Infinite, no managed tag, no capture).
    if (answers.consentMode === null && planAsksConsent(plan)) throw new Error("apply needs an answered consent mode (the run parks at `plan` without one).")
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
      const kept = answers.consentMode === null ? "the plan has no consent answer for it" : keptArtifact(tool, previous, keys, answers.consentMode)
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
    if (approved.has("sensitive_pages:posthog:managed")) artifacts = withSensitivePaths(artifacts, sensitivePathsFor(internals.scan, internals.before))
    // §3x.3 (B3): the conversion helpers, by the one rule (`withConversionHelpers`), on what this install really writes.
    artifacts = withConversionHelpers(artifacts, answers.conversions)
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
    return { root, scan, runId, artifacts, warnings, previous, internals, keys, answers, served, codeImprove, npmApproved, workspaceId, improveFiles, npmFiles, planResult, p }
  }

  async apply(plan: PlanModel, approvals: PlanApprovals): Promise<WizardApplyResult> {
    const prepared = this.prepareApply(plan, approvals)
    if (!("p" in prepared)) return prepared
    const { root, scan, runId, artifacts, warnings, previous, internals, keys, answers, served, codeImprove, npmApproved, workspaceId, improveFiles, npmFiles, planResult, p } = prepared
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
    const capturePlan = codeImprove.some(entry => entry.kind === "capture_beside_adopted_pixel") ? planManagedCapture({ root, appRoot: scan.appRoot, framework: scan.framework, pixels: scan.facts.meta, htmlPages: scan.inspect.detectedFiles.filter(file => /\.html?$/i.test(file)) }) : undefined
    const carriedFiles = [...new Set(carriedEdits.map((edit) => edit.file))]
    const snapshot: FileSnapshot[] = snapshotFiles(root, [
      ...new Set([...p.files, ...laneFiles, installManifestRelativePath, ...improveFiles, ...npmFiles, ...carriedFiles, ...(capturePlan ? [capturePlan.module, ...capturePlan.entrypoints] : [])])
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
    const ownerRequirements: ManualRequirement[] = []
    let managedCapture: ManagedCaptureRecord | undefined
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
        ownerRequirements.push(...applied.openJobs.filter(requirement => requirement.ownerBoundary))
        openJobs = applied.openJobs.filter(requirement => !requirement.ownerBoundary).map((requirement) => requirement.path)
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
        if (entry.kind === "capture_beside_adopted_pixel") {
          if (answers.consentMode === null) throw new Error("The capture requires the owner's recorded consent-mode answer")
          const applied = applyManagedCapture({ root, appRoot: scan.appRoot, framework: scan.framework, pixels: scan.facts.meta, htmlPages: scan.inspect.detectedFiles.filter(file => /\.html?$/i.test(file)), mode: answers.consentMode, runId, seq })
          ownerRequirements.push(...applied.plan?.requirements ?? [])
          edits.push(...applied.edits); seq += applied.edits.length
          changedFiles.push(...applied.changedFiles)
          managedCapture = applied.record
          continue
        }
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
          if (result.ownerRequirement) ownerRequirements.push(result.ownerRequirement)
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
      if (this.options.build && internals.before.localValidation !== "not_measured") {
        const result = await this.options.build()
        // ONE rule with the jobs step and the review's fix rounds (B26, `buildVerdict`): a build that could not
        // run (or ended red with no failure signature) is UNDETERMINED: never "passed", never "red before this
        // run too", and never blamed on the install.
        const baselineBuild = internals.before.baselineBuild
        const verdict = await buildVerdict(result, async () => baselineBuild ?? { failureSignature: [] })
        if (verdict.state === "pass") build = result.ok ? "passed" : "failed_baseline"
        else if (verdict.state === "undetermined") {
          build = "not_run"
          warnings.push(`The build could not run here (${verdict.reason ?? "test_error"}); the pull request's own checks will be the judge.`)
        } else {
          const known = new Set(baselineBuild?.failureSignature ?? [])
          const fresh = result.failureSignature.filter((signature) => !known.has(signature))
          const restored = rollback()
          return this.failed(artifacts, warnings, `The build failed after the install${fresh.length > 0 ? ` (${fresh.slice(0, 3).join("; ")})` : ""}; every change was rolled back.`, restored)
        }
      } else if (internals.before.localValidation !== "not_measured") {
        warnings.push("No local build check is available; the pull request's own checks will be the judge.")
      }

      // 5. the receipt: the earlier runs' edits carried over, this run's edits, and the public ids the
      // page now carries (this run's approvals plus every kept tool)
      this.writeReceipt(root, scan, workspaceId, edits, manifestIdsFor(artifacts), carriedEdits)
      if (managedCapture) {
        const receipt = readInstallManifest(root)
        if (!receipt) throw new Error("The managed capture has no install receipt")
        const files = [...new Set([...receipt.files, managedCapture.module, ...managedCapture.entrypoints])]
        writeInstallManifest(root, { ...receipt, managedCapture, files, contentHashes: { ...receipt.contentHashes, ...computeContentHashes(root, files) } })
      }
      return {
        ok: true,
        rolledBack: false,
        edits,
        openJobs,
        ...(ownerRequirements.length ? { ownerRequirements } : {}),
        ...(managedCapture ? { managedCapture } : {}),
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

  /** Re-render whole owned modules only. Entry points, npm and improve edits are never replayed. */
  async refreshManaged(plan: PlanModel, approvals: PlanApprovals): Promise<{ changedFiles: string[]; blocked: string[] }> {
    const prepared = this.prepareApply(plan, approvals)
    if (!("p" in prepared)) throw new Error(prepared.reason ?? "Could not rebuild the managed install plan")
    const { root, scan, p, runId } = prepared
    const readBlob = this.options.readBlob ?? gitShow
    const committedReceipt = readBlob(root, "HEAD", installManifestRelativePath)
    if (!committedReceipt) return { changedFiles: [], blocked: [] }
    const previous = JSON.parse(committedReceipt) as InstallManifest
    const current = readInstallManifest(root)
    if (previous.runId && previous.runId !== runId) return { changedFiles: [], blocked: [installManifestRelativePath] }
    if (!current || readFileSync(join(root, installManifestRelativePath), "utf8") !== committedReceipt) return { changedFiles: [], blocked: [installManifestRelativePath] }
    const expected = new Map<string, string>()
    for (const file of previous.files) {
      if (/(?:^|\/)lib\/infinite-analytics\.ts$/.test(file)) expected.set(file, buildAnalyticsModuleSource(p))
      if (/(?:^|\/)lib\/infinite-analytics-client\.tsx$/.test(file)) expected.set(file, buildClientComponentSource())
    }
    for (const instruction of p.instructions) {
      if (/(?:^|\/)next\.config\.[cm]?js$/.test(instruction.path) && previous.configOwnership?.[instruction.path]?.kind === "created" && isManagedInfiniteFile(instruction.snippet)) expected.set(instruction.path, instruction.snippet)
    }
    const lane = p.serverLane
    const infinite = p.artifacts.infinite
    const options = { siteSourceKey: infinite?.siteSourceKey || undefined, productionHosts: infinite?.productionHosts ?? p.artifacts.productionHosts ?? [], ...(infinite?.apiOrigin ? { apiOrigin: infinite.apiOrigin } : {}), ...(infinite?.collectPath ? { collectPath: infinite.collectPath } : {}) }
    if (lane?.mode === "next-middleware") {
      if (lane.modulePath && previous.serverLane?.module === lane.modulePath) expected.set(lane.modulePath, buildServerLaneModuleSource(options))
      if (lane.middleware && previous.configOwnership?.[lane.middleware.path]?.kind === "created") expected.set(lane.middleware.path, buildCreatedMiddlewareSource({ moduleImportPath: SERVER_LANE_MODULE_IMPORT_PATH }))
    }
    const target = lane ? serverLaneTargetForMode(lane.mode) : null
    if (target) {
      const built = target.build(options, join(root, scan.appRoot))
      for (const [file, source] of Object.entries(built)) {
        const path = normalizeAppRelativePath(scan.appRoot, file)
        if (previous.serverLane?.created?.includes(path) && previous.configOwnership?.[path]?.kind === "created") expected.set(path, source)
      }
    }
    const blocked: string[] = []
    const changed: Array<{ file: string; before: string; after: string }> = []
    for (const [file, after] of expected) {
      const before = existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : null
      const committed = readBlob(root, "HEAD", file)
      const ownership = previous.configOwnership?.[file]
      const hash = ownership?.kind === "created" ? ownership.installedHash : previous.contentHashes[file]
      if (!hash || before === null || committed === null || computeContentHash(before) !== hash || computeContentHash(committed) !== hash || !isManagedInfiniteFile(before)) {
        blocked.push(file)
      } else if (before !== after) changed.push({ file, before, after })
    }
    // Check every candidate before writing any: a hand edit never leaves a half-refreshed install.
    if (blocked.length > 0 || changed.length === 0) return { changedFiles: [], blocked }
    const snapshot = snapshotFiles(root, [...changed.map(entry => entry.file), installManifestRelativePath])
    try {
      for (const entry of changed) {
        recordGeneratedApi(root, entry.file, entry.after)
        writeFileAtomic(join(root, entry.file), entry.after)
      }
      const edits = changed.map((entry, seq) => makeEditRecord({ ...entry, jobId: null, planLineId: "managed_resume_refresh", by: "wizard", runId, seq: (current.edits?.length ?? 0) + seq }))
      const configOwnership = { ...current.configOwnership }
      for (const entry of changed) if (configOwnership[entry.file]?.kind === "created") configOwnership[entry.file] = { kind: "created", installedHash: computeContentHash(entry.after) }
      cacheEditBefores(root, edits)
      writeInstallManifest(root, { ...current, runId, edits: [...(current.edits ?? []), ...edits], configOwnership, contentHashes: { ...current.contentHashes, ...Object.fromEntries(changed.map(entry => [entry.file, computeContentHash(entry.after)])) } })
      return { changedFiles: [...changed.map(entry => entry.file), installManifestRelativePath], blocked: [] }
    } catch (error) {
      restoreSnapshot(root, snapshot)
      throw error
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
      runId: this.requireRunId(),
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
export function nextConfigRewritesNeeded(scan: Pick<WizardScanResult, "root"> & { unmanagedNextConfig?: string | null }, keys: TagKeys): { path: string; snippet: string } | null {
  if (!scan.unmanagedNextConfig || !keys.infinite.collectPath) return null
  const infinite = { path: keys.infinite.collectPath, destination: infiniteCollectDestination(INFINITE_API_ORIGIN) }
  return ownConfigHas(scan.root, scan.unmanagedNextConfig, { infinite }) ? null : { path: scan.unmanagedNextConfig, snippet: buildManualNextConfigInstruction({ infinite }) }
}
