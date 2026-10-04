// The wizard installer against fixture sites on disk (no network, no agent, no cloud). The managed
// bytes are the existing adapters'; what is tested here is the composition: approvals → artifacts,
// the improve edits, the receipt, open jobs, the build rollback, uninstall, scan and app roots.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  ADOPTED_META_HTML,
  candidate,
  cleanupSites,
  exists,
  fakeBefore,
  fakeHosting,
  fakeKeys,
  fakeProductionDeniedConflict,
  IDS,
  makeSite,
  notConnectedKeys,
  read,
  STATIC_HTML
} from "../../test/wizard/o7-fakes.js"
import { createBrowserVm } from "../../test/site-code/browser-vm.js"
import { transpileToCommonJs } from "../../test/site-code/typescript.js"
import { run3File } from "../../test/wizard/run3-fixture.js"
import { parseHarnessArgs } from "../harness/args.js"
import { runHarness, type HarnessIo } from "../harness/run.js"
import { readInstallManifest } from "../manifest.js"
import type { BuildResult, PlanModel } from "../wizard/contracts/jobs.js"

import { makeEditRecord } from "./edits.js"
import { WizardInstaller, type InstallerOptions, type WizardApplyResult } from "./installer.js"
import type { WizardBeforeFacts } from "./plan-model.js"

afterEach(cleanupSites)

function installer(overrides: Partial<InstallerOptions> = {}): WizardInstaller {
  return new WizardInstaller({
    repoFingerprint: IDS.fingerprint,
    runId: () => IDS.run,
    agent: () => ({ worker: "claude_code", whoPays: { payer: "plan", label: "your Claude plan pays" } }),
    consentFlag: () => null,
    productionDeniedConflict: fakeProductionDeniedConflict,
    build: async (): Promise<BuildResult> => ({ ok: true, failureSignature: [], durationMs: 1 }),
    ...overrides
  })
}

/** Approve every approval line, answer consent. */
function approveAll(plan: PlanModel, consentMode: "required" | "not_required" = "not_required") {
  return {
    approved: plan.lines.filter((line) => line.requires === "approval").map((line) => line.id),
    declined: [],
    edits: { consent_mode: consentMode }
  }
}

const VITE_PACKAGE = `{"name":"acme","dependencies":{"react":"18.0.0","vite":"5.0.0"}}\n`

describe("WizardInstaller.apply: a new install on a static site", () => {
  it("installs the approved tools from the connections, records the public ids, and keeps the plan's guard", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    const result = (await subject.apply(plan, approveAll(plan))) as WizardApplyResult
    expect(result).toMatchObject({ ok: true, rolledBack: false, build: "passed", openJobs: [] })
    // I1b: the spec's `deny` holds exact host literals only (the contract's suffixes are built into the
    // emitted expression); a suffix such as ".vercel.app" there made every guard consumer throw.
    expect(result.artifacts.hostGuard).toEqual({ mode: "deny", exempt: ["acme-store.com"], deny: expect.arrayContaining(["localhost", "127.0.0.1"]) })
    expect(result.artifacts.hostGuard!.deny.filter((host) => host.startsWith("."))).toEqual([])
    // ...and the managed bootstraps really carry it (I1b: the harness plan dropped `hostGuard`, so every
    // managed tag fired on previews).
    expect(read(root, "index.html")).toContain('"acme-store.com"')
    expect(read(root, "index.html")).toContain(".vercel.app")
    expect(result.artifacts.infinite).toMatchObject({ consentMode: "not_required", staticProxy: "vercel" })
    const html = read(root, "index.html")
    expect(html).toContain(IDS.ga4)
    expect(html).toContain(IDS.meta)
    const manifest = readInstallManifest(root)!
    expect(manifest.workspaceId).toBe(`wizard:${"ab".repeat(8)}`)
    expect(manifest.ids).toEqual({ ga4: [IDS.ga4], posthog: { projectKey: IDS.posthog, apiHost: "/ingest" }, meta: [IDS.meta], infinite: { siteSourceKey: IDS.siteSource } })
  })

  it("NEGATIVE: a declined install line installs nothing for that tool", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    const answer = approveAll(plan)
    const metaLine = `install_provider:meta:${IDS.meta}`
    const result = (await subject.apply(plan, { ...answer, approved: answer.approved.filter((id) => id !== metaLine), declined: [metaLine] })) as WizardApplyResult
    expect(result.ok).toBe(true)
    expect(read(root, "index.html")).not.toContain(IDS.meta)
    expect(readInstallManifest(root)!.ids?.meta).toEqual([])
  })

  it("NEGATIVE: apply refuses without an answered consent mode (the run parks at plan instead)", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    await expect(subject.apply(plan, { approved: [], declined: [], edits: {} })).rejects.toThrow(/consent/)
    expect(read(root, "index.html")).toBe(STATIC_HTML)
  })
})

