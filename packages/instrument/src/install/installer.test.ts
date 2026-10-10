// The wizard installer against fixture sites on disk (no network, no agent, no cloud). The managed
// bytes are the existing adapters'; what is tested here is the composition: approvals → artifacts,
// the improve edits, the receipt, open jobs, the build rollback, uninstall, scan and app roots.
import { writeFileSync } from "node:fs"
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
import { computeContentHash, readInstallManifest } from "../manifest.js"
import type { BuildResult, PlanModel } from "../wizard/contracts/jobs.js"

import { makeEditRecord } from "./edits.js"
import { reverseServerLane } from "../server-lane/install.js"
import { WizardInstaller, type InstallerOptions, type WizardApplyResult } from "./installer.js"
import type { WizardBeforeFacts } from "./plan-model.js"
import { ownerLayoutJobs } from "../wizard/steps/install.js"

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

  it("an explicit Meta install decline leaves its tag and manifest id absent", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    const answer = approveAll(plan)
    const metaLine = `install_provider:meta:${IDS.meta}`
    const result = (await subject.apply(plan, { ...answer, approved: answer.approved.filter((id) => id !== metaLine), declined: [metaLine] })) as WizardApplyResult
    expect(result.ok).toBe(true)
    expect(read(root, "index.html")).not.toContain(IDS.meta)
    expect(readInstallManifest(root)!.ids?.meta ?? []).toEqual([])
  })

  it("applies with no consent answer: nothing is asked and the tag installs active", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    expect(plan.lines.some((line) => line.kind === "consent_mode")).toBe(false)
    const result = await subject.apply(plan, { approved: [], declined: [], edits: {} })
    expect(result.ok).toBe(true)
    expect(read(root, "index.html")).not.toBe(STATIC_HTML)
    // No pixels of the site's own here: the tag starts on load.
    expect(read(root, "index.html")).not.toContain('"followSitePixels"')
  })

  it("on a site that already runs its own pixel, the tag is installed to follow it", async () => {
    const withPixel = STATIC_HTML.replace("</head>", "<script>!function(f){if(f.fbq)return;var n=f.fbq=function(){n.queue.push(arguments)};n.queue=[]}(window);fbq('init', '555500001111222');fbq('track', 'PageView');</script></head>")
    expect(withPixel).not.toBe(STATIC_HTML)
    const root = makeSite({ "index.html": withPixel })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    const result = await subject.apply(plan, { approved: [], declined: [], edits: {} })
    expect(result.ok).toBe(true)
    expect(read(root, "index.html")).toContain('"followSitePixels":["fbq","gtag","posthog","dataLayer"]')
  })
})

