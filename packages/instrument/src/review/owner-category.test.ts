import { expect, it } from "vitest"
import { isReviewResult, omitOwnerPolicyReview } from "./brief.js"
import { emptyLedger, openFindings, recordDecisions } from "./ledger.js"
import { triage, type TriageItem } from "./triage.js"
import { ciFixItem } from "./fix.js"
import { applyClaim } from "../jobs/state-machine.js"
import { item } from "../../test/wizard/repo.js"
import type { ReviewResult } from "../wizard/contracts/agents.js"

const finding = { id: "F1", item: "R1" as const, severity: "blocker" as const, path: "pages/terms.tsx", line: 2, body: "Server secret is inlined in client code. (Not about consent.)", suggested_fix: null }
const review: ReviewResult = { verdict: "changes_suggested", summary: "Review mentions consent incidentally", checklist: [], findings: [finding] }
const context = { allowlist: [finding.path], declinedKeys: new Set<string>(), passingChecks: new Set<string>(), answerFor: () => null }
const triageItem: TriageItem = { ...finding, source: "reviewer", threadId: null, findingId: finding.id, suggestedFix: null }

it("keeps secret/PII findings regardless of consent words or a policy page path", () => {
  expect(omitOwnerPolicyReview(review)).toEqual(review)
  expect(triage([triageItem], context)[0]).toMatchObject({ action: "ASK", askReason: "owner_file" })
  const ledger = emptyLedger("fixture")
  ledger.rounds = [{ round: 1, reviewedSha: "a".repeat(40), reviewer: "codex", fixSha: null, review }]
  expect(openFindings(ledger, [])).toHaveLength(1)
})

it("uses structured owner category for information while retaining the finding", () => {
  const owner = { ...triageItem, category: "owner_consent_privacy" } as TriageItem
  const decision = triage([owner], context)[0]!
  expect(decision.action).toBe("OWNER_INFO")
  const ledger = emptyLedger("fixture")
  recordDecisions(ledger, [decision], 1)
  expect(ledger.findings).toHaveLength(1)
  expect(openFindings(ledger, [])).toHaveLength(0)
})

it("findings on this run's own code stay in scope even when the reviewer labels them owner-only", () => {
  const decision = triage([{ ...triageItem, category: "owner_consent_privacy" } as TriageItem], { ...context, ownership: () => "the wizard's own change" as const })[0]!
  expect(decision.action).toBe("INFINITE")
})

it("an agent's blocked consent note remains blocked and cannot close a review finding", () => {
  const job = item("review_comments:F1", [finding.path])
  const result = applyClaim(job, { jobId: job.id, status: "blocked", note: "consent code in the way", at: "2026-10-07T00:00:00Z" }, () => ({ agrees: false, evidence: [] })).item
  expect(result.state).toBe("blocked")
  const ledger = emptyLedger("fixture")
  recordDecisions(ledger, [{ item: triageItem, action: "FIX", reason: "fix" }], 1)
  expect(openFindings(ledger, [result])).toHaveLength(1)
})

it("R7 selects the last actual CI error rather than an early success message containing error", () => {
  const output = "error tracking configured successfully\n" + "successful setup\n".repeat(500) + "src/broken.ts:1 ERROR actual failure\n"
  expect(ciFixItem(["src/broken.ts"], output).trigger.finding).toContain("actual failure")
})
it("R7 selects the failing step section when Actions logs include step markers", () => {
  const output = "job\tSetup\t2026-10-07 error tracking configured\n" + "job\tSetup\t2026-10-07 success\n".repeat(200) + "job\tBuild\t2026-10-07 src/broken.ts:1 ERROR actual failure\n" + "job\tCleanup\t2026-10-07 configured error tracking\n"
  const excerpt = ciFixItem(["src/broken.ts"], output).trigger.finding
  expect(excerpt).toContain("actual failure")
  expect(excerpt).not.toContain("Setup")
})

it("keeps a category-labelled finding on the run's agent-written capture fixable", () => {
  const decision = triage([{ ...triageItem, path: "src/capture.ts", category: "owner_consent_privacy" }], { ...context, allowlist: ["src/capture.ts"], writtenByRun: () => true })[0]!
  expect(decision.action).toBe("FIX")
})

it("accepts structured category in fresh reviews and leaves legacy missing-category findings in scope", () => {
  expect(isReviewResult(review)).toBe(true)
  expect(isReviewResult({ ...review, findings: [{ ...finding, category: "owner_consent_privacy" }] })).toBe(true)
  expect(isReviewResult({ ...review, findings: [{ ...finding, category: "trust_me" }] })).toBe(false)
})

