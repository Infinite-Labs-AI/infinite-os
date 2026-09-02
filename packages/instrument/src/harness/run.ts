// The harness runbook, composed: teardown §5.2 steps 1–11 over the adapters in inspect.ts,
// marking.ts and verify.ts, driven by runbook.ts. Every I/O seam is injectable so the whole run
// is testable against fixture repos and stubbed backends.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"

import { applyInstallation, restoreSnapshot, snapshotFiles, type FileSnapshot } from "../apply.js"
import { isSupportedFramework } from "../frameworks/index.js"
import { assertWriteTargetInsideRoot, writeFileAtomic } from "../frameworks/shared.js"
import { detectRepoStatus, inspectWorkspace } from "../inspect.js"
import { computeContentHashes, installManifestRelativePath, readInstallManifest, writeInstallManifest } from "../manifest.js"
import { INSTRUMENT_VERSION } from "../package-manager.js"
import { renderPreview } from "../render.js"
import { detectHosting } from "../server-lane/hosting.js"
import type { ApplyResult, InspectResult, InstallManifest, VerifyResult, WorkspaceInstallArtifacts } from "../types.js"
import { verifyInstallation } from "../verify.js"
import {
  applyInfiniteDownloadDestinationPath,
  discoverWorkspaceArtifacts,
  resolveWorkspaceArtifacts
} from "../workspace-artifacts.js"

import { hasExplicitArtifacts, type HarnessArgs } from "./args.js"
import {
  buildHarnessPlan,
  classifyProviders,
  detectProvidersWithEvidence,
  readEnvKeys,
  resolveHarnessKeys,
  type DetectedProviderEvidence,
  type HarnessPlanResult
} from "./inspect.js"
import {
  PROPOSED_CONVERSIONS_RELATIVE_PATH,
  applyConversions,
  ensureProposedIgnored,
  proposeConversions,
  readApprovedConversions,
  writeProposal,
  type ApplyConversionsResult,
  type ApprovedConversions,
  type ConversionProposal
} from "./marking.js"
import { recordHarnessFile } from "./outputs.js"
import { REPORT_SENT_LINE, buildHarnessReportPayload, reportNotSentLine, type ReportSink } from "./report-sink.js"
import { errorText, runRunbook, type RunbookStep } from "./runbook.js"
import {
  HARNESS_REPORT_RELATIVE_PATH,
  createHarnessReport,
  findProvider,
  renderReportMarkdown,
  renderReportTable,
  transitionProvider,
  updateProvider
} from "./state.js"
import type {
  HarnessProviderId,
  HarnessReport,
  ProviderClassification,
  ResolvedKeys
} from "./types.js"
import {
  NONE_BACKEND_REASON,
  NoneBackend,
  PosthogQueryBackend,
  verifyLanes,
  type VerificationBackend,
  type VerifyLane,
  type VerifyLanesResult
} from "./verify.js"

export const HARNESS_BRIEF_RELATIVE_PATH = ".infinite/harness-brief.json"
export const MINIMUM_NODE_MAJOR = 18

export interface HarnessIo {
  /** TTY on both ends and not forced non-interactive. Gates every prompt. */
  interactive: boolean
  out(line: string): void
  err(line: string): void
  /** Returns the founder's answer; `defaultYes` decides what Enter means. */
  confirm(question: string, defaultYes: boolean): Promise<boolean>
}

export interface HarnessDeps {
  /** Verification backends in priority order. Default: NoneBackend (standalone). */
  backends?: VerificationBackend[]
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Test seam for the saved-artifacts discovery. */
  discover?: typeof discoverWorkspaceArtifacts
  nodeVersion?: string
  budgetMs?: number
  pollIntervalMs?: number
  /**
   * Where the finished report is sent (the desktop's stack-health strip reads it back). Absent
   * = never sent: the standalone `infinite-tag harness` has no Infinite session. Only
   * `infinite analytics` wires one, and only a run that wrote a report is sent — `--check`
   * (read-only, ungated) reports nothing, and a send that fails never fails the run.
   */
  reportSink?: ReportSink
}

export interface HarnessRunResult {
  exitCode: number
  report: HarnessReport
}

interface Ctx {
  report: HarnessReport
  args: HarnessArgs
  io: HarnessIo
  deps: HarnessDeps
  root: string
  appRootAbsolute: string
  inspect?: InspectResult
  detected: DetectedProviderEvidence[]
  manifest: InstallManifest | null
  keys?: ResolvedKeys
  classifications: ProviderClassification[]
  planResult?: HarnessPlanResult
  applyResult?: ApplyResult
  staticVerify?: VerifyResult
  /** What the apply step did when static verification failed: rolled back, or left as written. */
  applyOutcome?: "rolled_back" | "left_written"
  declined: boolean
  /** Preflight's verdict, ignoring the harness's own .infinite/ outputs and gitignore block. */
  treeCleanForHarness: boolean
  proposal?: ConversionProposal
  marking?: ApplyConversionsResult
  verifyResult?: VerifyLanesResult
  /** Providers this run wrote (install/upgrade) — the lanes verification reads back. */
  writtenLanes: VerifyLane[]
}

/**
 * Human narration (preview, proposal table, brief echo). With --json stdout must carry exactly one
 * JSON document — the report — so everything else goes to stderr.
 */
