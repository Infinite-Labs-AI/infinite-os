import { expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { candidate, fakeBefore, fakeKeys, fakeProductionDeniedConflict } from "../../test/wizard/o7-fakes.js"
import { buildPlanModel, seedItemsAfterApprovals } from "../install/plan-model.js"
import { buildReport, renderMarkdown } from "../wizard/report.js"
import type { Cell } from "../wizard/contracts/report.js"
const RUN = "11111111-1111-4111-8111-111111111111"
const ownerJob = () => candidate("preview_guard", "meta", { state: "left_for_you", checks: [], note: "For you: add the preview guard to Meta pixel's start-up at src/tracking.ts:5; until then preview and local visits count in Meta pixel.", ownerBoundary: { kind: "frozen_unit", file: "src/tracking.ts", line: 5, unitHash: "hash" }, trigger: { finding: "old finding", evidence: [{ file: "src/tracking.ts", line: 5 }] } })
it.each(["lf", "crlf",])("the owner guard diff applies with plain git apply and preserves neighboring consent bytes: %s", async newline => {
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
it("gives the owner the exact guard and edit location as copyable plan text and preserves it on the saved job", () => {
  const job = ownerJob()
  const plan = buildPlanModel({ scan: { framework: "next-app-router", managedProviders: [], adopted: [], improve: [], serverLane: null, npm: null, sensitivePaths: [] }, keys: fakeKeys(), before: fakeBefore(), candidates: [job], agent: { worker: "claude_code", whoPays: { payer: "plan", label: "plan" } }, consentFlag: "not_required", productionDeniedConflict: fakeProductionDeniedConflict })
  const text = plan.lines.find(line => line.id === `owner_only:${job.id}`)?.text ?? ""
  expect(text).toContain("until then preview and local visits count in Meta pixel")
  expect(text).toContain("src/tracking.ts:5")
  expect(text).toContain("```js")
  expect(text).toContain("location.hostname")
  const saved = seedItemsAfterApprovals([job], [], plan, { approved: [], declined: [], edits: {} })
  expect(saved.find(item => item.id === job.id)?.trigger.finding).toBe(text)
  const report = buildReport({ runId: RUN, tagVersion: "0.0.0", site: { repoLabel: "example/site", productionHost: null }, columns: { live_today: null, in_pr: null, proven_live: null }, provenLivePending: null, day7: null, notes: [], verdictFacts: { jobs: saved, openFindings: [], tools: null, installedUnknown: null } })
  expect(report.notes.every(note => note.length <= 300 && !note.includes("```"))).toBe(true)
  expect(renderMarkdown(report, undefined, saved)).toContain(saved[0]!.ownerBoundary!.guard!)
})
it("shows previews silent as NOT DONE for the affected tool, with no run failure", () => {
  const pass: Cell = { state: "pass", value: "pass", display: "previews silent", provenance: { source: "wizard_check", at: "2026-10-07T00:00:00Z", runId: RUN } }
  const job = ownerJob()
  const report = buildReport({ runId: RUN, tagVersion: "0.0.0", site: { repoLabel: "example/site", productionHost: null }, columns: { live_today: null, in_pr: { meta: { measuredAt: "2026-10-07T00:00:00Z", sha: "a".repeat(40) }, cells: {}, finishLine: { previews_silent: pass } }, proven_live: null }, provenLivePending: null, day7: null, notes: [], verdictFacts: { jobs: [job], openFindings: [], tools: null, installedUnknown: null } })
  const cell = report.finishLine.find(line => line.id === "previews_silent")!.cells.in_pr
  expect(cell.state).toBe("info")
  expect(cell.display).toMatch(/NOT DONE.*Meta/i)
  expect(report.verdict?.reasons.some(reason => reason.kind === "approved_fix_missing")).toBe(false)
  expect(renderMarkdown(report)).toContain("preview and local visits keep counting")
})

it.each([ "fbq('init', '123456789');",])("renders a real single-statement guard diff without a placeholder: %s", async statement => {
  const { ownerGuardHandoff } = await import("./owner-boundary.js")
  const source = `function boot() {\n  ${statement}\n  fbq('consent', 'revoke');\n}\n`
  const handoff = ownerGuardHandoff("For you: add the guard.", { file: "src/tracking.ts", line: 2 }, "hostAllowed", source)
  expect(handoff.guard).toContain(`-  ${statement}\n+  if (hostAllowed) ${statement}`)
    expect(handoff.guard).toContain("@@ -1,4 +1,4 @@")
  expect(handoff.guard).not.toContain("Existing analytics")
    expect(handoff.guard.split("\n").filter(line => /^[+-]/.test(line)).join("\n")).not.toContain("revoke")
})

it.each([
  { source: "fbq('init', '123456789'), fbq('consent', 'revoke');\n", line: 1 },
  { source: "fbq('init', '123456789') && fbq('consent', 'revoke');\n", line: 1 },
])("does not offer an apply-ready guard when the initialization statement boundary is ambiguous: $source", async ({ source, line }) => {
  const { ownerGuardHandoff } = await import("./owner-boundary.js")
  const handoff = ownerGuardHandoff("For you: add the guard.", { file: "src/tracking.ts", line }, "hostAllowed", source)
  expect(handoff.text).toContain("Where exactly this goes could not be worked out safely, so place this condition yourself")
  expect(handoff.guard).toBe("if (hostAllowed)")
})

it.each(["&& fbq('consent', 'revoke');",])("refuses a continued expression after a semicolonless initialization: %s", async continuation => {
  const { ownerGuardHandoff } = await import("./owner-boundary.js")
  const source = `function boot() {\n  fbq('init', '123456789')\n  ${continuation}\n}\n`
  const handoff = ownerGuardHandoff("For you: add the guard.", { file: "src/tracking.ts", line: 2 }, "hostAllowed", source)
  expect(handoff.guard).toBe("if (hostAllowed)")
})