describe("requiresManual is an OPEN JOB, never 'installed' (S1 fix, run.ts apply)", () => {
  const VITE_NO_HEAD = `<!doctype html>\n<html>\n<body><div id="root"></div></body>\n</html>\n`

  it("Vite with no </head>: the installer returns the open job and the provider is not reported live", async () => {
    const root = makeSite({ "package.json": VITE_PACKAGE, "index.html": VITE_NO_HEAD, "vercel.json": "{}\n" })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    expect(scan.framework).toBe("vite-react")
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    const result = (await subject.apply(plan, approveAll(plan))) as WizardApplyResult
    expect(result.ok).toBe(true)
    expect(result.openJobs).toEqual(["index.html"])
    expect(read(root, "index.html")).toBe(VITE_NO_HEAD)
  })

  it("NEGATIVE (the old behaviour): the harness no longer marks GA4 'installed' when the tag could not be added", async () => {
    const root = makeSite({ "package.json": VITE_PACKAGE, "index.html": VITE_NO_HEAD, "vercel.json": "{}\n" })
    const io: HarnessIo = { interactive: false, out: () => undefined, err: () => undefined, confirm: async () => false }
    const { report } = await runHarness(
      parseHarnessArgs(["--yes", "--no-mark", "--allow-dirty", "--root", root, "--ga4-measurement-id", IDS.ga4, "--workspace", "ws-local"]),
      io
    )
    const ga4 = report.providers.find((provider) => provider.provider === "ga4")!
    expect(ga4.state).not.toBe("installed")
    expect(ga4.reason).toMatch(/open job/)
    expect(report.nextSteps.some((line) => line.includes("open job") && line.includes("index.html"))).toBe(true)
  })
})

