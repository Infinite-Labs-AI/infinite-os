// Step `before` (lane O8) against fakes: the call order, the no-send rules for the production dry load,
// `expect` from the keys verb only, consent-held tools never counted as problems, the preconditions,
// the base resolution, and the hand-off (Before facts file, markers, candidates; no report cell).
import { describe, expect, it } from "vitest"

import {
  context,
  deps,
  fakeBridge,
  FakeBridgeError,
  fakeChecks,
  fakeGit,
  fakeHost,
  fakeInstaller,
  initialState,
  memoryFs,
  assertNoSendOnProduction,
  spyRegistry,
  type CallLog
} from "../../../test/wizard/o8/before-fakes.js"
import { census, hostingResponse, keysResponse, RUN_ID } from "../../../test/wizard/o8/fixtures.js"
import { createJobRegistry } from "../../jobs/registry.js"
import { snapshotFromFiles } from "../../jobs/repo-files.js"
import type { HostingResponse, KeysResponse } from "../contracts/bridge.js"
import type { BuildResult, CheckResult } from "../contracts/jobs.js"
import type { WizardRunState } from "../contracts/state.js"
import { BEFORE_FACTS_PATH, beforeDryLiveRequest, createBeforeStep, jobScanWith, readBeforeFactsFile, type BeforeFactsFile } from "./before.js"

const SITE = {
  "package.json": JSON.stringify({ name: "acme", dependencies: { next: "15.0.0" } }),
  "app/layout.tsx": "export default function L({ children }) {\n  return <html><body>{children}</body></html>\n}\n",
  "app/page.tsx": "<a href='/signup'>Sign up</a>\n",
  "app/pricing/page.tsx": "<h1>Pricing</h1>\n",
  "app/signup/page.tsx": "<form></form>\n",
  "app/login/actions.ts": "'use server'\nexport async function login() {\n  await supabase.auth.signInWithPassword({ email, password })\n}\n",
  "components/user-menu.tsx": "onClick={() => supabase.auth.signOut()}\n",
  // A repo env file: its id must never become an expectation.
  ".env": "NEXT_PUBLIC_GA_ID=G-FROMENV0\nNEXT_PUBLIC_META_PIXEL_ID=9999999999999999\n"
}

interface Setup {
  log: CallLog
  state: WizardRunState
  run: () => ReturnType<ReturnType<typeof createBeforeStep>["run"]>
  bridge: ReturnType<typeof fakeBridge>
  git: ReturnType<typeof fakeGit>
  checks: ReturnType<typeof fakeChecks>
  fs: ReturnType<typeof memoryFs>
  events: ReturnType<typeof context>["events"]
}

function setup(options: {
  keys?: KeysResponse | FakeBridgeError
  hosting?: HostingResponse
  bridgePolls?: NonNullable<Parameters<typeof fakeBridge>[1]>["polls"]
  startErrors?: FakeBridgeError[]
  baselineError?: FakeBridgeError
  hostingEnvError?: FakeBridgeError
  buildLiveTodayColumn?: Parameters<typeof createBeforeStep>[0] extends infer O ? (O extends { buildLiveTodayColumn?: infer B } ? B : never) : never
  git?: Parameters<typeof fakeGit>[1]
  checks?: Parameters<typeof fakeChecks>[1]
  state?: Partial<WizardRunState>
  files?: Record<string, string>
  framework?: string
  fsFiles?: Record<string, string>
  defaultBranch?: string | null
  latestProduction?: Parameters<typeof fakeHost>[2]
  viewerPermission?: string
  allowForking?: boolean
  clockStepMs?: number
  ctx?: Partial<import("../contracts/deps.js").WizardContext>
} = {}): Setup {
  const log: CallLog = []
  const state = initialState(options.state)
  const bridge = fakeBridge(log, { keys: options.keys, hosting: options.hosting, polls: options.bridgePolls, startErrors: options.startErrors, baselineError: options.baselineError, hostingEnvError: options.hostingEnvError })
  const git = fakeGit(log, options.git)
  const checks = fakeChecks(log, options.checks)
  const fs = memoryFs(log, { "/repo/.env": SITE[".env"], ...(options.fsFiles ?? {}) })
  const { ctx, events } = context(state, log, options.ctx ?? {})
  const registry = spyRegistry(log, createJobRegistry({ briefFacts: () => null }))
  const wizardDeps = deps({ bridge: bridge.client, git: git.git, host: fakeHost(log, options.defaultBranch === undefined ? "main" : options.defaultBranch, options.latestProduction ?? null, options.viewerPermission ?? "WRITE", options.allowForking ?? true), checks: checks.checks, installer: fakeInstaller(log, options.framework ? { framework: options.framework } : {}), registry, fs: fs.fs })
  if (options.clockStepMs) {
    let now = Date.parse("2026-10-02T09:05:00.000Z")
    wizardDeps.clock = { now: () => new Date((now += options.clockStepMs!)), sleep: async () => {} }
  }
  const beforeStep = createBeforeStep({
    jobScan: jobScanWith(snapshotFromFiles(options.files ?? SITE)),
    requestId: () => "00000000-0000-4000-8000-0000000000aa",
    ...(options.buildLiveTodayColumn ? { buildLiveTodayColumn: options.buildLiveTodayColumn } : {})
  })
  return { log, state, run: () => beforeStep.run(ctx, wizardDeps), bridge, git, checks, fs, events }
}

