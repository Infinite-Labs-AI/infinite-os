import { expect, it } from "vitest"
import { verdictFactsFor } from "../wizard/verdict-facts.js"
import { triage, type TriageItem } from "./triage.js"
import { buildReviewPost, buildReply, safeText, buildFinalComment, buildChecklist, buildPrBody } from "./post.js"
import { createScanner } from "./scan.js"

it("keeps an owner-labelled secret blocker open without presenting it as owner information", async () => {
  const secret = "sk_test_" + "fixtureSecretValue".repeat(2)
  const body = `${secret} <!-- @here [open](https://example.test) ![image](https://example.test)`
  const ledger = { version: 1, runId: "fixture", rounds: [], declined: [], open: [], findings: [{ key: "x", findingId: "F1", category: "owner_consent_privacy", item: "R1", severity: "blocker", path: "src/main.ts", line: 1, action: "OWNER_INFO", body }] }
  const ctx = { root: "/fixture", appRoot: ".", runId: "fixture", state: { get: () => ({ runId: "fixture", jobs: [], git: null }) } }
  const deps = { env: {}, bridge: {}, git: {}, fs: { readText: async (path: string) => path.endsWith("review-ledger.json") ? JSON.stringify(ledger) : null } }
  const facts = await verdictFactsFor(ctx as never, deps as never)
  expect(facts.ownerPolicyFindings).toEqual([])
  expect(facts.openFindings).toHaveLength(1)
  const text = JSON.stringify(facts)
  expect(text).not.toContain(secret)
  for (const active of ["<!--", "@here", "](https:"]) expect(text).not.toContain(active)
  const post = buildReviewPost({ review: { verdict: "changes_suggested", summary: body, checklist: [], findings: [{ id: "F1", item: "R1", severity: "blocker", category: "owner_consent_privacy", path: "src/main.ts", line: null, body, suggested_fix: null }] }, diffFiles: [], scanner: createScanner({ literals: [], allowedIds: [] }), runId: "fixture", round: 1, head: "a".repeat(40), reviewer: "codex" })
  expect(post.body).not.toContain(secret)
  for (const active of ["<!-- @here", "@here", "](https:"]) expect(post.body).not.toContain(active)
})

it.each([
  "PII phone numbers are sent to the Meta pixel unhashed",
])("never auto-declines a blocker from wording: %s", body => {
  const finding: TriageItem = { source: "reviewer", threadId: null, findingId: "F1", item: "R1", severity: "blocker", path: "src/main.ts", line: 1, body, suggestedFix: null }
  expect(triage([finding], { allowlist: [finding.path!], declinedKeys: new Set(), passingChecks: new Set(), answerFor: () => null })[0]!.action).toBe("FIX")
})

it("keeps a structured security defect open even when unrelated deterministic checks passed", () => {
  const finding: TriageItem = { source: "reviewer", threadId: null, findingId: "F2", item: "R2", severity: "should", category: "security", path: "src/main.ts", line: 1, body: "PII phone is sent to the pixel; credential in the proxy", suggestedFix: null }
  expect(triage([finding], { allowlist: [finding.path!], declinedKeys: new Set(), passingChecks: new Set(["census_one_per_tool"]), answerFor: () => null })[0]!.action).toBe("FIX")
})

it("redacts a secret before a display limit can split its literal", async () => {
  const { safeDisplayText } = await import("./display.js")
  const secret = "opaqueFixtureCredentialValueForRedaction"
  const scanner = createScanner({ literals: [{ value: secret, kind: "env_value" }], allowedIds: [] })
  const text = safeDisplayText(scanner, "safe ".repeat(13_104) + " " + secret)
  expect(text).not.toContain("opaqueFixture")
})

it("redacts whole literals before the assembled PR size cap", () => {
  const secret = "opaqueFixtureCredentialValueForRedaction"
  const scanner = createScanner({ literals: [{ value: secret, kind: "env_value" }], allowedIds: [] })
  expect(safeText(scanner, "safe ".repeat(13_104) + " " + secret).includes("opaqueFixture")).toBe(false)
})

it("redacts and neutralizes failed-fix explanations before excerpting", () => {
  const secret = "opaqueFixtureCredentialValueForRedaction"
  const scanner = createScanner({ literals: [{ value: secret, kind: "env_value" }], allowedIds: [] })
  const decision = { action: "FIX", item: { path: "src/main.ts" }, reason: "fix" } as never
  for (const outcome of ["undone", "gate_refused", "blocked", "checks_failed"] as const) {
    for (const why of [`${secret} <!-- @here [open](https://example.test)`, "x".repeat(190) + secret]) {
      const reply = buildReply(scanner, decision, { kind: "not_fixed", outcome, why })
      expect(reply).not.toContain("opaqueFixture")
      expect(reply).not.toContain("<!-- @here")
      expect(reply).not.toContain("@here")
      expect(reply).not.toContain("](https:")
    }
  }
})

