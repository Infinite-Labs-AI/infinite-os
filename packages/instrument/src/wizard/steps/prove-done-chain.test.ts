// Review P2-6: W15 and W16 through the STEPS (prove, then done, on one run state and one fake app), not only through
// the column and report builders. The step-level paths a "properly" run takes had never run once: prove's
// `PATCH proofState: proven`, done's `phase: proven`, and an `unconfirmed` run through prove and done.
import { describe, expect, it } from "vitest"
import { buildFinalComment } from "../../review/post.js"
import { createScanner } from "../../review/scan.js"
import { createJobRegistry } from "../../jobs/registry.js"
import type { ChecklistItem } from "../contracts/jobs.js"

import { MERGE_SHA, RUN_ID, fakeContext, fakeDeps, keysFixture, runPublic } from "../../../test/wizard/runtime-fakes.js"
import type { RunPatch, WizardRunPublic } from "../contracts/bridge.js"
import type { ReportV2 } from "../contracts/report.js"
import { renderMarkdown, renderTerminal } from "../report.js"
import { createRunState } from "../run-state.js"
import { step as doneStep } from "./done.js"
import { step as proveStep } from "./prove.js"

function mergedState() {
  const state = createRunState({ tagVersion: "0.12.0", root: "/repo", appRoot: ".", now: new Date("2026-10-02T09:00:00Z"), displayId: "r-7f3c" })
  state.runId = RUN_ID
  state.pr = { host: "github", number: 42, url: "https://github.com/acme/acme-store/pull/42", nodeId: "PR_x", isDraft: false, round: 1, reviewedSha: null, handledThreadIds: [], mergeSha: MERGE_SHA }
  return state
}

/** A fake app run that remembers what was PATCHed (the cloud's own proof state is what done reads). */
function trackedRun() {
  let run: WizardRunPublic = runPublic({ proofState: "pending" })
  return (patch: RunPatch): WizardRunPublic => {
    run = {
      ...run,
      ...(patch.proofState ? { proofState: patch.proofState, proofClaimedBy: "tag" as const } : {}),
      ...(patch.phase ? { phase: patch.phase } : {}),
      ...(patch.checkinOptIn ? { checkinOptIn: true, checkinDueAt: "2026-10-09T09:45:00.000Z" } : {})
    }
    return run
  }
}

async function proveThenDone(keys: ReturnType<typeof keysFixture>) {
  const bundle = fakeDeps({ bridge: { keys, patchRun: trackedRun() } })
  const ctx = fakeContext(mergedState(), {}, bundle.clock)
  const proved = await proveStep.run(ctx, bundle.deps)
  const done = await doneStep.run(ctx, bundle.deps)
  const patches = bundle.log.calls.filter((call) => call.what === "patchRun").map((call) => call.args[1] as RunPatch)
  const posted = bundle.log.calls.filter((call) => call.what === "postReport").map((call) => call.args[2] as ReportV2)
  const files = (bundle.deps.fs as unknown as { files: Map<string, string> }).files
  const markdown = [...files.entries()].find(([path]) => path.endsWith(".infinite/wizard/report.md"))?.[1] ?? ""
  const comment = String(bundle.log.calls.find((call) => call.who === "host" && call.what === "comment")?.args[1] ?? "")
  return { proved, done, patches, posted, markdown, comment, ctx }
}

describe("W15 / W16 at step level (review P2-6)", () => {
  it("W15 connected: prove PATCHes proofState proven, done PATCHes phase proven; one headline on every surface", async () => {
    const run = await proveThenDone(keysFixture())
    expect(run.proved.kind, JSON.stringify(run.proved)).toBe("ok")
    expect(run.done.kind).toBe("ok")
    const report = run.posted.at(-1)!
    expect(report.verdict, JSON.stringify(report.verdict)).toMatchObject({ state: "properly", reasons: [] })
    expect(run.patches.filter((patch) => patch.proofState !== undefined)).toEqual([{ proofState: "proven" }])
    expect(run.patches.at(-1)).toEqual({ phase: "proven" })
    const headline = report.verdict!.headline
    expect(headline.startsWith("www.acme-store.com collects analytics properly now")).toBe(true)
    expect(renderTerminal(report, 5_000).startsWith(`◆ ${headline} · run `)).toBe(true)
    expect(run.markdown.split("\n")[0]).toBe(`**${headline}**`)
    expect(renderMarkdown(report).split("\n")[0]).toBe(`**${headline}**`)
    expect(run.comment).toContain(`**${headline}**`)
  })

  it("W16 not connected: unconfirmed with the exact words; PATCH undetermined; never phase proven", async () => {
    const run = await proveThenDone(
      keysFixture({
        ga4: { status: "not_connected", propertyLabel: null, streams: [] } as never,
        meta: { status: "not_connected", pixels: [] } as never
      })
    )
    expect(run.done.kind).toBe("ok")
    const report = run.posted.at(-1)!
    expect(report.verdict, JSON.stringify(report.verdict)).toMatchObject({ state: "unconfirmed" })
    expect(report.verdict!.reasons.map((reason) => reason.kind)).toEqual(["tool_not_connected"])
    expect(report.verdict!.headline).toBe(
      "www.acme-store.com: Infinite's tag and PostHog received this run's real visit; GA4 and Meta send, but their IDs are not checked (not connected in Infinite)"
    )
    expect(run.patches.filter((patch) => patch.proofState !== undefined)).toEqual([{ proofState: "undetermined" }])
    expect(run.patches.some((patch) => patch.phase === "proven")).toBe(false)
    expect(run.markdown.split("\n")[0]).toBe(`**${report.verdict!.headline}**`)
    expect(run.markdown).toContain("- Sending, but its ID is not checked (not connected in Infinite): GA4 G-ACME...0001, Meta 123456...3456")
    // R4-9 (live run 4): the PR comment said "Meta [redacted: phone]". The pixel id the real visit read from the site's
    // code is a public id, masked or not.
    expect(run.comment).toContain("Meta 123456...3456")
    expect(run.comment).not.toContain("[redacted: phone]")
  })
})


