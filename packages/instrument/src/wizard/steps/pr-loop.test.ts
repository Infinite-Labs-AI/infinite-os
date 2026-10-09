import { execFileSync } from "node:child_process"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { installPreCommitHook } from "../../../test/wizard/git-fixture.js"
import {
  eventText,
  fakeBridge,
  fakeClock,
  fakeHosting,
  PIXEL_ID,
  RUN_ID,
  testResult,
  type FakeBridge
} from "../../../test/wizard/o4-fakes.js"
import { ensurePushTarget } from "../push-target.js"
import { PR_MARKERS } from "../contracts/git-host.js"
import { step as rehearsalStep } from "./rehearsal.js"
import {
  BRANCH,
  PREVIEW,
  STRIPE,
  SIGNUP_JOB,
  assertCommittedImportsDeclared,
  bridgeVerbs,
  cleanupWorlds,
  expectOk,
  world
} from "../../../test/wizard/pr-loop-world.js"

afterEach(cleanupWorlds)

// Each test spawns git and the fake gh many times (real processes, no network): give them room.
describe("step `rehearsal` (§3d.1 step 8)", { timeout: 60_000 }, () => {
  it("an unloaded preview is not named as checked in the PR body", async () => {
    const w = await world()
    w.ctx.state.update(state => { state.jobs.push({ ...SIGNUP_JOB, id: "preview_guard:ga4", jobId: "preview_guard", title: "Keep GA4 previews silent", state: "claimed", checks: [{ id: "preview_self_silent", tier: "RH", state: "not_run" }], claim: { status: "done", note: "done", at: "2026-10-02T08:00:00.000Z" } }) })
    const poll = w.bridge.pollTest.bind(w.bridge)
    w.bridge.pollTest = async (...args) => w.bridge.testRequests.at(-1)?.targets.some(target => target.label === "preview_self")
      ? { protocolVersion: 1, requestId: "test", state: "failed", progress: [], error: { code: "load_failed", message: "The preview could not load" } }
      : poll(...args)
    expectOk(await rehearsalStep.run(w.ctx, w.deps))
    expect(String(w.gh.read().prs[0]!.body)).not.toContain("The preview rehearsal checked: Keep GA4 previews silent.")
  })

  it("commits only the allowed set with the run trailer, pushes, opens a draft PR, rehearses the preview, then PATCHes and marks GA4 key events", async () => {
    const w = await world({ approveGa4Settings: true })
    const outcome = await rehearsalStep.run(w.ctx, w.deps)
    expectOk(outcome)
    const head = w.fx.remoteSha(BRANCH)!
    expect(head).toBeTruthy()
    expect(w.fx.git(["log", "-1", "--format=%B", head])).toMatch(new RegExp(`Infinite-Tag-Run: ${RUN_ID}`))
    const committed = w.fx.git(["diff", "--name-only", `${w.baseSha}..${head}`]).trim().split("\n").sort()
    expect(committed).toEqual([".gitignore", ".infinite/install.json", "app/layout.tsx", "app/signup/page.tsx", "lib/infinite-server-lane.ts", "package-lock.json", "package.json"])
    // Never committed: a stranger edit outside the allowlist, a .env file, the wizard's own state.
    expect(committed).not.toContain("README.md")
    expect(committed).not.toContain(".env.local")
    assertCommittedImportsDeclared(w.fx, head)

    const pr = w.gh.read().prs[0]!
    expect(pr).toMatchObject({ number: 42, isDraft: true, headRefName: BRANCH, baseRefName: "main" })
    expect(pr.body).toContain(PR_MARKERS.pr(RUN_ID))
    expect(pr.body).not.toContain("- [ ]")

    // B14: the PR fields right after the PR is created, then the rehearsal, then the click-tested names.
    expect(bridgeVerbs(w.bridge)).toEqual(["keys", "hosting", "runs.patch", "test.rehearsal", "test.dry_live", "runs.patch", "ga4-key-events"])
    const [rehearsal, previewSelf] = w.bridge.testRequests
    expect(rehearsal).toMatchObject({
      mode: "rehearsal",
      runId: RUN_ID,
      productionHost: "acme-store.com",
      rehearsal: { previewOrigin: PREVIEW, headSha: head },
      fakeClickId: true,
      clicks: [{ selector: '[data-infinite-conversion="sign_up"]', label: "sign_up" }],
      spaNavigation: { path: "/signup" }
    })
    expect(rehearsal!.targets.map((target) => target.url)).toEqual(["https://acme-store.com/", "https://acme-store.com/signup"])
    expect(rehearsal!.expect).toMatchObject({ meta: [PIXEL_ID] })
    expect(previewSelf).toMatchObject({ mode: "dry_live", targets: [{ url: `${PREVIEW}/`, label: "preview_self" }] })
    expect(previewSelf!.clicks).toBeUndefined()
    expect(previewSelf!.fakeClickId).toBeUndefined()

    const patches = w.bridge.calls.filter((call) => call.verb === "runs.patch").map((call) => (call.body as { patch: Record<string, unknown> }).patch)
    expect(patches).toEqual([{ prUrl: "https://github.com/acme/acme-store/pull/42", prNumber: 42, prHeadSha: head, phase: "in_pr" }, { clickTestedConversions: ["sign_up"] }])
    expect(w.bridge.calls.find((call) => call.verb === "ga4-key-events")!.body).toEqual({ runId: RUN_ID, names: ["sign_up"] })

    const state = w.ctx.state.get()
    expect(state.pr).toMatchObject({ host: "github", number: 42, isDraft: true })
    expect(state.git!.headSha).toBe(head)
    expect(state.report.in_pr!.meta.sha).toBe(head)
    expect(state.report.in_pr!.finishLine.each_tool_once).toMatchObject({ state: "pass", provenance: { source: "desktop_test", runId: RUN_ID } })
    expect(state.report.in_pr!.finishLine.previews_silent!.state).toBe("pass")
    // Final verify F12: the column a reviewer reads before merging is filled from this step's own evidence: the
    // rehearsal's beacons, the consent mode read back from Infinite, the key events Infinite marked, and the
    // count over all 14 checks (it was "—" for "Checks passing" and five other rows).
    const inPr = state.report.in_pr!.cells
    expect(inPr.checks_passing).toMatchObject({ provenance: { source: "wizard_check", runId: RUN_ID } })
    expect(inPr.checks_passing!.display).toMatch(/^\d+ pass · \d+ problems?( · \d+ unknown)? · \d+ not testable of 13$/)
    expect(inPr.ga4_page_views_per_visit).toMatchObject({ display: "1", provenance: { source: "desktop_test" } })
    expect(inPr.posthog_route).toMatchObject({ display: "through /ingest" })
    expect(inPr.consent_setting).toMatchObject({ state: "info", display: "starts with your site's own analytics, or on page load if it has none (recorded in Infinite)", provenance: { source: "cloud_read" } })
    expect(inPr.ga4_key_events).toMatchObject({ state: "info", value: 1, display: "1 marked as key event (click test passed)", provenance: { source: "cloud_read" } })
    expect(inPr.live_test_per_tool!.display).toMatch(/^rehearsal: \d of \d tools fire once, right ID \(nothing sent\)$/)
    expect(state.report.in_pr!.finishLine.ga4_key_events_received).toMatchObject({ state: "info" })
  })

  it("a click that fires a Meta standard event never counts as click-tested (the never-list)", async () => {
    const w = await world()
    w.deps.bridge = fakeBridge({
      results: {
        rehearsal: testResult("rehearsal", {
          clicks: [{ label: "sign_up", selector: '[data-infinite-conversion="sign_up"]', found: true, events: { ga4: ["sign_up"], posthog: [], meta: ["CompleteRegistration"], infinite: [] }, nonGetCancelled: 1, navigatedAfterMs: null, navigationCancelled: false, refused: null }]
        })
      }
    })
    w.bridge = w.deps.bridge as FakeBridge
    expectOk(await rehearsalStep.run(w.ctx, w.deps))
    // Only the PR-fields PATCH: no click-tested names (B14)
    const patches = w.bridge.calls.filter((call) => call.verb === "runs.patch").map((call) => (call.body as { patch: Record<string, unknown> }).patch)
    expect(patches.every((patch) => patch.clickTestedConversions === undefined)).toBe(true)
    expect(bridgeVerbs(w.bridge)).not.toContain("ga4-key-events")
  })

  it("holds back a file that would commit a secret and blocks its job; the pixel literal commits fine", async () => {
    const w = await world()
    w.fx.write("app/signup/page.tsx", `export const key = "${STRIPE}"\n`)
    expectOk(await rehearsalStep.run(w.ctx, w.deps))
    const head = w.fx.remoteSha(BRANCH)!
    const committed = w.fx.git(["diff", "--name-only", `${w.baseSha}..${head}`])
    expect(committed).not.toContain("app/signup/page.tsx")
    expect(committed).toContain("app/layout.tsx")
    expect(w.fx.git(["show", `${head}:app/layout.tsx`])).toContain(PIXEL_ID)
    expect(w.ctx.state.get().jobs[0]).toMatchObject({ state: "blocked", blockedReason: "needs_you" })
    expect(eventText(w.ctx)).not.toContain(STRIPE)
  })

  it("a hook that rewrites a file into a secret stops before any push (the diff gate runs again)", async () => {
    const w = await world()
    installPreCommitHook(w.fx, `printf 'const k = "${STRIPE}"\\n' >> app/layout.tsx; git add app/layout.tsx`)
    const outcome = await rehearsalStep.run(w.ctx, w.deps)
    expect(outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_PR_CREATE_FAILED" })
    expect((outcome as { message: string }).message).toMatch(/Nothing was pushed/)
    expect(w.fx.remoteSha(BRANCH)).toBeNull()
  })

  it("a protected preview is not tried at once, said plainly (negative: no waiting, no test, no 'unknown' cell)", async () => {
    const clock = fakeClock()
    const w = await world({ hosting: fakeHosting({ previewProtection: "vercel_authentication" }), clock })
    const outcome = await rehearsalStep.run(w.ctx, w.deps)
    expectOk(outcome)
    expect(outcome.status).toMatch(/not tried before merge/)
    expect(clock.slept).toEqual([])
    expect(w.bridge.testRequests).toEqual([])
    expect(w.ctx.state.get().report.in_pr!.finishLine.previews_silent).toMatchObject({ state: "info", display: "not tried (previews need a login)", reason: "preview_protected" })
  })

  it("no push access without an early approved fork stops before any push", async () => {
    const w = await world({ gh: { repo: { viewerPermission: "READ" } } })
    const outcome = await rehearsalStep.run(w.ctx, w.deps)
    expect(outcome).toMatchObject({ kind: "failed", code: "INF_WIZ_PUSH_REFUSED" })
    expect(w.fx.remoteSha(BRANCH)).toBeNull()
  })

  it("TRIAGE with approved forking pushes only to the viewer fork and opens a cross-repo PR", async () => {
    const w = await world({ fork: true, gh: { repo: { viewerPermission: "TRIAGE", allowForking: true } }, answers: { confirm: true } })
    const early = await ensurePushTarget(w.ctx, w.deps, () => undefined)
    expect(early).toBeNull()
    expect(await ensurePushTarget(w.ctx, w.deps, () => undefined)).toBeNull()
    expect(w.gh.read().calls.filter((call) => call.argv.join(" ").includes("POST repos/{owner}/{repo}/forks"))).toHaveLength(1)
    expect(w.ctx.state.get().pushTarget).toMatchObject({ kind: "fork", headOwner: "acme-dev" })
    const outcome = await rehearsalStep.run(w.ctx, w.deps)
    expectOk(outcome)
    expect(w.fx.remoteSha(BRANCH)).toBeNull()
    expect(execFileSync("git", ["--git-dir", join(w.fx.dir, "viewer-fork.git"), "rev-parse", `refs/heads/${BRANCH}`], { encoding: "utf8" }).trim()).toBe(await w.git.head())
    expect(w.gh.read().prs[0]).toMatchObject({ isCrossRepository: true, headOwner: "acme-dev", state: "OPEN" })
  })

  it("a click that sends nothing leaves the conversion's click test a problem", async () => {
    const w = await world()
    w.deps.bridge = fakeBridge({
      results: {
        rehearsal: testResult("rehearsal", {
          clicks: [{ label: "sign_up", selector: '[data-infinite-conversion="sign_up"]', found: true, events: { ga4: [], posthog: [], meta: [], infinite: [] }, nonGetCancelled: 0, navigatedAfterMs: null, navigationCancelled: false, refused: null }]
        })
      }
    })
    w.bridge = w.deps.bridge as FakeBridge
    expectOk(await rehearsalStep.run(w.ctx, w.deps))
    const job = w.ctx.state.get().jobs.find((candidate) => candidate.id === SIGNUP_JOB.id)!
    expect(job.checks.find((check) => check.id === "click_test")!.state).toBe("problem")
    expect(job.state).toBe("pending")
  })
})