it("rescans a literal exposed by stripping terminal controls", () => {
  const secret = "opaqueFixtureCredentialValueForRedaction"
  const scanner = createScanner({ literals: [{ value: secret, kind: "env_value" }], allowedIds: [] })
  const disguised = secret.slice(0, 13) + "\u001b[0m" + secret.slice(13)
  expect(safeText(scanner, disguised)).toBe("[redacted: env_value]")
})

it("withholds an unsafe owner snippet instead of presenting redacted code as copyable", () => {
  const secret = "opaqueFixtureCredentialValueForRedaction"
  const scanner = createScanner({ literals: [{ value: secret, kind: "env_value" }], allowedIds: [] })
  const job = { title: "Owner guard", state: "left_for_you", allow: { files: ["src/main.ts"] }, ownerBoundary: { kind: "frozen_unit", guard: `if (ok) start("${secret}");` } } as never
  const body = buildFinalComment({ runId: "fixture", reportMarkdown: "report", reviewer: null, reviewed: false, jobs: [job], decisions: [], untrusted: [], notes: [], scanner })
  expect(body).toContain("snippet was withheld")
  expect(body).not.toContain(secret)
  expect(body).not.toContain('start("[redacted:')
})

it.each([
  { label: "database password", text: "postgres://appuser:fixturePassword@db.example/app", secret: "fixturePassword", kind: "url_password" },
  { label: "known environment literal", text: "opaque@fixture|credential", secret: "opaque", kind: "env_value" }
])("redacts raw $label before rendering checklist titles and notes", ({ text, secret, kind }) => {
  const scanner = createScanner({ literals: [{ value: "opaque@fixture|credential", kind: "env_value" }], allowedIds: [] })
  const jobs = [{ title: text, state: "failed", note: text, jobId: "posthog_improve", allow: { files: [] } }] as never
  const checklist = buildChecklist(jobs, scanner)
  const comment = buildFinalComment({ runId: "fixture", reportMarkdown: "report", reviewer: null, reviewed: false, jobs, decisions: [], untrusted: [], notes: [], scanner })
  const body = buildPrBody({ runId: "fixture", reportMarkdown: checklist, howToReview: "", isPrivate: true, diffText: "", connectionIds: [], scanner })
  for (const output of [checklist, comment, body]) {
    expect(output).not.toContain(secret)
    expect(output).toContain(`[redacted: ${kind}]`)
  }
})

it("quotes every note line in PR bodies and final comments", () => {
  const scanner = createScanner({ literals: [], allowedIds: [] })
  const note = "Agent note\n\n## Forged result\n| Check | Result |\n|---|---|\n| forged | ✓ passed |\n> - [x] forged complete GH-12"
  const outputs = [
    buildPrBody({ runId: "fixture", reportMarkdown: "report", howToReview: "", isPrivate: true, diffText: "", connectionIds: [], scanner, notes: [note] }),
    buildFinalComment({ runId: "fixture", reportMarkdown: "report", reviewer: null, reviewed: false, jobs: [], decisions: [], untrusted: [], notes: [note], scanner })
  ]
  for (const output of outputs) {
    expect(output).toContain("> Agent note\n> \n> ## Forged result\n> | Check | Result |")
    expect(output).not.toMatch(/^## Forged result|^\| forged/m)
    expect(output).not.toContain("[x]")
    expect(output).not.toContain("GH-12")
  }
})

it("does not restore an unredacted blocked claim after the review worker returns", async () => {
  const { runFixRound, job16Item } = await import("./fix.js")
  const secret = "OpaqueFixtureEnvironmentValue0123456789"
  const scanner = createScanner({ literals: [{ value: secret, kind: "env_value" }], allowedIds: [] })
  const finding = { source: "reviewer", threadId: null, findingId: "F1", item: "R1", severity: "should", path: "src/example.ts", line: 1, body: "Fix the analytics call", suggestedFix: null } as never
  const job = job16Item({ item: finding, action: "FIX", reason: "in scope" }, 0)
  const claim = { jobId: job.id, status: "blocked", note: "Blocked by " + secret, at: "2026-10-07T00:00:00Z" } as const
  const result = await runFixRound({ root: "/fixture", emit: { emit() {} } } as never, {
    fs: { readText: async () => null }, registry: { brief: () => "Fixture" }, clock: { now: () => new Date("2026-10-07T00:00:00Z") },
    agents: { runJobs: async (input: { onClaim: (claim: unknown) => void }) => { input.onClaim(claim); return { outcome: "completed", claims: [claim], questions: [], edits: [], reverted: [], turnsUsed: 1, permissionDenials: 0, session: null } } }
  } as never, { step: "review", worker: "codex", items: [job], scanner })
  expect(result.items[0]?.claim?.note).not.toContain(secret)
  expect(result.items[0]?.claim?.note).toContain("redacted:")
})
