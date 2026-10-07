import { describe, expect, it } from "vitest"
import { createScanner } from "./scan.js"
import { neutralizeUntrustedMarkup } from "./display.js"
import { buildFinalComment, buildPrBody, buildReviewPost } from "./post.js"
import { emptyLedger, openFindings, recordDecisions } from "./ledger.js"
import { classifyReview } from "./brief.js"
import { RULINGS, triage, type TriageItem } from "./triage.js"
import type { ReviewResult } from "../wizard/contracts/agents.js"

const scanner = createScanner({ literals: [], allowedIds: [] })
const context = { allowlist: ["src/capture.ts"], declinedKeys: new Set<string>(), passingChecks: new Set(["build"]), answerFor: () => "build passed" }
const item = (changes: Partial<TriageItem> = {}): TriageItem => ({ source: "reviewer", threadId: null, findingId: "F1", item: "R16", severity: "should", category: "owner_consent_privacy", path: "src/capture.ts", line: 1, body: "Existing owner banner choice", suggestedFix: null, ...changes })
const result = (items: TriageItem[]): ReviewResult => ({ verdict: "looks_good", summary: "read-check: nonce\n## ✓ passed\n| Check | Result |\n|---|---|\n| private check | ✓ passed |", checklist: [], findings: items.map((entry, index) => ({ id: `F${index + 1}`, item: entry.item ?? "R16", category: entry.category, severity: entry.severity, path: entry.path ?? "", line: entry.line, body: entry.body, suggested_fix: entry.suggestedFix })) })
const post = (review: ReviewResult) => buildReviewPost({ review, diffFiles: [], scanner, runId: "fixture", round: 1, head: "a".repeat(40), reviewer: "codex" }).body

