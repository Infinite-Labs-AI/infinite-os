// §3e.7 `Installer`: the wizard's install, composed from the SAME harness phases `runHarness` runs
// (`src/harness/run.ts`), plus the wizard's own pieces — improve-in-place edits on approved lines,
// the npm line, the build check with a full rollback, and the edit receipt.
//
// What it never does: emit browser bytes of its own (O5's builders and the managed adapters do), spawn
// `vercel`, auto-approve a line that reduces an adopted provider, or call the cloud (the steps call
// the bridge; this module only reads and writes the repo).
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
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
  ImproveLine,
  InspectResult,
  InstallManifest,
  ProviderId,
  SupportedFramework,
  WorkspaceInstallArtifacts
} from "../types.js"
import { uninstallInstallation } from "../uninstall.js"
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

import { refreshFromHead } from "./edits.js"
import { applyImproveEdit, detectAdoptedFacts, improveLinesFor, withSensitivePaths, type AdoptedFacts } from "./improve.js"
import { artifactsFromKeys, manifestIdsFor, wizardInstallWorkspaceId, type WizardInstallArtifacts } from "./keys-adapter.js"
import { findLockfile, NPM_JOB_ID, runNpmJob } from "./npm.js"
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
}

export interface InstallerOptions {
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
  /** The branch base sha (`state.git.baseSha`), for `refreshEditReceiptFromHead`. */
  baseRev?: () => string | null
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
      phase = inspectPhase({ root: opts.root, appRoot: resolved.appRoot })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Corrupt .infinite/install.json")) throw error
      // A corrupt receipt is rebuilt from the managed markers (never a silent reset), then read.
      receiptRebuilt = rebuildCorruptReceipt(opts.root, resolved.appRoot, wizardInstallWorkspaceId(this.options.repoFingerprint))
      warnings.push(
        `The install receipt (.infinite/install.json) was corrupt; it was rebuilt from the managed markers. Lost: ${receiptRebuilt.lost.join(", ")} (an earlier run's recorded edits cannot be reversed automatically).`
      )
      phase = inspectPhase({ root: opts.root, appRoot: resolved.appRoot })
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
    const improve = improveLinesFor(wizardScan.facts, { framework: wizardScan.framework, keys, sensitivePaths })
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
      sensitivePaths
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

    // ---- the artifacts: approved new tools only, from the connections ----
    const all = artifactsFromKeys(keys, { ...plan.decisions, consentMode: answers.consentMode })
    const installLine = (tool: ProviderId) => plan.lines.find((entry) => entry.kind === "install_provider" && entry.id.startsWith(`install_provider:${tool}`))
    let artifacts: WizardInstallArtifacts = { ...(all.productionHosts ? { productionHosts: all.productionHosts } : {}) }
    for (const tool of ["infinite", "ga4", "posthog", "meta"] as const) {
      const lineForTool = installLine(tool)
      if (lineForTool && approved.has(lineForTool.id) && all[tool]) (artifacts as Record<string, unknown>)[tool] = all[tool]
    }
    // A static / Vite site served by Vercel (the hosting verb says so) gets Infinite's same-origin
    // collect path through vercel.json — the "proven same-origin proxy" the static adapters require.
    if (artifacts.infinite && internals.before.hosting.provider === "vercel" && (scan.framework === "static-html" || scan.framework === "vite-react")) {
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
    const npmApproved = approved.has(DECISION_LINE_IDS.npmInstall) && scan.serverLane !== null && scan.serverLane.installPackages.length > 0
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
    let planResult = planPhase({ root, inspect: phase.inspect, classifications, keys: resolvedKeys, workspaceId, serverLane })
    if (planResult.failure && artifacts.posthog?.proxy && /next\.config|rewrites/.test(planResult.failure.message)) {
      // An existing next.config the installer will not edit: PostHog installs direct to its region,
      // and the proxy is left to a line the user sees (never a silent downgrade).
      const direct = keys.posthog.ingestHost
      if (direct) {
        artifacts = { ...artifacts, posthog: { projectKey: artifacts.posthog.projectKey, apiHost: direct, ...(artifacts.posthog.uiHost ? { uiHost: artifacts.posthog.uiHost } : {}) } }
        resolvedKeys.artifacts = artifacts
        planResult = planPhase({ root, inspect: phase.inspect, classifications, keys: resolvedKeys, workspaceId, serverLane })
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
    const snapshot: FileSnapshot[] = snapshotFiles(root, [
      ...new Set([...p.files, ...(p.serverLane ? [p.serverLane.briefPath] : []), installManifestRelativePath, ...improveFiles, ...npmFiles])
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
      }

      // 2. approved improve-in-place code edits (each recorded, reversible)
      let seq = 0
      for (const entry of codeImprove) {
        const result = applyImproveEdit({
          root,
          appRoot: scan.appRoot,
          framework: scan.framework,
          line: entry,
          keys,
          consentMode: answers.consentMode,
          runId,
          seq: seq++
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

      // 5. the receipt: the edits and the public ids this install emitted
      this.writeReceipt(root, scan, workspaceId, edits, manifestIdsFor(artifacts))
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
        artifacts
      }
    } catch (error) {
      const restored = rollback()
      return this.failed(artifacts, warnings, error instanceof Error ? error.message : String(error), restored)
    }
  }

  async npmInstall(pkgs: readonly string[]): Promise<{ ok: boolean; edits: WizardEditRecord[]; reason?: string }> {
    const scan = this.lastScan
    if (!scan) throw new Error("npmInstall needs a scan first.")
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
    const scan = this.lastScan
    if (!scan) throw new Error("recordEdits needs a scan first.")
    if (edits.length === 0) return
    this.writeReceipt(scan.root, scan, wizardInstallWorkspaceId(this.options.repoFingerprint), [...edits], null)
  }

  /**
   * §3e.6: after a commit's hooks ran, rebase each file's newest record onto the committed blob
   * (and refresh the managed files' content hashes). `refreshed: true` = the receipt changed and
   * O4 commits it once (`infinite-tag: refresh edit receipt after hooks`).
   */
  async refreshEditReceiptFromHead(): Promise<{ refreshed: boolean }> {
    const scan = this.lastScan
    if (!scan) throw new Error("refreshEditReceiptFromHead needs a scan first.")
    const root = scan.root
    const manifest = readInstallManifest(root)
    if (!manifest) return { refreshed: false }
    const readBlob = this.options.readBlob ?? gitShow
    const base = this.options.baseRev?.() ?? null
    let changed = false
    let edits = manifest.edits ?? []
    if (edits.length > 0) {
      if (base === null) throw new Error("refreshEditReceiptFromHead needs the branch base sha.")
      const result = refreshFromHead(edits, {
        readHead: (file) => readBlob(root, "HEAD", file),
        readBase: (file) => readBlob(root, base, file)
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
    const result = uninstallInstallation({ root: opts.root, dryRun: opts.dryRun })
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
    ids: InstallManifest["ids"] | null
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
    const known = new Set((base.edits ?? []).map((edit) => edit.id))
    const merged = [...(base.edits ?? []), ...edits.filter((edit) => !known.has(edit.id))]
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

export function createWizardInstaller(options: InstallerOptions): WizardInstaller {
  return new WizardInstaller(options)
}
