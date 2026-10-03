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
import { registerO9Checks } from "../checks/o9.js"
import { createCheckRunner } from "../checks/registry.js"
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
export function o9RunContext(root: string, runId: string | null): { productionHosts?: string[]; expect?: TestExpect } | undefined {
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
  return { productionHosts: [...new Set(hosts)], expect: testExpectFromKeys(keys) }
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
    previewGuard: previewGuardBrief(saved?.guard ?? null)
  }
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
  const gh = createGhClient({ cwd: root, env })
  const remoteUrl = await git.remoteUrl().catch(() => null)
  const host = createGitHostAdapter({ remoteUrl, gh, git })

  const checks = createCheckRunner({ root, appRoot: input.appRoot, runId, platform: platform as NodeJS.Platform, signal: input.signal })
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
      try {
        siteClaim = bridge.has("tag.site-claim.v1")
      } catch {
        siteClaim = false
      }
      return { site: state()?.site ?? null, siteClaim }
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
