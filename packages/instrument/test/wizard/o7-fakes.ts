// Lane O7 test fakes: keys / hosting / before facts, a fixture-site writer, a WizardFs over the real
// disk, an in-memory run state, and fakes for the deps the plan + install steps use. No network, no
// agent, no cloud: everything a test needs is built here from public-shaped fixture values.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { BEFORE_FACTS_SCHEMA, writeBeforeFactsFile } from "../../src/wizard/handoff/before-facts.js"
import { KEYS_RESULT_SCHEMA, writeKeysResult } from "../../src/wizard/handoff/keys-result.js"
import type { WizardBeforeFacts } from "../../src/install/plan-model.js"
import type { AskAnswer, AskKind, AskPayloads } from "../../src/wizard/contracts/asks.js"
import type { TagBridgeClient, TagHosting, TagKeys } from "../../src/wizard/contracts/bridge.js"
import type { RunStateAccessor, WizardContext, WizardDeps, WizardFs, WizardOptions } from "../../src/wizard/contracts/deps.js"
import type { WizardEventFields, WizardEventType } from "../../src/wizard/contracts/events.js"
import { HOST_DENY_V1, normalizeHost } from "../../src/wizard/contracts/host-deny.js"
import type { ChecklistItem, JobRegistry, PlanApprovals, PlanModel } from "../../src/wizard/contracts/jobs.js"
import { JOB_TABLE, type JobId } from "../../src/wizard/contracts/jobs.js"
import { WIZARD_STATE_SCHEMA, type WizardRunState } from "../../src/wizard/contracts/state.js"

/** Fixture public ids (obviously fake shapes; never a real property / project / pixel). */
export const IDS = {
  ga4: "G-TEST000001",
  ga4Other: "G-TEST000002",
  posthog: "phc_testFixtureKey0000000000000000000000000",
  meta: "1234567890123456",
  siteSource: "site_testfixture000000000000",
  run: "11111111-2222-4333-8444-555555555555",
  fingerprint: `sha256:${"ab".repeat(32)}`
} as const

export function fakeKeys(overrides: Partial<TagKeys> = {}): TagKeys {
  return {
    infinite: {
      status: "ready",
      siteSourceKey: IDS.siteSource,
      productionHosts: ["acme-store.com"],
      consentMode: null,
      consentStorageKey: "infinite_analytics_consent",
      collectPath: "/infinite/ledger"
    },
    ga4: { status: "connected", propertyLabel: "Acme", streams: [{ measurementId: IDS.ga4, defaultUri: "https://acme-store.com", streamName: "Web" }] },
    posthog: {
      status: "connected",
      projectKey: IDS.posthog,
      apiHost: "https://us.i.posthog.com",
      ingestHost: "https://us.i.posthog.com",
      uiHost: "https://us.posthog.com",
      region: "us"
    },
    meta: { status: "connected", pixels: [{ pixelId: IDS.meta, sourceRef: "src_1", adAccountLabel: "Acme ads" }] },
    serverLane: { laneState: "no_secret", envWriteGranted: true },
    ...overrides
  }
}

export function notConnectedKeys(): TagKeys {
  return fakeKeys({
    ga4: { status: "not_connected", propertyLabel: null, streams: [] },
    posthog: { status: "not_connected", projectKey: null, apiHost: null, ingestHost: null, uiHost: null, region: null },
    meta: { status: "not_connected", pixels: [] }
  })
}

export function fakeHosting(overrides: Partial<NonNullable<TagHosting["vercel"]>> = {}): TagHosting {
  return {
    provider: "vercel",
    vercel: {
      projectRef: "prj_fixture",
      projectName: "acme-store",
      productionBranch: "main",
      rootDirectory: null,
      framework: null,
      productionDomains: ["acme-store.com"],
      productionAliases: [],
      envWriteGranted: true,
      previewProtection: "none",
      ...overrides
    }
  }
}

export function fakeBefore(overrides: Partial<WizardBeforeFacts> = {}): WizardBeforeFacts {
  return {
    hosting: fakeHosting(),
    keys: fakeKeys(),
    census: { entries: [], envSourcedIds: [], identify: { identifyCalls: [], resetCalls: [] } },
    dryLive: null,
    checks: [],
    observedProductionHost: "acme-store.com",
    ...overrides
  }
}

/** O5's `productionDeniedConflict` semantics (§3h.9, exempt FIRST), for tests only. */
export function fakeProductionDeniedConflict(observed: readonly string[], exempt: readonly string[]): string[] {
  const exemptSet = new Set(exempt.map(normalizeHost))
  return observed
    .map(normalizeHost)
    .filter((host) => !exemptSet.has(host))
    .filter((host) => HOST_DENY_V1.deny.exact.includes(host) || HOST_DENY_V1.deny.suffix.some((suffix) => host.endsWith(suffix)))
}