describe("improve in place + the edit receipt + uninstall", () => {
  it("approved code improve lines are applied and recorded; the receipt round-trips; uninstall reverses a managed edit AND an agent edit", async () => {
    const aboutOriginal = STATIC_HTML.replace("<h1>Acme</h1>", "<h1>About</h1>")
    const root = makeSite({ "index.html": ADOPTED_META_HTML, "about.html": aboutOriginal })
    const subject = installer()
    const keys = fakeKeys({ ga4: { status: "not_connected", propertyLabel: null, streams: [] }, posthog: { status: "not_connected", projectKey: null, apiHost: null, ingestHost: null, uiHost: null, region: null } })
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, keys, fakeBefore({ keys }), [])
    const approvals = approveAll(plan)
    const result = (await subject.apply(plan, approvals)) as WizardApplyResult
    expect(result.ok).toBe(true)
    const wizardEdits = result.edits.map((edit) => edit.planLineId)
    expect(wizardEdits).toEqual(["capture_beside_adopted_pixel:meta:capture", "autoconfig_off_adopted:meta:autoconfig"])
    // The adopted pixel is never reinstalled: no install line for Meta, no second init.
    expect(plan.lines.some((line) => line.id.startsWith("install_provider:meta"))).toBe(false)
    expect(read(root, "index.html").match(/fbq\('init'/g)).toHaveLength(1)

    // An agent edit recorded through the installer (O3 hands over exact textEdits).
    const aboutBefore = read(root, "about.html")
    const aboutAfter = aboutBefore.replace("<h1>About</h1>", '<h1>About</h1>\n    <a data-infinite-conversion="sign_up" href="/signup">Sign up</a>')
    writeFileSync(join(root, "about.html"), aboutAfter)
    await subject.recordEdits([makeEditRecord({ file: "about.html", before: aboutBefore, after: aboutAfter, jobId: "conversions_to_tools", planLineId: null, by: "agent", runId: IDS.run })])

    const manifest = readInstallManifest(root)!
    expect(manifest.edits?.map((edit) => [edit.file, edit.by])).toEqual([
      ["index.html", "wizard"],
      ["index.html", "wizard"],
      ["about.html", "agent"]
    ])
    expect(manifest.ids?.meta).toEqual([])

    const report = await subject.uninstall({ root, dryRun: false })
    expect(read(root, "index.html")).toBe(ADOPTED_META_HTML)
    // The agent edit is reversed first, then the managed block comes off: the page is the original.
    expect(read(root, "about.html")).toBe(aboutOriginal)
    expect(report.leftAsIs).toEqual([])
    expect(report.reversed).toEqual(expect.arrayContaining(["index.html", "about.html"]))
  })

  it("NEGATIVE: a recorded file changed since → uninstall warns and leaves it exactly as it is", async () => {
    const root = makeSite({ "index.html": ADOPTED_META_HTML, "about.html": STATIC_HTML })
    const subject = installer()
    const keys = fakeKeys({ ga4: { status: "not_connected", propertyLabel: null, streams: [] }, posthog: { status: "not_connected", projectKey: null, apiHost: null, ingestHost: null, uiHost: null, region: null } })
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, keys, fakeBefore({ keys }), [])
    // Only the improve lines: no managed block, so the file holds nothing but recorded edits.
    const answer = approveAll(plan)
    const onlyImprove = { ...answer, approved: answer.approved.filter((id) => !id.startsWith("install_provider:")) }
    expect((await subject.apply(plan, onlyImprove)).ok).toBe(true)
    const touched = `${read(root, "index.html")}\n<!-- the customer edited this later -->\n`
    writeFileSync(join(root, "index.html"), touched)
    const report = await subject.uninstall({ root, dryRun: false })
    expect(report.leftAsIs).toEqual(["index.html"])
    expect(read(root, "index.html")).toBe(touched)
  })

  it("refreshEditReceiptFromHead rebases a record a commit hook rewrote", async () => {
    const root = makeSite({ "index.html": ADOPTED_META_HTML })
    const blobs = new Map<string, string>()
    const subject = installer({ readBlob: (_root, rev, path) => blobs.get(`${rev}:${path}`) ?? null })
    const keys = fakeKeys({ ga4: { status: "not_connected", propertyLabel: null, streams: [] }, posthog: { status: "not_connected", projectKey: null, apiHost: null, ingestHost: null, uiHost: null, region: null } })
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, keys, fakeBefore({ keys }), [])
    await subject.apply(plan, approveAll(plan))
    const hooked = read(root, "index.html").replace(/\n {4}/g, "\n  ") // a formatter re-indented it on commit
    blobs.set("HEAD:index.html", hooked)
    for (const file of Object.keys(readInstallManifest(root)!.contentHashes)) if (!blobs.has(`HEAD:${file}`)) blobs.set(`HEAD:${file}`, read(root, file))
    expect(await subject.refreshEditReceiptFromHead()).toEqual({ refreshed: true })
    writeFileSync(join(root, "index.html"), hooked)
    await subject.uninstall({ root, dryRun: false })
    expect(read(root, "index.html")).toBe(ADOPTED_META_HTML)
  })
})

