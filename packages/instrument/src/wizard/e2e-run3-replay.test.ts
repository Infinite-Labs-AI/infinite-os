// DECISIONS §10 W14 / W15 / W16: live run 3 replayed through THE verdict. Live run 3 printed "collects analytics
// properly now" and PATCHed `proven` + `phase: proven` while the duplicate GA4 tag and both unguarded tags were still
// on the live site and the Meta pixel sent nothing on the real visit. This replay feeds the run's own files (its
// checklist, its review ledger, its stored real visit and grades, its Live today / In the PR columns) through the
// SAME code `prove` and `done` run: `buildProvenColumn` with the three post-deploy measurements, `proofFactsFromVisit`,
// `openFindings` with the wizard's ownership, then the report builder, which computes the verdict.
//
// The step-level halves are covered elsewhere: `prove`'s PATCH is `proofStateOf(verdict)` (§3y E2E: `problem`, never
// `phase: proven`) and `done` PATCHes `phase: proven` only for "properly" (done.test.ts).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

import { RUN3_DIR, run3Json } from "../../test/wizard/run3-fixture.js"
import { gradeContextFrom } from "../checks/grade-context.js"
import { gradeTestRun } from "../checks/grade-test-run.js"
import { openFindings, type ReviewLedger } from "../review/ledger.js"
import { wizardOwnership } from "../review/ownership.js"
import type { WizardDeps } from "./contracts/deps.js"
import type { CheckResult, ChecklistItem } from "./contracts/jobs.js"
import type { LaneReceipt, ReceiptLane, ReceiptsResponseFields } from "./contracts/receipts.js"
import type { ReportColumnSnapshot, VerdictOpenFinding } from "./contracts/report.js"
import type { BeforeFactsFile } from "./handoff/before-facts.js"
import type { TagKeys } from "./contracts/bridge.js"
import { testExpectFromKeys, type TestResult, type TestTool } from "./contracts/test-engine.js"
import { proofStateOf } from "./verdict.js"
import { buildProvenColumn, proofFactsFromVisit, type PostDeployLoad } from "./steps/prove.js"
import { createReportBuilder } from "./report.js"

const HOST = "shop.examplebrand.com"
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
const GA4_ID = "G-TEST0000000"
const PIXEL_ID = "7777000011112222"
const AT = "2026-10-03T15:04:00.000Z"

interface Run3State {
  runId: string
  runStartedAt: string
  jobs: ChecklistItem[]
  report: { live_today: ReportColumnSnapshot; in_pr: ReportColumnSnapshot; proven_live: ReportColumnSnapshot }
  site: { claim: { siteSourceKey: string } }
}
const state = run3Json<Run3State>("wizard/state.json")
const before = run3Json<BeforeFactsFile>("wizard/before.json")
const ledger = run3Json<ReviewLedger>("wizard/review-ledger.json")
const stored = run3Json<{ mergeSha: string; visit: { result: TestResult; grades: Record<TestTool, CheckResult> } }>("wizard/prove-visit.json")
const RUN_ID = state.runId
const SITE_KEY = state.site.claim.siteSourceKey
/** The merge commit's own tree (census): the site's GA4 and Meta snippets, and Infinite's managed tag. */
const INSTALLED: TestTool[] = ["infinite", "ga4", "meta"]

/** Keys as `prove` read them in run 3 (Infinite's source proven; nothing else connected), or with GA4 + Meta connected. */
function keysFor(connected: boolean): TagKeys {
  const keys = structuredClone(before.facts.keys)
  keys.infinite = { ...keys.infinite, status: "ready", siteSourceKey: SITE_KEY, productionHosts: [HOST], consentMode: "not_required" }
  if (connected) {
    keys.ga4 = { status: "connected", propertyLabel: "Tag smoke", streams: [{ measurementId: GA4_ID, defaultUri: `https://${HOST}` }] } as TagKeys["ga4"]
    keys.meta = { status: "connected", pixels: [{ pixelId: PIXEL_ID, sourceRef: "src_meta_test", adAccountLabel: null }] }
  }
  return keys
}

