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
it("shows previews silent as the owner's preview guard for the affected tool (said once, in For you), with no run failure", () => {
  const pass: Cell = { state: "pass", value: "pass", display: "previews silent", provenance: { source: "wizard_check", at: "2026-10-07T00:00:00Z", runId: RUN } }
  const job = ownerJob()
  const report = buildReport({ runId: RUN, tagVersion: "0.0.0", site: { repoLabel: "example/site", productionHost: null }, columns: { live_today: null, in_pr: { meta: { measuredAt: "2026-10-07T00:00:00Z", sha: "a".repeat(40) }, cells: {}, finishLine: { previews_silent: pass } }, proven_live: null }, provenLivePending: null, day7: null, notes: [], verdictFacts: { jobs: [job], openFindings: [], tools: null, installedUnknown: null } })
  const cell = report.finishLine.find(line => line.id === "previews_silent")!.cells.in_pr
  expect(cell.state).toBe("info")
  expect(cell.display).toBe("for you: the preview guard for Meta pixel")
  expect(report.verdict?.reasons.some(reason => reason.kind === "approved_fix_missing")).toBe(false)
  const text = renderMarkdown(report)
  // The action is said ONCE, in the "For you" list; no table cell or note repeats it.
  expect(text).toContain("### For you")
  expect(text.split("preview and local visits count in Meta pixel")).toHaveLength(2)
  expect(text).not.toMatch(/NOT DONE|left for the owner|keep counting/)
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


it("the owner's changes say the action plainly; why they are the owner's is said ONCE, never on every line", async () => {
  const { frozenJobNote, OWNER_CODE_REASON } = await import("./owner-boundary.js")
  const place = { file: "src/analytics/tracking.ts", line: 160 }
  const history = frozenJobNote({ id: "posthog_improve:history_change", jobId: "posthog_improve", title: "Improve PostHog" }, place)
  expect(history).toBe("For you: turn on PostHog's page-change counting (`capture_pageview: 'history_change'` in its init) at src/analytics/tracking.ts:160.")
  const defaults = frozenJobNote({ id: "posthog_improve:defaults", jobId: "posthog_improve", title: "Improve PostHog" }, place)
  const jobs = [history, defaults].map((note, index) => candidate("posthog_improve", `owner${index}`, { state: "left_for_you", checks: [], note, ownerBoundary: { kind: "frozen_unit", file: place.file, line: place.line, unitHash: `hash${index}` } }))
  const report = buildReport({ runId: RUN, tagVersion: "0.0.0", site: { repoLabel: "example/site", productionHost: null }, columns: { live_today: null, in_pr: null, proven_live: null }, provenLivePending: null, day7: null, notes: [], verdictFacts: { jobs, openFindings: [], tools: null, installedUnknown: null } })
  expect(report.notes.filter(note => note === OWNER_CODE_REASON)).toHaveLength(1)
  expect(report.notes.indexOf(OWNER_CODE_REASON)).toBeLessThan(report.notes.indexOf(history))
  const text = renderMarkdown(report)
  expect(text).not.toMatch(/sits inside your consent code|so this run left it to you/)
  expect(text.split(OWNER_CODE_REASON)).toHaveLength(2)
})

it("a setup check the owner must finish is the concrete action, never its check id or internal code", async () => {
  const { frozenJobNote } = await import("./owner-boundary.js")
  const finding = "Setup check click_id_capture: INF_SETUP_CLICK_ID_NOT_AT_LANDING: A Meta pixel initialises in src/analytics/tracking.ts, but this source check could not prove that it runs on every landing page. It does not follow imports to establish site-wide coverage. Check whether the existing module already loads through pages/_app.tsx or pages/_document.tsx or pages/index.tsx. The _fbc cookie needs the landing URL's fbclid before navigation removes it."
  const note = frozenJobNote({ id: "setup_check_fixes:click_id_capture", jobId: "setup_check_fixes", title: "Fix the setup-check findings", trigger: { finding } }, { file: "src/analytics/tracking.ts", line: 1 })
  expect(note).toBe("For you: check that src/analytics/tracking.ts, where your Meta pixel starts, is loaded from pages/_app.tsx, so it runs on every page a visitor can land on and saves the ad click before they move on. The wizard could not confirm it, because it does not follow imports; if it is, nothing is left to do.")
  const other = frozenJobNote({ id: "setup_check_fixes:silent_form", jobId: "setup_check_fixes", title: "Fix the setup-check findings", trigger: { finding: "Setup check silent_form: INF_SETUP_SILENT_FORM: The signup form at pages/join.tsx:12 sends no conversion." } }, { file: "pages/join.tsx", line: 12 })
  expect(other).toBe("For you: the signup form at pages/join.tsx:12 sends no conversion (at pages/join.tsx:12).")
  for (const text of [note, other]) {
    expect(text).not.toMatch(/INF_|Setup check|click_id_capture|silent_form|make the "/)
  }
})

it("a clean measured run says only which files changed, never a disclaimer about what it did not touch", async () => {
  const { OWNER_BOUNDARY, withOwnerBoundary } = await import("./owner-boundary.js")
  const measured = { state: "checked" as const, scope: "commit" as const, measuredCommitCount: 1, wizardCommits: ["a".repeat(40)], issues: [], files: ["lib/infinite-analytics.ts"], filesAvailable: true }
  const text = withOwnerBoundary("", false, measured)
  expect(text).toBe("Files changed:\n- lib/infinite-analytics.ts")
  expect(text).not.toContain(OWNER_BOUNDARY)
  // A saved text that still carries the old disclaimer and list is cleaned to the short list.
  expect(withOwnerBoundary(`${OWNER_BOUNDARY}\n\nChanged files:\n- lib/infinite-analytics.ts`, false, measured)).toBe(text)
  expect(text).not.toMatch(/recognised a consent call|Consent and privacy are yours/)
  // A saved report's old sentence is replaced, never shown beside the new one.
  const resaved = withOwnerBoundary("This run did not edit your privacy or terms pages, or any code where it recognised a consent call (checked against the commits it made). Consent and privacy are yours: please review the files this run changed.", false, measured)
  expect(resaved).not.toContain("recognised a consent call")
})
