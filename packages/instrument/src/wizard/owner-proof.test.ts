import { afterEach, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "../../test/wizard/git-fixture.js"
import { initialState } from "../../test/wizard/o4-fakes.js"
import { ownerBoundaryForState } from "./owner-proof.js"
import { withOwnerBoundary } from "../jobs/owner-boundary.js"
import { buildReport, renderMarkdown, renderTerminal } from "./report.js"

const fixtures: GitFixture[] = []
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup() })

it("does not describe an unavailable diff as an empty changed-file list", async () => {
  const proof = await ownerBoundaryForState("/unavailable", ".", initialState(), null)
  const text = withOwnerBoundary("", false, proof)
  expect(text).toContain("Changed files: unavailable")
  expect(text).not.toContain("none found")
})

it("does not reuse a stale successful proof after the commit is amended", async () => {
  const fx = createGitFixture({ files: { "tracking.ts": "export const count = 1;\n" } }); fixtures.push(fx)
  const baseSha = fx.git(["rev-parse", "HEAD"]).trim()
  fx.write("tracking.ts", "export const count = 2;\n")
  fx.git(["add", "tracking.ts"]); fx.git(["commit", "-m", "wizard fixture"])
  const made = fx.git(["rev-parse", "HEAD"]).trim()
  const state = initialState({ wizardCommits: [made], git: { base: "main", baseSource: "default_branch", baseSha, headSha: made, branch: "main" } })
  state.ownerBoundary = await ownerBoundaryForState(fx.root, ".", state, made)
  expect(state.ownerBoundary).toMatchObject({ state: "checked", measuredCommitCount: 1 })
  fx.git(["commit", "--amend", "-m", "rewritten fixture"])
  const proof = await ownerBoundaryForState(fx.root, ".", state, fx.git(["rev-parse", "HEAD"]).trim())
  expect(proof).toMatchObject({ state: "not_checked", unverifiedReason: expect.stringContaining("amended") })
  expect(withOwnerBoundary("", false, proof)).toContain("tracking.ts")
})

it("retains the unverified reason and bounded paths in saved cloud notes and every report fallback", () => {
  const reason = "the older state has no complete record of the commits this run made"
  const proof = { state: "not_checked" as const, scope: "commit" as const, baseSha: "a".repeat(40), headSha: "b".repeat(40), files: Array.from({ length: 40 }, (_, n) => `src/changed-${n}.ts`), issues: [], measuredCommitCount: 0, wizardCommits: [], unverifiedReason: reason, fileScope: "branch_history" as const }
  const report = buildReport({ runId: "fixture", tagVersion: "0.0.0", site: { repoLabel: "example/site", productionHost: null }, columns: { live_today: null, in_pr: null, proven_live: null }, provenLivePending: null, day7: null, notes: Array.from({ length: 30 }, (_, n) => `Note ${n}`), verdictFacts: { jobs: [], openFindings: [], tools: null, installedUnknown: null, ownerBoundary: proof } })
  expect(report.notes.length).toBeLessThanOrEqual(20)
  expect(report.notes.every(note => note.length <= 300)).toBe(true)
  for (const output of [report.notes.join("\n"), renderMarkdown(report), renderTerminal(report, 300)]) {
    expect(output).toContain(reason)
    expect(output).toContain("src/changed-0.ts")
    expect(output).toContain("more changed files")
    expect(output).not.toContain("changed neither")
    expect(output).not.toContain("This run did not edit")
  }
})