export function candidate(jobId: JobId, target: string, overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  const spec = JOB_TABLE[jobId]
  return {
    id: `${jobId}:${target}`,
    jobId,
    n: spec.n,
    title: spec.title,
    owner: "agent",
    trigger: { finding: `${spec.title} (${target})`, evidence: [{ file: "index.html", line: 1 }] },
    allow: { files: ["index.html"], create: [] },
    checks: spec.checks.map((check) => ({ id: check.checkId, tier: check.tier, state: "not_run" as const })),
    state: "pending",
    ...overrides
  }
}

// ---- fixture sites ----

const roots: string[] = []

export function makeSite(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "o7-site-"))
  roots.push(root)
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), contents)
  }
  return root
}

export function cleanupSites(): void {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
}

export const read = (root: string, path: string): string => readFileSync(join(root, path), "utf8")
export const exists = (root: string, path: string): boolean => existsSync(join(root, path))

export const STATIC_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Acme</title>
  </head>
  <body>
    <h1>Acme</h1>
  </body>
</html>
`

/** An adopted (customer-owned) Meta pixel in an HTML page, automatic events on by Meta's default. */
export const ADOPTED_META_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Acme</title>
    <script>
      !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
      fbq('init', '${IDS.meta}');
      fbq('track', 'PageView');
    </script>
  </head>
  <body>
    <h1>Acme</h1>
  </body>
</html>
`

/** An adopted PostHog in an HTML page: direct to the region host, no history page views, old defaults. */
export const ADOPTED_POSTHOG_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Acme</title>
    <script>
      posthog.init('${IDS.posthog}', { api_host: 'https://us.i.posthog.com', defaults: '2025-05-24' })
    </script>
  </head>
  <body><h1>Acme</h1></body>
</html>
`

// ---- WizardFs on the real disk ----

export function diskFs(): WizardFs {
  return {
    async readText(path) {
      return existsSync(path) ? readFileSync(path, "utf8") : null
    },
    async writeTextAtomic(path, text, mode) {
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.tmp`
      writeFileSync(temp, text)
      if (mode !== undefined) chmodSync(temp, mode)
      renameSync(temp, path)
    },
    async exists(path) {
      return existsSync(path)
    },
    async mkdirp(path, mode) {
      mkdirSync(path, { recursive: true, ...(mode !== undefined ? { mode } : {}) })
    }
  }
}

// ---- the run state, the context, the deps ----

export function emptyState(root: string, overrides: Partial<WizardRunState> = {}): WizardRunState {
  return {
    schema: WIZARD_STATE_SCHEMA,
    runId: IDS.run,
    displayId: "r-1111",
    createdAt: "2026-10-02T10:00:00.000Z",
    tagVersion: "0.11.0",
    root,
    appRoot: ".",
    link: null,
    steps: { before: { outcome: "ok", inputHash: `sha256:${"0".repeat(64)}`, at: "2026-10-02T10:01:00.000Z" } },
    agent: null,
    git: null,
    pr: null,
    plan: null,
    jobs: [],
    markers: { before: {}, rehearsal: {}, prove: {} },
    report: { live_today: null, in_pr: null, proven_live: null },
    snapshot: null,
    ...overrides
  }
}

export interface RecordedEvent {
  type: WizardEventType
  fields: unknown
}

export interface FakeContext extends WizardContext {
  events: RecordedEvent[]
  asks: Array<{ kind: AskKind; payload: unknown }>
  stateValue(): WizardRunState
}

export function fakeContext(input: {
  root: string
  state?: WizardRunState
  answers?: Array<unknown>
  options?: Partial<WizardOptions>
  runId?: string | null
}): FakeContext {
  let state = input.state ?? emptyState(input.root)
  const answers = [...(input.answers ?? [])]
  const events: RecordedEvent[] = []
  const asks: Array<{ kind: AskKind; payload: unknown }> = []
  const accessor: RunStateAccessor = {
    get: () => state,
    update(mutate) {
      const copy = structuredClone(state)
      mutate(copy)
      state = copy
    },
    async save() {}
  }
  const ask = async <K extends AskKind>(kind: K, payload: AskPayloads[K]): Promise<AskAnswer<K>> => {
    asks.push({ kind, payload })
    if (answers.length === 0) throw new Error(`unexpected ask: ${kind}`)
    return answers.shift() as AskAnswer<K>
  }
  return {
    runId: input.runId === undefined ? IDS.run : input.runId,
    state: accessor,
    emit: {
      emit<T extends WizardEventType>(type: T, fields: WizardEventFields[T]) {
        events.push({ type, fields })
      }
    },
    ask,
    signal: new AbortController().signal,
    options: {
      json: false,
      yes: false,
      answersFile: null,
      resume: false,
      noAgent: false,
      worker: null,
      reviewer: null,
      consentMode: null,
      noProve: false,
      nested: false,
      ...input.options
    },
    root: input.root,
    appRoot: ".",
    now: () => new Date("2026-10-02T10:05:00.000Z"),
    events,
    asks,
    stateValue: () => state
  }
}