describe("the build check", () => {
  it("NEGATIVE: a failure NEW against the baseline rolls back every change", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const subject = installer({ build: async () => ({ ok: false, failureSignature: ["TS2304 in app/page.tsx"], durationMs: 1 }) })
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const before: WizardBeforeFacts = { ...fakeBefore(), baselineBuild: { ok: true, failureSignature: [], durationMs: 1 } }
    const plan = subject.buildPlan(scan, fakeKeys(), before, [])
    const result = (await subject.apply(plan, approveAll(plan))) as WizardApplyResult
    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(result.reason).toMatch(/build failed/)
    expect(read(root, "index.html")).toBe(STATIC_HTML)
    expect(exists(root, ".infinite/install.json")).toBe(false)
    expect(exists(root, "vercel.json")).toBe(false)
  })

  it("a build that was already red with the same failures is reported, not blamed on the install", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const subject = installer({ build: async () => ({ ok: false, failureSignature: ["old failure"], durationMs: 1 }) })
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const before: WizardBeforeFacts = { ...fakeBefore(), baselineBuild: { ok: false, failureSignature: ["old failure"], durationMs: 1 } }
    const plan = subject.buildPlan(scan, fakeKeys(), before, [])
    const result = (await subject.apply(plan, approveAll(plan))) as WizardApplyResult
    expect(result).toMatchObject({ ok: true, build: "failed_baseline" })
  })

  it("B26: a build that could not run is not_run (undetermined), never 'already red' and never blamed on the install", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const couldNotRun = { ok: false, failureSignature: [], durationMs: 1, error: "sandbox-exec could not apply the profile" } as BuildResult
    const subject = installer({ build: async () => couldNotRun })
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    // The baseline could not run either (nested in another sandbox): red with no signature.
    const before: WizardBeforeFacts = { ...fakeBefore(), baselineBuild: { ok: false, failureSignature: [], durationMs: 1 } }
    const plan = subject.buildPlan(scan, fakeKeys(), before, [])
    const result = (await subject.apply(plan, approveAll(plan))) as WizardApplyResult
    expect(result).toMatchObject({ ok: true, build: "not_run" })
    expect(result.warnings.some((warning) => warning.startsWith("The build could not run (test_error"))).toBe(true)
    // With a green baseline it is still not a new failure: the install stays.
    const green = makeSite({ "index.html": STATIC_HTML })
    const second = installer({ build: async () => couldNotRun })
    const secondPlan = second.buildPlan(await second.scan({ root: green, hosting: fakeHosting() }), fakeKeys(), { ...fakeBefore(), baselineBuild: { ok: true, failureSignature: [], durationMs: 1 } } as WizardBeforeFacts, [])
    expect(await second.apply(secondPlan, approveAll(secondPlan))).toMatchObject({ ok: true, build: "not_run" })
  })
})

describe("D17 sensitive pages (decision 17: a plan line from the detector)", () => {
  it("a NEW managed PostHog gets the sensitive-pages line from the detector, and the approved bytes carry the paths", async () => {
    const root = makeSite({ "index.html": STATIC_HTML, "login.html": STATIC_HTML, "pricing.html": STATIC_HTML })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    const line = plan.lines.find((entry) => entry.id === "sensitive_pages:posthog:managed")
    expect(line, "the D17 line (the detector's /login) is on the plan").toBeDefined()
    expect(line!.text).toContain("/login")
    expect(line!.text).not.toContain("/pricing")
    expect((await subject.apply(plan, approveAll(plan))).ok).toBe(true)
    expect(read(root, "index.html")).toContain('var INFINITE_SENSITIVE_PATHS = ["/login"];')
  })

  it("negative: declined, the managed PostHog carries no sensitive paths; no sensitive route, no line", async () => {
    const root = makeSite({ "index.html": STATIC_HTML, "login.html": STATIC_HTML })
    const subject = installer()
    const plan = subject.buildPlan(await subject.scan({ root, hosting: fakeHosting() }), fakeKeys(), fakeBefore(), [])
    const answer = approveAll(plan)
    expect((await subject.apply(plan, { ...answer, approved: answer.approved.filter((id) => id !== "sensitive_pages:posthog:managed") })).ok).toBe(true)
    expect(read(root, "index.html")).not.toContain("INFINITE_SENSITIVE_PATHS")
    const plain = makeSite({ "index.html": STATIC_HTML, "pricing.html": STATIC_HTML })
    const other = installer()
    const plainPlan = other.buildPlan(await other.scan({ root: plain, hosting: fakeHosting() }), fakeKeys(), fakeBefore(), [])
    expect(plainPlan.lines.some((entry) => entry.kind === "sensitive_pages")).toBe(false)
  })

  it("an adopted PostHog that already turns replay off there (setup check pass) gets no line", async () => {
    const root = makeSite({ "index.html": STATIC_HTML, "login.html": STATIC_HTML })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const handled = { ...fakeBefore(), checks: [{ checkId: "sensitive_pages", tier: "S" as const, state: "pass" as const, at: "2026-10-02T09:00:00.000Z", runId: IDS.run }] }
    expect(subject.buildPlan(scan, fakeKeys(), handled, []).lines.some((entry) => entry.kind === "sensitive_pages")).toBe(false)
  })
})