it("uses receipt edit ranges to keep a real capture finding in scope", async () => {
  const { wizardOwnership } = await import("./ownership.js")
  const source = "function capture() {\n  if (!window.__infiniteConsentAllowed()) return;\n}\n"
  const receipt = { edits: [{ by: "agent", file: "src/tracking.ts", beforeHash: "prior", textEdits: [{ offset: 0, removed: "", inserted: source }] }] }
  const ownership = await wizardOwnership({ fs: { readText: async (path: string) => path.endsWith("install.json") ? JSON.stringify(receipt) : path.endsWith("src/tracking.ts") ? source : null } } as never, "/fixture", async () => true)
  const current: TriageItem = { ...triageItem, path: "src/tracking.ts", category: "owner_consent_privacy", body: "Our new capture's gate does not read the existing decision" }
  expect(ownership.writtenByRun?.(current.path!, 2)).toBe(true)
  expect(triage([current], { ...context, allowlist: [current.path!], ownership: ownership.classify, writtenByRun: ownership.writtenByRun })[0]?.action).toBe("FIX")
  const ledger = emptyLedger("fixture")
  recordDecisions(ledger, [{ item: current, action: "OWNER_INFO", reason: "stale category" }], 1)
  expect(openFindings(ledger, [], ownership.classify, ownership.writtenByRun)).toHaveLength(1)
})

it("R7 never appends a changed-neither claim to an unmeasured PR or final comment", async () => {
  const { buildPrBody, buildFinalComment } = await import("./post.js")
  const { createScanner } = await import("./scan.js")
  const scanner = createScanner({ literals: [], allowedIds: [] })
  const pr = buildPrBody({ reportMarkdown: "Unmeasured report", howToReview: "Review changes", runId: "fixture", isPrivate: true, diffText: "", connectionIds: [], scanner })
  const final = buildFinalComment({ runId: "fixture", reportMarkdown: "Unmeasured report", reviewer: null, reviewed: false, jobs: [], decisions: [], untrusted: [], notes: [], scanner })
  expect(pr).not.toContain("changed neither")
  expect(final).not.toContain("changed neither")
})

it("R7 shows the exact owner guard and distinguishes a restored edit from a withheld guard", async () => {
  const { buildChecklist, jobStateCell } = await import("./post.js")
  const { buildHostGuardExpression } = await import("../host-guard.js")
  const guard = `if (${buildHostGuardExpression({ mode: "allow", hosts: ["fictional.test"] })}) {\n  // Existing analytics start-up statements go here.\n}`
  const note = "Not changed by us: GA4's start-up code at src/tracking.ts:7 also handles consent, which is yours. Until you add the guard there, preview and local visits keep counting in GA4."
  const withheld = { ...item("preview_guard:ga4", ["src/tracking.ts"]), state: "left_for_you" as const, note, ownerBoundary: { kind: "frozen_unit" as const, file: "src/tracking.ts", line: 7, guard } }
  expect(jobStateCell(withheld)).toBe(note)
  const checklist = buildChecklist([withheld])
  expect(checklist).toContain(guard)
  expect(checklist).toContain("src/tracking.ts:7")
  expect(jobStateCell({ ...withheld, note: "ignored old note", ownerBoundary: { kind: "restored_unit" } })).toBe("Put back: an edit reached code that handles consent.")
})

it("R7 treats a stale assertion string as text, never as measurement authority", async () => {
  const { buildPrBody } = await import("./post.js")
  const { createScanner } = await import("./scan.js")
  const { OWNER_BOUNDARY } = await import("../jobs/owner-boundary.js")
  const output = buildPrBody({ reportMarkdown: OWNER_BOUNDARY, howToReview: "Review changes", runId: "fixture", isPrivate: true, diffText: "", connectionIds: [], scanner: createScanner({ literals: [], allowedIds: [] }) })
  expect(output).not.toContain("changed neither")
})

it("keeps manual installer wiring distinct from a preview guard", async () => {
  const { buildChecklist } = await import("./post.js")
  const wiring = 'import { AnalyticsClient } from "./analytics-client";\n<AnalyticsClient />'
  const manual = { ...item("unusual_layout:owner_wiring", ["app/layout.tsx"]), state: "left_for_you" as const, note: "Not changed by us: this entrypoint handles consent.", ownerBoundary: { kind: "frozen_unit" as const, file: "app/layout.tsx", wiring } }
  const text = buildChecklist([manual])
  expect(text).toContain(wiring)
  expect(text).toContain("has not been applied")
  expect(text).not.toContain("Apply this condition")
})