const BEFORE_FACTS_PATH_ABS = `/repo/${BEFORE_FACTS_PATH}`

describe("step before: dependency install and the baseline", () => {
  it.each(["yes", "nested"] as const)("never implies dependency installation in %s mode", async (mode) => {
    const options = { ...context(initialState(), []).ctx.options, [mode]: true }
    const s = setup({ ctx: { options, ask: (async () => { throw new Error("must not ask") }) as never }, checks: { baselineBuild: { ok: false, durationMs: 1, failureSignature: ["exit_code:127"] } } })
    expect(await s.run()).toMatchObject({ kind: "failed", message: expect.stringContaining("npm install") })
    expect(s.log.some((line) => line.startsWith("installer.scan"))).toBe(false)
  })

  it.each([
    { error: "sandbox-exec could not apply the profile" },
  ])("records unavailable validation as not measured before work: %j", async (detail) => {
    const s = setup({ checks: { baselineBuild: { ok: false, durationMs: 1, failureSignature: [], ...detail } as BuildResult } })
    expect(await s.run()).toMatchObject({ kind: "ok" })
    expect((await readBeforeFactsFile(s.fs.fs, "/repo", RUN_ID))?.facts.localValidation).toBe("not_measured")
    expect(JSON.stringify(s.events)).toContain("your pull request's own checks will be the judge")
    expect(JSON.stringify(s.events)).not.toContain("already fails on production")
  })

  it("retakes the baseline after the approved dependency install", async () => {
    const s = setup({ ctx: { ask: (async () => true) as never } })
    let count = 0
    s.checks.checks.buildBaseline = async () => ++count === 1
      ? { ok: false, durationMs: 1, failureSignature: ["exit_code:127"], exitCode: 127 } as BuildResult
      : { ok: true, durationMs: 1, failureSignature: [] }
    let installs = 0
    s.checks.checks.installDependencies = async (output) => { installs += 1; output("installed fixture dependencies"); return { ok: true, reason: null } }
    expect(await s.run()).toMatchObject({ kind: "ok" })
    expect(installs).toBe(1)
    expect(count).toBe(2)
    expect((await readBeforeFactsFile(s.fs.fs, "/repo", RUN_ID))?.facts.baselineBuild?.ok).toBe(true)
  })

  it("stops for missing dependencies before scanning or agent jobs when install is declined", async () => {
    const asked: string[] = []
    const s = setup({ checks: { baselineBuild: { ok: false, failureSignature: ["exit_code:127"], durationMs: 250, error: "the site's build script could not run: its executable was not found", skipped: null, packageManager: "npm", exitCode: 127, timedOut: false, sandboxed: true, outputTail: [] } as BuildResult }, ctx: { ask: (async (_kind: string, payload: { question: string }) => { asked.push(payload.question); return false }) as never } })
    expect(await s.run()).toMatchObject({ kind: "failed", code: "INF_WIZ_VALIDATION_FAILED" })
    expect(asked).toEqual([expect.stringContaining("Your site's dependencies are not installed here")])
    expect(s.log).not.toContain("installer.scan")
  })
})