describe("scan: app root, truncation, a corrupt receipt", () => {
  it("monorepo: the app root comes from Vercel's rootDirectory", async () => {
    const root = makeSite({
      "package.json": `{"name":"mono","private":true,"workspaces":["apps/*","packages/*"]}\n`,
      "apps/web/package.json": VITE_PACKAGE,
      "apps/web/index.html": STATIC_HTML,
      "apps/docs/index.html": STATIC_HTML,
      "packages/ui/package.json": `{"name":"ui"}\n`
    })
    const scan = await installer().scan({ root, hosting: fakeHosting({ rootDirectory: "apps/web" }) })
    expect(scan).toMatchObject({ appRoot: "apps/web", appRootSource: "vercel_root_directory", framework: "vite-react" })
  })

  it("monorepo without Vercel: one web app among the workspace globs is the app; two is ambiguous (job 2) and says so", async () => {
    const one = makeSite({ "package.json": `{"workspaces":["apps/*"]}\n`, "apps/web/package.json": VITE_PACKAGE, "apps/web/index.html": STATIC_HTML, "apps/api/package.json": `{"name":"api"}\n` })
    expect(await installer().scan({ root: one, hosting: { provider: "none", vercel: null } })).toMatchObject({ appRoot: "apps/web", appRootSource: "workspace_globs" })
    const two = makeSite({ "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n", "package.json": "{}\n", "apps/a/index.html": STATIC_HTML, "apps/b/index.html": STATIC_HTML })
    const scan = await installer().scan({ root: two, hosting: { provider: "none", vercel: null } })
    expect(scan).toMatchObject({ ambiguousAppRoot: true, appRootCandidates: ["apps/a", "apps/b"], appRootSource: "default" })
    expect(scan.warnings.some((warning) => warning.includes("2 web apps"))).toBe(true)
  })

  it("truncation: 2,001 source files → a warning; 2,000 → none", async () => {
    const big = makeSite({ "index.html": STATIC_HTML })
    mkdirSync(join(big, "src"), { recursive: true })
    for (let index = 0; index < 2_000; index += 1) writeFileSync(join(big, "src", `m${String(index).padStart(4, "0")}.js`), "export {}\n")
    const scan = await installer().scan({ root: big, hosting: fakeHosting() })
    expect(scan.truncated).toBe(true)
    expect(scan.fileCount).toBe(2_000)
    expect(scan.warnings.some((warning) => /stopped at 2,000 files/.test(warning))).toBe(true)

    const fits = makeSite({ "index.html": STATIC_HTML })
    mkdirSync(join(fits, "src"), { recursive: true })
    for (let index = 0; index < 1_999; index += 1) writeFileSync(join(fits, "src", `m${index}.js`), "export {}\n")
    const ok = await installer().scan({ root: fits, hosting: fakeHosting() })
    expect(ok.truncated).toBe(false)
    expect(ok.warnings.some((warning) => /stopped at/.test(warning))).toBe(false)
  })

  it("static sites scan public/ too (they serve pages from it)", async () => {
    const root = makeSite({ "index.html": STATIC_HTML, "public/landing.html": STATIC_HTML })
    const scan = await installer().scan({ root, hosting: fakeHosting() })
    expect(scan.fileCount).toBe(2)
  })

  it("a corrupt receipt is rebuilt from the managed markers, and the scan says what was lost", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    await subject.apply(plan, approveAll(plan))
    writeFileSync(join(root, ".infinite/install.json"), "{ not json")
    const rescanned = await installer().scan({ root, hosting: fakeHosting() })
    expect(rescanned.receiptRebuilt?.lost).toContain("edits")
    expect(rescanned.warnings.some((warning) => warning.includes("rebuilt from the managed markers"))).toBe(true)
    const rebuilt = readInstallManifest(root)!
    expect(rebuilt.files).toContain("index.html")
    expect(rebuilt.providers).toEqual(expect.arrayContaining(["ga4", "meta"]))
  })
})

