import { expect, it } from "vitest"
import { verdictFactsFor } from "../wizard/verdict-facts.js"
import { triage, type TriageItem } from "./triage.js"
import { buildReviewPost } from "./post.js"
import { createScanner } from "./scan.js"

it("redacts owner-category review text before it reaches report facts", async () => {
  const secret = "sk_test_" + "fixtureSecretValue".repeat(2)
  const body = `${secret} <!-- @here [open](https://example.test) ![image](https://example.test)`
  const ledger = { version: 1, runId: "fixture", rounds: [], declined: [], open: [], findings: [{ key: "x", findingId: "F1", category: "owner_consent_privacy", item: "R1", severity: "blocker", path: "src/main.ts", line: 1, action: "OWNER_INFO", body }] }
  const ctx = { root: "/fixture", appRoot: ".", runId: "fixture", state: { get: () => ({ runId: "fixture", jobs: [], git: null }) } }
  const deps = { env: {}, bridge: {}, git: {}, fs: { readText: async (path: string) => path.endsWith("review-ledger.json") ? JSON.stringify(ledger) : null } }
  const facts = await verdictFactsFor(ctx as never, deps as never)
  const text = facts.ownerPolicyFindings!.join("\n")
  expect(text).not.toContain(secret)
  for (const active of ["<!--", "@here", "](https:"]) expect(text).not.toContain(active)
  const post = buildReviewPost({ review: { verdict: "changes_suggested", summary: body, checklist: [], findings: [{ id: "F1", item: "R1", severity: "blocker", category: "owner_consent_privacy", path: "src/main.ts", line: null, body, suggested_fix: null }] }, diffFiles: [], scanner: createScanner({ literals: [], allowedIds: [] }), runId: "fixture", round: 1, head: "a".repeat(40), reviewer: "codex" })
  expect(post.body).not.toContain(secret)
  for (const active of ["<!-- @here", "@here", "](https:"]) expect(post.body).not.toContain(active)
})

it.each([
  "PII phone numbers are sent to the Meta pixel unhashed",
  "Secret key exposed in GA4 proxy code",
  "The delete pixel path exposes a server credential"
])("never auto-declines a blocker from wording: %s", body => {
  const finding: TriageItem = { source: "reviewer", threadId: null, findingId: "F1", item: "R1", severity: "blocker", path: "src/main.ts", line: 1, body, suggestedFix: null }
  expect(triage([finding], { allowlist: [finding.path!], declinedKeys: new Set(), passingChecks: new Set(), answerFor: () => null })[0]!.action).toBe("FIX")
})

it("keeps a structured security defect open even when unrelated deterministic checks passed", () => {
  const finding: TriageItem = { source: "reviewer", threadId: null, findingId: "F2", item: "R2", severity: "should", category: "security", path: "src/main.ts", line: 1, body: "PII phone is sent to the pixel; credential in the proxy", suggestedFix: null }
  expect(triage([finding], { allowlist: [finding.path!], declinedKeys: new Set(), passingChecks: new Set(["duplicate_page_views", "one_pageview_per_visit"]), answerFor: () => null })[0]!.action).toBe("FIX")
})