function lane(state: LaneReceipt["state"], receiptAt: string | null = null, provenance: LaneReceipt["provenance"] = "cloud_ledger"): LaneReceipt {
  return { state, receiptAt, reason: null, provenance }
}
function receipts(lanes: Partial<Record<ReceiptLane, LaneReceipt>>): ReceiptsResponseFields {
  return {
    runId: RUN_ID,
    phase: "proven_live",
    checkedAt: AT,
    lanes: {
      infinite: lane("verified", "2026-10-03T15:03:12.000Z"),
      posthog: lane("not_verifiable", null, "posthog_query"),
      ga4: lane("delivering", null, "desktop_test"),
      meta_pixel: lane("no_receipt", null, "desktop_test"),
      server_lane: lane("not_verifiable"),
      meta_capi: lane("not_verifiable", null, "relay_ledger"),
      ...lanes
    }
  } as ReceiptsResponseFields
}

/** A no-send load (`dry_live`) of one target, with the facts given; v2 facts and the browser UA. */
function dryLoad(url: string, label: string, facts: { ga4?: Array<{ afterNav: boolean }>; meta?: Array<{ afterNav: boolean }> }): TestResult {
  const result = structuredClone(stored.visit.result)
  result.mode = "dry_live"
  result.environment = { ...result.environment, ua: BROWSER_UA }
  result.loads = [{ label, url, finalUrl: url, status: 200, rendered: true, managedMarkerSeen: true, redirects: [] }]
  result.ga4.events = (facts.ga4 ?? []).map((event) => ({ tid: GA4_ID, cid: "1234567890.1759500000", en: "page_view", dlHost: new URL(url).host, transport: "post" as const, status: "cancelled" as const, loadLabel: label, afterNav: event.afterNav }))
  result.meta.tr = (facts.meta ?? []).map((tr) => ({ pixelId: PIXEL_ID, ev: "PageView", eid: null, method: "GET", status: "cancelled" as const, loadLabel: label, afterNav: tr.afterNav }))
  result.infinite.events = []
  result.serverLaneProbe = null
  return result
}

/** Run 3's own PR head on disk (the site at 6d16d8f with the install of f1abea9): whose code each finding is on. */
async function run3Ownership() {
  const root = mkdtempSync(join(tmpdir(), "run3-replay-"))
  const files = (base: string, at = ""): string[] =>
    readdirSync(join(base, at)).flatMap((name) => {
      const rel = at ? `${at}/${name}` : name
      return statSync(join(base, rel)).isDirectory() ? files(base, rel) : [rel]
    })
  for (const from of ["site-6d16d8f", "install-f1abea9"]) {
    for (const rel of files(join(RUN3_DIR, from))) {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), readFileSync(join(RUN3_DIR, from, rel)))
    }
  }
  const fs = { readText: async (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null) } as unknown as WizardDeps["fs"]
  const ownership = await wizardOwnership({ fs }, root, async (path) => existsSync(join(RUN3_DIR, "site-6d16d8f", path)))
  rmSync(root, { recursive: true, force: true })
  return ownership
}

interface World {
  connected: boolean
  /** The jobs as run 3 left them, or all done (the fixed world). */
  jobs: ChecklistItem[]
  findings: VerdictOpenFinding[]
  visit: { result: TestResult; grades: Record<TestTool, CheckResult> }
  receipts: ReceiptsResponseFields
  postDeploy: { byteCensus: CheckResult[]; mergePreview: PostDeployLoad; deployedDry: PostDeployLoad }
}

function replay(world: World, installedUnknown: string | null = null) {
  const keys = keysFor(world.connected)
  const expectation = testExpectFromKeys(keys)
  const column = buildProvenColumn({
    runId: RUN_ID,
    mergeSha: stored.mergeSha,
    at: AT,
    keys,
    expect: expectation,
    installed: INSTALLED,
    postDeploy: world.postDeploy,
    visit: world.visit,
    receipts: world.receipts,
    t1: [],
    serverLaneInstalled: false,
    conversionsWaiting: 0,
    runStartedAt: state.runStartedAt
  })
  const proof = proofFactsFromVisit(world.visit, world.receipts, INSTALLED, expectation, false, AT, { ga4: [GA4_ID], meta: [PIXEL_ID], infinite: [SITE_KEY] }, installedUnknown)
  const report = createReportBuilder(() => new Date(AT)).build({
    runId: RUN_ID,
    tagVersion: "0.13.0",
    site: { repoLabel: "examplebrand/example-shop", productionHost: HOST },
    columns: { live_today: state.report.live_today, in_pr: state.report.in_pr, proven_live: column },
    provenLivePending: null,
    runStartedAt: state.runStartedAt,
    day7: null,
    notes: [],
    verdictFacts: { jobs: world.jobs, openFindings: world.findings, tools: proof.tools, installedUnknown: proof.installedUnknown }
  })
  return { report, column, proof }
}

