// Live run 2 (P0-2): the store's mailing-list form was seeded twice, as the lead server job AND as a silent-form setup
// fix. The silent-form edit sent GA4 and PostHog a second lead beside the site's own generate_lead (a double count), and
// its co-ownership of the page put the lead's own lines back. A setup-check conversion fix is never seeded for a form
// a server or browser conversion job already covers.
import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
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
const RUN_ID = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"

let root = ""
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tag-store-silent-form-"))
  cpSync(STORE, root, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore", env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1" } })
  git("init", "-q")
  git("add", "-A")
  git("-c", "user.email=store@example.com", "-c", "user.name=Store", "commit", "-qm", "store")
})
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

async function seeded() {
  const keys = fixtureKeys()
  const installer = createWizardInstaller({
    root,
    repoFingerprint: `sha256:${"a".repeat(64)}`,
    runId: () => RUN_ID,
    agent: () => ({ worker: "claude_code", whoPays: null }),
    consentFlag: () => null,
    productionDeniedConflict: () => []
  })
  const scan = await installer.scan({ root, hosting: fixtureHosting() })
  // The before step's setup checks, as the live run had them (the form is flagged as silent).
  const ctx = { runId: RUN_ID, now: () => new Date("2026-10-08T10:00:00.000Z") }
  const checks = runSetupChecks(root, { repoRoot: root }).findings.filter((finding) => finding.state === "problem").map((finding) => setupFindingResult(finding, ctx))
  const before: BeforeFacts = { hosting: fixtureHosting(), keys, census: runCensus({ root, appRoot: "." }), dryLive: null, checks, observedProductionHost: "www.halden-audio.example" }
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
