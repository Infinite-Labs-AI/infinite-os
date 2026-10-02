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
  read,
  STATIC_HTML
} from "../../test/wizard/o7-fakes.js"
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
    expect(result.artifacts.hostGuard).toEqual({ mode: "deny", exempt: ["acme-store.com"], deny: expect.arrayContaining([".vercel.app", "localhost"]) })
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
