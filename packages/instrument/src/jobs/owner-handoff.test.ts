import { expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { candidate, fakeBefore, fakeKeys, fakeProductionDeniedConflict } from "../../test/wizard/o7-fakes.js"
import { buildPlanModel, seedItemsAfterApprovals } from "../install/plan-model.js"
import { buildReport, renderMarkdown } from "../wizard/report.js"
import type { Cell } from "../wizard/contracts/report.js"
import { buildFinalComment, buildPrBody, buildChecklist, withFinalReport } from "../review/post.js"
import { createScanner } from "../review/scan.js"
const RUN = "11111111-1111-4111-8111-111111111111"
const ownerJob = () => candidate("preview_guard", "meta", { state: "left_for_you", checks: [], note: "Not changed by us: Meta pixel's start-up code at src/tracking.ts:5 also handles consent, which is yours. Until you add the guard there, preview and local visits keep counting in Meta pixel.", ownerBoundary: { kind: "frozen_unit", file: "src/tracking.ts", line: 5, unitHash: "hash" }, trigger: { finding: "old finding", evidence: [{ file: "src/tracking.ts", line: 5 }] } })
it("renders each owner note once in the report, PR body and final comment, with a diff fence", () => {
  const job = ownerJob()
  job.note = "Not changed by us: this exact owner initialization needs your guard."
  job.ownerBoundary!.guard = "--- a/src/tracking.ts\n+++ b/src/tracking.ts\n@@ -1,2 +1,2 @@\n function boot() {\n+  if (hostAllowed) start();"
  const report = buildReport({ runId: RUN, tagVersion: "fixture", site: { repoLabel: "example/site", productionHost: null }, columns: { live_today: null, in_pr: null, proven_live: null }, provenLivePending: null, day7: null, notes: [], verdictFacts: { jobs: [job], openFindings: [], tools: null, installedUnknown: null } })
  const reportMarkdown = renderMarkdown(report, undefined, [job], ["GA4 account settings"])
  const scanner = createScanner({ literals: [], allowedIds: [] })
  const pr = buildPrBody({ reportMarkdown, howToReview: "Review the changed files.", runId: RUN, isPrivate: true, diffText: "", connectionIds: [], scanner })
  const comment = buildFinalComment({ reportMarkdown, runId: RUN, reviewer: null, reviewed: false, jobs: [job], decisions: [], untrusted: [], notes: [], scanner })
  const updated = withFinalReport(comment, reportMarkdown, buildChecklist([job], scanner, reportMarkdown))!
  for (const text of [reportMarkdown, pr, comment, updated]) {
    expect(text.split(job.note)).toHaveLength(2)
    expect(text.split("```diff\n--- a/src/tracking.ts")).toHaveLength(2)
    expect(text.split("### You said no to")).toHaveLength(2)
  }
})
it.each(["lf", "crlf", "no-final-newline"])("the owner guard diff applies with plain git apply and preserves neighboring consent bytes: %s", async newline => {
  const { ownerGuardHandoff } = await import("./owner-boundary.js")
  const root = mkdtempSync(join(tmpdir(), "tag-owner-diff-"))
  try {
    mkdirSync(join(root, "src"))
    const base = "function boot() {\n  fbq('init', '123456789');\n  fbq('consent', 'revoke');\n}\n"
    const source = newline === "crlf" ? base.replace(/\n/g, "\r\n") : newline === "no-final-newline" ? base.trimEnd() : base
    writeFileSync(join(root, "src/tracking.ts"), source)
    execFileSync("git", ["init", "-q"], { cwd: root })
    const handoff = ownerGuardHandoff("Owner action", { file: "src/tracking.ts", line: 2 }, "hostAllowed", source)
    expect(() => execFileSync("git", ["apply", "-"], { cwd: root, input: handoff.guard + "\n", stdio: ["pipe", "pipe", "pipe"] })).not.toThrow()
    expect(readFileSync(join(root, "src/tracking.ts"), "utf8")).toBe(source.replace("  fbq('init'", "  if (hostAllowed) fbq('init'"))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it("the one-line owner diff applies when the source has no final newline", async () => {
  const { ownerGuardHandoff } = await import("./owner-boundary.js")
  const root = mkdtempSync(join(tmpdir(), "tag-one-line-diff-"))
  try {
    const source = "fbq('init', '123456789');"
    writeFileSync(join(root, "tracking.js"), source)
    execFileSync("git", ["init", "-q"], { cwd: root })
    const handoff = ownerGuardHandoff("Owner action", { file: "tracking.js", line: 1 }, "hostAllowed", source)
    execFileSync("git", ["apply", "-"], { cwd: root, input: handoff.guard + "\n" })
    expect(readFileSync(join(root, "tracking.js"), "utf8")).toBe(`if (hostAllowed) ${source}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it("gives the owner the exact guard and edit location as copyable plan text and preserves it on the saved job", () => {
  const job = ownerJob()
  const plan = buildPlanModel({ scan: { framework: "next-app-router", managedProviders: [], adopted: [], improve: [], serverLane: null, npm: null, sensitivePaths: [] }, keys: fakeKeys(), before: fakeBefore(), candidates: [job], agent: { worker: "claude_code", whoPays: { payer: "plan", label: "plan" } }, consentFlag: "not_required", productionDeniedConflict: fakeProductionDeniedConflict })
  const text = plan.lines.find(line => line.id === `owner_only:${job.id}`)?.text ?? ""
  expect(text).toContain("preview and local visits keep counting")
  expect(text).toContain("src/tracking.ts:5")
  expect(text).toContain("```js")
  expect(text).toContain("location.hostname")
  const saved = seedItemsAfterApprovals([job], [], plan, { approved: [], declined: [], edits: {} })
  expect(saved.find(item => item.id === job.id)?.trigger.finding).toBe(text)
  const report = buildReport({ runId: RUN, tagVersion: "0.0.0", site: { repoLabel: "example/site", productionHost: null }, columns: { live_today: null, in_pr: null, proven_live: null }, provenLivePending: null, day7: null, notes: [], verdictFacts: { jobs: saved, openFindings: [], tools: null, installedUnknown: null } })
  expect(report.notes.every(note => note.length <= 300 && !note.includes("```"))).toBe(true)
  expect(renderMarkdown(report, undefined, saved)).toContain(saved[0]!.ownerBoundary!.guard!)
})
it.each(["frozen_unit", "restored_unit"] as const)("shows previews silent as NOT DONE for the affected tool, with no run failure (%s)", kind => {
  const pass: Cell = { state: "pass", value: "pass", display: "previews silent", provenance: { source: "wizard_check", at: "2026-10-07T00:00:00Z", runId: RUN } }
  const job = ownerJob()
  job.ownerBoundary = { ...job.ownerBoundary!, kind }
  if (kind === "restored_unit") job.note = "Put back: an edit reached code that handles consent."
  const report = buildReport({ runId: RUN, tagVersion: "0.0.0", site: { repoLabel: "example/site", productionHost: null }, columns: { live_today: null, in_pr: { meta: { measuredAt: "2026-10-07T00:00:00Z", sha: "a".repeat(40) }, cells: {}, finishLine: { previews_silent: pass } }, proven_live: null }, provenLivePending: null, day7: null, notes: [], verdictFacts: { jobs: [job], openFindings: [], tools: null, installedUnknown: null } })
  const cell = report.finishLine.find(line => line.id === "previews_silent")!.cells.in_pr
  expect(cell.state).toBe("info")
  expect(cell.display).toMatch(/NOT DONE.*Meta/i)
  expect(report.verdict?.reasons.some(reason => reason.kind === "approved_fix_missing")).toBe(false)
  expect(renderMarkdown(report)).toContain("preview and local visits keep counting")
  if (kind === "restored_unit") expect(renderMarkdown(report)).toContain("Put back: an edit reached code that handles consent.")
})
it("preserves another tool's measured preview failure beside the owner NOT DONE annotation", () => {
  const problem: Cell = { state: "problem", value: "problem", display: "Meta pixel sends on previews", provenance: { source: "desktop_test", at: "2026-10-07T00:00:00Z", runId: RUN, checkId: "meta_host_matrix" } }
  const left = { ...ownerJob(), id: "preview_guard:ga4" }
  const report = buildReport({ runId: RUN, tagVersion: "0.0.0", site: { repoLabel: "example/site", productionHost: null }, columns: { live_today: null, in_pr: { meta: { measuredAt: "2026-10-07T00:00:00Z", sha: "a".repeat(40) }, cells: {}, finishLine: { previews_silent: problem } }, proven_live: null }, provenLivePending: null, day7: null, notes: [], verdictFacts: { jobs: [left], openFindings: [], tools: null, installedUnknown: null } })
  expect(report.finishLine.find(line => line.id === "previews_silent")!.cells.in_pr.state).toBe("problem")
  expect(renderMarkdown(report)).toContain("Meta pixel sends on previews (problem)")
  expect(renderMarkdown(report)).toContain("NOT DONE for GA4")
})
it("does not render a stale unmeasured assertion from report notes as a new measured claim", () => {
  const report = buildReport({ runId: RUN, tagVersion: "0.0.0", site: { repoLabel: "example/site", productionHost: null }, columns: { live_today: null, in_pr: null, proven_live: null }, provenLivePending: null, day7: null, notes: ["Consent and your privacy policy are yours; this run changed neither."], verdictFacts: null })
  expect(renderMarkdown(report)).not.toContain("this run changed neither")
  expect(report.notes.join(" ")).not.toContain("this run changed neither")
})

it.each(["gtag('config', 'G-FAKE');", "fbq('init', '123456789');", "posthog.init('phc_fake', { defaults: '2026-01-30' });"])("renders a real single-statement guard diff without a placeholder: %s", async statement => {
  const { ownerGuardHandoff } = await import("./owner-boundary.js")
  const source = `function boot() {\n  ${statement}\n  fbq('consent', 'revoke');\n}\n`
  const handoff = ownerGuardHandoff("Not changed by us", { file: "src/tracking.ts", line: 2 }, "hostAllowed", source)
  expect(handoff.guard).toContain(`-  ${statement}\n+  if (hostAllowed) ${statement}`)
    expect(handoff.guard).toContain("@@ -1,4 +1,4 @@")
  expect(handoff.guard).not.toContain("Existing analytics")
    expect(handoff.guard.split("\n").filter(line => /^[+-]/.test(line)).join("\n")).not.toContain("revoke")
})

it.each([
  { source: "\nfbq('init', '123456789');\n", line: 1 },
  { source: "function boot() {\n  if (enabled)\n    fbq('init', '123456789');\n  else fbq('consent', 'revoke');\n}\n", line: 3 },
  { source: "fbq('init', '123456789'), fbq('consent', 'revoke');\n", line: 1 },
  { source: "fbq('init', '123456789') && fbq('consent', 'revoke');\n", line: 1 },
  { source: "gtag('config', 'G-FAKE',\n  buildConfig()) || fbq('consent', 'revoke');\n", line: 1 },
])("does not offer an apply-ready guard when the initialization statement boundary is ambiguous: $source", async ({ source, line }) => {
  const { ownerGuardHandoff } = await import("./owner-boundary.js")
  const handoff = ownerGuardHandoff("Not changed by us", { file: "src/tracking.ts", line }, "hostAllowed", source)
  expect(handoff.text).toContain("not an apply-ready edit")
  expect(handoff.guard).toBe("if (hostAllowed)")
})

it("keeps a multiline literal initialization separate from the following consent statement", async () => {
  const { ownerGuardHandoff } = await import("./owner-boundary.js")
  const source = "function boot() {\n  window.posthog.init('phc_fake', {\n    defaults: '2026-01-30'\n  });\n  fbq('consent', 'revoke');\n}\n"
  const handoff = ownerGuardHandoff("Not changed by us", { file: "src/tracking.ts", line: 2 }, "hostAllowed", source)
  expect(handoff.guard).toContain("+  if (hostAllowed) window.posthog.init('phc_fake', {")
  expect(handoff.guard.split("\n").filter(line => /^[+-]/.test(line)).join("\n")).not.toContain("revoke")
})

it.each(["gtag('config', 'G-FAKE')", "fbq('init', '123456789')", "posthog.init('phc_fake', { defaults: '2026-01-30' })"])("renders a real diff for an isolated initialization without a semicolon: %s", async statement => {
  const { ownerGuardHandoff } = await import("./owner-boundary.js")
  const source = `function boot() {\n  ${statement}\n  fbq('consent', 'revoke')\n}\n`
  const handoff = ownerGuardHandoff("Not changed by us", { file: "src/tracking.ts", line: 2 }, "hostAllowed", source)
  expect(handoff.guard).toContain(`-  ${statement}\n+  if (hostAllowed) ${statement}`)
})

it.each(["&& fbq('consent', 'revoke');", ", fbq('consent', 'revoke');", "?.then(grant)", "['consent']()"])("refuses a continued expression after a semicolonless initialization: %s", async continuation => {
  const { ownerGuardHandoff } = await import("./owner-boundary.js")
  const source = `function boot() {\n  fbq('init', '123456789')\n  ${continuation}\n}\n`
  const handoff = ownerGuardHandoff("Not changed by us", { file: "src/tracking.ts", line: 2 }, "hostAllowed", source)
  expect(handoff.guard).toBe("if (hostAllowed)")
})

it.each(["x.gtag('config', 'G-FAKE');", "x.fbq('init', '123456789');"])("renders an apply-ready diff for an initialization on a local receiver: %s", async statement => {
  const { ownerGuardHandoff } = await import("./owner-boundary.js")
  const source = `function boot(x) {\n  ${statement}\n  x.fbq('consent', 'revoke');\n}\n`
  const handoff = ownerGuardHandoff("Not changed by us", { file: "src/tracking.ts", line: 2 }, "hostAllowed", source)
  expect(handoff.guard).toContain(`-  ${statement}\n+  if (hostAllowed) ${statement}`)
  expect(handoff.text).not.toContain("not an apply-ready edit")
  expect(handoff.guard.split("\n").filter(line => /^[+-]/.test(line)).join("\n")).not.toContain("revoke")
})
