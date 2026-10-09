import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MERGE_SHA, RUN_ID, fakeDeps, prSummary } from "../../test/wizard/runtime-fakes.js"
import { ASK_TIMEOUT, type AskKind } from "./contracts/asks.js"
import type { AskFn } from "./contracts/deps.js"
import { nodeWizardFs } from "./fs.js"
import { createRunState } from "./run-state.js"
import { UNINSTALL_RECORD_PATH, runUninstallFlow, type UninstallPiece } from "./uninstall-flow.js"

// These workflow tests use a fake GitOps, so its measurement is fake too. Actual Git history,
// protected-source refusal and pinned GitHub/GitLab pushes run in uninstall-boundary.test.ts.
vi.mock("../jobs/owner-diff.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../jobs/owner-diff.js")>()
  return { ...actual,
    measureOwnerDiff: async (input: { baseSha: string }) => ({ state: "checked", scope: "working_tree", baseSha: input.baseSha, headSha: input.baseSha, files: [], issues: [] }),
    measureWizardCommits: async (input: { baseSha: string; headSha: string; wizardCommits: string[] }) => ({ state: "checked", scope: "commit", baseSha: input.baseSha, headSha: input.headSha, wizardCommits: input.wizardCommits, files: [], issues: [] }),
    unrecordedCommits: async () => [] }
})

const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wizard-uninstall-"))
  roots.push(root)
  return root
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function linkedState(root: string) {
  const state = createRunState({ tagVersion: "0.12.0", root, appRoot: ".", now: new Date("2026-10-02T09:00:00Z") })
  state.runId = RUN_ID
  state.link = { linkId: "lk_FAKEFAKEFAKEFAKEFAKE00", workspaceName: "Acme", approvedAt: "2026-10-02T09:01:00Z", runtimeVariant: "prod" }
  state.git = { base: "main", baseSource: "vercel", branch: "infinite/tag/2026-10-02-7f3c2a", baseSha: "b".repeat(40), headSha: null }
  return state
}

/** Answers each piece's ask from a map (missing = a non-answer). */
function answering(answers: Partial<Record<UninstallPiece, string>>, asked: string[] = []): AskFn {
  return (async (kind: AskKind, payload: { question?: string }) => {
    asked.push(`${kind}:${payload.question ?? ""}`)
    const piece = (["server_lane_env", "site_source", "link"] as const).find((candidate) =>
      candidate === "server_lane_env" ? payload.question?.includes("server-lane") : candidate === "site_source" ? payload.question?.includes("Turn this site off") : payload.question?.includes("link")
    )
    return piece && answers[piece] !== undefined ? answers[piece] : ASK_TIMEOUT
  }) as AskFn
}

function run(root: string, bundle: ReturnType<typeof fakeDeps>, ask: AskFn, state = linkedState(root)) {
  bundle.deps.fs = nodeWizardFs
  return runUninstallFlow({ root, state, ask, print() {}, now: () => new Date("2026-10-03T10:00:00Z"), base: null }, bundle.deps)
}