describe("candidates and the adopted-provider rule through the installer", () => {
  it("a job-3 candidate links to its improve line; no line for it is ever an install line", async () => {
    const root = makeSite({ "index.html": STATIC_HTML.replace("</head>", `  <script>posthog.init('${IDS.posthog}', { api_host: 'https://us.i.posthog.com' })</script>\n  </head>`) })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [candidate("posthog_improve", "history_change")])
    expect(plan.lines.find((line) => line.id === "improve_additive:posthog:history_change")?.jobIds).toEqual(["posthog_improve:history_change"])
    expect(plan.lines.some((line) => line.id.startsWith("install_provider:posthog"))).toBe(false)
  })
})

describe("the receipt in a fresh process (O3 records agent edits, O4 refreshes after hooks)", () => {
  it("recordEdits works without a prior scan when the installer knows its root", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const after = STATIC_HTML.replace("<h1>Acme</h1>", "<h1>Acme!</h1>")
    writeFileSync(join(root, "index.html"), after)
    await installer({ root }).recordEdits([makeEditRecord({ file: "index.html", before: STATIC_HTML, after, jobId: "csp", planLineId: null, by: "agent", runId: IDS.run })])
    expect(readInstallManifest(root)!.edits).toHaveLength(1)
    // NEGATIVE: without a root or a scan it refuses rather than guessing a repo.
    await expect(installer().recordEdits([makeEditRecord({ file: "index.html", before: "a", after: "b", jobId: null, planLineId: null, by: "agent", runId: IDS.run })])).rejects.toThrow(/needs a scan/)
  })

  it("NEGATIVE: an install where every line was declined writes no receipt at all", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    const declineAll = { approved: ["consent_mode"], declined: plan.lines.filter((line) => line.requires === "approval" && line.id !== "consent_mode").map((line) => line.id), edits: { consent_mode: "not_required" } }
    expect((await subject.apply(plan, declineAll)).ok).toBe(true)
    expect(exists(root, ".infinite/install.json")).toBe(false)
    expect(read(root, "index.html")).toBe(STATIC_HTML)
  })
})