describe("step before: the production dry load sends nothing", () => {
  it("carries no clicks and no fake click id, targets production root + pages, and an SPA navigation", async () => {
    const s = setup()
    await s.run()
    expect(s.bridge.sentTests).toHaveLength(1)
    const sent = s.bridge.sentTests[0]!
    expect(sent.mode).toBe("dry_live")
    expect(sent).not.toHaveProperty("clicks")
    expect(sent).not.toHaveProperty("fakeClickId")
    expect(sent.productionHost).toBe("acme-store.com")
    expect(sent.targets).toEqual([
      { url: "https://acme-store.com/", label: "home" },
      { url: "https://acme-store.com/pricing", label: "pricing" },
      { url: "https://acme-store.com/signup", label: "signup" }
    ])
    expect(sent.spaNavigation).toEqual({ path: "/pricing" })
    expect(sent.consentSeed).toBeNull()
  })

  it("negative: a production dry_live with clicks or a fake click id fails the fake bridge", () => {
    const request = beforeDryLiveRequest({ requestId: "x", runId: RUN_ID, productionHost: "acme-store.com", pages: [], framework: "next-app-router", keys: keysResponse(), expect: {} })
    const { protocolVersion: _v, requestId: _r, ...body } = request
    expect(() => assertNoSendOnProduction(body)).not.toThrow()
    expect(() => assertNoSendOnProduction({ ...body, clicks: [{ selector: "a", label: "a" }] })).toThrow(/clicks or a fake click id/)
    expect(() => assertNoSendOnProduction({ ...body, fakeClickId: true })).toThrow(/clicks or a fake click id/)
  })
})

describe("step before: expect comes from the keys verb only", () => {
  it("expect ids equal the keys response, never a repo .env value", async () => {
    const s = setup()
    await s.run()
    const sent = s.bridge.sentTests[0]!
    expect(sent.expect).toEqual({
      ga4: ["G-FAKE00001", "G-FAKE00002"],
      posthog: { projectKey: "phc_FAKEtestProjectKeyNotReal000", apiHost: "https://us.i.posthog.com" },
      meta: ["1234567890123456"],
      infinite: { siteSourceKey: "site_FAKEacmeStoreSourceKey", collectPath: "/infinite/ledger" }
    })
    expect(JSON.stringify(sent)).not.toContain("G-FROMENV0")
    expect(JSON.stringify(sent)).not.toContain("9999999999999999")
  })
})

describe("step before: consent", () => {
  it("on a consent-required site seeds the test-window grant, and held_by_consent is never a problem", async () => {
    const keys = keysResponse()
    keys.infinite.consentMode = "required"
    const held: CheckResult = { checkId: "dry_live_meta", tier: "T1", state: "undetermined", reason: "held_by_consent", at: "2026-10-02T09:12:00.000Z", runId: RUN_ID }
    const s = setup({ keys, checks: { grades: { meta: held, ga4: { ...held, checkId: "dry_live_ga4" } } } })
    const outcome = await s.run()
    expect(s.bridge.sentTests[0]!.consentSeed).toEqual({ kind: "infinite_runtime_grant", storageKey: "infinite_analytics_consent" })
    expect(outcome).toEqual({ kind: "ok", status: "Before: 9 code and live checks run · 7 pass · 0 problems · 2 unknown" })
    expect(s.events.filter((event) => event.type === "step.sub" && /^!/.test((event.fields as { text: string }).text))).toEqual([])
    expect(s.state.jobs.some((item) => item.trigger.finding.includes("consent"))).toBe(false)
  })
})

describe("step before: preconditions and the branch", () => {
  it("not a git repo → NO_GIT; a dirty tree → DIRTY_TREE (the wizard's own .infinite/ and .gitignore are exempt)", async () => {
    expect(await setup({ git: { isRepo: false } }).run()).toMatchObject({ kind: "failed", code: "INF_WIZ_NO_GIT", next: "halt" })
    const dirty = setup({ git: { dirtyPaths: ["app/page.tsx", ".gitignore"] } })
    expect(await dirty.run()).toMatchObject({ kind: "failed", code: "INF_WIZ_DIRTY_TREE", next: "halt" })
    expect(dirty.log).not.toContain("bridge.hosting")
    expect(await setup({ git: { dirtyPaths: [".infinite/wizard/state.json", ".gitignore"] } }).run()).toMatchObject({ kind: "ok" })
  })
})

