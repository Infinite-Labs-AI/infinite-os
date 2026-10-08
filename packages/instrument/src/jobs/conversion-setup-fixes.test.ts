// Live run 2 (P0-2): the store's mailing-list form was seeded twice, as the lead server job AND as a silent-form setup
// fix. The silent-form edit sent GA4 and PostHog a second lead beside the site's own generate_lead (a double count), and
// its co-ownership of the page put the lead's own lines back. A setup-check conversion fix is never seeded for a form
// a server or browser conversion job already covers.
//
// Live run 3: the store's own mailing-list route only logged the email (the fixture's route subscribes through a
// provider; the logs-only shape is `test/scan/fixtures/store-halden`'s). There is no lead there: neither the lead job nor
// the silent-form fix is seeded, and the plan tells the owner why.
import { execFileSync } from "node:child_process"
import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { fixtureHosting, fixtureKeys } from "../../test/wizard/o8/fixtures.js"
import { runCensus } from "../checks/census.js"
import { setupFindingResult } from "../checks/o9.js"
import { createWizardInstaller } from "../install/installer.js"
import { seedItemsAfterApprovals, type WizardPlanModel } from "../install/plan-model.js"
import { runSetupChecks } from "../setup-checks/index.js"
import type { BeforeFacts, ChecklistItem } from "../wizard/contracts/jobs.js"
import { createJobRegistry, withoutConversionCoveredSetupFixes } from "./registry.js"

const here = dirname(fileURLToPath(import.meta.url))
const STORE = resolve(here, "../../test/wizard/fixtures/store/site")
const LOGS_ONLY_ROUTE = resolve(here, "../../test/scan/fixtures/store-halden/pages/api/mailing-list.ts")
const RUN_ID = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"

/** A git repo of the store (the scan reads a real tree); `logsOnly` puts back the route that only logs the email. */
function storeRepo(logsOnly: boolean): string {
  const at = mkdtempSync(join(tmpdir(), "tag-store-silent-form-"))
  cpSync(STORE, at, { recursive: true })
  if (logsOnly) copyFileSync(LOGS_ONLY_ROUTE, join(at, "pages/api/mailing-list.ts"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: at, stdio: "ignore", env: { PATH: "/usr/bin:/bin", HOME: at, GIT_CONFIG_NOSYSTEM: "1" } })
  git("init", "-q")
  git("add", "-A")
  git("-c", "user.email=store@example.com", "-c", "user.name=Store", "commit", "-qm", "store")
  return at
}

let root = ""
let logsOnlyRoot = ""
beforeAll(() => {
  root = storeRepo(false)
  logsOnlyRoot = storeRepo(true)
})
afterAll(() => {
  for (const at of [root, logsOnlyRoot]) if (at) rmSync(at, { recursive: true, force: true })
})

async function seeded(at: string = root) {
  const keys = fixtureKeys()
  const installer = createWizardInstaller({
    root: at,
    repoFingerprint: `sha256:${"a".repeat(64)}`,
    runId: () => RUN_ID,
    agent: () => ({ worker: "claude_code", whoPays: null }),
    consentFlag: () => null,
    productionDeniedConflict: () => []
  })
  const scan = await installer.scan({ root: at, hosting: fixtureHosting() })
  // The before step's setup checks, as the live run had them (the form is flagged as silent).
  const ctx = { runId: RUN_ID, now: () => new Date("2026-10-08T10:00:00.000Z") }
  const checks = runSetupChecks(at, { repoRoot: at }).findings.filter((finding) => finding.state === "problem").map((finding) => setupFindingResult(finding, ctx))
  const before: BeforeFacts = { hosting: fixtureHosting(), keys, census: runCensus({ root: at, appRoot: "." }), dryLive: null, checks, observedProductionHost: "www.halden-audio.example" }
  const registry = createJobRegistry({ briefFacts: () => null })
  const candidates = registry.seedCandidates(scan, before)
  const plan = installer.buildPlan(scan, keys, before, candidates) as WizardPlanModel
  const approvals = { approved: plan.lines.filter((line) => line.requires === "approval").map((line) => line.id), declined: [], edits: {} }
  return { checks, candidates, plan, items: seedItemsAfterApprovals(candidates, plan.seeds ?? [], plan, approvals) }
}