describe("review fixes (O7 fix round)", () => {
  const noVercel = { provider: "none" as const, vercel: null }

  async function run(root: string, keys = fakeKeys(), hosting = fakeHosting(), answer?: (plan: PlanModel) => { approved: string[]; declined: string[]; edits: Record<string, string> }, options: Partial<InstallerOptions> = {}) {
    const subject = installer(options)
    const scan = await subject.scan({ root, hosting })
    const plan = subject.buildPlan(scan, keys, fakeBefore({ keys, hosting }), [])
    const result = (await subject.apply(plan, answer ? answer(plan) : approveAll(plan))) as WizardApplyResult
    return { subject, plan, result }
  }

  it("P1-3: a second run keeps the first run's edits; uninstall then reverses every one of them", async () => {
    const root = makeSite({ "index.html": ADOPTED_META_HTML })
    const keysWithoutPosthog = fakeKeys({ posthog: { status: "not_connected", projectKey: null, apiHost: null, ingestHost: null, uiHost: null, region: null } })
    const first = await run(root, keysWithoutPosthog)
    expect(first.result.ok).toBe(true)
    const firstEdits = readInstallManifest(root)!.edits!.map((edit) => edit.id)
    expect(firstEdits.length).toBeGreaterThanOrEqual(2)
    // Run 2: PostHog is newly connected; the managed block changes on the same page.
    const second = await run(root, fakeKeys())
    expect(second.result.ok).toBe(true)
    expect(read(root, "index.html")).toContain(IDS.posthog)
    const edits = readInstallManifest(root)!.edits!
    expect(edits.map((edit) => edit.id).slice(0, firstEdits.length)).toEqual(firstEdits)
    const report = await second.subject.uninstall({ root, dryRun: false })
    expect(report.leftAsIs).toEqual([])
    expect(read(root, "index.html")).toBe(ADOPTED_META_HTML)
  })

  it("P1-4 + P2-12: declining 'Update …' on a re-run KEEPS the managed tags and their ids (never drops them)", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    expect((await run(root)).result.ok).toBe(true)
    const installed = read(root, "index.html")
    const second = await run(root, fakeKeys(), fakeHosting(), (plan) => {
      const updates = plan.lines.filter((line) => line.kind === "install_provider" && !line.id.startsWith("install_provider:infinite")).map((line) => line.id)
      const all = approveAll(plan)
      return { ...all, approved: all.approved.filter((id) => !updates.includes(id)), declined: updates }
    })
    expect(second.result.ok).toBe(true)
    const html = read(root, "index.html")
    for (const id of [IDS.ga4, IDS.posthog, IDS.meta]) expect(html).toContain(id)
    expect(html).toBe(installed)
    expect(readInstallManifest(root)!.providers).toEqual(expect.arrayContaining(["ga4", "posthog", "meta", "infinite"]))
    expect(readInstallManifest(root)!.ids).toEqual({ ga4: [IDS.ga4], posthog: { projectKey: IDS.posthog, apiHost: "/ingest" }, meta: [IDS.meta], infinite: { siteSourceKey: IDS.siteSource } })
  })

  it("P1-5: a static site NOT served by Vercel installs PostHog straight to its region — no /ingest, no vercel.json", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const { plan, result } = await run(root, fakeKeys(), noVercel)
    expect(result.ok).toBe(true)
    expect(result.artifacts.posthog).toMatchObject({ apiHost: "https://us.i.posthog.com" })
    expect(result.artifacts.posthog?.proxy).toBeUndefined()
    expect(exists(root, "vercel.json")).toBe(false)
    expect(plan.lines.find((line) => line.id.startsWith("install_provider:posthog"))?.text).not.toContain("/ingest")
    expect(readInstallManifest(root)!.ids?.posthog?.apiHost).toBe("https://us.i.posthog.com")
  })

  it("P1-6: a static site off Vercel is still installable — Infinite becomes a user-action line, the other tools install", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const { plan, result } = await run(root, fakeKeys(), noVercel)
    expect(result).toMatchObject({ ok: true })
    expect(plan.lines.some((line) => line.id.startsWith("install_provider:infinite"))).toBe(false)
    expect(plan.lines.find((line) => line.id === "user_action:infinite_blocked")?.text).toMatch(/not served through Vercel/)
    const html = read(root, "index.html")
    expect(html).toContain(IDS.ga4)
    expect(html).not.toContain(IDS.siteSource)
  })

  it("P1-8: an adopted gtag in public/ is detected on a static site — no second managed GA4 on that page", async () => {
    const gtag = `<script async src="https://www.googletagmanager.com/gtag/js?id=${IDS.ga4}"></script>\n    <script>window.dataLayer=[];function gtag(){dataLayer.push(arguments)}gtag('js', new Date());gtag('config', '${IDS.ga4}');</script>\n  </head>`
    const root = makeSite({ "index.html": STATIC_HTML, "public/landing.html": STATIC_HTML.replace("</head>", gtag) })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    expect(scan.detected.some((entry) => entry.provider === "ga4" && entry.file === "public/landing.html")).toBe(true)
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    expect(plan.lines.some((line) => line.id.startsWith("install_provider:ga4"))).toBe(false)
    expect((await subject.apply(plan, approveAll(plan))).ok).toBe(true)
    expect(read(root, "public/landing.html").match(new RegExp(`config', '${IDS.ga4}'`, "g"))).toHaveLength(1)
  })

  it("P2-11: the npm line never runs when the server lane is declined", async () => {
    const root = makeSite({ "index.html": STATIC_HTML, "vercel.json": "{}\n", "package.json": `{"name":"acme"}\n`, "package-lock.json": `{"lockfileVersion":3}\n` })
    const calls: string[][] = []
    const spawn = async (command: string, args: readonly string[]) => {
      calls.push([command, ...args])
      return { code: 0, signal: null, timedOut: false, outputTail: "" }
    }
    const subject = installer({ spawn: spawn as never })
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    expect(plan.lines.some((line) => line.id === "npm_install")).toBe(true)
    const all = approveAll(plan)
    const result = await subject.apply(plan, { ...all, approved: all.approved.filter((id) => id !== "server_lane"), declined: ["server_lane"] })
    expect(result.ok).toBe(true)
    expect(calls).toEqual([])
    expect(read(root, "package.json")).toBe(`{"name":"acme"}\n`)
  })

  it("P3-21: a build-failure rollback removes the server-lane files too (nothing left half-installed)", async () => {
    const root = makeSite({ "index.html": STATIC_HTML, "vercel.json": "{}\n" })
    const subject = installer({ build: async () => ({ ok: false, failureSignature: ["new failure"], durationMs: 1 }) })
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const before: WizardBeforeFacts = { ...fakeBefore(), baselineBuild: { ok: true, failureSignature: [], durationMs: 1 } }
    const plan = subject.buildPlan(scan, fakeKeys(), before, [])
    expect(plan.lines.some((line) => line.id === "server_lane")).toBe(true)
    const answer = approveAll(plan)
    const result = await subject.apply(plan, { ...answer, approved: answer.approved.filter((id) => id !== "npm_install") })
    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(exists(root, "docs/infinite-server-lane.md")).toBe(false)
    expect(exists(root, "middleware.ts")).toBe(false)
    expect(read(root, "index.html")).toBe(STATIC_HTML)
    expect(read(root, "vercel.json")).toBe("{}\n")
  })

  it("P3-22: a receipt that parses but fails the shape check is never overwritten by a rebuild", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    mkdirSync(join(root, ".infinite"), { recursive: true })
    const newer = `{"workspaceId":"wizard:abababababababab","appRoot":".","framework":"static-html","providers":"a newer shape"}\n`
    writeFileSync(join(root, ".infinite/install.json"), newer)
    await expect(installer().scan({ root, hosting: fakeHosting() })).rejects.toThrow(/Corrupt/)
    expect(read(root, ".infinite/install.json")).toBe(newer)
  })
})

