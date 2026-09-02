// The harness runbook, composed: teardown §5.2 steps 1–11 over the adapters in inspect.ts,
// marking.ts and verify.ts, driven by runbook.ts. Every I/O seam is injectable so the whole run
// is testable against fixture repos and stubbed backends.
import { existsSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { applyInstallation } from "../apply.js"
import { isSupportedFramework } from "../frameworks/index.js"
import { assertWriteTargetInsideRoot, writeFileAtomic } from "../frameworks/shared.js"
import { detectRepoStatus, inspectWorkspace } from "../inspect.js"
import { computeContentHashes, readInstallManifest, writeInstallManifest } from "../manifest.js"
import { renderPreview } from "../render.js"
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
  declined: boolean
  proposal?: ConversionProposal
  marking?: ApplyConversionsResult
  verifyResult?: VerifyLanesResult
  /** Providers this run wrote (install/upgrade) — the lanes verification reads back. */
  writtenLanes: VerifyLane[]
}

const laneOf: Partial<Record<HarnessProviderId, VerifyLane>> = {
  infinite: "infinite",
  ga4: "ga4",
  posthog: "posthog",
  meta: "meta",
  server_lane: "server_lane"
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
    const status = detectRepoStatus(ctx.root)
    const writes = ctx.args.mode === "apply"
    if (writes && status === "dirty" && !ctx.args.allowDirty) {
      return { note: "dirty" }
    }
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
            return transitionProvider(state, { to: "skipped", reason: entry.reason })
          case "install":
          case "upgrade":
            return { ...state, reason: entry.reason, ...(entry.key ? { key: entry.key } : {}) }
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
    ctx.io.out(renderPreview(ctx.planResult.plan))
    if (ctx.args.yes) return { note: "approved with --yes" }
    if (!ctx.io.interactive) {
      ctx.declined = true
      ctx.io.out("This was a preview — nothing changed. To apply:  npx infinite-tag harness --yes")
      return { note: "non-interactive without --yes; nothing written" }
    }
    const approved = await ctx.io.confirm("Apply these changes? [Y/n] ", true)
    if (!approved) {
      ctx.declined = true
      ctx.io.out("No changes made.")
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
    ctx.applyResult = applyInstallation({
      root: ctx.root,
      workspaceId: ctx.args.workspaceId as string,
      plan: p,
      allowDirty: ctx.args.allowDirty
    })
    ctx.staticVerify = verifyInstallation({ root: ctx.root })
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
    return { note: `${ctx.applyResult.changedFiles.length} file${ctx.applyResult.changedFiles.length === 1 ? "" : "s"} changed` }
  },
  successCheck(ctx) {
    return ctx.staticVerify?.buildOk === true
  },
  failure: {
    code: "INF_APPLY_ROLLED_BACK",
    message: (ctx, error) => {
      const files = ctx.planResult?.plan.files.length ?? 0
      const drift = ctx.staticVerify?.routeChecks.filter((line) => /Missing|drifted|forbidden/.test(line)).join("; ")
      return `Apply failed${error ? ` (${errorText(error)})` : drift ? ` — ${drift}` : ""}; rolled back ${files} file${files === 1 ? "" : "s"}. Nothing was left half-installed.`
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
      ctx.io.out(renderProposalTable(ctx.proposal))
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
    const patched = lane.mode === "next-middleware" && lane.middleware?.action !== "unpatchable"
    if (patched) {
      ctx.writtenLanes.push("server_lane")
      updateProvider(ctx.report, "server_lane", (state) =>
        transitionProvider(state, { to: "installed", reason: `middleware ${lane.middleware?.action ?? "created"}; brief ${applied.briefWritten ? "written" : "printed"}`, evidence: lane.middleware?.path ?? lane.modulePath })
      )
      return { note: `middleware ${lane.middleware?.action}; ${lane.briefPath} ${applied.briefWritten ? "written" : "not written"}` }
    }
    updateProvider(ctx.report, "server_lane", (state) =>
      transitionProvider(state, { to: "skipped", reason: `this stack has no patchable server here; the agent brief ${applied.briefWritten ? `was written to ${lane.briefPath}` : "was printed"}`, evidence: lane.briefPath })
    )
    if (!applied.briefWritten) ctx.io.out(applied.brief)
    return { note: `brief only (${lane.mode}${lane.middleware?.reason ? `: ${lane.middleware.reason}` : ""})` }
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
      if (manifest.serverLane?.mode === "next-middleware") {
        ctx.writtenLanes.push("server_lane")
        updateProvider(ctx.report, "server_lane", (state) => ({ ...state, state: "installed", reason: "recorded in .infinite/install.json", evidence: manifest.serverLane?.middleware }))
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

  const exitCode = report.failures.length === 0 ? 0 : 1
  return { exitCode, report }
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
