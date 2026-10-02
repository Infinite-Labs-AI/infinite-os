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
import { census, fixtureDryLive, hostingResponse, keysResponse, RUN_ID } from "../../../test/wizard/o8/fixtures.js"
import { createJobRegistry } from "../../jobs/registry.js"
import { snapshotFromFiles } from "../../jobs/repo-files.js"
import type { HostingResponse, KeysResponse } from "../contracts/bridge.js"
import type { CheckResult } from "../contracts/jobs.js"
import type { WizardRunState } from "../contracts/state.js"
import { BEFORE_FACTS_PATH, beforeDryLiveRequest, createBeforeStep, jobScanWith, readBeforeFactsFile, step as defaultStep, type BeforeFactsFile } from "./before.js"
import { WIZARD_STEPS } from "./index.js"

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
  buildLiveTodayColumn?: Parameters<typeof createBeforeStep>[0] extends infer O ? (O extends { buildLiveTodayColumn?: infer B } ? B : never) : never
  git?: Parameters<typeof fakeGit>[1]
  checks?: Parameters<typeof fakeChecks>[1]
  state?: Partial<WizardRunState>
  files?: Record<string, string>
  fsFiles?: Record<string, string>
  defaultBranch?: string | null
  clockStepMs?: number
} = {}): Setup {
  const log: CallLog = []
  const state = initialState(options.state)
  const bridge = fakeBridge(log, { keys: options.keys, hosting: options.hosting, polls: options.bridgePolls, startErrors: options.startErrors, baselineError: options.baselineError })
  const git = fakeGit(log, options.git)
  const checks = fakeChecks(log, options.checks)
  const fs = memoryFs(log, { "/repo/.env": SITE[".env"], ...(options.fsFiles ?? {}) })
  const { ctx, events } = context(state, log)
  const registry = spyRegistry(log, createJobRegistry({ briefFacts: () => null }))
  const wizardDeps = deps({ bridge: bridge.client, git: git.git, host: fakeHost(log, options.defaultBranch === undefined ? "main" : options.defaultBranch), checks: checks.checks, installer: fakeInstaller(log), registry, fs: fs.fs })
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

const indexOf = (log: CallLog, prefix: string): number => log.findIndex((entry) => entry.startsWith(prefix))

describe("step before: call order", () => {
  it("branches first, reads keys before the dry load, and seeds candidates last", async () => {
    const s = setup()
    const outcome = await s.run()
    expect(outcome).toEqual({ kind: "ok", status: "Before: 9 pass · 0 problems · 0 unknown" })
    const order = [
      "bridge.hosting",
      "git.createBranch",
      "bridge.keys",
      "checks.buildBaseline",
      "installer.scan",
      "checks.census",
      "checks.setupChecks",
      "bridge.test.start(dry_live)",
      "checks.gradeTestRun(dry_live)",
      "checks.liveBytes",
      "checks.redirectWalk",
      "checks.csp",
      "checks.metaDomains",
      "bridge.baseline",
      "fs.write(/repo/.infinite/wizard/before.json)",
      "registry.seedCandidates"
    ].map((prefix) => indexOf(s.log, prefix))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The branch comes before every other verb and every repo read; the only earlier call is the
    // read-only hosting lookup that names the production branch (§3g.1).
    const branchAt = indexOf(s.log, "git.createBranch")
    expect(s.log.slice(0, branchAt).filter((entry) => !entry.startsWith("git.isRepo") && !entry.startsWith("git.cleanTree"))).toEqual(["bridge.hosting"])
    expect(indexOf(s.log, "bridge.keys")).toBeLessThan(indexOf(s.log, "bridge.test.start"))
    expect(s.git.branches).toEqual([{ base: "main", branch: "infinite/tag/2026-10-02-7f3c2a" }])
    expect(s.state.git).toMatchObject({ base: "main", baseSource: "vercel", branch: "infinite/tag/2026-10-02-7f3c2a" })
  })

  it("the default export is the step the engine runs", () => {
    expect(WIZARD_STEPS.before).toBe(defaultStep)
    expect(defaultStep.requiredCapabilities).toEqual(["tag.hosting.v1", "tag.keys.v1", "tag.test.v1", "tag.baseline.v1"])
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

  it("negative: with GA4 and Meta not connected, the .env ids still never become expectations", async () => {
    const keys = keysResponse()
    keys.ga4 = { status: "not_connected", propertyLabel: null, streams: [] }
    keys.meta = { status: "not_connected", pixels: [] }
    const s = setup({ keys })
    await s.run()
    const sent = s.bridge.sentTests[0]!
    expect(sent.expect.ga4).toBeUndefined()
    expect(sent.expect.meta).toBeUndefined()
    expect(JSON.stringify(sent)).not.toMatch(/G-FROMENV0|9999999999999999/)
    // No Meta connection: no Meta domain probe either.
    expect(s.log.some((entry) => entry.startsWith("checks.metaDomains"))).toBe(false)
  })

  it("asks nothing: the keys are read silently (the keys step compares and asks later)", async () => {
    const s = setup()
    await s.run()
    expect(s.events.some((event) => event.type === "ask.open")).toBe(false)
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
    expect(outcome).toEqual({ kind: "ok", status: "Before: 7 pass · 0 problems · 2 unknown" })
    expect(s.events.filter((event) => event.type === "step.sub" && /^!/.test((event.fields as { text: string }).text))).toEqual([])
    expect(s.state.jobs.some((item) => item.trigger.finding.includes("consent"))).toBe(false)
  })

  it("passes the static CMP to the grader when the window saw none", async () => {
    const files = { ...SITE, "components/cookie-banner.tsx": "export function CookieBanner() {}\n", "app/layout.tsx": "<Script src='https://consent.cookiebot.com/uc.js' />\n" }
    const s = setup({ files })
    await s.run()
    expect(s.checks.graded[0]!.ctx).toMatchObject({ cmpDetected: "cookiebot" })
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

  it("a branch failure or a missing run id → BRANCH_FAILED, before any scan", async () => {
    const failed = setup({ git: { createBranchError: new Error("fatal: couldn't find remote ref main") } })
    expect(await failed.run()).toMatchObject({ kind: "failed", code: "INF_WIZ_BRANCH_FAILED", next: "halt" })
    expect(failed.log.some((entry) => entry.startsWith("installer.scan") || entry.startsWith("bridge.keys"))).toBe(false)
    expect(await setup({ state: { runId: null } }).run()).toMatchObject({ kind: "failed", code: "INF_WIZ_BRANCH_FAILED" })
  })

  it("the base: Vercel's production branch, else the default branch, else origin/HEAD (labelled fallback)", async () => {
    const vercel = hostingResponse()
    vercel.vercel!.productionBranch = "production"
    const fromVercel = setup({ hosting: vercel })
    await fromVercel.run()
    expect(fromVercel.state.git).toMatchObject({ base: "production", baseSource: "vercel" })

    const none: HostingResponse = { protocolVersion: 1, requestId: "r", provider: "none", vercel: null }
    const fromGithub = setup({ hosting: none })
    await fromGithub.run()
    expect(fromGithub.state.git).toMatchObject({ base: "main", baseSource: "default_branch" })
    expect(fromGithub.events.some((event) => event.type === "step.sub" && (event.fields as { text: string }).text.includes("(fallback)"))).toBe(true)

    const fromOrigin = setup({ hosting: none, defaultBranch: null, fsFiles: { "/repo/.git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/trunk\n" } })
    await fromOrigin.run()
    expect(fromOrigin.state.git).toMatchObject({ base: "trunk", baseSource: "origin_head" })

    const nowhere = setup({ hosting: none, defaultBranch: null })
    expect(await nowhere.run()).toMatchObject({ kind: "failed", code: "INF_WIZ_BRANCH_FAILED" })
  })

  it("on a resume the existing branch is reused, never re-created", async () => {
    const s = setup({
      state: { git: { base: "main", baseSource: "vercel", branch: "infinite/tag/2026-10-02-7f3c2a", baseSha: "0a".repeat(20), headSha: null } },
      fsFiles: { "/repo/.git/HEAD": "ref: refs/heads/infinite/tag/2026-10-02-7f3c2a\n" }
    })
    expect(await s.run()).toMatchObject({ kind: "ok" })
    expect(s.git.branches).toEqual([])
  })

  it("a resume on another branch stops before any scan (review P2-7)", async () => {
    const git = { base: "main", baseSource: "vercel" as const, branch: "infinite/tag/2026-10-02-7f3c2a", baseSha: "0a".repeat(20), headSha: null }
    const onMain = setup({ state: { git }, fsFiles: { "/repo/.git/HEAD": "ref: refs/heads/main\n" } })
    const outcome = await onMain.run()
    expect(outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_BRANCH_FAILED", next: "halt" })
    expect((outcome as { message: string }).message).toContain("git switch infinite/tag/2026-10-02-7f3c2a")
    expect(onMain.log.some((entry) => entry.startsWith("installer.scan") || entry.startsWith("bridge.keys"))).toBe(false)
    // A worktree: `.git` is a file pointing at the worktree's git dir.
    const worktree = setup({ state: { git }, fsFiles: { "/repo/.git": "gitdir: /main/.git/worktrees/repo\n", "/main/.git/worktrees/repo/HEAD": "ref: refs/heads/infinite/tag/2026-10-02-7f3c2a\n" } })
    expect(await worktree.run()).toMatchObject({ kind: "ok" })
  })

  it("a signed-out GitHub CLI falls back to origin/HEAD instead of stopping (review P3-3)", async () => {
    const none: HostingResponse = { protocolVersion: 1, requestId: "r", provider: "none", vercel: null }
    const s = setup({ hosting: none, defaultBranch: "THROW", fsFiles: { "/repo/.git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/trunk\n" } })
    expect(await s.run()).toMatchObject({ kind: "ok" })
    expect(s.state.git).toMatchObject({ base: "trunk", baseSource: "origin_head" })
  })

  it("402 from the keys verb → blocked SUBSCRIPTION_REQUIRED (exit 4)", async () => {
    const s = setup({ keys: new FakeBridgeError(402, "subscription_required") })
    expect(await s.run()).toEqual({ kind: "blocked", code: "INF_WIZ_SUBSCRIPTION_REQUIRED", reason: "Infinite needs an active subscription for this site" })
    expect(s.bridge.sentTests).toEqual([])
  })

  it("other bridge errors are not swallowed", async () => {
    const s = setup({ keys: new FakeBridgeError(502, "cloud_error", true) })
    await expect(s.run()).rejects.toThrow(/502 cloud_error/)
  })
})

describe("step before: the dry load's own failures stay unknown", () => {
  it("a busy test engine is retried, then the load stays unknown; nothing crashes (review P2-6, probe P-I)", async () => {
    const busy = () => new FakeBridgeError(409, "busy", true)
    const once = setup({ startErrors: [busy()] })
    expect(await once.run()).toMatchObject({ kind: "ok", status: "Before: 9 pass · 0 problems · 0 unknown" })
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
    expect(outcome).toEqual({ kind: "ok", status: "Before: 5 pass · 0 problems · 1 unknown" })
    expect(s.log.some((entry) => entry.startsWith("checks.gradeTestRun"))).toBe(false)
    expect(s.log).toContain("bridge.baseline(" + RUN_ID + ")")
  })

  it("a test past its deadline is cancelled and stays unknown", async () => {
    const s = setup({ bridgePolls: [{ protocolVersion: 1, requestId: "r", state: "running", progress: [] }], clockStepMs: 60_000 })
    const outcome = await s.run()
    expect(s.log).toContain("bridge.test.cancel")
    expect(outcome).toMatchObject({ kind: "ok", status: expect.stringContaining("1 unknown") })
  })

  it("no production domain → no test load, an unknown check, and no T1 reads", async () => {
    const keys = keysResponse()
    keys.infinite.productionHosts = []
    const hosting = hostingResponse()
    hosting.vercel!.productionDomains = []
    const s = setup({ keys, hosting })
    const outcome = await s.run()
    expect(s.bridge.sentTests).toEqual([])
    expect(s.log.some((entry) => entry.startsWith("checks.liveBytes"))).toBe(false)
    expect(outcome).toMatchObject({ kind: "ok", status: expect.stringContaining("1 unknown") })
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

  it("hands the live_today readings to the column builder and keeps its column (review P1-2)", async () => {
    const inputs: unknown[] = []
    const s = setup({
      buildLiveTodayColumn: (input) => {
        inputs.push(input)
        return { meta: input.meta, cells: {}, finishLine: {} }
      }
    })
    await s.run()
    expect(inputs).toHaveLength(1)
    const input = inputs[0] as { runId: string; meta: { measuredAt: string; sha: string }; facts: Array<{ input: string }>; rows: Record<string, { source: string }> }
    expect(input.runId).toBe(RUN_ID)
    expect(input.meta.sha).toBe("0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d")
    expect(input.facts.map((fact) => fact.input)).toEqual(expect.arrayContaining(["dry_live.graded", "t1.redirect_walk", "baseline.preview_share", "keys.consent_mode"]))
    expect(s.state.report.live_today).toEqual({ meta: input.meta, cells: {}, finishLine: {} })
    expect(s.state.report.in_pr).toBeNull()
  })

  it("reads env targets only when the census found env-sourced ids", async () => {
    const s = setup({ checks: { census: census([], { envSourcedIds: [{ tool: "meta", envName: "NEXT_PUBLIC_META_PIXEL_ID", file: "app/layout.tsx", line: 4 }] }) } })
    await s.run()
    expect(s.log).toContain("bridge.hosting(NEXT_PUBLIC_META_PIXEL_ID)")
    expect(s.log).toContain("checks.envTargets")
    const plain = setup()
    await plain.run()
    expect(plain.log.some((entry) => entry.startsWith("checks.envTargets"))).toBe(false)
    expect(plain.bridge.hostingCalls).toEqual([undefined])
  })

  it("counts a graded problem as a problem and shows it as a live warning", async () => {
    const blocked: CheckResult = { checkId: "dry_live_meta", tier: "T1", state: "problem", reason: "traffic_permissions_blocked", at: "2026-10-02T09:12:00.000Z", runId: RUN_ID }
    const s = setup({ checks: { grades: { meta: blocked } } })
    expect(await s.run()).toEqual({ kind: "ok", status: "Before: 8 pass · 1 problem · 0 unknown" })
    const subs = s.events.filter((event) => event.type === "step.sub").map((event) => (event.fields as { text: string; tone: string }))
    expect(subs).toContainEqual({ step: "before", text: "! Meta pixel blocked on www.acme-store.com", tone: "warn" })
    // Never a raw reason code in the live lines (review P3-5).
    expect(subs.some((sub) => sub.text.includes("traffic_permissions_blocked"))).toBe(false)
  })

  it("the dry fixture is the production load (sanity)", () => {
    expect(fixtureDryLive().loads[0]!.label).toBe("home")
  })
})