describe("step before: the dry load's own failures stay unknown", () => {
  it("a busy test engine is retried, then the load stays unknown; nothing crashes (review P2-6, probe P-I)", async () => {
    const busy = () => new FakeBridgeError(409, "busy", true)
    const once = setup({ startErrors: [busy()] })
    expect(await once.run()).toMatchObject({ kind: "ok", status: "Before: 9 code and live checks run · 9 pass · 0 problems · 0 unknown" })
    expect(once.bridge.sentTests).toHaveLength(1)
    const always = setup({ startErrors: [busy(), busy(), busy(), busy(), busy()] })
    const outcome = await always.run()
    expect(outcome).toMatchObject({ kind: "ok", status: expect.stringContaining("1 unknown") })
    expect(always.log.filter((entry) => entry.startsWith("bridge.test.start"))).toHaveLength(4)
    expect(always.state.jobs.length).toBeGreaterThan(0)
    // Negative: a signed-out app still stops the run.
    expect(await setup({ startErrors: [new FakeBridgeError(409, "signed_out")] }).run()).toMatchObject({ kind: "blocked", code: "INF_WIZ_SIGNED_OUT" })
  })

  it("a failed baseline read leaves the baseline unknown (null) and still seeds (review P2-6, probe P-J)", async () => {
    const s = setup({ baselineError: new FakeBridgeError(502, "cloud_error", true) })
    expect(await s.run()).toMatchObject({ kind: "ok" })
    const file = JSON.parse(s.fs.store.get(`/repo/${BEFORE_FACTS_PATH}`)!.text) as BeforeFactsFile
    expect(file.facts.baseline).toBeNull()
    expect(s.state.jobs.length).toBeGreaterThan(0)
    // Negative: 402 on the baseline still blocks.
    expect(await setup({ baselineError: new FakeBridgeError(402, "subscription_required") }).run()).toMatchObject({ kind: "blocked", code: "INF_WIZ_SUBSCRIPTION_REQUIRED" })
  })

  it("a failed test run is undetermined (test_error), and the step continues", async () => {
    const s = setup({ bridgePolls: [{ protocolVersion: 1, requestId: "r", state: "failed", progress: [], error: { code: "load_failed", message: "the page did not load" } }] })
    const outcome = await s.run()
    expect(outcome).toEqual({ kind: "ok", status: "Before: 6 code and live checks run · 5 pass · 0 problems · 1 unknown" })
    expect(s.log.some((entry) => entry.startsWith("checks.gradeTestRun"))).toBe(false)
    expect(s.log).toContain("bridge.baseline(" + RUN_ID + ")")
  })
})

describe("step before: the live-site address (§3y.1)", () => {
  const unknownHost = () => {
    const keys = keysResponse()
    keys.infinite.productionHosts = []
    keys.infinite.status = "not_provisioned"
    keys.infinite.siteSourceKey = null
    const hosting: HostingResponse = { ...hostingResponse(), provider: "none", vercel: null }
    return { keys, hosting }
  }
  type Asked = Array<{ kind: string; payload: { question: string; options?: Array<{ label: string; value: string }>; default?: string } }>
  const answering = (asked: Asked, answers: unknown[]) =>
    (async (kind: string, payload: Asked[number]["payload"]) => {
      asked.push({ kind, payload })
      return answers.shift()
    }) as never

  it("NEGATIVE (founder ruling 2026-10-03): GitHub's Production deployment is on Vercel, the repo names the alias — the ask still offers no *.vercel.app", async () => {
    const asked: Asked = []
    const s = setup({
      ...unknownHost(),
      fsFiles: { "/repo/public/CNAME": "example-shop-site.vercel.app\n" },
      latestProduction: { sha: "a".repeat(40), createdAt: "2026-10-03T08:20:00Z" },
      ctx: { ask: answering(asked, ["example-shop-site.vercel.app", "example-shop-site.vercel.app"]) }
    })
    const outcome = await s.run()
    expect(outcome.kind).toBe("ok")
    expect(asked[0]!.payload.options!.map((option) => option.label)).toEqual(["Type another address", "It isn't live yet"])
    expect(asked[0]!.payload.default).toBe("__type__")
    // The host ask reads no deployment to derive an alias from.
    expect(s.log).not.toContain("host.latestProductionDeployment")
    // A scripted client that answers the alias anyway is refused, re-asked once with the reason, and refused again.
    expect(asked.map((entry) => entry.kind)).toEqual(["single", "text"])
    expect(asked[1]!.payload.question).toContain("example-shop-site.vercel.app is a Vercel address — add a custom domain in Vercel, then run npx infinite-tag again.")
    expect(s.state.site).toMatchObject({ productionHost: null, source: "answer" })
    expect(s.bridge.sentTests).toEqual([])
  })

  it("--yes never answers it: no ask, no host, no park, nothing saved", async () => {
    const s = setup({ ...unknownHost(), ctx: { options: { json: true, yes: true, answersFile: null, resume: false, noAgent: false, worker: null, reviewer: null, consentMode: null, noProve: false, nested: false } } })
    const outcome = await s.run()
    expect(outcome.kind).toBe("ok")
    expect(s.state.site).toBeUndefined()
    expect(s.bridge.sentTests).toEqual([])
  })
})