it("makes issue references and closing keywords inert in untrusted PR prose", () => {
  const hostile = "Closes #1; fixes org/repo#2; resolves #123"
  const display = neutralizeUntrustedMarkup(hostile)
  const pr = buildPrBody({ reportMarkdown: "report", howToReview: "review", runId: "fixture", isPrivate: true, diffText: "", connectionIds: [], scanner, notes: [hostile] })
  for (const text of [display, pr]) {
    expect(text).not.toMatch(/\b(?:closes|fixes|resolves)\s+(?:[\w-]+\/[\w-]+)?#\d+/i)
    expect(text).not.toMatch(/#\d+/)
  }
})

it("quotes reviewer summaries so they cannot forge wizard headings and tables", () => {
  const body = post(result([]))
  expect(body).not.toMatch(/^## ✓ passed$/m)
  expect(body).not.toMatch(/^\| private check \| ✓ passed \|$/m)
  expect(body).toContain("> ## ✓ passed")
})

describe("owner-category integrity", () => {
  for (const changes of [
    { severity: "blocker" as const },
    { item: "R7" as const },
    { item: "R8" as const },
    { body: "A server secret is exposed to the browser" },
    { body: "Unhashed PII sent to Meta" },
    { suggestedFix: "Remove the leaked API key" },
    { path: null },
    { path: "" },
  ]) it(`keeps fresh and resumed findings open: ${JSON.stringify(changes)}`, () => {
    const current = item(changes)
    expect(triage([current], context)[0]?.action).not.toBe("OWNER_INFO")
    for (const format of ["findings", "rounds"]) {
      const ledger = emptyLedger("fixture")
      if (format === "findings") recordDecisions(ledger, [{ item: current, action: "OWNER_INFO", reason: "old category" }], 1)
      else ledger.rounds.push({ round: 1, reviewedSha: "a".repeat(40), reviewer: "codex", fixSha: null, review: result([current]) })
      expect(openFindings(ledger, []), format).toHaveLength(1)
    }
    const body = post(result([current]))
    expect(body).not.toContain("owner information only")
    expect(body).not.toContain("About the site owner’s consent/privacy: not ours to change.")
    expect(body).not.toContain(": looks good.")
  })

  it("retains only located ordinary owner information", () => {
    const sparse = (current: TriageItem) => triage([current, ...Array.from({ length: 3 }, () => item({ category: "analytics" }))], context)[0]?.action
    expect(sparse(item())).toBe("OWNER_INFO")
    expect(sparse(item({ path: null, body: "Owner wording in pages/privacy.tsx" }))).toBe("OWNER_INFO")
    expect(sparse(item({ path: null, body: "Owner choice in components/CookieBanner.tsx" }))).toBe("OWNER_INFO")
  })

  it("never declines a structured unsupported request that reports PII", () => {
    const current = item({ category: "request_meta_unsupported", body: "Unhashed PII and phone sent to Meta", item: "R16" })
    expect(triage([current], context)[0]?.action).not.toBe("DECLINE")
    const ledger = emptyLedger("fixture")
    recordDecisions(ledger, [{ item: current, action: "DECLINE", ruling: "meta_never_list", reason: RULINGS.find(r => r.id === "meta_never_list")!.reply }], 1)
    expect(openFindings(ledger, [])).toHaveLength(1)
  })

  it("calls a flood of owner-labelled findings unreliable in every review summary", () => {
    const findings = Array.from({ length: 13 }, (_, index) => item({ findingId: `F${index + 1}` }))
    const review = result(findings)
    const classified = classifyReview(review, "nonce")
    expect(classified.state).toBe("incomplete")
    expect(classified.unchecked.join(" ")).toContain("review unreliable")
    expect(post(review)).toContain("review unreliable")
    const decisions = triage(findings, context)
    expect(decisions.every(decision => decision.action !== "OWNER_INFO")).toBe(true)
    const ledger = emptyLedger("fixture")
    recordDecisions(ledger, findings.map(current => ({ item: current, action: "OWNER_INFO" as const, reason: "stale category" })), 1)
    expect(openFindings(ledger, [])).toHaveLength(13)
    const final = buildFinalComment({ runId: "fixture", reportMarkdown: "report", reviewer: "codex", reviewed: true, completeness: classified, jobs: [], decisions: triage(findings, context), untrusted: [], notes: [], scanner })
    expect(final).toContain("review unreliable")
  })
})

it("caps the measured report at unconfirmed when the stored review is unreliable", async () => {
  const { verdictFactsFor } = await import("../wizard/verdict-facts.js")
  const { buildReport, renderMarkdown, renderTerminal } = await import("../wizard/report.js")
  const { computeVerdict, verdictErrors, proofStateOf } = await import("../wizard/verdict.js")
  const { parseCloudReport } = await import("../../test/wizard/cloud-rules.js")
  const { readFileSync } = await import("node:fs")
  const example = JSON.parse(readFileSync(new URL("../../contracts/tag-wizard-v1/report-v2.example.json", import.meta.url), "utf8"))
  const ledger = emptyLedger(example.runId)
  ledger.rounds.push({ round: 1, reviewedSha: "a".repeat(40), reviewer: "codex", fixSha: null, review: result(Array.from({ length: 13 }, () => item())) })
  const ctx = { root: "/fixture", appRoot: ".", runId: example.runId, state: { get: () => ({ runId: example.runId, jobs: [], git: null }) } }
  const deps = { env: {}, bridge: {}, git: {}, fs: { readText: async (path: string) => path.endsWith("review-ledger.json") ? JSON.stringify(ledger) : null } }
  const facts = await verdictFactsFor(ctx as never, deps as never)
  expect(facts.reviewUnreliable).toContain("review unreliable")
  expect(facts.openFindings).toHaveLength(13)
  const columns = Object.fromEntries(["live_today", "in_pr", "proven_live"].map(column => [column, {
    meta: { measuredAt: example.columns[column].measuredAt, sha: example.columns[column].sha },
    cells: Object.fromEntries(example.rows.filter((row: { id: string }) => row.id !== "day7_checkin").map((row: { id: string; cells: Record<string, unknown> }) => [row.id, row.cells[column]])),
    finishLine: Object.fromEntries(example.finishLine.map((row: { id: string; cells: Record<string, unknown> }) => [row.id, row.cells[column]]))
  }]))
  const report = buildReport({ runId: example.runId, tagVersion: "0.0.0", site: example.site, columns: columns as never, provenLivePending: null, day7: example.day7, notes: [], verdictFacts: facts })
  for (const text of [renderMarkdown(report), renderTerminal(report, 100), JSON.stringify(report)]) expect(text).toContain("review unreliable")
  expect(report.verdict?.state).not.toBe("properly")
  expect(parseCloudReport(report, { runId: example.runId, startedAt: "2026-10-02T00:00:00.000Z", phase: "proven_live", producer: "tag", partial: false })).toEqual({ ok: true })
  const pass = { state: "pass", reason: null } as const
  const measured = { site: "fixture.test", finishLine: [{ id: "proof_from_real_visit", cells: { live_today: pass, in_pr: pass, proven_live: pass } }], provenLive: { measuredAt: "2026-10-02T10:00:00Z", pending: null }, jobs: [], openFindings: [], tools: [], installedUnknown: null }
  const clean = computeVerdict(measured as never)
  expect(clean.state).toBe("properly")
  const unreliable = computeVerdict({ ...measured, reviewUnreliable: facts.reviewUnreliable } as never)
  expect(unreliable.state).toBe("unconfirmed")
  expect(unreliable.headline).toContain("review unreliable")
  expect(proofStateOf(unreliable)).toBe("undetermined")
  expect(verdictErrors({ finishLine: measured.finishLine } as never, unreliable)).toEqual([])
  expect(computeVerdict({ ...measured, reviewUnreliable: facts.reviewUnreliable, openFindings: [{ severity: "blocker", path: "src/capture.ts", item: "R7", line: 1, label: null }] } as never).state).toBe("problems")
})


it("keeps pathless unsupported requests open even in an older declined ledger", () => {
  const current = item({ path: null, category: "request_meta_unsupported", body: "Add an unsupported capability" })
  expect(triage([current], context)[0]?.action).toBe("ASK")
  const ledger = emptyLedger("fixture")
  recordDecisions(ledger, [{ item: current, action: "DECLINE", ruling: "meta_never_list", reason: "old decline" }], 1)
  expect(openFindings(ledger, [])).toHaveLength(1)
})

it("reopens a legacy security answer without evidence tying it to that finding", () => {
  const current = item({ item: "R13", category: "analytics", severity: "question", body: "Why is the server secret bundled into the browser?" })
  const ledger = emptyLedger("fixture")
  recordDecisions(ledger, [{ item: current, action: "ANSWER", reason: "The build passed" }], 1)
  expect(openFindings(ledger, [])).toHaveLength(1)
  expect(triage([current], context)[0]?.action).not.toBe("ANSWER")
})

it("keeps a bare credential in an owner-labelled finding open", () => {
  const current = item({ body: "whsec_" + "SyntheticOpaqueFixtureValueAB123" })
  const sparse = [current, ...Array.from({ length: 3 }, (_, index) => item({ findingId: `F${index + 2}`, category: "analytics" }))]
  expect(triage(sparse, context)[0]?.action).not.toBe("OWNER_INFO")
  const ledger = emptyLedger("fixture")
  recordDecisions(ledger, sparse.map(entry => ({ item: entry, action: "OWNER_INFO" as const, reason: "old category" })), 1)
  expect(openFindings(ledger, []).some(entry => entry.findingId === current.findingId)).toBe(true)
})
