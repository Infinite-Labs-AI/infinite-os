import { expect, it } from "vitest"
import { verdictFactsFor } from "../wizard/verdict-facts.js"
import { triage, type TriageItem } from "./triage.js"
import { buildReviewPost, buildReply, safeText, buildFinalComment, buildChecklist } from "./post.js"
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
  expect(triage([finding], { allowlist: [finding.path!], declinedKeys: new Set(), passingChecks: new Set(["census_one_per_tool"]), answerFor: () => null })[0]!.action).toBe("FIX")
})

it("keeps uncategorized legacy security text open despite a passing check", () => {
  const finding: TriageItem = { source: "reviewer", threadId: null, findingId: "F3", item: "R2", severity: "should", path: "src/main.ts", line: 1, body: "PII phone is sent to Meta", suggestedFix: null }
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

it("keeps generated owner snippets executable while neutralizing checklist prose", () => {
  const guard = 'if (location.pathname !== "/private") { posthog.init("public-key"); }'
  const jobs = [{ title: "<!-- @here [open](https://example.test)", state: "left_for_you", jobId: "posthog_improve", allow: { files: ["src/main.ts"] }, ownerBoundary: { kind: "frozen_unit", file: "src/main.ts", line: 1, guard } }] as never
  const body = buildFinalComment({ runId: "fixture", reportMarkdown: "report", reviewer: null, reviewed: false, jobs, decisions: [], untrusted: [], notes: [], scanner: createScanner({ literals: [], allowedIds: [] }) })
  expect(body).toContain(guard)
  expect(body).not.toContain("<!-- @here")
  expect(body).not.toContain("@here")
  expect(body).not.toContain("](https:")
})


it("keeps repo backticks inside owner snippet fences without rewriting source", () => {
  const guard = '/*\n```\n<!-- @here [open](https://example.test)\n*/\nif (location.pathname !== "/private") posthog.init("public-key");'
  const job = { title: "Owner guard", state: "left_for_you", allow: { files: ["src/main.ts"] }, ownerBoundary: { kind: "frozen_unit", guard } } as never
  const body = buildChecklist([job])
  expect(body).toContain(`\n\n\`\`\`\`js\n${guard}\n\`\`\`\``)
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
