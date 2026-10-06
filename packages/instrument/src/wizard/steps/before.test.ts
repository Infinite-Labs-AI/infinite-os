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
import type { BuildResult, CheckResult } from "../contracts/jobs.js"
import type { WizardRunState } from "../contracts/state.js"
import { BEFORE_FACTS_PATH, beforeDryLiveRequest, buildLiveTodayColumn, createBeforeStep, jobScanWith, readBeforeFactsFile, step as defaultStep, type BeforeFactsFile } from "./before.js"
import { WIZARD_STEPS } from "./index.js"
import { refreshValidationBaseline } from "../local-validation.js"

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
  const wizardDeps = deps({ bridge: bridge.client, git: git.git, host: fakeHost(log, options.defaultBranch === undefined ? "main" : options.defaultBranch, options.latestProduction ?? null, options.viewerPermission ?? "WRITE", options.allowForking ?? true), checks: checks.checks, installer: fakeInstaller(log), registry, fs: fs.fs })
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

const indexOf = (log: CallLog, prefix: string): number => log.findIndex((entry) => entry.startsWith(prefix))

describe("step before: call order", () => {
  it.each(["yes", "nested"] as const)("never implies dependency installation in %s mode", async (mode) => {
    const options = { ...context(initialState(), []).ctx.options, [mode]: true }
    const s = setup({ ctx: { options, ask: (async () => { throw new Error("must not ask") }) as never }, checks: { baselineBuild: { ok: false, durationMs: 1, failureSignature: ["exit_code:127"] } } })
    expect(await s.run()).toMatchObject({ kind: "failed", message: expect.stringContaining("npm ci") })
    expect(s.log.some((line) => line.startsWith("installer.scan"))).toBe(false)
  })

  it("retakes and saves an old-version baseline before resumed work", async () => {
    const s = setup()
    await s.run()
    let reads = 0
    s.checks.checks.buildBaseline = async () => { reads++; return { ok: true, durationMs: 1, failureSignature: [], signatureVersion: 2 } as BuildResult }
    const ctx = context(s.state, s.log).ctx
    const minimal = { fs: s.fs.fs, checks: s.checks.checks } as import("../contracts/deps.js").WizardDeps
    expect(await refreshValidationBaseline(ctx, minimal)).toBeNull()
    expect(reads).toBe(1)
    expect(await refreshValidationBaseline(ctx, minimal)).toBeNull()
    expect(reads).toBe(1)
  })
  it.each([
    { error: "sandbox-exec could not apply the profile" },
    { timedOut: true },
    { failureSignature: ["build: opaque: process failed without a diagnostic"] }
  ])("records unavailable validation as not measured before work: %j", async (detail) => {
    const s = setup({ checks: { baselineBuild: { ok: false, durationMs: 1, failureSignature: [], ...detail } as BuildResult } })
    expect(await s.run()).toMatchObject({ kind: "ok" })
    expect((await readBeforeFactsFile(s.fs.fs, "/repo", RUN_ID))?.facts.localValidation).toBe("not_measured")
    expect(JSON.stringify(s.events)).toContain("your pull request's own checks will be the judge")
    expect(JSON.stringify(s.events)).not.toContain("already fails on production")
  })

  it("stops ambiguous package managers before scanning", async () => {
    const s = setup({ checks: { baselineBuild: { ok: false, failureSignature: [], durationMs: 1, skipped: "ambiguous_lockfiles" } as BuildResult } })
    expect(await s.run()).toMatchObject({ kind: "failed", message: expect.stringContaining("Several lockfiles") })
    expect(s.log.some((line) => line.startsWith("installer.scan"))).toBe(false)
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

  it("branches first, reads keys before the dry load, and seeds candidates last", async () => {
    const s = setup()
    const outcome = await s.run()
    expect(outcome).toEqual({ kind: "ok", status: "Before: 9 code and live checks run · 9 pass · 0 problems · 0 unknown" })
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
    // Push permission is resolved before the branch and all expensive checks.
    const branchAt = indexOf(s.log, "git.createBranch")
    expect(s.log.slice(0, branchAt).filter((entry) => !entry.startsWith("git.isRepo") && !entry.startsWith("git.cleanTree"))).toEqual(["host.repoFacts", "state.save", "bridge.hosting"])
    expect(indexOf(s.log, "bridge.keys")).toBeLessThan(indexOf(s.log, "bridge.test.start"))
    expect(s.git.branches).toEqual([{ base: "main", branch: "infinite/tag/2026-10-02-7f3c2a" }])
    expect(s.state.git).toMatchObject({ base: "main", baseSource: "vercel", branch: "infinite/tag/2026-10-02-7f3c2a" })
  })

  it("the default export is the step the engine runs", () => {
    expect(WIZARD_STEPS.before).toBe(defaultStep)
    expect(defaultStep.requiredCapabilities).toEqual(["tag.hosting.v1", "tag.keys.v1", "tag.test.v2", "tag.baseline.v1"])
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
    expect(outcome).toEqual({ kind: "ok", status: "Before: 9 code and live checks run · 7 pass · 0 problems · 2 unknown" })
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

  it("B12: lane O6's D10 result goes into before.json's checks (the plan's one count); none when O6 returns none", async () => {
    const d10: CheckResult = { checkId: "meta_automatic_events", tier: "T1", state: "info", reason: "meta_automatic_events — 1.5 automatic event(s) per visit, no clicks", at: "2026-10-02T09:12:00.000Z", runId: RUN_ID }
    const s = setup({ checks: { metaAutomaticEvents: d10 } })
    expect(await s.run()).toMatchObject({ kind: "ok" })
    const file = await readBeforeFactsFile(s.fs.fs, "/repo", RUN_ID)
    expect(file?.facts.checks.filter((check) => check.checkId === "meta_automatic_events")).toEqual([d10])
    const none = setup({})
    expect(await none.run()).toMatchObject({ kind: "ok" })
    expect((await readBeforeFactsFile(none.fs.fs, "/repo", RUN_ID))?.facts.checks.some((check) => check.checkId === "meta_automatic_events")).toBe(false)
  })

  it("O8 resume: on another branch with a clean tree, the wizard switches back itself (O4 switchTo)", async () => {
    const git = { base: "main", baseSource: "vercel" as const, branch: "infinite/tag/2026-10-02-7f3c2a", baseSha: "0a".repeat(20), headSha: null }
    const checkedOut = { branch: "main" as string | null }
    const s = setup({ state: { git }, fsFiles: { "/repo/.git/HEAD": "ref: refs/heads/main\n" }, git: { resumeOps: { checkedOut } } })
    expect(await s.run()).toMatchObject({ kind: "ok" })
    expect(s.log).toContain("git.switchTo(infinite/tag/2026-10-02-7f3c2a)")
    expect(checkedOut.branch).toBe("infinite/tag/2026-10-02-7f3c2a")
    expect(s.events.some((event) => JSON.stringify(event).includes("Switched back to branch infinite/tag/2026-10-02-7f3c2a"))).toBe(true)
  })

  it("O8 resume NEGATIVE: a switch git refuses → BRANCH_FAILED with the command to run, before any scan", async () => {
    const git = { base: "main", baseSource: "vercel" as const, branch: "infinite/tag/2026-10-02-7f3c2a", baseSha: "0a".repeat(20), headSha: null }
    const s = setup({ state: { git }, fsFiles: { "/repo/.git/HEAD": "ref: refs/heads/main\n" }, git: { resumeOps: { checkedOut: { branch: "main" }, switchFails: true } } })
    const outcome = await s.run()
    expect(outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_BRANCH_FAILED", next: "halt" })
    expect((outcome as { message: string }).message).toContain("git switch infinite/tag/2026-10-02-7f3c2a")
    expect(s.log.some((entry) => entry.startsWith("installer.scan") || entry.startsWith("bridge.keys"))).toBe(false)
  })

  it("B25: a run rebuilt from its PR marker (no base SHA) re-derives it as merge-base(origin/<base>, HEAD); none → BRANCH_FAILED", async () => {
    const git = { base: "main", baseSource: "default_branch" as const, branch: "infinite/tag/2026-10-02-7f3c2a", baseSha: "", headSha: null }
    const head = { "/repo/.git/HEAD": "ref: refs/heads/infinite/tag/2026-10-02-7f3c2a\n" }
    const checkedOut = { branch: "infinite/tag/2026-10-02-7f3c2a" as string | null }
    const s = setup({ state: { git }, fsFiles: head, git: { resumeOps: { checkedOut, remoteBase: "1b".repeat(20), mergeBase: "2c".repeat(20) } } })
    expect(await s.run()).toMatchObject({ kind: "ok" })
    expect(s.state.git).toMatchObject({ branch: "infinite/tag/2026-10-02-7f3c2a", baseSha: "2c".repeat(20) })
    expect(s.log).toContain(`git.mergeBase(${"1b".repeat(20)},HEAD)`)
    const none = setup({ state: { git }, fsFiles: head, git: { resumeOps: { checkedOut, remoteBase: "1b".repeat(20), mergeBase: null } } })
    expect(await none.run()).toMatchObject({ kind: "failed", code: "INF_WIZ_BRANCH_FAILED" })
  })

  it("a signed-out GitHub CLI uses origin/HEAD and continues when access cannot be checked early", async () => {
    const none: HostingResponse = { protocolVersion: 1, requestId: "r", provider: "none", vercel: null }
    const s = setup({ hosting: none, defaultBranch: "THROW", fsFiles: { "/repo/.git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/trunk\n" } })
    expect(await s.run()).toMatchObject({ kind: "ok" })
    expect(s.state.git).toMatchObject({ base: "trunk", baseSource: "origin_head" })
    expect(s.events.some((event) => JSON.stringify(event).includes("could not be checked early"))).toBe(true)
  })

  it("TRIAGE with forking disabled stops before branching or building", async () => {
    const s = setup({ viewerPermission: "TRIAGE", allowForking: false })
    expect(await s.run()).toMatchObject({ kind: "failed", code: "INF_WIZ_PUSH_REFUSED", message: expect.stringContaining("does not allow forks") })
    expect(s.git.branches).toEqual([])
    expect(s.log).not.toContain("bridge.baseline")
  })

  it("402 from the keys verb → blocked SUBSCRIPTION_REQUIRED (exit 4)", async () => {
    const s = setup({ keys: new FakeBridgeError(402, "subscription_required") })
    expect(await s.run()).toMatchObject({ kind: "blocked", code: "INF_WIZ_SUBSCRIPTION_REQUIRED" })
    expect(s.bridge.sentTests).toEqual([])
  })

  it("a cloud failure on a read it cannot do without parks INFINITE_UNAVAILABLE (§3z.4), never 'open the app'", async () => {
    const s = setup({ keys: new FakeBridgeError(502, "cloud_error", true) })
    expect(await s.run()).toMatchObject({ kind: "parked", code: "INF_WIZ_INFINITE_UNAVAILABLE" })
  })

  it("negative: a bridge failure the table does not map (a 400) is not swallowed", async () => {
    const s = setup({ keys: new FakeBridgeError(400, "invalid_request") })
    await expect(s.run()).rejects.toThrow(/400 invalid_request/)
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

  it("a test past its deadline is cancelled and stays unknown", async () => {
    const s = setup({ bridgePolls: [{ protocolVersion: 1, requestId: "r", state: "running", progress: [] }], clockStepMs: 60_000 })
    const outcome = await s.run()
    expect(s.log).toContain("bridge.test.cancel")
    expect(outcome).toMatchObject({ kind: "ok", status: expect.stringContaining("1 unknown") })
  })

  it("no production domain (the user says it isn't live yet) → no test load, an unknown check, and no T1 reads", async () => {
    const keys = keysResponse()
    keys.infinite.productionHosts = []
    const hosting = hostingResponse()
    hosting.vercel!.productionDomains = []
    const s = setup({ keys, hosting, ctx: { ask: (async () => "__none__") as never } })
    const outcome = await s.run()
    expect(s.bridge.sentTests).toEqual([])
    expect(s.log.some((entry) => entry.startsWith("checks.liveBytes"))).toBe(false)
    expect(outcome).toMatchObject({ kind: "ok", status: expect.stringContaining("1 unknown") })
    // §3y.1: the answer is saved (a null host), so the same run never asks again.
    expect(s.state.site).toMatchObject({ productionHost: null, source: "answer" })
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

  it("asks ONCE, pre-filled with the repo's hints (a preview-shaped hint dropped), and tests the chosen host", async () => {
    const asked: Asked = []
    const s = setup({
      ...unknownHost(),
      fsFiles: {
        "/repo/public/CNAME": "acme-store-git-main-acme.vercel.app\n",
        "/repo/app/layout.tsx": 'export const metadata = { metadataBase: new URL("https://www.acme-store.com") }\n',
        "/repo/public/robots.txt": "User-agent: *\nSitemap: https://acme-store.com/sitemap.xml\n"
      },
      ctx: { ask: answering(asked, ["www.acme-store.com"]) }
    })
    const outcome = await s.run()
    expect(outcome.kind).toBe("ok")
    expect(asked).toHaveLength(1)
    expect(asked[0]!.kind).toBe("single")
    expect(asked[0]!.payload.question).toBe("Which address is your live site? The wizard tests it without sending anything, and Infinite collects only there.")
    expect(asked[0]!.payload.options!.map((option) => option.value)).toEqual(["www.acme-store.com", "acme-store.com", "__type__", "__none__"])
    expect(asked[0]!.payload.options![0]!.label).toBe("www.acme-store.com  (from app/layout.tsx)")
    expect(asked[0]!.payload.default).toBe("www.acme-store.com")
    expect(s.state.site).toMatchObject({ productionHost: "www.acme-store.com", source: "answer" })
    expect(s.bridge.sentTests.map((test) => test.productionHost)).toEqual(["www.acme-store.com"])
    const subs = s.events.filter((event) => event.type === "step.sub").map((event) => (event.fields as { text: string }).text)
    expect(subs).toContain("✓ Live site: www.acme-store.com (you said)")
  })

  it("a typed address that is not a domain, then a Vercel address, is refused twice and read as 'not live yet'", async () => {
    const asked: Asked = []
    const s = setup({ ...unknownHost(), ctx: { ask: answering(asked, ["__type__", "not a host", "shop-git-main-acme.vercel.app"]) } })
    await s.run()
    expect(asked.map((entry) => entry.kind)).toEqual(["single", "text", "text"])
    expect(asked[0]!.payload.default).toBe("__type__")
    // R2-3: the re-ask carries the refusal's reason (the sub line hides behind the popup).
    expect(asked[2]!.payload.question).toMatch(/^not a host isn't a domain name \(press ESC if it isn't live yet\) /)
    const subs = s.events.filter((event) => event.type === "step.sub").map((event) => (event.fields as { text: string }).text)
    expect(subs).toContain("! not a host isn't a domain name (press ESC if it isn't live yet)")
    expect(subs).toContain("! Infinite needs your site's own domain. shop-git-main-acme.vercel.app is a Vercel address — add a custom domain in Vercel, then run npx infinite-tag again.")
    expect(s.state.site).toMatchObject({ productionHost: null, source: "answer" })
    expect(s.bridge.sentTests).toEqual([])
  })

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

  it("NEGATIVE: a typed production alias, then a hash URL, are both refused; a custom domain is the only way in", async () => {
    const asked: Asked = []
    const s = setup({ ...unknownHost(), ctx: { ask: answering(asked, ["__type__", "example-shop-site.vercel.app", "example-shop-site-mix177n53-example-team.vercel.app"]) } })
    await s.run()
    expect(asked[2]!.payload.question).toContain("example-shop-site.vercel.app is a Vercel address")
    expect(s.state.site).toMatchObject({ productionHost: null })
    const custom: Asked = []
    const t = setup({ ...unknownHost(), ctx: { ask: answering(custom, ["__type__", "vercel.app", "https://www.acme-store.com"]) } })
    await t.run()
    expect(custom[2]!.payload.question).toContain("vercel.app is a Vercel address")
    expect(t.state.site).toMatchObject({ productionHost: "www.acme-store.com" })
    expect(t.bridge.sentTests.map((test) => test.productionHost)).toEqual(["www.acme-store.com"])
  })

  it("--yes never answers it: no ask, no host, no park, nothing saved", async () => {
    const s = setup({ ...unknownHost(), ctx: { options: { json: true, yes: true, answersFile: null, resume: false, noAgent: false, worker: null, reviewer: null, consentMode: null, noProve: false, nested: false } } })
    const outcome = await s.run()
    expect(outcome.kind).toBe("ok")
    expect(s.state.site).toBeUndefined()
    expect(s.bridge.sentTests).toEqual([])
  })

  it("--production-host skips the ask and is recorded as the flag's", async () => {
    const s = setup({ ...unknownHost(), ctx: { options: { json: true, yes: true, answersFile: null, resume: false, noAgent: false, worker: null, reviewer: null, consentMode: null, noProve: false, nested: false, productionHost: "acme-store.com" } } })
    await s.run()
    expect(s.state.site).toMatchObject({ productionHost: "acme-store.com", source: "flag" })
    expect(s.bridge.sentTests.map((test) => test.productionHost)).toEqual(["acme-store.com"])
  })

  it("an earlier answer in this run is reused on a resume (never asked again)", async () => {
    const s = setup({ ...unknownHost(), state: { site: { productionHost: null, source: "answer", decidedAt: "2026-10-02T09:01:00.000Z" } } })
    // The default context's ask throws: reaching it would fail the test.
    expect((await s.run()).kind).toBe("ok")
  })

  it("the sanity line: an answered host whose live page shows none of the repo's own IDs", async () => {
    const asked: Asked = []
    const s = setup({
      ...unknownHost(),
      checks: { census: census([{ tool: "ga4", kind: "gtag_config", id: "G-NOTONPAGE1", file: "app/layout.tsx", line: 2 }]) },
      ctx: { ask: answering(asked, ["__type__", "acme-store.com"]) }
    })
    await s.run()
    const subs = s.events.filter((event) => event.type === "step.sub").map((event) => (event.fields as { text: string }).text)
    expect(subs.some((text) => text.startsWith("! acme-store.com doesn't show the GA4 ID in your code (G-NOTONPAGE1)"))).toBe(true)
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
    const input = inputs[0] as { runId: string; meta: { measuredAt: string; sha: string | null }; facts: Array<{ input: string }>; rows: Record<string, { source: string }> }
    expect(input.runId).toBe(RUN_ID)
    // F17: never the base commit (the branch was cut from 0a1b…, the state holds it), always null.
    expect(s.state.git?.baseSha).toBe("0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d")
    expect(input.meta.sha).toBeNull()
    expect(input.facts.map((fact) => fact.input)).toEqual(expect.arrayContaining(["dry_live.graded", "t1.redirect_walk", "baseline.preview_share", "keys.consent_mode"]))
    expect(s.state.report.live_today).toEqual({ meta: input.meta, cells: {}, finishLine: {} })
    expect(s.state.report.in_pr).toBeNull()
  })

  it("I1: the production builder (O1 buildColumn) turns the readings into a real live_today column", async () => {
    const s = setup({ buildLiveTodayColumn })
    expect(await s.run()).toMatchObject({ kind: "ok" })
    const column = s.state.report.live_today!
    expect(column.meta.sha).toBeNull()
    expect(Object.keys(column.cells).length).toBeGreaterThan(0)
    expect(Object.keys(column.finishLine).length).toBeGreaterThan(0)
    // negative: no builder → no column (the test harness's own default)
    const bare = setup({})
    await bare.run()
    expect(bare.state.report.live_today).toBeNull()
  })

  it("final verify F4: the step's status is the report's own 'Checks passing' cell (one 'before' count, of 14)", async () => {
    const s = setup({ buildLiveTodayColumn })
    const outcome = (await s.run()) as { kind: string; status: string }
    const cell = s.state.report.live_today!.cells.checks_passing!
    expect(outcome.status).toBe(`Before: ${cell.display}`)
    expect(outcome.status).toMatch(/ of 14$/)
    // The same words reach the screen, and they are NOT the raw count of every check result (9 pass · 0 problems).
    const statuses = s.events.filter((event) => event.type === "step.status").map((event) => (event.fields as { text: string }).text)
    expect(statuses.at(-1)).toBe(outcome.status)
    expect(outcome.status).not.toBe("Before: 9 pass · 0 problems · 0 unknown")
  })

  it("terminal QA #17: a real grade ('<code> — <detail>') is worded and counted by its code", async () => {
    const twice: CheckResult = { checkId: "dry_live_ga4", tier: "T1", state: "problem", reason: "duplicate_page_view — 2 page views per visit", at: "2026-10-02T09:12:00.000Z", runId: RUN_ID }
    const s = setup({ buildLiveTodayColumn, checks: { grades: { ga4: twice } } })
    await s.run()
    const subs = s.events.filter((event) => event.type === "step.sub").map((event) => (event.fields as { text: string }).text)
    expect(subs).toContain("! GA4 counts every page twice")
    expect(subs.some((text) => /a problem$/.test(text))).toBe(false)
    // The column reads the same grade as a problem (it read `undetermined` while the whole string was compared).
    expect(s.state.report.live_today!.finishLine.each_tool_once).toMatchObject({ state: "problem" })
    // negative: the bare code (what the old tests fed) still reads the same.
    const bare = setup({ buildLiveTodayColumn, checks: { grades: { ga4: { ...twice, reason: "duplicate_page_view" } } } })
    await bare.run()
    expect(bare.state.report.live_today!.finishLine.each_tool_once).toMatchObject({ state: "problem" })
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

    it("a mixed list asks only the public names, at most 10; the rest stay undetermined", async () => {
      const names = ["GA_ID", "INFINITE_SITE_SOURCE_KEY", "next_public_lower", ...Array.from({ length: 11 }, (_, index) => `NEXT_PUBLIC_ID_${String(index).padStart(2, "0")}`)]
      const s = setup({ checks: { census: census([], { envSourcedIds: names.map((name, index) => envId(name, index + 1)) }) } })
      expect(await s.run()).toMatchObject({ kind: "ok" })
      expect(s.bridge.hostingCalls).toHaveLength(2)
      const asked = s.bridge.hostingCalls[1]!
      expect(asked).toHaveLength(10)
      for (const name of asked) expect(name).toMatch(/^(NEXT_PUBLIC|VITE|PUBLIC)_[A-Z0-9_]{1,64}$/)
      const checks = envChecks(s)
      const byName = (name: string) => checks.find((check) => check.reason?.startsWith(name))
      for (const name of ["GA_ID", "INFINITE_SITE_SOURCE_KEY", "next_public_lower", "NEXT_PUBLIC_ID_10"]) expect(byName(name)?.state, name).toBe("undetermined")
      expect(byName("NEXT_PUBLIC_ID_00")?.state).toBe("pass")
    })

    it("a 4xx on the optional read degrades to undetermined (never a raw rethrow); a hard stop still stops", async () => {
      const ids = { census: census([], { envSourcedIds: [envId("NEXT_PUBLIC_GA_ID")] }) }
      const refused = setup({ checks: ids, hostingEnvError: new FakeBridgeError(400, "invalid_request") })
      expect(await refused.run()).toMatchObject({ kind: "ok" })
      expect(envChecks(refused)[0]).toMatchObject({ state: "undetermined" })
      expect(refused.events.some((event) => event.type === "step.sub" && String((event.fields as { text: string }).text).includes("that check stays unknown"))).toBe(true)
      const unpaid = setup({ checks: ids, hostingEnvError: new FakeBridgeError(402, "subscription_required") })
      expect(await unpaid.run()).toMatchObject({ kind: "blocked", code: "INF_WIZ_SUBSCRIPTION_REQUIRED" })
    })
  })

  it("counts a graded problem as a problem and shows it as a live warning", async () => {
    const blocked: CheckResult = { checkId: "dry_live_meta", tier: "T1", state: "problem", reason: "traffic_permissions_blocked", at: "2026-10-02T09:12:00.000Z", runId: RUN_ID }
    const s = setup({ checks: { grades: { meta: blocked } } })
    expect(await s.run()).toEqual({ kind: "ok", status: "Before: 9 code and live checks run · 8 pass · 1 problem · 0 unknown" })
    const subs = s.events.filter((event) => event.type === "step.sub").map((event) => (event.fields as { text: string; tone: string }))
    expect(subs).toContainEqual({ step: "before", text: "! Meta pixel blocked on www.acme-store.com", tone: "warn" })
    // Never a raw reason code in the live lines (review P3-5).
    expect(subs.some((sub) => sub.text.includes("traffic_permissions_blocked"))).toBe(false)
  })

  it("the dry fixture is the production load (sanity)", () => {
    expect(fixtureDryLive().loads[0]!.label).toBe("home")
  })
})
