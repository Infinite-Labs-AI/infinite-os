import { afterEach, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "../../test/wizard/git-fixture.js"
import { fakeBridge, initialState, RUN_ID, testContext, testDeps } from "../../test/wizard/o4-fakes.js"
import { createGitOps } from "../git/index.js"
import { GitPushError } from "../git/push.js"
import { createScanner } from "./scan.js"
import { pushBranch, stageAndCommit } from "./ship.js"

const fixtures: GitFixture[] = []
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup() })
const path = "src/tracking.ts"
const source = 'export function boot() {\n  fbq?.("consent", "revoke");\n}\nexport const count = 1;\n'
async function setup() {
  const fx = createGitFixture({ files: { [path]: source, ".gitignore": ".infinite/\n" } }); fixtures.push(fx)
  const git = createGitOps({ cwd: fx.root, env: fx.env })
  const branch = "infinite/tag/owner-proof"
  const { baseSha } = await git.createBranch("main", branch)
  const ctx = testContext({ root: fx.root, state: initialState({ git: { base: "main", baseSource: "vercel", baseSha, headSha: baseSha, branch }, jobs: [] }) })
  const deps = testDeps({ bridge: fakeBridge(), agents: {} as never, git, host: { kind: "github" } as never })
  const scanner = createScanner({ literals: [], allowedIds: [] })
  const push = () => pushBranch({ ctx, deps, git, scanner, branch, base: "main", title: "Fixture", hostKind: "github" })
  return { fx, git, ctx, deps, scanner, branch, baseSha, push }
}
it("R7 refuses a dirty owner unit before committing and names the file", async () => {
  const w = await setup(); w.fx.write(path, source.replace('  fbq', '  return;\n  fbq'))
  const result = await stageAndCommit({ ...w, step: "rehearsal", runId: RUN_ID, message: "fixture", round: null, allowlist: [path], managed: [], npmFiles: [], connectionIds: [] })
  expect(result.kind).not.toBe("committed")
  expect(JSON.stringify(result)).toContain(path)
  expect(await w.git.head()).toBe(w.baseSha)
})
it("R7 refuses an already committed owner edit before any push", async () => {
  const w = await setup(); w.fx.write(path, source.replace('  fbq', '  return;\n  fbq'))
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", "owner change fixture"])
  expect(await w.push()).toMatchObject({ kind: "failed", message: expect.stringContaining(path) })
  expect(w.fx.remoteSha(w.branch)).toBeNull()
})
it("R7 pushes the measured neighbor edit, not a newer unmeasured branch head", async () => {
  const w = await setup(); w.fx.write(path, source.replace('count = 1', 'count = 2'))
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", "neighbor fixture"])
  const measured = await w.git.head()
  const push = w.git.push.bind(w.git)
  w.git.push = async (branch, sha) => {
    w.fx.write(path, source.replace('  fbq', '  return;\n  fbq'))
    w.fx.git(["add", path]); w.fx.git(["commit", "-m", "later fixture"])
    await push(branch, sha)
  }
  expect(await w.push()).toMatchObject({ kind: "pushed" })
  expect(w.fx.remoteSha(w.branch)).toBe(measured)
  expect(await w.git.head()).not.toBe(measured)
})
it("R7 pins the SSH handover command to the measured commit", async () => {
  const w = await setup()
  const measured = await w.git.head()
  w.git.push = async () => { throw new GitPushError("ssh_passphrase", "fixture SSH key locked") }
  expect(await w.push()).toMatchObject({ kind: "failed" })
  const handover = w.ctx.asks.find(ask => ask.kind === "tty-handover")
  expect(JSON.stringify(handover)).toContain(`${measured}:refs/heads/${w.branch}`)
})