function narrate(ctx: Ctx, text: string): void {
  if (ctx.args.json) ctx.io.err(text)
  else ctx.io.out(text)
}

const laneOf: Partial<Record<HarnessProviderId, VerifyLane>> = {
  infinite: "infinite",
  ga4: "ga4",
  posthog: "posthog",
  meta: "meta",
  server_lane: "server_lane"
}

/** Paths the harness itself writes between `--plan` and `--apply`; they never make a tree "dirty". */
const HARNESS_OWN_PATHS = [".infinite/", ".gitignore"]

/**
 * The clean-tree gate, aware of the harness's own outputs: a `--plan` run leaves
 * `.infinite/REPORT.md`, the proposal and the gitignore block behind by design, and the
 * documented next step is `--apply --conversions <file>` — that must not trip the gate.
 */
export function harnessRepoStatus(root: string): "clean" | "dirty" | "not-a-git-repo" {
  const status = detectRepoStatus(root)
  if (status !== "dirty") return status
  const porcelain = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })
  if (porcelain.status !== 0) return "dirty"
  const foreign = porcelain.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
    .filter((path) => !HARNESS_OWN_PATHS.some((own) => (own.endsWith("/") ? path.startsWith(own) : path === own)))
  return foreign.length === 0 ? "clean" : "dirty"
}

function nodeMajor(version: string): number {
  return Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "0", 10)
}

function flagArtifacts(root: string, args: HarnessArgs): WorkspaceInstallArtifacts {
  return resolveWorkspaceArtifacts(root, {
    artifactFile: args.artifactFile,
    ga4MeasurementId: args.ga4MeasurementId,
    posthogProjectKey: args.posthogProjectKey,
    posthogApiHost: args.posthogApiHost,
    xPixelId: args.xPixelId,
    xEventTagIds: args.xEventTagIds,
    metaPixelId: args.metaPixelId,
    infiniteSiteSourceKey: args.infiniteSiteSourceKey,
    infiniteCollectPath: args.infiniteCollectPath,
    infiniteProductionHosts: args.infiniteProductionHosts.length > 0 ? args.infiniteProductionHosts : undefined,
    infiniteStaticProxy: args.infiniteStaticProxy,
    infiniteConsentMode: args.infiniteConsentMode
  })
}

function keyFor(classification: ProviderClassification): string | undefined {
  return classification.key
}

function productionUrl(ctx: Ctx): string | undefined {
  if (ctx.args.url) return ctx.args.url
  const host = ctx.keys?.artifacts.productionHosts?.[0] ?? ctx.keys?.artifacts.infinite?.productionHosts?.[0]
  return host ? `https://${host}/` : undefined
}

function writeJson(root: string, relativePath: string, value: unknown): string {
  const absolutePath = join(root, relativePath)
  assertWriteTargetInsideRoot(root, absolutePath)
  writeFileAtomic(absolutePath, `${JSON.stringify(value, null, 2)}\n`)
  recordHarnessFile(root, relativePath)
  return absolutePath
}

function renderProposalTable(proposal: ConversionProposal): string {
  const rows = proposal.rows.map((row) => `  ${row.ctaId.padEnd(28)} ${row.ctaLocation.padEnd(10)} ${row.file}:${row.line}  <${row.tag}> ${row.hrefOrHandler}`)
  return [
    `Proposed conversions (${proposal.rows.length}) — data-analytics-cta-id / location / element:`,
    ...rows,
    ...(proposal.skipped.length > 0 ? [`  (${proposal.skipped.length} element${proposal.skipped.length === 1 ? "" : "s"} skipped: already marked, download destination, Stripe host, or no destination)`] : []),
    `Edit ${PROPOSED_CONVERSIONS_RELATIVE_PATH} to rename or drop rows, then re-run with --conversions ${PROPOSED_CONVERSIONS_RELATIVE_PATH}.`
  ].join("\n")
}

/**
 * Marking runs AFTER the install (teardown order), and a marked element can sit in a file the
 * installer manages (index.html, app/layout.tsx). The install manifest records those files'
 * content hashes for `verify`, so after an additive mark the recorded hash is refreshed — the
 * mark itself is recorded (and reversible) in .infinite/conversions.json.
 */
