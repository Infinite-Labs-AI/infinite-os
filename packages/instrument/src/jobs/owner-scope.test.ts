import { expect, it } from "vitest"
import { item } from "../../test/wizard/repo.js"
import { scopeOwnerJob } from "./owner-scope.js"

it("keeps the actual setup finding in an owner handoff", () => {
  const file = "src/analytics.ts"
  const sources = new Map([[file, "function boot() {\n posthog.opt_out_capturing();\n}\n"]])
  const finding = "Setup check silent_form: add the approved lead call to the form's success handler"
  const scoped = scopeOwnerJob({ ...item("setup_check_fixes:silent_form", [file]), jobId: "setup_check_fixes", trigger: { finding, evidence: [{ file, line: 2 }] } }, sources)
  expect(scoped.state).toBe("left_for_you")
  expect(scoped.note).toContain(finding)
})

it("preserves the plan's copyable owner text when jobs rescope the same frozen unit", () => {
  const file = "src/analytics.ts"
  const sources = new Map([[file, "function boot() {\n posthog.init('phc_fixture', {});\n posthog.opt_out_capturing();\n}\n"]])
  const first = scopeOwnerJob({ ...item("preview_guard:posthog", [file]), trigger: { finding: "Guard", evidence: [{ file, line: 2 }] } }, sources)
  const planned = { ...first, note: `${first.note} Preview visits keep counting until you apply this.`, ownerBoundary: { ...first.ownerBoundary!, guard: "@@ -2 +2 @@\n- posthog.init('phc_fixture', {});\n+ if (isProduction) posthog.init('phc_fixture', {});", wiring: "manualWiring();" } }
  const rescoped = scopeOwnerJob(planned, sources)
  expect(rescoped.ownerBoundary).toEqual(planned.ownerBoundary)
  expect(rescoped.note).toBe(planned.note)
  expect(scopeOwnerJob(rescoped, sources)).toEqual(rescoped)
})

it.each(["Owner-only placement remains unchanged.", "Owner-only placement remains unchanged.\nCopy the shown guard yourself."])("carries rescoped owner snippets and notes through report and PR surfaces once: %s", async note => {
  const { buildReport, renderMarkdown, renderTerminal } = await import("../wizard/report.js")
  const { buildPrBody, buildFinalComment } = await import("../review/post.js")
  const { createScanner } = await import("../review/scan.js")
  const file = "src/analytics.ts"
  const sources = new Map([[file, "function boot() {\n posthog.init('phc_fixture', {});\n posthog.opt_out_capturing();\n}\n"]])
  const first = scopeOwnerJob({ ...item("preview_guard:posthog", [file]), trigger: { finding: "Guard", evidence: [{ file, line: 2 }] } }, sources)
  const snippet = "@@ -2 +2 @@\n- posthog.init('phc_fixture', {});\n+ if (isProduction) posthog.init('phc_fixture', {});"
  const jobs = [scopeOwnerJob({ ...first, note, ownerBoundary: { ...first.ownerBoundary!, guard: snippet } }, sources)]
  const report = buildReport({ runId: "fixture", tagVersion: "0.0.0", site: { repoLabel: "example/site", productionHost: null }, columns: { live_today: null, in_pr: null, proven_live: null }, provenLivePending: null, day7: null, notes: [], verdictFacts: { jobs, openFindings: [], tools: null, installedUnknown: null } })
  const markdown = renderMarkdown(report, undefined, jobs)
  const scanner = createScanner({ literals: [], allowedIds: [] })
  const body = buildPrBody({ reportMarkdown: markdown, howToReview: "Review", runId: "fixture", isPrivate: true, diffText: "", connectionIds: [], scanner })
  const comment = buildFinalComment({ reportMarkdown: markdown, runId: "fixture", reviewer: null, reviewed: false, jobs, decisions: [], untrusted: [], notes: [], scanner })
  for (const text of [markdown, body, comment]) {
    expect(text.split(snippet)).toHaveLength(2)
    expect(text.split("Owner-only placement remains unchanged.")).toHaveLength(2)
  }
  expect(renderTerminal(report, 100, { ownerJobs: jobs })).toContain("Full text in the pull request and .infinite/wizard/report.md")
})
