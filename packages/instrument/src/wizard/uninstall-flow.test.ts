import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { MERGE_SHA, RUN_ID, fakeDeps, prSummary } from "../../test/wizard/runtime-fakes.js"
import { ASK_TIMEOUT, type AskKind } from "./contracts/asks.js"
import type { AskFn } from "./contracts/deps.js"
import { nodeWizardFs } from "./fs.js"
import { createRunState } from "./run-state.js"
import { UNINSTALL_PIECES, UNINSTALL_RECORD_PATH, runUninstallFlow, type UninstallPiece } from "./uninstall-flow.js"

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

  it("'after the merge' defers to the next run: not merged → exit 3; merged and deployed → the deferred pieces run, env before link", async () => {
    const root = tempRoot()
    const first = fakeDeps()
    await run(root, first, answering({ server_lane_env: "after_merge", site_source: "after_merge", link: "after_merge" }))
    expect(first.log.names("bridge")).toEqual([])

    const open = fakeDeps({ host: { readPr: prSummary({ state: "OPEN" }) } })
    const waiting = await run(root, open, answering({}))
    expect(waiting).toMatchObject({ exitCode: 3, code: "INF_WIZ_MERGE_PARKED" })
    expect(open.log.names("installer")).toEqual([])
    expect(open.log.names("git")).not.toContain("git.createBranch")

    const merged = fakeDeps({ host: { readPr: prSummary({ state: "MERGED", mergeCommitOid: MERGE_SHA, mergedAt: "2026-10-03T11:00:00Z" }) } })
    const done = await run(root, merged, answering({}))
    expect(done.exitCode).toBe(0)
    expect(merged.log.names("bridge")).toEqual(["bridge.deployStatus", "bridge.removeServerLaneEnv", "bridge.disableSiteSource", "bridge.revokeLink"])
    expect(done.record!.pieces).toEqual(Object.fromEntries(UNINSTALL_PIECES.map((piece) => [piece, "done"])))
  })

  it("merged but not yet deployed → waits (exit 3) and changes nothing in Infinite", async () => {
    const root = tempRoot()
    await run(root, fakeDeps(), answering({ server_lane_env: "after_merge" }))
    const notDeployed = fakeDeps({
      host: { readPr: prSummary({ state: "MERGED", mergeCommitOid: MERGE_SHA }) },
      bridge: { deploy: [{ mergeDeployment: { state: "building", readyAt: null }, serving: null, target: "production" }] }
    })
    const result = await run(root, notDeployed, answering({}))
    expect(result).toMatchObject({ exitCode: 3, code: "INF_WIZ_DEPLOY_TIMEOUT" })
    expect(notDeployed.log.names("bridge")).toEqual(["bridge.deployStatus"])
  })

  it("no saved link and no way to link from here: no cloud asks, and every piece says it was NOT changed (never 'nothing to change')", async () => {
    const root = tempRoot()
    const bundle = fakeDeps()
    const state = linkedState(root)
    state.link = null
    const asked: string[] = []
    const result = await run(root, bundle, answering({}, asked), state)
    expect(asked).toEqual([])
    expect(result.record!.pieces).toEqual({ server_lane_env: "no_link", site_source: "no_link", link: "no_link" })
    expect(result.exitCode).toBe(4)
    const text = result.lines.join("\n")
    expect(text).not.toMatch(/nothing in Infinite to change/i)
    expect(text).toContain("NOT changed: this machine is not linked to Infinite")
  })
})

describe("uninstall --pr from a fresh clone, link last, retries (O1-09, O1-18)", () => {
  function runWith(root: string, bundle: ReturnType<typeof fakeDeps>, ask: AskFn, state: ReturnType<typeof linkedState> | null, link?: () => Promise<{ linkId: string } | { linkId: null; code: "INF_WIZ_NO_APP"; message: string }>) {
    bundle.deps.fs = nodeWizardFs
    return runUninstallFlow({ root, state, ask, print() {}, now: () => new Date("2026-10-03T10:00:00Z"), base: "main", ...(link ? { link } : {}) }, bundle.deps)
  }
  const LINK_ID = "lk_FAKEFAKEFAKEFAKEFAKE00"

  it("no state.json: the flow links first (a remembered link approves at once), then asks and runs each piece", async () => {
    const root = tempRoot()
    const bundle = fakeDeps()
    const asked: string[] = []
    let linkCalls = 0
    const result = await runWith(root, bundle, answering({ server_lane_env: "now", site_source: "now", link: "after_merge" }, asked), null, async () => {
      linkCalls += 1
      return { linkId: LINK_ID }
    })
    expect(linkCalls).toBe(1)
    expect(asked).toHaveLength(3)
    expect(bundle.log.names("bridge")).toEqual(["bridge.removeServerLaneEnv", "bridge.disableSiteSource"])
    expect(bundle.bridge.linkId).toBe(LINK_ID)
    expect(result.record!.pieces).toEqual({ server_lane_env: "done", site_source: "done", link: "after_merge" })
  })

  it("the link cannot be made (no app): exit 4, the pieces stay pending as 'not linked', and the next run links, asks and runs them", async () => {
    const root = tempRoot()
    const first = fakeDeps()
    const asked: string[] = []
    const result = await runWith(root, first, answering({}, asked), null, async () => ({ linkId: null, code: "INF_WIZ_NO_APP", message: "Infinite is not running" }))
    expect(result).toMatchObject({ exitCode: 4, code: "INF_WIZ_NO_APP" })
    expect(asked).toEqual([])
    expect(result.lines.join("\n")).toContain("Could not link this machine to Infinite: Infinite is not running")
    expect(JSON.parse(readFileSync(join(root, UNINSTALL_RECORD_PATH), "utf8")).pieces.server_lane_env).toBe("no_link")

    const second = fakeDeps({ host: { readPr: prSummary({ state: "MERGED", mergeCommitOid: MERGE_SHA }) } })
    const again = await runWith(root, second, answering({ server_lane_env: "now", site_source: "after_merge", link: "after_merge" }), null, async () => ({ linkId: LINK_ID }))
    expect(second.log.names("installer")).toEqual([])
    expect(second.log.names("git")).not.toContain("git.createBranch")
    expect(second.log.names("bridge")).toEqual(["bridge.removeServerLaneEnv", "bridge.deployStatus", "bridge.disableSiteSource", "bridge.revokeLink"])
    expect(again.record!.pieces).toEqual({ server_lane_env: "done", site_source: "done", link: "done" })
  })

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

  it("when nothing is left to do, .infinite/wizard/ is cleared (never the run lock); negative: a pending piece keeps the record", async () => {
    const root = tempRoot()
    mkdirSync(join(root, ".infinite/wizard"), { recursive: true })
    writeFileSync(join(root, ".infinite/wizard/state.json"), "{}")
    writeFileSync(join(root, ".infinite/wizard/run.lock"), "{}")
    await runWith(root, fakeDeps(), answering({ server_lane_env: "after_merge", site_source: "now", link: "after_merge" }), linkedState(root))
    expect(readdirSync(join(root, ".infinite/wizard")).sort()).toEqual(["run.lock", "state.json", "uninstall-pr-body.md", "uninstall.json"])

    const merged = fakeDeps({ host: { readPr: prSummary({ state: "MERGED", mergeCommitOid: MERGE_SHA }) } })
    const done = await runWith(root, merged, answering({}), linkedState(root))
    expect(done.lines.join("\n")).toContain("the wizard's run files in .infinite/wizard/ were removed")
    expect(readdirSync(join(root, ".infinite/wizard"))).toEqual(["run.lock"])
  })
})
