// B25: a fresh machine rebuilds the minimal run state from an OPEN wizard PR's body marker. No gh, no network:
// the adapter's `gh` is a stub answering `pr list --json`.
import { describe, expect, it } from "vitest"

import type { GitHostAdapter } from "./contracts/git-host.js"
import { rebuildFromPrMarker } from "./fresh-machine.js"
import { createRunState } from "./run-state.js"

const RUN = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"

function pr(number: number, state: string, branch: string, body: string) {
  return {
    number,
    url: `https://github.com/acme/acme-store/pull/${number}`,
    id: `PR_${number}`,
    isDraft: true,
    state,
    headRefOid: "ab".repeat(20),
    headRefName: branch,
    baseRefName: "main",
    mergeCommit: null,
    mergedAt: null,
    mergeStateStatus: null,
    reviewDecision: null,
    body
  }
}

function adapter(rows: unknown[] | Error, kind: GitHostAdapter["kind"] = "github"): { host: GitHostAdapter; calls: string[][] } {
  const calls: string[][] = []
  const gh = {
    json: async (args: string[]) => {
      calls.push(args)
      if (rows instanceof Error) throw rows
      return rows
    }
  }
  return { host: { kind, gh, readThreadDetails: async () => [] } as unknown as GitHostAdapter, calls }
}

const fresh = () => createRunState({ tagVersion: "0.12.0-test", root: "/repo", appRoot: ".", now: new Date("2026-10-02T09:00:00.000Z") })

describe("rebuildFromPrMarker (B25)", () => {
  it("restores the fork destination from an open cross-repo PR", async () => {
    const row = { ...pr(7, "OPEN", "infinite/tag/2026-10-02-7f3c2a", `<!-- infinite-tag:pr v1 run=${RUN} -->`), isCrossRepository: true, headRepositoryOwner: { login: "acme-dev" } }
    const { host } = adapter([row])
    Object.assign(host, { repoFacts: async () => ({ isPrivate: true, defaultBranch: "main", viewerPermission: "TRIAGE", nameWithOwner: "acme/acme-store", allowForking: true }) })
    const state = fresh()
    await rebuildFromPrMarker(state, host)
    expect(state.pushTarget).toEqual({ kind: "fork", headOwner: "acme-dev", remoteUrl: "https://github.com/acme-dev/acme-store.git" })
  })
  it("takes the newest OPEN wizard PR: run id, PR, branch and base; the base SHA is left for `before`", async () => {
    const marker = `body\n<!-- infinite-tag:pr v1 run=${RUN} -->`
    const { host, calls } = adapter([
      pr(3, "OPEN", "infinite/tag/2026-10-01-7f3c2a", marker),
      pr(7, "OPEN", "infinite/tag/2026-10-02-7f3c2a", marker),
      pr(9, "MERGED", "infinite/tag/2026-10-03-7f3c2a", marker),
      pr(11, "OPEN", "feature/x", marker)
    ])
    const state = fresh()
    expect(await rebuildFromPrMarker(state, host)).toEqual({ runId: RUN, prNumber: 7, branch: "infinite/tag/2026-10-02-7f3c2a" })
    expect(state.runId).toBe(RUN)
    expect(state.pr).toMatchObject({ host: "github", number: 7, url: "https://github.com/acme/acme-store/pull/7", isDraft: true, round: 0, mergeSha: null })
    expect(state.git).toEqual({ base: "main", baseSource: "default_branch", branch: "infinite/tag/2026-10-02-7f3c2a", baseSha: "", headSha: null })
    expect(calls[0]).toEqual(expect.arrayContaining(["pr", "list", "--author", "@me"]))
  })

  it("NEGATIVE: no marker, only merged/closed PRs, another host, or a gh failure → nothing rebuilt, state untouched", async () => {
    for (const rows of [[pr(5, "OPEN", "infinite/tag/2026-10-02-7f3c2a", "no marker")], [pr(6, "CLOSED", "infinite/tag/2026-10-02-7f3c2a", `<!-- infinite-tag:pr v1 run=${RUN} -->`)], new Error("gh: not logged in")]) {
      const state = fresh()
      expect(await rebuildFromPrMarker(state, adapter(rows).host)).toBeNull()
      expect(state.runId).toBeNull()
      expect(state.pr).toBeNull()
    }
    const gitlab = adapter([pr(7, "OPEN", "infinite/tag/2026-10-02-7f3c2a", `<!-- infinite-tag:pr v1 run=${RUN} -->`)], "gitlab")
    expect(await rebuildFromPrMarker(fresh(), gitlab.host)).toBeNull()
    expect(gitlab.calls).toEqual([])
  })
})
