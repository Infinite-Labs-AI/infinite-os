// The real wiring (lane I1): `createDefaultWizardDeps` builds every collaborator from the sibling lanes'
// own modules, and `installDefaultWizardWiring` hands them to the command (`setWizardWiring`). Fakes live
// in tests only; nothing here is a stub.
//
//   bridge     O2 `openTagBridge` (discovery on first use; the link step turns "no app" into its outcome)
//   agents     O3 `AgentRunnerImpl` (connection IDs from the keys verb, the bridge token as a secret literal,
//              O9's post-turn gate through O6's CheckRunner)
//   git, host  O4 `createGitOps` + `createGitHostAdapter` (GitHub over `gh`, GitLab/Bitbucket/other)
//   checks     O6 `createCheckRunner` + O9 `registerO9Checks` (live reads through the proxy-aware fetch,
//              the run's production hosts and expectation from `before`'s facts)
//   registry   O8 `createJobRegistry` (brief facts from the run state + the hand-off files; liveSince)
//   installer  O7 `createWizardInstaller` (O5 `productionDeniedConflict`, O6 `build`)
//   report     O1 `createReportBuilder`; `before`'s live_today column is O1 `buildColumn("live_today")`
//   UIs        O2 `createWizardUi` with O3's `sanitizeUntrusted`
//
// Everything that needs the run (its id, plan, guard) reads it through `input.state()` (the engine's
// in-memory state) or the gitignored, run-scoped hand-off files; a missing piece reads as "unknown",
// never a guess.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { connectionIdsFromKeys } from "../agents/connection-ids.js"
import { repoFingerprint } from "../agents/repo-fingerprint.js"
import { AgentRunnerImpl } from "../agents/runner.js"
import { sanitizeUntrusted } from "../agents/sanitize.js"
import { openTagBridge } from "../bridge/client.js"
import { envProxyFetch } from "../checks/live/env-proxy-fetch.js"
import { registerJobStaticChecks, type JobStaticRunContext } from "../checks/job-static.js"
import { readEventInventory } from "../checks/commerce-inventory.js"
import type { EventInventory } from "../scan/event-inventory.js"
import { registerO9Checks, type O9RunContext } from "../checks/o9.js"
import { runCensus } from "../checks/census.js"
import { lexicalStates } from "../lexical-states.js"
import { createCheckRunner } from "../checks/registry.js"
import { baselineTree, sweepBaselineTrees } from "../checks/baseline-tree.js"
import { createGitOps } from "../git/index.js"
import { createGhClient } from "../github/gh.js"
import { buildHostGuardExpression, productionDeniedConflict, type HostGuardSpec } from "../host-guard.js"
import { createGitHostAdapter } from "../hosts/index.js"
import { createWizardInstaller } from "../install/installer.js"
import type { GuardDecision } from "../install/plan-model.js"
import type { SavedPlanApprovals } from "../install/step-inputs.js"
import { briefConnectionsFrom, briefPlanFrom } from "../jobs/plan-data.js"
import { createJobRegistry, newlyInstalledTools } from "../jobs/registry.js"
import { posthogProxyFor } from "../install/keys-adapter.js"
import { INFINITE_API_ORIGIN, infiniteCollectDestination } from "../workspace-artifacts.js"
import type { BeforeFacts } from "./contracts/jobs.js"
import type { BriefFacts } from "../jobs/briefs.js"
import { adoptedMetaGuardRecipe } from "../providers/meta.js"
import { buildScanner } from "../review/context.js"
import { createWizardUi } from "../tui/index.js"
import type { KeyboardInput } from "../tui/keys.js"
import type { JsonInput } from "../tui/json-ui.js"
import type { TtyOutput } from "../tui/tty-ui.js"
import type { TagKeys } from "./contracts/bridge.js"
import type { WizardDeps } from "./contracts/deps.js"
import { normalizeHost } from "./contracts/host-deny.js"
import { WIZARD_PATHS, type WizardRunState } from "./contracts/state.js"
import { testExpectFromKeys, type TestExpect } from "./contracts/test-engine.js"
import { nodeWizardFs, systemClock } from "./fs.js"
import { readInstallManifest } from "../manifest.js"
import { BEFORE_FACTS_SCHEMA, type BeforeFactsFile } from "./handoff/before-facts.js"
import { applyKeysChoices, KEYS_RESULT_SCHEMA, type KeysStepResult } from "./handoff/keys-result.js"
import { createReportBuilder } from "./report.js"
import { getWizardWiring, setWizardWiring, type CreateDepsInput, type WizardIo, type WizardUiLike, type WizardWiring } from "./wiring.js"