const grade = (result: TestResult, expectation: ReturnType<typeof testExpectFromKeys>, mode: "dry_live" | "real_visit", spaNavigation = false) =>
  gradeTestRun(result, expectation, mode, gradeContextFrom({ census: before.facts.census, installed: INSTALLED, consentMode: "not_required", cmpDetected: null, spaNavigation }))

describe("W14 live run 3 replayed: THE verdict is 'problems', with the run's own reasons", () => {
  it("3 live problems · 5 approved fixes not in the code · 2 review blockers · the Meta pixel sent nothing; proofState problem", async () => {
    const ownership = await run3Ownership()
    const expectation = testExpectFromKeys(keysFor(false))
    // After the deploy: the live page still holds GA4 twice; the merge's own deployment address sends GA4 and Meta;
    // production with one page change counts GA4 once (Meta sends nothing at all, as on the real visit).
    const census: CheckResult = { checkId: "byte_census", tier: "T1", state: "problem", reason: "duplicate tags on one page: ga4 G-TEST0000000 ×2", evidence: [{ url: `https://${HOST}/` }], at: AT, runId: RUN_ID }
    const preview = dryLoad("https://example-shop-git-main-examplebrand.vercel.app/", "preview_self", { ga4: [{ afterNav: false }], meta: [{ afterNav: false }] })
    const deployed = dryLoad(`https://${HOST}/`, "home", { ga4: [{ afterNav: false }, { afterNav: true }] })
    const { report } = replay({
      connected: false,
      jobs: state.jobs,
      findings: openFindings(ledger, state.jobs, ownership.classify),
      // The run's own stored visit and ITS grades (graded `no_beacon` for Meta then).
      visit: stored.visit,
      receipts: receipts({}),
      postDeploy: {
        byteCensus: [census],
        mergePreview: { kind: "graded", result: preview, grades: grade(preview, expectation, "dry_live") },
        deployedDry: { kind: "graded", result: deployed, grades: grade(deployed, expectation, "dry_live", true) }
      }
    })
    expect(report.verdict!.state).toBe("problems")
    expect(report.verdict!.headline).toBe(
      "shop.examplebrand.com does not collect properly yet: 3 problems on the live site (each tool once, previews silent, proof from real visit) · 5 approved fixes are not in the code (Remove duplicate tags, Keep previews silent (existing tags), Keep previews silent (existing tags) +2 more) · 2 review blockers open (R1 next.config.mjs:1 (the wizard's own change), R8 lib/infinite-analytics.ts:3 (Infinite's own code)) · Meta pixel sent nothing on the real visit"
    )
    expect(proofStateOf(report.verdict!)).toBe("problem")
    // The Meta row says what the visit measured, never a pass.
    expect(report.finishLine.find((line) => line.id === "proof_from_real_visit")!.cells.proven_live.state).toBe("problem")
  })
})

/** The fixed world: every approved job in the code, no open finding, one GA4 config, guards in, every tool firing once. */
function fixedWorld(connected: boolean): World {
  const keys = keysFor(connected)
  const expectation = testExpectFromKeys(keys)
  const jobs = state.jobs.filter((item) => item.jobId !== "review_comments").map((item) => ({ ...item, state: "waiting_deploy" as const, blockedReason: undefined }))
  const visitResult = structuredClone(stored.visit.result)
  visitResult.environment = { ...visitResult.environment, ua: BROWSER_UA }
  visitResult.ga4.events = visitResult.ga4.events.map((event) => ({ ...event, cid: "1234567890.1759500000" }))
  visitResult.meta.tr = [{ pixelId: PIXEL_ID, ev: "PageView", eid: null, method: "GET", status: 200, loadLabel: "home", afterNav: false }]
  const census: CheckResult = { checkId: "byte_census", tier: "T1", state: "pass", evidence: [{ url: `https://${HOST}/` }], at: AT, runId: RUN_ID }
  const preview = dryLoad("https://example-shop-git-main-examplebrand.vercel.app/", "preview_self", {})
  const deployed = dryLoad(`https://${HOST}/`, "home", { ga4: [{ afterNav: false }, { afterNav: true }], meta: [{ afterNav: false }, { afterNav: true }] })
  return {
    connected,
    jobs,
    findings: [],
    visit: { result: visitResult, grades: grade(visitResult, expectation, "real_visit") },
    receipts: receipts({ meta_pixel: lane("delivering", null, "desktop_test") }),
    postDeploy: {
      byteCensus: [census],
      mergePreview: { kind: "graded", result: preview, grades: grade(preview, expectation, "dry_live") },
      deployedDry: { kind: "graded", result: deployed, grades: grade(deployed, expectation, "dry_live", true) }
    }
  }
}