describe("store: no silent-form job for a form the lead server job covers", () => {
  it("the setup checks flag the mailing-list form, yet only the lead server job is seeded for it (never the silent-form fix)", async () => {
    const { checks, candidates, plan, items } = await seeded()
    // Precondition: the live run's finding is really there.
    expect(checks.some((check) => check.checkId === "silent_form" && check.evidence?.some((entry) => "file" in entry && entry.file === "pages/mailing-list.tsx"))).toBe(true)
    const lead = items.find((item) => item.id === "server_conversions:lead")
    expect(lead?.allow.files).toContain("pages/mailing-list.tsx")
    for (const list of [candidates, items]) expect(list.map((item) => item.id)).not.toContain("setup_check_fixes:silent_form")
    // The plan never offers it either.
    expect(plan.lines.some((line) => (line.jobIds ?? []).includes("setup_check_fixes:silent_form"))).toBe(false)
  })

  it("a silent form no conversion job covers is still seeded; a purchase or checkout job on the same page does not cover it", () => {
    const item = (id: string, files: string[], evidence: string[] = files): ChecklistItem => ({
      id, jobId: id.split(":")[0] as ChecklistItem["jobId"], n: 1, title: id, owner: "agent",
      trigger: { finding: "fixture", evidence: evidence.map((file) => ({ file, line: 1 })) }, allow: { files, create: [] }, checks: [], state: "pending"
    })
    const silent = item("setup_check_fixes:silent_form", ["pages/contact.tsx"])
    expect(withoutConversionCoveredSetupFixes([silent, item("server_conversions:lead", ["pages/api/mailing-list.ts", "pages/mailing-list.tsx"])])).toContain(silent)
    expect(withoutConversionCoveredSetupFixes([silent, item("server_conversions:begin_checkout", ["pages/contact.tsx"])])).toContain(silent)
    expect(withoutConversionCoveredSetupFixes([silent, item("conversions_to_tools:signup", ["pages/contact.tsx"])])).not.toContain(silent)
    expect(withoutConversionCoveredSetupFixes([item("setup_check_fixes:conversion_placement", ["pages/contact.tsx"]), item("server_conversions:lead", ["pages/contact.tsx"])]).map((entry) => entry.id)).toEqual(["server_conversions:lead"])
  })
})

describe("store, live run 3: the mailing-list route only logs the email (it saves nothing)", () => {
  it("no lead job and no silent-form fix for its form; the plan says plainly why, and what would change it", async () => {
    const { checks, candidates, plan, items } = await seeded(logsOnlyRoot)
    // Precondition: the silent-form check still flags the form.
    expect(checks.some((check) => check.checkId === "silent_form" && check.evidence?.some((entry) => "file" in entry && entry.file === "pages/mailing-list.tsx"))).toBe(true)
    for (const list of [candidates, items]) {
      expect(list.map((item) => item.id)).not.toContain("server_conversions:lead")
      expect(list.map((item) => item.id)).not.toContain("setup_check_fixes:silent_form")
      expect(list.some((item) => item.jobId === "conversions_to_tools" && item.id.endsWith(":lead"))).toBe(false)
    }
    // The checkout start and the purchase are still reported from the server.
    expect(items.map((item) => item.id)).toEqual(expect.arrayContaining(["server_conversions:begin_checkout", "server_conversions:purchase"]))
    expect(plan.lines.find((line) => line.id === "user_action:unsaved_form_route:pages/api/mailing-list.ts")?.text).toBe(
      "Your sign-up route (pages/api/mailing-list.ts) doesn't save or subscribe the email yet, so there is no lead to report. Once it does, run the wizard again."
    )
    expect(plan.decisions.conversionNames).not.toContain("lead")
  })

  it("NEGATIVE: the same store whose route subscribes through a provider keeps its lead job, and no such line", async () => {
    const { plan, items } = await seeded()
    expect(items.map((item) => item.id)).toContain("server_conversions:lead")
    expect(plan.lines.some((line) => line.id.startsWith("user_action:unsaved_form_route:"))).toBe(false)
  })
})