/** Test seams for the few things a real run reads from the machine (never used by the published wiring). */
export interface DefaultDepsOverrides {
  /** The live checks' fetch (default: the proxy-aware global fetch). */
  fetch?: typeof fetch
  home?: string
}

function readJsonSync(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** THIS run's `before` facts (sync: the registry's brief and O9's run context are sync), or null. */
export function readBeforeFactsSync(root: string, runId: string | null): BeforeFactsFile | null {
  if (!runId) return null
  const parsed = readJsonSync(join(root, WIZARD_PATHS.beforeFacts))
  if (!isRecord(parsed) || parsed.schema !== BEFORE_FACTS_SCHEMA || parsed.runId !== runId || !isRecord(parsed.facts)) return null
  return parsed as unknown as BeforeFactsFile
}

/**
 * The scan's own event × tool inventory as `before` wrote it (`src/scan/event-inventory.ts` shape), or null when the
 * file holds none (an older run, or no store facts).
 */
export function scanInventoryOf(before: BeforeFactsFile | null): EventInventory | null {
  const value = (before as { eventInventory?: unknown } | null)?.eventInventory
  if (!isRecord(value) || !Array.isArray(value.events) || !Array.isArray(value.checkoutCreates) || !Array.isArray(value.pixelRestrictedRoutes)) return null
  return value as unknown as EventInventory
}

/** THIS run's `keys` step result (its stream / pixel choices), or null. */
export function readKeysResultSync(root: string, runId: string | null): KeysStepResult | null {
  if (!runId) return null
  const parsed = readJsonSync(join(root, WIZARD_PATHS.keys))
  if (!isRecord(parsed) || parsed.schema !== KEYS_RESULT_SCHEMA || parsed.runId !== runId) return null
  return parsed as unknown as KeysStepResult
}

/** The saved plan approvals (the plan, its approvals and the guard the plan decided), or null. */
export function readPlanApprovalsSync(root: string): SavedPlanApprovals | null {
  const parsed = readJsonSync(join(root, WIZARD_PATHS.planApprovals))
  return isRecord(parsed) && parsed.schema === "infinite-tag.plan-approvals.v1" ? (parsed as unknown as SavedPlanApprovals) : null
}

/** The connection's keys, narrowed to this site's choices, from `before`'s facts. */
function runKeys(root: string, runId: string | null): TagKeys | null {
  const before = readBeforeFactsSync(root, runId)
  if (!before) return null
  return applyKeysChoices(before.facts.keys, readKeysResultSync(root, runId))
}

/** O9's run context: the exempt production hosts (§3h.9) and the run's expectation (the connection's ids). */
export function o9RunContext(root: string, runId: string | null): O9RunContext | undefined {
  const before = readBeforeFactsSync(root, runId)
  if (!before) return undefined
  const keys = applyKeysChoices(before.facts.keys, readKeysResultSync(root, runId))
  const vercel = before.facts.hosting.vercel
  const hosts = [
    ...keys.infinite.productionHosts,
    ...(vercel?.productionDomains ?? []),
    ...(vercel?.productionAliases ?? []),
    ...(before.facts.observedProductionHost ? [before.facts.observedProductionHost] : [])
  ]
    .map(normalizeHost)
    .filter((host) => host !== "")
  const saved = readPlanApprovalsSync(root)
  const runState = readJsonSync(join(root, WIZARD_PATHS.state))
  const currentPlan = isRecord(runState) && runState.runId === runId && isRecord(runState.plan) && runState.plan.hash === saved?.planHash && isRecord(runState.steps) && isRecord(runState.steps.before) && runState.steps.before.at === saved?.beforeAt
  const approved = currentPlan ? saved?.guard : null
  const expectedEmittedGuard = approved?.emit ? buildHostGuardExpression({ mode: "deny", exempt: approved.exempt, deny: approved.deny }) : null
  const plan = currentPlan && saved?.plan ? briefPlanFrom(saved.plan, saved.approvals) : null
  return {
    productionHosts: [...new Set(hosts)], expect: testExpectFromKeys(keys), ...(expectedEmittedGuard ? { expectedEmittedGuard } : {}),
    ...(plan ? { conversionNames: plan.conversionNames, posthogSensitivePaths: [...new Set(plan.lines.filter(line => line.kind === "sensitive_pages").flatMap(line => line.sensitivePaths ?? []))] } : {})
  }
}

/**
 * The job-table S checks' run context (review I1 P1-5): O9's hosts and expectation, plus the approved
 * conversion names and privacy paragraph (the saved plan), the tools this run newly installs and the
 * same-origin rewrites the managed install relies on. A piece that cannot be read stays absent (the
 * check that needs it reads undetermined, never a pass).
 */
export function jobStaticRunContext(root: string, runId: string | null): JobStaticRunContext {
  const base = o9RunContext(root, runId) ?? {}
  const before = readBeforeFactsSync(root, runId)
  const saved = readPlanApprovalsSync(root)
  const plan = saved?.plan ? briefPlanFrom(saved.plan, saved.approvals) : null
  const out: JobStaticRunContext = { ...base }
  if (plan) {
    out.conversionNames = plan.conversionNames
    out.privacyText = plan.privacyText
  }
  if (before) {
    const keys = applyKeysChoices(before.facts.keys, readKeysResultSync(root, runId))
    out.newTools = newlyInstalledTools({ ...(before.facts as unknown as BeforeFacts), keys })
    const posthog = keys.posthog.status === "connected" ? posthogProxyFor(keys.posthog) : null
    const infinite = keys.infinite.collectPath ? { path: keys.infinite.collectPath, destination: infiniteCollectDestination(INFINITE_API_ORIGIN) } : null
    out.proxy = { ...(posthog ? { posthog } : {}), ...(infinite ? { infinite } : {}) }
    // Review r3: the scan's event × tool inventory (what the plan promised each tool) and whether Meta gets this site's
    // conversions (connected in Infinite, or the site runs a pixel), for the commerce checks.
    const inventory = readEventInventory((before as unknown as { eventInventory?: unknown }).eventInventory)
    if (inventory) out.eventInventory = inventory
    out.metaInUse = keys.meta.status === "connected" || before.facts.census.entries.some((entry) => entry.tool === "meta")
  }
  return out
}

function routerOf(framework: string): BriefFacts["router"] {
  if (framework === "next-app-router") return "app"
  if (framework === "next-pages-router") return "pages"
  return null
}

/** Job 7's guard data: O5's expression and, for an adopted Meta pixel, the exact wrap (B13). */
export function previewGuardBrief(guard: GuardDecision | null | undefined): BriefFacts["previewGuard"] {
  if (!guard || !guard.emit) return null
  const spec: HostGuardSpec = { mode: "deny", exempt: guard.exempt, deny: guard.deny }
  return { expression: buildHostGuardExpression(spec), exemptHosts: [...guard.exempt], metaRecipe: adoptedMetaGuardRecipe(spec) }
}

/** The brief facts for the registry, from the run state and the hand-off files (null without a run). */
export function briefFactsFor(root: string, state: Readonly<WizardRunState> | null): BriefFacts | null {
  if (!state?.runId) return null
  const before = readBeforeFactsSync(root, state.runId)
  const saved = readPlanApprovalsSync(root)
  const keys = runKeys(root, state.runId)
  const framework = before?.scan.framework ?? "unknown"
  return {
    runId: state.runId,
    framework,
    packageManager: before?.scan.packageManager ?? null,
    router: routerOf(framework),
    appRoot: state.appRoot,
    plan: saved?.plan ? briefPlanFrom(saved.plan, saved.approvals) : null,
    connections: keys ? briefConnectionsFrom(keys) : null,
    previewGuard: previewGuardBrief(saved?.guard ?? null),
    helpers: writtenHelpers(root),
    guardSites: adoptedInitSites(root, state.appRoot),
    consentMode: state.plan?.answers.consentMode ?? null,
    managedFiles: managedModules(root),
    inventory: scanInventoryOf(before)
  }
}

/**
 * R4-6: Infinite's own modules the install wrote whole (they carry the "Managed by Infinite" header), never a customer
 * file the install only edited. Null when no receipt is readable.
 */
export function managedModules(root: string): string[] | null {
  const manifest = readInstallManifest(root)
  if (!manifest) return null
  return manifest.files.filter((file) => {
    try {
      return /Managed by Infinite/.test(readFileSync(join(root, file), "utf8").slice(0, 400))
    } catch {
      return false
    }
  })
}

/** The public id an adopted init names, as written (a literal only; a variable is never resolved here). */
const INIT_ID: Record<"ga4" | "posthog" | "meta", RegExp> = {
  ga4: /\bgtag\s*\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]{4,20})['"]/,
  posthog: /\bposthog\s*\.\s*init\s*\(\s*['"](phc_[A-Za-z0-9]{10,80})['"]/,
  meta: /\bfbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{15,16})['"]/
}

const INIT_CALL: Record<"ga4" | "posthog" | "meta", RegExp> = {
  ga4: /\bgtag\s*\(\s*['"]config['"]/,
  posthog: /\bposthog\s*\.\s*init\s*\(/,
  meta: /\bfbq\s*\(\s*['"]init['"]/
}

/**
 * §3x.3 (§2.3) Where each adopted GA4 / PostHog / Meta init lives in the CURRENT tree, and whether it sits inside a
 * template literal (a Next `<Script>{`…`}</Script>` body): the brief then gives the guard escaped for it.
 */
export function adoptedInitSites(root: string, appRoot: string): NonNullable<BriefFacts["guardSites"]> {
  const out: NonNullable<BriefFacts["guardSites"]> = []
  let census: ReturnType<typeof runCensus>
  try {
    census = runCensus({ root, appRoot })
  } catch (error) {
    // Review P3-3: never "no adopted tags" (the brief would then give no guard as written, and the agent would escape
    // a template literal by hand again): the census failure is the run's, named.
    throw new Error(`the code census could not run (${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}), so the brief cannot say where your existing tags are`)
  }
  for (const entry of census.entries) {
    if (entry.owner !== "adopted" || (entry.tool !== "ga4" && entry.tool !== "posthog" && entry.tool !== "meta")) continue
    let text: string
    try {
      text = readFileSync(join(root, entry.file), "utf8")
    } catch {
      continue
    }
    const lines = text.split("\n")
    const lineText = lines[entry.line - 1] ?? ""
    const column = lineText.search(INIT_CALL[entry.tool])
    if (column < 0) continue
    const offset = lines.slice(0, entry.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + column
    const publicId = INIT_ID[entry.tool].exec(lineText)?.[1]
    out.push({ tool: entry.tool, file: entry.file, line: entry.line, context: lexicalStates(text)[offset] === 2 ? "template_literal" : "js", ...(publicId ? { publicId } : {}) })
  }
  return out
}

/**
 * §3x.3 (B3) The conversion helpers the install really wrote, read from the repo (never assumed from the plan): the
 * managed module that EXPORTS `infiniteTrack`, or the managed page block that defines the globals. Null = none.
 */
export function writtenHelpers(root: string): BriefFacts["helpers"] {
  const manifest = readInstallManifest(root)
  if (!manifest) return null
  for (const file of manifest.files) {
    let text: string
    try {
      text = readFileSync(join(root, file), "utf8")
    } catch {
      continue
    }
    if (/\.[cm]?[jt]sx?$/.test(file) && /export\s+(?:async\s+)?function\s+infiniteTrack\b|export\s+const\s+infiniteTrack\b/.test(text)) return { module: file }
    if (/\.html?$/.test(file) && /window\.infiniteTrack\s*=/.test(text)) return { module: null }
  }
  return null
}

export interface DefaultDepsInput extends CreateDepsInput {
  /** The engine's run state (in memory); null before it exists. */
  state?: () => Readonly<WizardRunState> | null
}

export async function createDefaultWizardDeps(input: DefaultDepsInput, overrides: DefaultDepsOverrides = {}): Promise<WizardDeps> {
  const { root, env, platform, tagVersion, options } = input
  const home = overrides.home ?? env.HOME ?? homedir()
  const state = () => input.state?.() ?? null
  const runId = () => state()?.runId ?? null

  const bridge = openTagBridge({ tagVersion, env, platform, homeDir: home })
  /** The bridge token, when a descriptor is readable (a secret literal no commit or agent edit may carry). */
  const bridgeToken = (): string[] => {
    try {
      return [bridge.descriptor.token]
    } catch {
      return []
    }
  }
  let keysCache: Promise<string[]> | null = null
  const connectionIds = (): Promise<string[]> => {
    if (!keysCache) {
      keysCache = (async () => {
        const fromBefore = runKeys(root, runId())
        if (fromBefore) return connectionIdsFromKeys(fromBefore)
        if (!bridge.has("tag.keys.v1")) return []
        try {
          return connectionIdsFromKeys(await bridge.keys({ signal: input.signal }))
        } catch {
          return []
        }
      })()
      // A failed or empty read is retried on the next turn (the keys may be readable later in the run).
      void keysCache.then((ids) => {
        if (ids.length === 0) keysCache = null
      })
    }
    return keysCache
  }

  const git = createGitOps({ cwd: root, env, runKey: runId() ?? "local-run" })
  if (await git.isRepo()) await sweepBaselineTrees(root, git)
  const gh = createGhClient({ cwd: root, env })
  const remoteUrl = await git.remoteUrl().catch(() => null)
  const host = createGitHostAdapter({ remoteUrl, gh, git })

  const checks = createCheckRunner({ root, appRoot: input.appRoot, runId, platform: platform as NodeJS.Platform, signal: input.signal,
    baselineTree: async () => {
      const sha = state()?.git?.baseSha
      if (!sha) return { root, dispose: async () => {} }
      return baselineTree(root, input.appRoot, sha, git)
    }
  })
  registerO9Checks(checks, {
    root,
    version: tagVersion,
    fetch: overrides.fetch ?? envProxyFetch(env),
    run: () => o9RunContext(root, runId())
  })
  // Review I1 P1-5: the job table's S checks on an agent's edit (jobs 1, 2, 3, 8, 9, 12, 14).
  registerJobStaticChecks(checks, { root, run: () => jobStaticRunContext(root, runId()) })

  const agents = new AgentRunnerImpl({
    root,
    appRoot: input.appRoot,
    home,
    env,
    isTTY: !options.json && !options.nested,
    tagVersion,
    runId,
    checks,
    connectionIds,
    secretLiterals: bridgeToken,
    preferWorker: options.noAgent ? "none" : options.worker,
    worker: () => state()?.agent?.worker ?? null,
    now: () => systemClock.now()
  })

  const registry = createJobRegistry({
    briefFacts: () => briefFactsFor(root, state()),
    scanner: () => {
      const before = readBeforeFactsSync(root, runId())
      const keys = runKeys(root, runId())
      const publicIds = [
        ...(keys ? connectionIdsFromKeys(keys) : []),
        ...(before?.facts.census?.entries ?? []).flatMap(entry => entry.id ? [entry.id] : []),
        ...(before?.facts.dryLive?.ga4?.events ?? []).flatMap(event => event.tid ? [event.tid] : []),
        ...(before?.facts.dryLive?.meta?.tr ?? []).flatMap(event => event.pixelId ? [event.pixelId] : []),
        ...(state()?.proof?.tools ?? []).flatMap(tool => tool.ids)
      ]
      return buildScanner({ root, appRoot: input.appRoot }, { bridge, env, agents }, publicIds)
    },
    // A production reading counts for an item only after the change could be live: the merge.
    liveSince: () => state()?.steps.merge?.at ?? null
  })

  const fingerprint = await repoFingerprint({ remoteUrl, root, appRoot: input.appRoot })
  const installer = createWizardInstaller({
    root,
    repoFingerprint: fingerprint,
    runId,
    agent: () => {
      const agent = state()?.agent
      return agent ? { worker: agent.worker, whoPays: agent.whoPays.worker } : null
    },
    consentFlag: () => options.consentMode,
    productionDeniedConflict,
    build: () => checks.build(),
    // §3y.5: the answered host and a pending claim (the run state), and whether the app offers the claim path.
    runFacts: () => {
      let siteClaim = false
      let metaRelay: boolean | undefined
      try {
        siteClaim = bridge.has("tag.site-claim.v1")
      } catch {
        siteClaim = false
      }
      try {
        // P1-8: Meta counts as connected in Infinite only when the app can send server events to Meta.
        metaRelay = bridge.has("tag.meta-relay.v1")
      } catch {
        metaRelay = undefined
      }
      return { site: state()?.site ?? null, siteClaim, ...(metaRelay === undefined ? {} : { metaRelay }) }
    }
  })

  return {
    bridge,
    agents,
    git,
    host,
    checks,
    registry,
    installer,
    report: createReportBuilder(() => systemClock.now()),
    fs: nodeWizardFs,
    clock: systemClock,
    env,
    platform,
    tagVersion,
    // B29: the merge-ready "open" answer opens the PR, in a darwin terminal run only.
    ...(platform === "darwin" && !options.json && !options.nested ? { openUrl: openInBrowser } : {})
  }
}

/** `open <https URL>` (macOS), detached; never waits, never throws into the run. */
function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve) => {
    if (!/^https:\/\/[^\s]+$/.test(url)) return resolve()
    try {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" })
      child.on("error", () => resolve())
      child.unref()
      resolve()
    } catch {
      resolve()
    }
  })
}

/** The TTY or JSON UI (lane O2) over the process streams, with lane O3's one sanitiser. */
export function createDefaultUi(kind: "tty" | "json", io: WizardIo): WizardUiLike {
  const streams = {
    stdin: io.stdin as unknown as KeyboardInput & JsonInput,
    stdout: io.stdout as unknown as TtyOutput,
    stderr: { write: (text: string) => io.stderr.write(text) }
  }
  return kind === "json"
    ? createWizardUi("json", { ...streams, sanitize: sanitizeUntrusted })
    : createWizardUi("tty", { ...streams, env: io.env, sanitize: sanitizeUntrusted })
}

export function createDefaultWizardWiring(overrides: DefaultDepsOverrides = {}): WizardWiring {
  let created: WizardDeps | null = null
  return {
    createDeps: async (input) => (created = await createDefaultWizardDeps(input, overrides)),
    createUi: (kind, _store, io) => createDefaultUi(kind, io),
    // The SIGINT sequence's restore stage (review I1 P2-5): waits until the open turn's snapshot is back
    // (idempotent after `killAll`; nothing to do when no turn is open).
    fenceAbort: async () => {
      if (created) await created.agents.killAll()
    }
  }
}

/** Installs the real wiring unless a caller (a test) already set one. */
export function installDefaultWizardWiring(): void {
  if (!getWizardWiring()) setWizardWiring(createDefaultWizardWiring())
}