describe("W15 / W16 the fixed run-3 site: 'properly' only when every installed tool's ID is checked", () => {
  it("W15 GA4 and Meta connected → properly; the PATCH is proven", () => {
    const { report } = replay(fixedWorld(true))
    expect(report.verdict!.state, JSON.stringify(report.verdict)).toBe("properly")
    expect(report.verdict!.headline.startsWith("shop.examplebrand.com collects analytics properly now")).toBe(true)
    expect(proofStateOf(report.verdict!)).toBe("proven")
  })

  it("W16 GA4 and Meta NOT connected → unconfirmed, with the exact words; the PATCH is undetermined", () => {
    const { report } = replay(fixedWorld(false))
    expect(report.verdict!.state, JSON.stringify(report.verdict)).toBe("unconfirmed")
    expect(report.verdict!.headline).toBe("shop.examplebrand.com: Infinite's tag received this run's real visit; GA4 and Meta send, but their IDs are not checked (not connected in Infinite)")
    expect(proofStateOf(report.verdict!)).toBe("undetermined")
  })
})

describe("review P2-1 / P1-6 / P2-5: every unconfirmed or problems verdict names its cause", () => {
  it("P2-1 connected GA4 and Meta whose receipts are not in: unconfirmed WITH a receipt_not_in reason naming them", () => {
    const world = fixedWorld(true)
    world.receipts = receipts({ ga4: lane("undetermined", null, "desktop_test"), meta_pixel: lane("pending", null, "desktop_test") })
    const { report } = replay(world)
    expect(report.verdict!.state).toBe("unconfirmed")
    expect(report.verdict!.reasons).toEqual([{ kind: "receipt_not_in", count: 2, names: ["GA4", "Meta"] }])
    expect(report.verdict!.headline).toBe("shop.examplebrand.com: Infinite's tag received this run's real visit · the receipts of GA4 and Meta are not in yet")
  })

  it("P1-6 the merge tree could not be read: never properly; the cause is the reason and is in the headline", () => {
    const why = "the merge commit 6d16d8f's files could not be read (fatal: bad object 6d16d8f)"
    const { report, proof } = replay(fixedWorld(true), why)
    expect(proof.installedUnknown).toBe(why)
    expect(report.verdict!.state).toBe("unconfirmed")
    expect(report.verdict!.reasons).toEqual([{ kind: "installed_unknown", count: 1, names: [why] }])
    expect(report.verdict!.headline).toContain(`the deployed code could not be read (${why}), so a tool that sent nothing could not be named`)
    expect(proofStateOf(report.verdict!)).toBe("undetermined")
  })

  it("P2-5 a claimed fix is 'in the code but the wizard could not check it', never 'not in the code'", async () => {
    const ownership = await run3Ownership()
    const jobs = state.jobs.map((item) => (item.title === "Remove duplicate tags" ? { ...item, state: "claimed" as const, blockedReason: undefined } : item))
    const { report } = replay({ ...fixedWorld(true), jobs, findings: openFindings(ledger, jobs, ownership.classify) })
    expect(report.verdict!.state).toBe("problems")
    expect(report.verdict!.headline).toContain("4 approved fixes are not in the code (Keep previews silent (existing tags), Keep previews silent (existing tags)")
    expect(report.verdict!.headline).toContain("1 approved fix is in the code but the wizard could not check it (Remove duplicate tags)")
    expect(report.verdict!.headline).not.toMatch(/not in the code \([^)]*Remove duplicate tags/)
  })
})