it("request 2 P1-1: done refreshes the existing PR checklist from the proven jobs", async () => {
  const bundle = fakeDeps({ bridge: { patchRun: trackedRun() } })
  const state = mergedState()
  const job: ChecklistItem = {
    id: "ga4_improve:spa_page_view", jobId: "ga4_improve", n: 4, title: "Improve the existing GA4",
    owner: "agent", trigger: { finding: "SPA", evidence: [] }, allow: { files: [], create: [] },
    state: "waiting_deploy", claim: { status: "done", note: "done", at: "2026-10-02T09:00:00.000Z" },
    checks: [{ id: "ga4_seen_leaving", tier: "PV", state: "not_run" }]
  }
  state.jobs = [job, { ...job, id: "preview_guard:meta", jobId: "preview_guard", title: "Keep previews silent: Meta pixel", state: "done_in_code", checks: [{ id: "meta_host_matrix", tier: "T1", state: "not_run" }, { id: "adopted_init_guarded", tier: "S", state: "pass", runId: RUN_ID, at: "2026-10-02T09:10:00.000Z" }] }]
  bundle.deps.registry = createJobRegistry({ briefFacts: () => null })
  bundle.deps.checks.gradeTestRunChecks = async () => [{ checkId: "ga4_seen_leaving", tier: "PV", state: "pass", at: "2026-10-02T09:43:00.000Z", runId: RUN_ID }]
  let comment = buildFinalComment({ runId: RUN_ID, reportMarkdown: "### Before and after\n\n| Check | Before | After |\n|---|---|---|\n| Live | — | — |", reviewer: "brief", reviewed: true, jobs: state.jobs, decisions: [], untrusted: [], notes: ["Keep this review note."], scanner: createScanner({ literals: [], allowedIds: [] }) })
  expect(comment).toContain("| Improve the existing GA4 | waiting deploy |")
  Object.assign(bundle.deps.host, { updateOwnComment: async (_number: number, _marker: string, edit: (body: string) => string) => { comment = edit(comment); return true } })
  const ctx = fakeContext(state, {}, bundle.clock)
  await proveStep.run(ctx, bundle.deps)
  expect(ctx.current().jobs[0]!.state).toBe("proven")
  await doneStep.run(ctx, bundle.deps)
  expect(comment).toContain("| Improve the existing GA4 | proven |")
  expect(comment).not.toContain("waiting deploy")
  expect(comment).toContain("done in code: Not checked after the deploy: Meta refuses data from preview addresses")
  expect(comment).not.toMatch(/T1:|PV:|meta_host_matrix/)
  expect(ctx.events.filter(event => event.type === "job.state").map(event => (event.fields as { note: string }).note).join(" ")).not.toMatch(/T1:|PV:|meta_host_matrix/)
  expect(comment).toContain("Keep this review note.")
  expect(comment).toContain("Reviewed from the printed review brief")
  expect(comment).toContain("Updated after the live check")
  expect(bundle.log.calls.filter(call => call.what === "comment")).toHaveLength(0)
})

it.each([false, true])("request 3 P3-public: final checklist exposes IDs only when already in the public diff (%s)", async inDiff => {
  const bundle = fakeDeps()
  const state = mergedState()
  const id = "G-ACME000001"
  state.git = { base: "main", baseSource: "default_branch", branch: "infinite/tag/test", baseSha: "a".repeat(40), headSha: "b".repeat(40) }
  const job: ChecklistItem = { id: "ga4_improve:id", jobId: "ga4_improve", n: 4, title: `Improve GA4 ${id}`, owner: "agent", trigger: { finding: "ID", evidence: [] }, allow: { files: [], create: [] }, checks: [], state: "done_in_code" }
  state.jobs = [job]
  bundle.deps.host.repoFacts = async () => ({ isPrivate: false, defaultBranch: "main", viewerPermission: "ADMIN" })
  bundle.deps.git.diff = async () => inDiff ? `+ const id = '${id}'` : "+ unrelated change"
  let comment = buildFinalComment({ runId: RUN_ID, reportMarkdown: "### Before and after\n\n| Check | State |\n|---|---|\n| test | — |", reviewer: "brief", reviewed: true, jobs: [{ ...job, title: "Improve GA4 <id>" }], decisions: [], untrusted: [], notes: [], scanner: createScanner({ literals: [], allowedIds: [id] }) })
  Object.assign(bundle.deps.host, { updateOwnComment: async (_number: number, _marker: string, edit: (body: string) => string) => { comment = edit(comment); return true } })
  await doneStep.run(fakeContext(state, {}, bundle.clock), bundle.deps)
  expect(comment).toContain(`| Improve GA4 ${inDiff ? id : "<id>"} | done in code |`)
  if (!inDiff) expect(comment).not.toContain(`| Improve GA4 ${id}`)
})
