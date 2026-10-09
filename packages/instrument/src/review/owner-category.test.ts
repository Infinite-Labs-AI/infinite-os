import { expect, it } from "vitest"
import { omitOwnerPolicyReview } from "./brief.js"
import { emptyLedger, openFindings, recordDecisions } from "./ledger.js"
import { RULINGS, triage, triageKey, type TriageItem } from "./triage.js"
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
  const owner = { ...triageItem, category: "owner_consent_privacy", severity: "nit", body: "Owner wording in the terms page" } as TriageItem
  const decision = triage([owner], context)[0]!
  expect(decision.action).toBe("OWNER_INFO")
  const ledger = emptyLedger("fixture")
  recordDecisions(ledger, [decision], 1)
  ledger.rounds = [{ round: 1, reviewedSha: "a".repeat(40), reviewer: "codex", fixSha: null, review: { ...review, findings: [{ ...finding, category: "owner_consent_privacy", severity: "nit", body: owner.body }] } }]
  expect(ledger.findings).toHaveLength(1)
  expect(openFindings(ledger, [])).toHaveLength(0)
})

it("an agent's blocked consent note remains blocked and cannot close a review finding", () => {
  const job = item("review_comments:F1", [finding.path])
  const result = applyClaim(job, { jobId: job.id, status: "blocked", note: "consent code in the way", at: "2026-10-07T00:00:00Z" }, () => ({ agrees: false, evidence: [] })).item
  expect(result.state).toBe("blocked")
  const ledger = emptyLedger("fixture")
  recordDecisions(ledger, [{ item: triageItem, action: "FIX", reason: "fix" }], 1)
  expect(openFindings(ledger, [result])).toHaveLength(1)
})

it("keeps a blocker on run-written capture open for the owner", () => {
  const decision = triage([{ ...triageItem, path: "src/capture.ts", category: "owner_consent_privacy" }], { ...context, allowlist: ["src/capture.ts"], writtenByRun: () => true })[0]!
  expect(decision.action).toBe("ASK")
})

it("keeps a blocker open even when its owner category refers to this run's code", async () => {
  const { wizardOwnership } = await import("./ownership.js")
  const source = "function capture() {\n  if (!window.__infiniteConsentAllowed()) return;\n}\n"
  const receipt = { edits: [{ by: "agent", file: "src/tracking.ts", beforeHash: "prior", textEdits: [{ offset: 0, removed: "", inserted: source }] }] }
  const ownership = await wizardOwnership({ fs: { readText: async (path: string) => path.endsWith("install.json") ? JSON.stringify(receipt) : path.endsWith("src/tracking.ts") ? source : null } } as never, "/fixture", async () => true)
  const current: TriageItem = { ...triageItem, path: "src/tracking.ts", category: "owner_consent_privacy", body: "Our new capture's gate does not read the existing decision" }
  expect(ownership.writtenByRun?.(current.path!, 2)).toBe(true)
  expect(triage([current], { ...context, allowlist: [current.path!], ownership: ownership.classify, writtenByRun: ownership.writtenByRun })[0]?.action).toBe("ASK")
  const ledger = emptyLedger("fixture")
  recordDecisions(ledger, [{ item: current, action: "OWNER_INFO", reason: "stale category" }], 1)
  expect(openFindings(ledger, [], ownership.classify, ownership.writtenByRun)).toHaveLength(1)
})

const requestRulings = [
  ["request_ga4_proxy", "ga4_proxy", "R11"],
  ["request_meta_unsupported", "meta_never_list", "R8"],
  ["request_meta_deletion", "no_deletion", null]
] as const

it("does not decline security or legacy findings because their text mentions a standing ruling", () => {
  for (const category of [undefined, "security"] as const) {
    for (const body of ["PII phone sent to the Meta pixel unhashed", "GA4 proxy sends a secret header to the browser", "Delete leaked credentials from Meta payloads"]) {
      const current: TriageItem = { ...triageItem, category, path: "src/capture.ts", severity: "should", item: "R11", body }
      expect(triage([current], { ...context, allowlist: [current.path!], passingChecks: new Set(["posthog_via_proxy_once"]) })[0]?.action).toBe("FIX")
    }
  }
})

it("only closes structured non-blocker requests with a matching ruling", () => {
  for (const [category, rulingId, violationItem] of requestRulings) {
    const ruling = RULINGS.find(entry => entry.id === rulingId)!
    for (const format of ["findings", "rounds"] as const) {
      for (const variant of ["request", "blocker", "mismatch", ...(violationItem ? ["violation"] : [])]) {
        const current: TriageItem = { ...triageItem, category, path: "src/capture.ts", body: "Please add this unsupported capability", severity: variant === "blocker" ? "blocker" : "should", item: variant === "violation" ? violationItem : "R1" }
        const chosen = variant === "mismatch" ? RULINGS.find(entry => entry.id === "banner_consent")! : ruling
        const ledger = emptyLedger("fixture")
        if (format === "findings") recordDecisions(ledger, [{ item: current, action: "DECLINE", ruling: chosen.id, reason: chosen.reply }], 1)
        else {
          ledger.rounds = [{ round: 1, reviewedSha: "a".repeat(40), reviewer: "codex", fixSha: null, review: { ...review, findings: [{ ...finding, category, path: current.path!, severity: current.severity, item: current.item!, body: current.body }] } }]
          ledger.declined = [{ key: triageKey(current), reason: chosen.reply, round: 1 }]
        }
        expect(openFindings(ledger, []), `${format}: ${category}: ${variant}`).toHaveLength(variant === "request" || variant === "violation" ? 0 : 1)
      }
    }
  }
})