describe("uninstall --pr", () => {
  it("creates the uninstall branch BEFORE any file changes, then reverses, commits, pushes and opens a draft PR", async () => {
    const root = tempRoot()
    const bundle = fakeDeps({ reversed: ["app/layout.tsx", ".gitignore"] })
    const result = await run(root, bundle, answering({}))
    const order = bundle.log.calls.map((call) => `${call.who}.${call.what}`).filter((name) => /createBranch|uninstall|stage|commit|push|createDraftPr/.test(name))
    expect(order).toEqual(["git.createBranch", "installer.uninstall", "git.stage", "git.commit", "git.push", "host.createDraftPr"])
    expect(bundle.log.calls.find((call) => call.what === "createBranch")!.args).toEqual(["main", expect.stringMatching(/^infinite\/tag\/uninstall-2026-10-03-[0-9a-f]{6}$/)])
    expect(bundle.log.calls.find((call) => call.what === "stage")!.args[0]).toEqual(["app/layout.tsx", ".gitignore", ".infinite/install.json"])
    expect(bundle.log.calls.find((call) => call.what === "commit")!.args[0]).toMatchObject({ trailers: { "Infinite-Tag-Run": RUN_ID } })
    expect(result).toMatchObject({ exitCode: 0, record: { pr: { number: 43 } } })
  })

  it("negative: when the branch cannot be created, nothing is reversed (the user's branch is never edited)", async () => {
    const root = tempRoot()
    const bundle = fakeDeps({ git: { createBranchFails: true } })
    const result = await run(root, bundle, answering({}))
    expect(result).toMatchObject({ exitCode: 1, code: "INF_WIZ_BRANCH_FAILED" })
    expect(bundle.log.names("installer")).toEqual([])
  })

  it("a dirty tree stops before the branch (exit 2), ignoring the wizard's own run directory", async () => {
    const root = tempRoot()
    const dirty = fakeDeps({ git: { clean: false, dirtyPaths: ["src/app.tsx", ".infinite/wizard/state.json"] } })
    expect(await run(root, dirty, answering({}))).toMatchObject({ exitCode: 2, code: "INF_WIZ_DIRTY_TREE" })
    expect(dirty.log.names("git")).not.toContain("git.createBranch")
    // I1b: a finished run leaves the fence's record `.infinite/harness.json` untracked (never committed).
    const harnessRecord = fakeDeps({ git: { clean: false, dirtyPaths: [".infinite/harness.json", ".infinite/wizard/state.json"] } })
    expect((await run(tempRoot(), harnessRecord, answering({}))).exitCode).toBe(0)
    const harnessPlusUser = fakeDeps({ git: { clean: false, dirtyPaths: [".infinite/harness.json", ".infinite/install.json"] } })
    expect(await run(tempRoot(), harnessPlusUser, answering({}))).toMatchObject({ exitCode: 2, code: "INF_WIZ_DIRTY_TREE" })
    const onlyOwn = fakeDeps({ git: { clean: false, dirtyPaths: [".infinite/wizard/state.json"] } })
    expect((await run(tempRoot(), onlyOwn, answering({}))).exitCode).toBe(0)
  })

  it("asks once per cloud piece with the consequence and 'after the merge' as the default; 'now' runs it, a declined piece is untouched", async () => {
    const root = tempRoot()
    const bundle = fakeDeps()
    const asked: string[] = []
    const result = await run(root, bundle, answering({ server_lane_env: "now", site_source: "keep", link: "after_merge" }, asked), linkedState(root))
    expect(asked).toHaveLength(3)
    expect(asked[0]).toContain("stops server-side collection while the old code is still live")
    expect(result.record!.pieces).toEqual({ server_lane_env: "done", site_source: "kept", link: "after_merge" })
    expect(bundle.log.names("bridge")).toEqual(["bridge.removeServerLaneEnv"])
    expect(bundle.bridge.linkId).toBe("lk_FAKEFAKEFAKEFAKEFAKE00")
    expect(result.lines.join("\n")).toMatch(/The site in Infinite: kept \(unchanged\)/)
    const saved = JSON.parse(readFileSync(join(root, UNINSTALL_RECORD_PATH), "utf8"))
    expect(saved.pieces.link).toBe("after_merge")
  })

  it("an unanswered piece (no one to ask) is left as it is", async () => {
    const root = tempRoot()
    const bundle = fakeDeps()
    const result = await run(root, bundle, answering({}))
    expect(result.record!.pieces).toEqual({ server_lane_env: "kept", site_source: "kept", link: "kept" })
    expect(bundle.log.names("bridge")).toEqual([])
    expect(result.lines.join("\n")).toContain("not answered")
  })
})

describe("uninstall --pr from a fresh clone, link last, retries (O1-09, O1-18)", () => {
  function runWith(root: string, bundle: ReturnType<typeof fakeDeps>, ask: AskFn, state: ReturnType<typeof linkedState> | null, link?: () => Promise<{ linkId: string } | { linkId: null; code: "INF_WIZ_NO_APP"; message: string }>) {
    bundle.deps.fs = nodeWizardFs
    return runUninstallFlow({ root, state, ask, print() {}, now: () => new Date("2026-10-03T10:00:00Z"), base: "main", ...(link ? { link } : {}) }, bundle.deps)
  }
  const LINK_ID = "lk_FAKEFAKEFAKEFAKEFAKE00"

  it("the link is revoked LAST: with another piece failed it is kept, and the next run retries the failed piece, then revokes", async () => {
    const root = tempRoot()
    const first = fakeDeps()
    first.bridge.removeServerLaneEnv = async () => {
      throw new Error("Vercel said 500")
    }
    const result = await runWith(root, first, answering({ server_lane_env: "now", site_source: "now", link: "now" }), linkedState(root))
    expect(result.record!.pieces).toEqual({ server_lane_env: "failed", site_source: "done", link: "after_merge" })
    expect(first.log.names("bridge")).not.toContain("bridge.revokeLink")
    expect(result.lines.join("\n")).toContain("The link to Infinite: kept until server-lane settings on vercel is done")

    const second = fakeDeps({ host: { readPr: prSummary({ state: "MERGED", mergeCommitOid: MERGE_SHA }) } })
    const retried = await runWith(root, second, answering({}), linkedState(root))
    expect(second.log.names("bridge")).toEqual(["bridge.deployStatus", "bridge.removeServerLaneEnv", "bridge.revokeLink"])
    expect(retried.record!.pieces).toEqual({ server_lane_env: "done", site_source: "done", link: "done" })
  })
})