describe("requiresManual is an OPEN JOB, never 'installed' (S1 fix, run.ts apply)", () => {
  const VITE_NO_HEAD = `<!doctype html>\n<html>\n<body><div id="root"></div></body>\n</html>\n`

  it("leaves an inline-consent layout untouched and hands exact wiring to the owner without a worker job", async () => {
    const original = "export default function RootLayout({children}) { return <html><body><script>{`gtag('consent','default',{analytics_storage:'denied'});`}</script>{children}</body></html> }\n"
    const root = makeSite({ "package.json": '{"dependencies":{"next":"16.0.0","react":"19.0.0"}}', "app/layout.tsx": original })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    const result = await subject.apply(plan, approveAll(plan))
    expect(result).toMatchObject({ ok: true, openJobs: [] })
    expect(read(root, "app/layout.tsx")).toBe(original)
    expect(result.changedFiles).not.toContain("app/layout.tsx")
    const jobs = ownerLayoutJobs(plan.ownerWiring?.requirements ?? [])
    expect(jobs).toEqual([expect.objectContaining({ id: "unusual_layout:app/layout.tsx", owner: "code", state: "left_for_you", checks: [], allow: { files: [], create: [] }, ownerBoundary: expect.objectContaining({ kind: "frozen_unit" }) })])
    expect(jobs[0]?.trigger.finding).toContain('import { InfiniteAnalyticsClient } from "../lib/infinite-analytics-client"')
    expect(jobs[0]?.trigger.finding).toContain("<InfiniteAnalyticsClient />")
    expect(plan.installTools).toEqual([])
    expect(exists(root, "lib/infinite-analytics.ts")).toBe(false)
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
    expect(wizardEdits).toEqual(["capture_beside_adopted_pixel:meta:capture", "capture_beside_adopted_pixel:meta:capture", "capture_beside_adopted_pixel:meta:capture", "autoconfig_off_adopted:meta:autoconfig"])
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
      ["infinite-meta-click-id.js", "wizard"],
      ["index.html", "wizard"],
      ["about.html", "wizard"],
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
    expect(exists(root, "infinite-meta-click-id.js")).toBe(false)
  })

  it("NEGATIVE: a recorded file changed since → uninstall warns and leaves it exactly as it is", async () => {
    const root = makeSite({ "index.html": ADOPTED_META_HTML, "about.html": STATIC_HTML })
    const subject = installer()
    const keys = fakeKeys({ ga4: { status: "not_connected", propertyLabel: null, streams: [] }, posthog: { status: "not_connected", projectKey: null, apiHost: null, ingestHost: null, uiHost: null, region: null } })
    const hosting = { provider: "none" as const, vercel: null }
    const scan = await subject.scan({ root, hosting })
    const plan = subject.buildPlan(scan, keys, fakeBefore({ keys, hosting }), [])
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

  it("the npm line never runs without its own explicit yes", async () => {
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
    const result = await subject.apply(plan, { ...all, approved: all.approved.filter((id) => id !== "npm_install"), declined: ["npm_install"] })
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

  it("P0-6: server conversions in the plan → the owner's steps are written into the PR as a lane file, and uninstall removes it", async () => {
    const root = makeSite({ "index.html": STATIC_HTML, "vercel.json": "{}\n", "package.json": '{"name":"shop","dependencies":{"stripe":"16.0.0"}}\n' })
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const candidates = [
      candidate("server_conversions", "purchase", { allow: { files: ["api/checkout.js"], create: [] } }),
      candidate("server_conversions", "lead", { allow: { files: ["api/lead.js"], create: [] } })
    ]
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), candidates)
    expect(plan.lines.some((line) => line.id === "server_lane")).toBe(true)
    const answer = approveAll(plan)
    const result = await subject.apply(plan, { ...answer, approved: answer.approved.filter((id) => id !== "npm_install") })
    expect(result.ok).toBe(true)
    const handoff = read(root, "docs/infinite-server-events.md")
    expect(handoff).toContain("# Turn on server conversions")
    expect(handoff).toMatch(/add `purchase` and `lead`, each with the source \*\*Your server\*\*/)
    expect(handoff).toContain("Stripe → Developers → Webhooks")
    expect(result.changedFiles).toContain("docs/infinite-server-events.md")
    const receipt = readInstallManifest(root)!
    expect(receipt.serverLane?.created).toContain("docs/infinite-server-events.md")
    expect(receipt.configOwnership?.["docs/infinite-server-events.md"]).toMatchObject({ kind: "created", installedHash: computeContentHash(handoff) })
    // Uninstall reverses it with the rest of the lane (hash-gated: only while unedited).
    expect(reverseServerLane({ root, manifest: receipt, dryRun: true }).removedFiles).toContain("docs/infinite-server-events.md")
  })
})


// PR #15 follow-up (i): the plan refuses a run that would take a recorded tool off the page. The wizard's
// apply adds back every tool the receipt records (`keptArtifact`), so its DRY plans (the plan screen's
// blocker check, the install preflight) must not report a removal that apply never makes.
describe("a wizard re-run keeps the receipt's tools, and its dry plans say no removal", () => {
  async function installAll(root: string): Promise<void> {
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    expect(((await subject.apply(plan, approveAll(plan))) as WizardApplyResult).ok).toBe(true)
  }

  it("GA4 no longer connected: no install-blocked line, no preflight refusal, and GA4 stays on the page", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    await installAll(root)
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys({ ga4: { status: "not_connected", propertyLabel: null, streams: [] } }), fakeBefore(), [])
    expect(plan.lines.map((line) => line.id)).not.toContain("user_action:install_blocked")
    expect(subject.preflight(plan, approveAll(plan))).toBeNull()
    expect(((await subject.apply(plan, approveAll(plan))) as WizardApplyResult).ok).toBe(true)
    expect(read(root, "index.html")).toContain(IDS.ga4)
    expect(readInstallManifest(root)!.providers).toContain("ga4")
  })

  it("'Update GA4' declined: no preflight refusal, and GA4 stays on the page", async () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    await installAll(root)
    const subject = installer()
    const scan = await subject.scan({ root, hosting: fakeHosting() })
    const plan = subject.buildPlan(scan, fakeKeys(), fakeBefore(), [])
    const answer = approveAll(plan)
    const ga4Line = `install_provider:ga4:${IDS.ga4}`
    const declined = { ...answer, approved: answer.approved.filter((id) => id !== ga4Line), declined: [ga4Line] }
    expect(subject.preflight(plan, declined)).toBeNull()
    expect(((await subject.apply(plan, declined)) as WizardApplyResult).ok).toBe(true)
    expect(read(root, "index.html")).toContain(IDS.ga4)
  })
})
