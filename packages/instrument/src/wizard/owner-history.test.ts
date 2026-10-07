import { describe, expect, it } from "vitest"
import { item } from "../../test/wizard/repo.js"
import { leaveForOwner } from "../jobs/state-machine.js"
import { OWNER_BOUNDARY, OWNER_BOUNDARY_UNMEASURED } from "../jobs/owner-boundary.js"
import { buildFinalComment, buildPrBody } from "../review/post.js"
import { createScanner } from "../review/scan.js"
import { buildReport, renderMarkdown, renderTerminal } from "./report.js"
import { verdictFactsFor } from "./verdict-facts.js"
import type { VerdictFacts } from "./contracts/report.js"
import type { WizardContext, WizardDeps } from "./contracts/deps.js"

const RUN = "11111111-1111-4111-8111-111111111111"
const LEGACY = "Consent and your privacy policy are yours. An earlier version of this run recorded policy edits; this continuation left them alone."
const LEGACY_UNMEASURED = "Your consent code and privacy policy are yours. An earlier version of this run recorded policy edits; their final diff has not been checked."
const legacyJob = leaveForOwner({ ...item("privacy_paragraph:page", ["app/privacy/page.tsx"]), state: "done_in_code", edits: [{ editId: "legacy-policy-edit", file: "app/privacy/page.tsx" }] }).item
const facts = (jobs: VerdictFacts["jobs"] = []): VerdictFacts => ({ jobs, openFindings: [], tools: null, installedUnknown: null })
const reportFor = (verdictFacts = facts()) => buildReport({
  runId: RUN, tagVersion: "0.0.0", site: { repoLabel: "example/site", productionHost: null },
  columns: { live_today: null, in_pr: null, proven_live: null }, provenLivePending: null,
  day7: null, notes: [], verdictFacts
})
const scanner = createScanner({ literals: [], allowedIds: [] })

describe("report owner boundary preserves legacy edit history", () => {
  // The new-run sentence is deliberately different for a persistent run whose older release
  // recorded policy work. Retiring a job does not erase that history or reverse its files.
  it("uses saved job edit references without reading policy, and serializes the exception in notes", () => {
    const report = reportFor(facts([legacyJob]))
    expect(report.notes).toContain(LEGACY_UNMEASURED)
    for (const output of [renderMarkdown(report), renderTerminal(report, 240)]) {
      expect(output).toContain(LEGACY_UNMEASURED)
      expect(output).not.toContain(OWNER_BOUNDARY)
      expect(output.split(LEGACY_UNMEASURED)).toHaveLength(2)
    }
    expect(legacyJob.edits).toEqual([{ editId: "legacy-policy-edit", file: "app/privacy/page.tsx" }])
  })

  it("does not make an unchanged assertion for a new unmeasured run", () => {
    const report = reportFor()
    expect(renderMarkdown(report)).toContain(OWNER_BOUNDARY_UNMEASURED)
    expect(renderTerminal(report, 240)).toContain(OWNER_BOUNDARY_UNMEASURED)
    expect(report.notes).not.toContain(LEGACY)
  })

  it.each([true, false])("uses receipt metadata only, scoped to this run: sameRun=%s", async sameRun => {
    const read: string[] = []
    const ctx = { root: "/fixture", appRoot: ".", runId: RUN, state: { get: () => ({ runId: RUN, jobs: [], git: null, proof: null }) } } as unknown as WizardContext
    const deps = { git: {}, fs: { readText: async (path: string) => {
      read.push(path)
      if (path === "/fixture/.infinite/install.json") return JSON.stringify({ edits: [{ id: "e", file: "app/privacy/page.tsx", jobId: "privacy_paragraph", by: "agent", runId: sameRun ? RUN : "older-run" }] })
      if (path === "/fixture/.infinite/wizard/review.json") return null
      if (path.includes(".infinite/")) return null
      throw new Error("Policy content must never be read")
    } } } as unknown as WizardDeps
    const report = reportFor(await verdictFactsFor(ctx, deps))
    expect(renderMarkdown(report)).toContain(sameRun ? LEGACY_UNMEASURED : OWNER_BOUNDARY_UNMEASURED)
    expect(read.some(path => path.includes("app/privacy/"))).toBe(false)
    expect(read.filter(path => path === "/fixture/.infinite/install.json")).toHaveLength(1)
  })

  it("PR and final-comment fallbacks neither append nor retain a contradictory new-run assertion", () => {
    const body = buildPrBody({ reportMarkdown: LEGACY, howToReview: "", runId: RUN, isPrivate: true, diffText: "", connectionIds: [], scanner })
    expect(body).toContain(LEGACY_UNMEASURED)
    expect(body).not.toContain(OWNER_BOUNDARY)
    const final = buildFinalComment({ runId: RUN, reportMarkdown: OWNER_BOUNDARY, reviewer: null, reviewed: false, jobs: [legacyJob], decisions: [], untrusted: [], notes: [], scanner })
    expect(final).toContain(LEGACY_UNMEASURED)
    expect(final).not.toContain(OWNER_BOUNDARY)
  })
})