/** A deps object whose unexpected members throw (a step reaching for one it should not use fails the test). */
export function fakeDeps(parts: Omit<Partial<WizardDeps>, "bridge"> & { bridge?: Partial<TagBridgeClient> }): WizardDeps {
  const guard = <T extends object>(name: string, value: Partial<T> | undefined): T =>
    new Proxy((value ?? {}) as T, {
      get(target, property) {
        if (property in target) return (target as Record<PropertyKey, unknown>)[property]
        if (property === "then") return undefined
        throw new Error(`unexpected deps.${name}.${String(property)}`)
      }
    })
  return {
    bridge: guard<TagBridgeClient>("bridge", parts.bridge as Partial<TagBridgeClient>),
    agents: guard("agents", parts.agents ?? { isAgentAlive: () => false }),
    git: guard("git", parts.git),
    host: guard("host", parts.host),
    checks: guard("checks", parts.checks),
    registry: guard("registry", parts.registry),
    installer: guard("installer", parts.installer),
    report: guard("report", parts.report),
    fs: parts.fs ?? diskFs(),
    clock: guard("clock", parts.clock),
    env: parts.env ?? {},
    platform: parts.platform ?? "darwin",
    tagVersion: parts.tagVersion ?? "0.11.0"
  } as WizardDeps
}

/**
 * A minimal JobRegistry.applyApprovals with §3e.7's documented behaviour (drop declined lines' items,
 * mark unanswered ones blocked:needs_you). It stands in for O8's registry; the plan step's own gate is
 * what the tests check.
 */
export function fakeRegistry(): JobRegistry {
  return {
    applyApprovals(candidates: readonly ChecklistItem[], plan: PlanModel, approvals: PlanApprovals): ChecklistItem[] {
      const lineOf = new Map<string, string>()
      for (const line of plan.lines) for (const id of line.jobIds ?? []) lineOf.set(id, line.id)
      return candidates.flatMap((item) => {
        const line = lineOf.get(item.id)
        if (!line) return [item]
        if (approvals.declined.includes(line)) return []
        if (!approvals.approved.includes(line)) return [{ ...item, state: "blocked" as const, blockedReason: "needs_you" as const }]
        return [item]
      })
    }
  } as unknown as JobRegistry
}

// ---- the hand-off files other lanes write (O8's before.json, O2's keys.json), in their shapes ----

/** What lane O8's `before` writes to `.infinite/wizard/before.json`, through the ONE hand-off module (B1). */
export async function writeBeforeFacts(fs: WizardFs, root: string, runId: string, facts: WizardBeforeFacts): Promise<void> {
  const { baseline, baselineBuild, ...rest } = facts
  await writeBeforeFactsFile(fs, root, {
    schema: BEFORE_FACTS_SCHEMA,
    runId,
    writtenAt: "2026-10-02T10:01:00.000Z",
    measuredAt: "2026-10-02T10:01:00.000Z",
    productionHost: rest.observedProductionHost,
    scan: { framework: "next-app-router", packageManager: "pnpm", appRoot: ".", fileCount: 12, truncated: false },
    facts: { ...rest, baseline: baseline ?? null, baselineBuild: baselineBuild ?? { ok: true, failureSignature: [], durationMs: 1 } },
    grades: null,
    setupChecks: [],
    envTargetChecks: [],
    liveChecks: [],
    cmpDetected: null,
    loginFound: false,
    spaNavigation: null
  })
}

/** What lane O2's `keys` step writes to `.infinite/wizard/keys.json` (its choices among the connection's ids), via O2's writer. */
export async function writeKeysChoices(
  fs: WizardFs,
  root: string,
  choices: { ga4MeasurementId: string | null; metaPixel: { pixelId: string; sourceRef: string } | null },
  runId: string = IDS.run
): Promise<void> {
  await writeKeysResult(fs, root, {
    schema: KEYS_RESULT_SCHEMA,
    runId,
    at: "2026-10-02T10:02:00.000Z",
    linkId: null,
    keysDigest: `sha256:${"0".repeat(64)}`,
    choices,
    comparisons: [],
    lines: [],
    metaInstall: true
  })
}