function refreshManagedHashes(ctx: Ctx): void {
  if (!ctx.marking || ctx.marking.marked.length === 0) return
  const manifest = readInstallManifest(ctx.root)
  if (!manifest) return
  const appRoot = ctx.inspect?.appRoot ?? "."
  const touched = new Set(ctx.marking.marked.map((entry) => (appRoot === "." ? entry.file : `${appRoot}/${entry.file}`)))
  const files = manifest.files.filter((file) => touched.has(file))
  if (files.length === 0) return
  writeInstallManifest(ctx.root, {
    ...manifest,
    contentHashes: { ...manifest.contentHashes, ...computeContentHashes(ctx.root, files) }
  })
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

const preflight: RunbookStep<Ctx> = {
  id: "preflight",
  title: "Preflight",
  run(ctx) {
    const version = ctx.deps.nodeVersion ?? process.versions.node
    if (nodeMajor(version) < MINIMUM_NODE_MAJOR) {
      throw new Error(`Node ${version} is too old; infinite-tag needs Node ${MINIMUM_NODE_MAJOR} or newer.`)
    }
    const status = harnessRepoStatus(ctx.root)
    const writes = ctx.args.mode === "apply"
    if (writes && status === "dirty" && !ctx.args.allowDirty) {
      return { note: "dirty" }
    }
    ctx.treeCleanForHarness = status !== "dirty"
    return { note: `git tree ${status}; node ${version}` }
  },
  successCheck(ctx) {
    const step = ctx.report.steps.find((entry) => entry.id === "preflight")
    return step?.note !== "dirty"
  },
  failure: {
    code: "INF_ENV_DIRTY_TREE",
    message: () => "Your working tree has uncommitted changes. Commit or stash them first, or re-run with --allow-dirty.",
    next: "halt"
  }
}

const inspect: RunbookStep<Ctx> = {
  id: "inspect",
  title: "Inspect stack",
  run(ctx) {
    ctx.inspect = inspectWorkspace(ctx.root, { appRoot: ctx.args.appRoot, packageManager: ctx.args.packageManager })
    ctx.appRootAbsolute = ctx.inspect.appRoot === "." ? ctx.root : join(ctx.root, ctx.inspect.appRoot)
    ctx.report.framework = ctx.inspect.framework
    ctx.report.appRoot = ctx.inspect.appRoot
    ctx.report.hosting = detectHosting(ctx.appRootAbsolute)
    ctx.detected = detectProvidersWithEvidence(ctx.appRootAbsolute)
    ctx.manifest = readInstallManifest(ctx.root)
    return {
      note: `${ctx.inspect.framework} at ${ctx.inspect.appRoot}; existing: ${ctx.detected.length === 0 ? "none" : ctx.detected.map((entry) => `${entry.provider}${entry.via === "gtm" ? "(gtm)" : ""} in ${entry.file}:${entry.line}`).join(", ")}`
    }
  },
  successCheck(ctx) {
    return ctx.inspect !== undefined && isSupportedFramework(ctx.inspect.framework)
  },
  failure: {
    code: "INF_DETECT_NO_FRAMEWORK",
    message: () => "Could not identify a web app in this repo. Run with --root pointing at the app, or use --brief to get an agent brief instead.",
    next: "halt"
  }
}

const resolveKeys: RunbookStep<Ctx> = {
  id: "resolve-keys",
  title: "Resolve keys",
  run(ctx) {
    const explicit = hasExplicitArtifacts(ctx.args)
    let flags = flagArtifacts(ctx.root, ctx.args)
    let discovered: WorkspaceInstallArtifacts | null = null
    if (!explicit) {
      const found = (ctx.deps.discover ?? discoverWorkspaceArtifacts)({
        workspaceId: ctx.args.workspaceId,
        warn: (message) => ctx.io.err(message)
      })
      if (found) {
        discovered = found.artifacts
        if (ctx.args.workspaceId === undefined && found.workspaceId) ctx.args.workspaceId = found.workspaceId
        ctx.io.err(`Discovered saved public artifacts: ${found.filePath} (providers: ${found.providers.join(", ")})`)
      }
    }
    flags = applyInfiniteDownloadDestinationPath(flags, { path: ctx.args.infiniteDownloadDestinationPath })
    const env = readEnvKeys(ctx.root, ctx.inspect?.appRoot ?? ".")
    ctx.keys = resolveHarnessKeys({ flags, explicitFlags: explicit, discovered, env, detected: ctx.detected })
    if (discovered && ctx.args.infiniteDownloadDestinationPath) {
      ctx.keys.artifacts = applyInfiniteDownloadDestinationPath(ctx.keys.artifacts, { path: ctx.args.infiniteDownloadDestinationPath })
    }
    const named = Object.entries(ctx.keys.sources).map(([provider, source]) => `${provider} (${source})`)
    return { note: named.length === 0 ? "no keys resolved" : named.join(", ") }
  },
  successCheck(ctx) {
    // Only an EXPLICIT request for PostHog with no key is a failure (non-fatal); everything else
    // without a key is simply skipped and says so in the table.
    const requested = ctx.args.providers?.includes("posthog") ?? false
    const hasKey = Boolean(ctx.keys?.artifacts.posthog?.projectKey)
    const exists = ctx.detected.some((entry) => entry.provider === "posthog")
    return !(requested && !hasKey && !exists)
  },
  failure: {
    code: "INF_POSTHOG_NO_KEY",
    message: () => "PostHog: no project key. Paste one with --posthog-project-key, or re-run with --providers listing only the providers you have keys for.",
    next: "continue"
  }
}

const classify: RunbookStep<Ctx> = {
  id: "classify",
  title: "Classify providers",
  run(ctx) {
    ctx.classifications = classifyProviders({
      manifest: ctx.manifest,
      detected: ctx.detected,
      keys: ctx.keys ?? { artifacts: {}, sources: {} },
      adoptExisting: ctx.args.adoptExisting,
      serverLane: ctx.args.serverLane,
      requested: ctx.args.providers
    })
    for (const entry of ctx.classifications) {
      updateProvider(ctx.report, entry.provider, (state) => {
        const evidence = entry.file ? `${entry.file}` : undefined
        switch (entry.action) {
          case "adopt":
          case "manual":
            return { ...transitionProvider(state, { to: "adopted", reason: entry.reason, key: keyFor(entry), evidence }), verification: { kind: "adopted_not_ours" } }
          case "report":
            return transitionProvider(state, { to: "conflict", reason: entry.reason, key: keyFor(entry), evidence })
          case "skip":
            // A provider infinite-tag already installed (manifest-backed) is installed, not absent,
            // even when this run has no key to re-plan it with.
            return entry.file === ".infinite/install.json"
              ? transitionProvider(state, { to: "installed", reason: entry.reason, evidence: entry.file })
              : transitionProvider(state, { to: "skipped", reason: entry.reason })
          case "install":
            return { ...state, reason: entry.reason, ...(entry.key ? { key: entry.key } : {}) }
          case "upgrade":
            return transitionProvider(state, { to: "installed", reason: entry.reason, key: entry.key, evidence: ".infinite/install.json" })
        }
      })
    }
    return { note: ctx.classifications.map((entry) => `${entry.provider}:${entry.action}`).join(" ") }
  },
  successCheck: () => true,
  failure: { code: "INF_PLAN_BLOCKED", message: () => "classification failed", next: "halt" }
}

const plan: RunbookStep<Ctx> = {
  id: "plan",
  title: "Plan",
  run(ctx) {
    if (!ctx.inspect || !ctx.keys) throw new Error("inspect did not run")
    ctx.planResult = buildHarnessPlan({
      root: ctx.root,
      inspect: ctx.inspect,
      classifications: ctx.classifications,
      keys: ctx.keys,
      workspaceId: ctx.args.workspaceId,
      serverLane: ctx.args.serverLane
    })
    if (ctx.args.brief) {
      writeJson(ctx.root, HARNESS_BRIEF_RELATIVE_PATH, {
        version: 1,
        generatedAt: new Date(ctx.deps.now?.() ?? Date.now()).toISOString(),
        mode: ctx.args.mode,
        framework: ctx.inspect.framework,
        appRoot: ctx.inspect.appRoot,
        providers: ctx.classifications,
        plan: {
          files: ctx.planResult.plan.files,
          envKeys: ctx.planResult.plan.envKeys,
          instructions: ctx.planResult.plan.instructions,
          assumptions: ctx.planResult.plan.assumptions,
          blockers: ctx.planResult.plan.blockers
        },
        handoff: ctx.report.handoff
      })
    }
    const p = ctx.planResult.plan
    return {
      note: ctx.planResult.nothingToInstall
        ? "nothing to install"
        : `${p.providers.length} provider${p.providers.length === 1 ? "" : "s"} → ${p.files.length} file${p.files.length === 1 ? "" : "s"}${p.serverLane ? " + server lane" : ""}`
    }
  },
  successCheck(ctx) {
    if (!ctx.planResult || ctx.planResult.failure) return false
    if (ctx.args.mode === "apply" && !ctx.planResult.nothingToInstall && !ctx.args.workspaceId) {
      ctx.planResult.failure = {
        code: "INF_PLAN_BLOCKED",
        message: "apply requires --workspace <workspace-id> (or a saved artifacts file that names one)."
      }
      return false
    }
    return true
  },
  failure: {
    code: "INF_PLAN_UNMANAGED_TARGET",
    message: (ctx) => ctx.planResult?.failure?.message ?? "plan failed",
    next: "halt"
  }
}

const confirm: RunbookStep<Ctx> = {
  id: "confirm",
  title: "Confirm install",
  async run(ctx) {
    if (ctx.args.mode !== "apply") return { skipped: `${ctx.args.mode} mode writes no install` }
    if (ctx.args.brief) return { skipped: "--brief" }
    if (!ctx.planResult || ctx.planResult.nothingToInstall) return { skipped: "nothing to install" }
    narrate(ctx, renderPreview(ctx.planResult.plan))
    if (ctx.args.yes) return { note: "approved with --yes" }
    if (!ctx.io.interactive) {
      ctx.declined = true
      narrate(ctx, "This was a preview — nothing changed. To apply:  npx infinite-tag harness --yes")
      return { note: "non-interactive without --yes; nothing written" }
    }
    const approved = await ctx.io.confirm("Apply these changes? [Y/n] ", true)
    if (!approved) {
      ctx.declined = true
      narrate(ctx, "No changes made.")
      return { note: "declined; nothing written" }
    }
    return { note: "approved" }
  },
  successCheck: () => true,
  failure: { code: "INF_PLAN_BLOCKED", message: () => "confirmation failed", next: "halt" }
}

const apply: RunbookStep<Ctx> = {
  id: "apply",
  title: "Apply",
  run(ctx) {
    if (ctx.args.mode !== "apply") return { skipped: `${ctx.args.mode} mode` }
    if (ctx.args.brief) return { skipped: "--brief" }
    if (ctx.declined) return { skipped: "not approved" }
    if (!ctx.planResult || ctx.planResult.nothingToInstall) return { skipped: "nothing to install" }
    const p = ctx.planResult.plan
    // The installer's own gate reads raw `git status`; preflight already judged the tree with the
    // harness's outputs excluded, so its verdict (or --allow-dirty) is what applies here.
    // applyInstallation restores its own snapshot when it throws; a static-verification failure
    // AFTER a successful write is ours to roll back, so the same pre-image is taken here.
    const snapshot: FileSnapshot[] = snapshotFiles(ctx.root, [
      ...p.files,
      ...(p.serverLane ? [p.serverLane.briefPath] : []),
      installManifestRelativePath
    ])
    ctx.applyResult = applyInstallation({
      root: ctx.root,
      workspaceId: ctx.args.workspaceId as string,
      plan: p,
      allowDirty: ctx.args.allowDirty || ctx.treeCleanForHarness
    })
    ctx.staticVerify = verifyInstallation({ root: ctx.root })
    if (!ctx.staticVerify.buildOk) {
      try {
        restoreSnapshot(ctx.root, snapshot)
        ctx.applyOutcome = "rolled_back"
        ctx.applyResult = undefined
      } catch {
        ctx.applyOutcome = "left_written"
      }
    }
    if (ctx.staticVerify.buildOk) {
      for (const provider of p.providers) {
        const lane = laneOf[provider as HarnessProviderId]
        if (lane) ctx.writtenLanes.push(lane)
        updateProvider(ctx.report, provider as HarnessProviderId, (state) =>
          transitionProvider(state, {
            to: "installed",
            reason: "written this run; hash-verified against .infinite/install.json",
            evidence: p.files.find((file) => !file.endsWith("install.json")) ?? ".infinite/install.json"
          })
        )
      }
    }
    const changed = ctx.applyResult?.changedFiles.length ?? 0
    return { note: ctx.applyOutcome ? `static verification failed; ${ctx.applyOutcome === "rolled_back" ? "rolled back" : "left as written"}` : `${changed} file${changed === 1 ? "" : "s"} changed` }
  },
  successCheck(ctx) {
    return ctx.staticVerify?.buildOk === true
  },
  failure: {
    code: "INF_APPLY_ROLLED_BACK",
    // "rolled back" is claimed only when a rollback actually ran: applyInstallation restores its
    // snapshot when it throws, and the apply step restores its own when static verification fails.
    message: (ctx, error) => {
      const files = ctx.planResult?.plan.files.length ?? 0
      const drift = ctx.staticVerify?.routeChecks.filter((line) => /Missing|drifted|forbidden/.test(line)).join("; ")
      if (error !== undefined || ctx.applyOutcome === "rolled_back") {
        return `Apply failed${error ? ` (${errorText(error)})` : drift ? ` — ${drift}` : ""}; rolled back ${files} file${files === 1 ? "" : "s"}. Nothing was left half-installed.`
      }
      return `Apply wrote ${files} file${files === 1 ? "" : "s"} but static verification failed${drift ? ` — ${drift}` : ""}; the files were left as written (rollback failed) — review \`git diff\`.`
    },
    next: "halt"
  }
}

const conversions: RunbookStep<Ctx> = {
  id: "conversions",
  title: "Mark conversions",
  async run(ctx) {
    if (ctx.args.noMark) return { skipped: "--no-mark" }
    if (ctx.args.mode === "check") return { skipped: "check mode writes nothing" }
    if (ctx.args.mode === "verify-only") return { skipped: "verify-only" }
    if (ctx.args.brief) return { skipped: "--brief" }
    const appRoot = ctx.inspect?.appRoot ?? "."
    const downloadDestinationPath = ctx.keys?.artifacts.infinite?.downloadDestinationPath

    let approved: ApprovedConversions | null = null
    if (ctx.args.conversions) {
      approved = readApprovedConversions(ctx.root, ctx.args.conversions)
      // Only --apply marks. In plan mode the file is validated and counted, and nothing is written.
      if (ctx.args.mode !== "apply") {
        ctx.report.conversions = { proposed: approved.rows.length, marked: 0, skipped: 0, stale: 0 }
        return { note: `${approved.rows.length} approved row${approved.rows.length === 1 ? "" : "s"} validated; nothing marked in ${ctx.args.mode} mode` }
      }
      if (ctx.declined) return { skipped: "install not approved; nothing marked" }
    } else {
      ctx.proposal = proposeConversions({ root: ctx.root, appRoot, downloadDestinationPath })
      writeProposal(ctx.root, ctx.proposal)
      ensureProposedIgnored(ctx.root)
      ctx.report.conversions = { proposed: ctx.proposal.rows.length, marked: 0, skipped: ctx.proposal.skipped.length, stale: 0 }
      if (ctx.args.mode === "plan") {
        return { note: `${ctx.proposal.rows.length} proposed → ${PROPOSED_CONVERSIONS_RELATIVE_PATH} (nothing marked in plan mode)` }
      }
      if (ctx.declined) return { skipped: "install not approved; proposal written only" }
      if (ctx.proposal.rows.length === 0) return { note: "nothing to propose" }
      narrate(ctx, renderProposalTable(ctx.proposal))
      // --yes never approves marking: renaming a company's conversion vocabulary is a data
      // contract change, so it is always an explicit answer (default No).
      const mark = ctx.io.interactive
        ? await ctx.io.confirm(`Mark these ${ctx.proposal.rows.length} elements now? [y/N] `, false)
        : false
      if (!mark) return { note: "proposal written; not marked (approve with --conversions <file>)" }
      approved = { rows: ctx.proposal.rows }
    }

    ctx.marking = applyConversions({ root: ctx.root, appRoot, approved })
    refreshManagedHashes(ctx)
    ctx.report.conversions = {
      proposed: ctx.proposal?.rows.length ?? approved.rows.length,
      marked: ctx.marking.marked.length,
      skipped: (ctx.proposal?.skipped.length ?? 0) + ctx.marking.skipped.length,
      stale: ctx.marking.stale.length
    }
    if (ctx.marking.marked.length > 0) {
      const has = (provider: HarnessProviderId) => ["installed", "adopted"].includes(findProvider(ctx.report, provider).state)
      if (has("ga4")) ctx.report.nextSteps.push("GA4 key events for the marked conversions are designated from the Infinite desktop (the cloud owns them) — not done by this run.")
      if (has("posthog")) ctx.report.nextSteps.push("PostHog actions for the marked conversions need a write key — create them in PostHog; not done by this run.")
    }
    return { note: `${ctx.marking.marked.length} marked, ${ctx.marking.skipped.length} skipped, ${ctx.marking.stale.length} stale` }
  },
  successCheck(ctx) {
    return (ctx.marking?.stale.length ?? 0) === 0
  },
  failure: {
    code: "INF_MARK_STALE_ELEMENT",
    message: (ctx) => ctx.marking?.stale.map((entry) => entry.message).join(" ") ?? "stale element",
    next: "continue"
  }
}

const serverLane: RunbookStep<Ctx> = {
  id: "server-lane",
  title: "Server lane",
  run(ctx) {
    if (!ctx.args.serverLane) return { skipped: "not requested" }
    if (ctx.args.mode !== "apply" || ctx.declined || ctx.args.brief) return { skipped: `${ctx.args.mode === "apply" ? "not applied" : `${ctx.args.mode} mode`}` }
    const lane = ctx.planResult?.plan.serverLane
    const applied = ctx.applyResult?.serverLane
    if (!lane || !applied) return { skipped: "no server lane in the plan" }
    // The plan picked a target by framework + hosting (Next middleware, Vercel root middleware,
    // Netlify edge, Cloudflare Pages, Node module) or fell back to the brief. It is "installed"
    // only when a file the lane manages was actually written or kept this run.
    const target = lane.targetLabel ?? (lane.mode === "next-middleware" ? "Next.js middleware" : lane.mode)
    const why = lane.targetEvidence ? ` (${lane.targetEvidence})` : ""
    const middlewareWritten = lane.mode === "next-middleware" && lane.middleware?.action !== "unpatchable"
    const created = lane.created ?? []
    // "installed" for a lane means a file that RUNS was written: the entry (middleware, edge
    // function, Pages middleware), or the Next middleware. Module-only writes with a manual entry
    // record nothing until the founder mounts them.
    const entryWritten = created.some((entry) => entry.role === "entry" && entry.action !== "manual")
    const moduleWritten = created.some((entry) => entry.role === "module" && entry.action !== "manual")
    const manualEntry = created.find((entry) => entry.role === "entry" && entry.action === "manual")
    const manual = created.filter((entry) => entry.action === "manual")
    if (lane.mode !== "brief" && (middlewareWritten || entryWritten)) {
      ctx.writtenLanes.push("server_lane")
      const evidence = lane.middleware?.path ?? created.find((entry) => entry.role === "entry" && entry.action !== "manual")?.path ?? lane.modulePath
      updateProvider(ctx.report, "server_lane", (state) =>
        transitionProvider(state, {
          to: "installed",
          reason: `${target}${why}; brief ${applied.briefWritten ? "written" : "printed"}${manual.length > 0 ? `; ${manual.length} file${manual.length === 1 ? "" : "s"} left for you (see the brief)` : ""}`,
          evidence
        })
      )
      return { note: `${target}${why}: ${lane.files.join(", ")}; ${lane.briefPath} ${applied.briefWritten ? "written" : "not written"}` }
    }
    if (lane.mode === "node-module" && moduleWritten) {
      // No entry by design: the customer mounts the module. Written, but not counting anything yet.
      updateProvider(ctx.report, "server_lane", (state) =>
        transitionProvider(state, {
          to: "installed",
          reason: `${target}${why}; not mounted yet — add the one-line mount from ${lane.briefPath}; nothing is recorded until then`,
          evidence: created.find((entry) => entry.role === "module")?.path ?? lane.modulePath
        })
      )
      return { note: `${target}: module written, mount is manual (${lane.briefPath})` }
    }
    if (lane.mode !== "brief" && moduleWritten && manualEntry) {
      updateProvider(ctx.report, "server_lane", (state) =>
        transitionProvider(state, {
          to: "skipped",
          reason: `entry manual — ${manualEntry.path} is not ours to edit${manualEntry.reason ? ` (${manualEntry.reason})` : ""}; the module was written but nothing runs until you add the lines from ${lane.briefPath}`,
          evidence: manualEntry.path
        })
      )
      return { note: `${target}: module written, entry ${manualEntry.path} left for you (${lane.briefPath})` }
    }
    const reason = lane.middleware?.reason ?? manual[0]?.reason
    updateProvider(ctx.report, "server_lane", (state) =>
      transitionProvider(state, {
        to: "skipped",
        reason: `brief only — ${lane.mode === "brief" ? "no server this harness can patch here" : `${target} left untouched${reason ? `: ${reason}` : ""}`}; the agent brief ${applied.briefWritten ? `is at ${lane.briefPath}` : "was printed"}`,
        evidence: lane.briefPath
      })
    )
    if (!applied.briefWritten) narrate(ctx, applied.brief)
    return { note: `brief only (${lane.mode}${reason ? `: ${reason}` : ""})` }
  },
  successCheck: () => true,
  failure: { code: "INF_PLAN_BLOCKED", message: () => "server lane failed", next: "continue" }
}

const verify: RunbookStep<Ctx> = {
  id: "verify",
  title: "Verify receipts",
  async run(ctx) {
    if (ctx.args.mode === "check" || ctx.args.mode === "plan") return { skipped: `${ctx.args.mode} mode` }
    if (ctx.args.brief) return { skipped: "--brief" }
    if (ctx.args.mode === "verify-only") {
      const manifest = ctx.manifest
      if (!manifest) return { skipped: "no .infinite/install.json to verify against" }
      for (const provider of manifest.providers) {
        const lane = laneOf[provider as HarnessProviderId]
        if (lane) ctx.writtenLanes.push(lane)
        updateProvider(ctx.report, provider as HarnessProviderId, (state) =>
          state.state === "absent" || state.state === "skipped"
            ? { ...state, state: "installed", reason: "recorded in .infinite/install.json", evidence: ".infinite/install.json" }
            : state
        )
      }
      // Every lane mode a manifest can record (Next, Vercel-any, Netlify, Cloudflare Pages, Node
      // module) is a lane to read back; only "brief" wrote nothing.
      const recordedLane = manifest.serverLane
      if (recordedLane && recordedLane.mode !== "brief") {
        ctx.writtenLanes.push("server_lane")
        // Evidence is the file that RUNS: the middleware, else the created entry (never the
        // lib/ module), else the module for a node-module lane.
        const created = recordedLane.created ?? []
        const entry = created.find((file) => !/(^|\/)lib\//.test(file)) ?? created[0]
        const evidence = recordedLane.middleware ?? entry ?? recordedLane.module ?? ".infinite/install.json"
        updateProvider(ctx.report, "server_lane", (state) => ({ ...state, state: "installed", reason: `recorded in .infinite/install.json (${recordedLane.mode})`, evidence }))
      }
    } else if (ctx.declined) {
      return { skipped: "not applied" }
    }
    const lanes = [...new Set(ctx.writtenLanes)]
    if (lanes.length === 0) return { skipped: "nothing installed by this run to read back" }
    const url = productionUrl(ctx)
    if (!url) return { skipped: "no --url and no production host to load" }

    const backends: VerificationBackend[] = []
    const posthogHost = ctx.keys?.artifacts.posthog?.apiHost || "https://us.i.posthog.com"
    // A founder-supplied Query Read key answers the PostHog lane directly; without one the lane
    // falls through to the cloud (or None) backend and the reason names the missing key.
    if (lanes.includes("posthog") && ctx.args.posthogQueryKey) {
      backends.push(new PosthogQueryBackend({ apiHost: posthogHost, queryKey: ctx.args.posthogQueryKey, fetch: ctx.deps.fetch, now: ctx.deps.now, sleep: ctx.deps.sleep, budgetMs: ctx.deps.budgetMs, pollIntervalMs: ctx.deps.pollIntervalMs }))
    }
    backends.push(...(ctx.deps.backends ?? [new NoneBackend()]))
    ctx.io.err(`Verifying ${lanes.join(", ")} against ${url} — open the site in a browser now so the tags fire; polling up to ${Math.round((ctx.deps.budgetMs ?? 60_000) / 1000)}s.`)
    ctx.verifyResult = await verifyLanes({ url, lanes, backends, fetch: ctx.deps.fetch, now: ctx.deps.now, sleep: ctx.deps.sleep, budgetMs: ctx.deps.budgetMs, pollIntervalMs: ctx.deps.pollIntervalMs, log: (line) => ctx.io.err(line) })
    if (lanes.includes("posthog") && !ctx.args.posthogQueryKey) {
      const answer = ctx.verifyResult.lanes.posthog
      if (answer.state === "not_verifiable" && answer.reason === NONE_BACKEND_REASON) {
        ctx.verifyResult.lanes.posthog = { state: "not_verifiable", reason: "no query key — pass --posthog-query-key, or run infinite analytics from the desktop CLI" }
      }
    }
    for (const lane of lanes) {
      const answer = ctx.verifyResult.lanes[lane]
      const provider = lane as HarnessProviderId
      updateProvider(ctx.report, provider, (state) => {
        if (answer.state === "verified") return transitionProvider(state, { to: "verified", receiptAt: answer.receiptAt })
        if (answer.state === "not_verifiable") return { ...state, verification: { kind: "not_verifiable", reason: answer.reason } }
        return { ...state, verification: { kind: "no_receipt", causes: answer.causes } }
      })
    }
    const summary = lanes.map((lane) => `${lane}=${ctx.verifyResult?.lanes[lane].state}`).join(" ")
    return { note: `${url} (HTTP ${ctx.verifyResult.siteStatus ?? "—"}) ${summary}` }
  },
  successCheck(ctx) {
    if (!ctx.verifyResult) return true
    return !Object.values(ctx.verifyResult.lanes).some((answer) => answer.state === "no_receipt")
  },
  failure: {
    code: "INF_VERIFY_NO_RECEIPT",
    message: (ctx) => {
      const missing = Object.entries(ctx.verifyResult?.lanes ?? {}).filter(([, answer]) => answer.state === "no_receipt")
      const budget = Math.round((ctx.deps.budgetMs ?? 60_000) / 1000)
      const causes = missing[0]?.[1].state === "no_receipt" ? missing[0][1].causes : []
      return `No ${missing.map(([lane]) => lane).join("/")} event arrived within ${budget}s.${causes.length > 0 ? ` Likely: ${causes.join(" · ")}` : ""}`
    },
    next: "continue"
  }
}

const reportStep: RunbookStep<Ctx> = {
  id: "report",
  title: "Report + handoff",
  run(ctx) {
    if (ctx.args.mode === "check") return { note: "check mode: printed only, nothing written" }
    ctx.report.finishedAt = new Date(ctx.deps.now?.() ?? Date.now()).toISOString()
    const absolutePath = join(ctx.root, HARNESS_REPORT_RELATIVE_PATH)
    assertWriteTargetInsideRoot(ctx.root, absolutePath)
    writeFileAtomic(absolutePath, renderReportMarkdown(ctx.report))
    recordHarnessFile(ctx.root, HARNESS_REPORT_RELATIVE_PATH)
    return { note: `${HARNESS_REPORT_RELATIVE_PATH} written` }
  },
  successCheck: () => true,
  failure: { code: "INF_PLAN_BLOCKED", message: () => "report failed", next: "continue" }
}

export const HARNESS_STEPS: ReadonlyArray<RunbookStep<Ctx>> = [
  preflight,
  inspect,
  resolveKeys,
  classify,
  plan,
  confirm,
  apply,
  conversions,
  serverLane,
  verify,
  reportStep
]

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------

export async function runHarness(args: HarnessArgs, io: HarnessIo, deps: HarnessDeps = {}): Promise<HarnessRunResult> {
  const root = resolve(args.root ?? process.cwd())
  const ctx: Ctx = {
    report: createHarnessReport({ mode: args.mode, root, startedAt: new Date(deps.now?.() ?? Date.now()).toISOString() }),
    args: { ...args, xEventTagIds: [...args.xEventTagIds], infiniteProductionHosts: [...args.infiniteProductionHosts] },
    io,
    deps,
    root,
    appRootAbsolute: root,
    detected: [],
    manifest: null,
    classifications: [],
    declined: false,
    treeCleanForHarness: false,
    writtenLanes: []
  }

  const { report } = await runRunbook(HARNESS_STEPS, ctx, {
    now: () => new Date(deps.now?.() ?? Date.now()).toISOString(),
    finalize(finished) {
      if (args.json) {
        io.out(JSON.stringify(finished, null, 2))
        return
      }
      io.out("")
      io.out(`Infinite analytics harness · ${finished.mode} · ${finished.framework ?? "no framework"}${finished.appRoot && finished.appRoot !== "." ? ` (app at ${finished.appRoot})` : ""}`)
      io.out("")
      io.out(renderReportTable(finished))
      if (finished.conversions) {
        const c = finished.conversions
        io.out("")
        io.out(`Conversions: ${c.proposed} proposed · ${c.marked} marked · ${c.skipped} skipped · ${c.stale} stale`)
      }
      for (const failure of finished.failures) {
        io.out("")
        io.out(`${failure.next === "halt" ? "✗" : "!"} ${failure.code} at ${failure.step}: ${failure.message}`)
      }
      if (finished.nextSteps.length > 0) {
        io.out("")
        io.out("Next steps (not done by this run):")
        for (const next of finished.nextSteps) io.out(`  - ${next}`)
      }
      io.out("")
      if (finished.mode !== "check") {
        io.out(`Report: ${HARNESS_REPORT_RELATIVE_PATH}`)
        io.out("")
        io.out("Paste this to your agent:")
        io.out(`  ${finished.handoff}`)
        io.out("")
      }
    }
  })

  await sendReport(report, args, io, deps)

  const exitCode = report.failures.length === 0 ? 0 : 1
  return { exitCode, report }
}

/**
 * After the report step: hand the state table to the sink, print one line either way. Gated on
 * the report step having RUN OK — a run that halted before inspecting (dirty tree, no framework)
 * has seven `absent` rows that were never observed, and sending those would render as a stack
 * the harness did not look at. `--check` writes no report and sends none (it is the ungated,
 * read-only path). With --json the line rides stderr so stdout stays one document.
 */
async function sendReport(report: HarnessReport, args: HarnessArgs, io: HarnessIo, deps: HarnessDeps): Promise<void> {
  const sink = deps.reportSink
  if (!sink || args.mode === "check") return
  const say = (line: string) => (args.json ? io.err(line) : io.out(line))
  if (report.steps.find((step) => step.id === "report")?.status !== "ok") {
    say(reportNotSentLine("the run did not reach the report step"))
    return
  }
  if (!args.workspaceId) {
    say(reportNotSentLine("no workspace id — pass --workspace"))
    return
  }
  const payload = buildHarnessReportPayload(report, {
    engineProjectId: args.workspaceId,
    tagVersion: INSTRUMENT_VERSION,
    repoLabel: basename(report.root)
  })
  let result: Awaited<ReturnType<ReportSink["send"]>>
  try {
    result = await sink.send(payload)
  } catch (error) {
    result = { sent: false, reason: errorText(error) }
  }
  say(result.sent ? REPORT_SENT_LINE : reportNotSentLine(result.reason))
}

/** The .infinite/REPORT.md text of the last run, for the CLI's `--brief` echo and tests. */
export function readHarnessReport(root: string): string | null {
  const absolutePath = join(root, HARNESS_REPORT_RELATIVE_PATH)
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null
}

/** Root-relative display path helper for CLI copy. */
export function displayPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath) || "."
}