describe("§3x.3 (B3, W4): the conversion helpers are written whenever job 10 is seeded", () => {
  const RUN3_FILES = ["package.json", "tsconfig.json", "app/layout.tsx", "app/page.tsx", "app/signup/page.tsx", "app/globals.css", "app/api/signup/route.ts", "lib/users.ts"]
  const run3Site = () => makeSite(Object.fromEntries(RUN3_FILES.map((rel) => [rel, run3File(`site-6d16d8f/${rel}`)])))

  async function installRun3(conversion: boolean) {
    const root = run3Site()
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const keys = notConnectedKeys()
    const ready = { ...keys, infinite: fakeKeys().infinite }
    const candidates = conversion ? [candidate("conversions_to_tools", "signup", { allow: { files: ["app/signup/page.tsx"], create: [] } })] : []
    const plan = subject.buildPlan(scan, ready, fakeBefore({ keys: ready }), candidates)
    const answer = approveAll(plan)
    if (!conversion) answer.approved = answer.approved.filter((id) => id !== "conversion_names")
    const result = (await subject.apply(plan, answer)) as WizardApplyResult
    return { root, plan, result }
  }

  it("next-app-router + conversions ['signup'] (run 3): the managed module EXPORTS the five helpers (executed, not grepped)", async () => {
    const { root, plan, result } = await installRun3(true)
    expect(plan.decisions.conversionNames).toEqual(["signup"])
    expect(result.ok).toBe(true)
    expect(result.artifacts.conversions).toEqual({ helpers: true })
    const vm = createBrowserVm({ url: "https://acme-store.com/" })
    vm.window.exports = {}
    vm.runScript(`(function (exports) {\n${transpileToCommonJs(read(root, "lib/infinite-analytics.ts"))}\n})(window.exports);`)
    expect(vm.scriptErrors).toEqual([])
    const api = vm.window.exports as Record<string, unknown>
    for (const name of ["infiniteTrack", "infiniteTrackThenNavigate", "infiniteIdentify", "infiniteReset", "infiniteMetaMirror"]) expect(typeof api[name], name).toBe("function")
  })

  it("negative: no approved conversion name → no helpers (and so no job 10 promising them)", async () => {
    const { root, result } = await installRun3(false)
    expect(result.ok).toBe(true)
    expect(result.artifacts.conversions).toBeUndefined()
    const vm = createBrowserVm({ url: "https://acme-store.com/" })
    vm.window.exports = {}
    vm.runScript(`(function (exports) {\n${transpileToCommonJs(read(root, "lib/infinite-analytics.ts"))}\n})(window.exports);`)
    expect(typeof (vm.window.exports as Record<string, unknown>).infiniteTrack).toBe("undefined")
  })
})