describe("step before: the hand-off", () => {
  it("writes the Before facts (0600), the before markers and the candidates; never a report cell", async () => {
    const s = setup({
      checks: {
        census: census([{ tool: "ga4", kind: "gtag_config", id: "G-FAKE00001", file: "app/layout.tsx", line: 2 }])
      }
    })
    await s.run()
    const written = s.fs.store.get(`/repo/${BEFORE_FACTS_PATH}`)!
    expect(written.mode).toBe(0o600)
    const file = JSON.parse(written.text) as BeforeFactsFile
    expect(file.schema).toBe("infinite-tag.before-facts.v1")
    expect(file.runId).toBe(RUN_ID)
    expect(file.productionHost).toBe("acme-store.com")
    expect(file.facts.observedProductionHost).toBe("www.acme-store.com")
    expect(file.facts.dryLive?.markers.infiniteEventIds).toEqual(["evt_FAKE0001"])
    // The ONE hand-off shape lane O7 reads: baseline and baselineBuild INSIDE facts (review P1-1).
    expect(file.facts.baseline?.ga4.pageViews).toEqual({ production: 39, preview: 5, other: 0 })
    expect(file.facts.baselineBuild).toEqual({ ok: true, failureSignature: [], durationMs: 1200 })
    expect(file).not.toHaveProperty("baseline")
    expect(await readBeforeFactsFile(s.fs.fs, "/repo", RUN_ID)).toEqual(file)
    expect(await readBeforeFactsFile(s.fs.fs, "/repo", "another-run")).toBeNull()
    expect(Object.keys(file.facts.keys)).toEqual(["infinite", "ga4", "posthog", "meta", "serverLane"])
    expect(file).not.toHaveProperty("cells")
    expect(s.state.markers.before).toEqual({ infiniteEventIds: ["evt_FAKE0001"], posthogDistinctId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", probePath: null, metaEventIds: [] })
    expect(s.state.report).toEqual({ live_today: null, in_pr: null, proven_live: null })
    expect(s.state.jobs.map((item) => item.id)).toEqual(["preview_guard:ga4", "identify_reset:auth", "conversions_to_tools:signup"])
    expect(s.events.filter((event) => event.type === "check.result")).toHaveLength(9)
    const subs = s.events.filter((event) => event.type === "step.sub").map((event) => (event.fields as { text: string }).text)
    expect(subs).toContain("Branch infinite/tag/2026-10-02-7f3c2a from main")
    expect(subs).toContain("Found GA4 in app/layout.tsx:2")
    expect(subs).toContain("Test load of acme-store.com (nothing sent)…")
  })

  describe("review I2 P1-2: the env-target read sends only §3b names", () => {
    const envId = (envName: string, line = 4) => ({ tool: "ga4" as const, envName, file: "app/layout.tsx", line })
    const envChecks = (s: Setup) => {
      const facts = JSON.parse(s.fs.store.get(BEFORE_FACTS_PATH_ABS)!.text) as BeforeFactsFile
      return facts.envTargetChecks
    }

    it("a server-side name (GA_ID) is never sent, the run goes on, and the check reads it undetermined", async () => {
      const s = setup({ checks: { census: census([], { envSourcedIds: [envId("GA_ID")] }) } })
      expect(await s.run()).toMatchObject({ kind: "ok" })
      // No second hosting read at all: no name was askable.
      expect(s.bridge.hostingCalls).toEqual([undefined])
      const checks = envChecks(s)
      expect(checks).toHaveLength(1)
      expect(checks[0]).toMatchObject({ checkId: "env_targets", state: "undetermined" })
      expect(checks[0]!.reason).toContain("GA_ID is not a public build-time name")
    })
  })
})

