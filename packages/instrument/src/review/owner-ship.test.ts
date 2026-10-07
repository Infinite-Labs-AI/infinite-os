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
async function setup(approveForeign = false) {
  const fx = createGitFixture({ files: { [path]: source, ".gitignore": ".infinite/\n" } }); fixtures.push(fx)
  const git = createGitOps({ cwd: fx.root, env: fx.env })
  const branch = "infinite/tag/owner-proof"
  const { baseSha } = await git.createBranch("main", branch)
  const ctx = testContext({ root: fx.root, state: initialState({ git: { base: "main", baseSource: "vercel", baseSha, headSha: baseSha, branch }, jobs: [] }), answers: { confirm: approveForeign } })
  const deps = testDeps({ bridge: fakeBridge(), agents: {} as never, git, host: { kind: "github" } as never })
  const scanner = createScanner({ literals: [], allowedIds: [] })
  const push = () => pushBranch({ ctx, deps, git, scanner, branch, base: "main", title: "Fixture", hostKind: "github" })
  return { fx, git, ctx, deps, scanner, branch, baseSha, push }
}
it("refuses a dirty owner unit before committing and names the file", async () => {
  const w = await setup(); w.fx.write(path, source.replace('  fbq', '  return;\n  fbq'))
  const result = await stageAndCommit({ ...w, step: "rehearsal", runId: RUN_ID, message: "fixture", round: null, allowlist: [path], managed: [], npmFiles: [], connectionIds: [] })
  expect(result.kind).not.toBe("committed")
  expect(JSON.stringify(result)).toContain(path)
  expect(await w.git.head()).toBe(w.baseSha)
})
it("refuses a recorded wizard commit that touched an owner unit before any push", async () => {
  const w = await setup(); w.fx.write(path, source.replace('  fbq', '  return;\n  fbq'))
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", "owner change fixture"])
  const sha = await w.git.head()
  w.ctx.state.update(state => { state.wizardCommits = [sha] })
  expect(await w.push()).toMatchObject({ kind: "failed", message: expect.stringContaining(path) })
  expect(w.fx.remoteSha(w.branch)).toBeNull()
})
it("pushes the measured neighbor edit, not a newer unmeasured branch head", async () => {
  const w = await setup(); w.fx.write(path, source.replace('count = 1', 'count = 2'))
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", "neighbor fixture"])
  const measured = await w.git.head()
  w.ctx.state.update(state => { state.wizardCommits = [measured] })
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
it("pins the SSH handover command to the measured commit", async () => {
  const w = await setup()
  const measured = await w.git.head()
  w.git.push = async () => { throw new GitPushError("ssh_passphrase", "fixture SSH key locked") }
  expect(await w.push()).toMatchObject({ kind: "failed" })
  const handover = w.ctx.asks.find(ask => ask.kind === "tty-handover")
  expect(JSON.stringify(handover)).toContain(`${measured}:refs/heads/${w.branch}`)
})

it("allows an explicitly approved owner consent commit between recorded wizard commits", async () => {
  const w = await setup(true)
  w.fx.write(path, source.replace("count = 1", "count = 2"))
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", "first wizard fixture"])
  const first = await w.git.head()
  const ownerSource = source.replace('"revoke"', '"grant"').replace("count = 1", "count = 2")
  w.fx.write(path, ownerSource)
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", "owner handoff fixture"])
  const owner = await w.git.head()
  w.fx.write(path, ownerSource.replace("count = 2", "count = 3"))
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", "second wizard fixture"])
  const second = await w.git.head()
  w.ctx.state.update(state => Object.assign(state, { wizardCommits: [first, second] }))
  expect(await w.push()).toMatchObject({ kind: "pushed" })
  expect(w.ctx.asks.find(ask => ask.kind === "confirm")?.payload).toMatchObject({ question: expect.stringContaining(owner.slice(0, 12)) })
  expect(w.fx.remoteSha(w.branch)).toBe(second)
  expect(w.ctx.state.get().ownerBoundary?.wizardCommits).toEqual([first, second])
  expect(w.ctx.state.get().lastPush?.sha).toBe(second)
})

it("records its own commit SHA while allowing a committed owner handoff as the working baseline", async () => {
  const w = await setup(true)
  const ownerSource = source.replace('"revoke"', '"grant"')
  w.fx.write(path, ownerSource)
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", "owner handoff fixture"])
  w.fx.write(path, ownerSource.replace("count = 1", "count = 2"))
  const result = await stageAndCommit({ ...w, step: "rehearsal", runId: RUN_ID, message: "wizard fixture", round: null, allowlist: [path], managed: [], npmFiles: [], connectionIds: [] })
  expect(result.kind).toBe("committed")
  expect(w.ctx.state.get().wizardCommits).toEqual([await w.git.head()])
  expect(await w.push()).toMatchObject({ kind: "pushed" })
})

it("requires approval for unrecorded commits on every push, even with a forged run trailer", async () => {
  const w = await setup(false)
  w.fx.write(path, source.replace("count = 1", "count = 2"))
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", `owner fixture\n\nInfinite-Tag-Run: ${RUN_ID}`])
  expect(await w.push()).toMatchObject({ kind: "failed", message: expect.stringContaining("not approved") })
  expect(w.fx.remoteSha(w.branch)).toBeNull()
})

it("redacts and neutralizes untrusted commit subjects in the foreign-push question", async () => {
  const w = await setup(false)
  const secret = "sk_test_fixtureSecret123456"
  w.fx.write(path, source.replace("count = 1", "count = 2"))
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", `owner <!-- @reviewer [click](https://example.com) ![image](https://example.com/i) ${secret}`])
  const sha = await w.git.head()
  expect(await w.push()).toMatchObject({ kind: "failed", message: expect.stringContaining("not approved") })
  const question = JSON.stringify(w.ctx.asks.find(ask => ask.kind === "confirm")?.payload)
  expect(question).toContain(sha.slice(0, 12))
  expect(question).toContain("redacted")
  for (const unsafe of [secret, "<!--", "@reviewer", "[click](", "![image](", "https://"]) expect(question).not.toContain(unsafe)
  expect(w.fx.remoteSha(w.branch)).toBeNull()
})

it("keeps foreign approval specific to the exact SHAs across later pushes", async () => {
  const w = await setup(true)
  const message = `owner fixture\n\nInfinite-Tag-Run: ${RUN_ID}`
  w.fx.write(path, source.replace("count = 1", "count = 2"))
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", message])
  const first = await w.git.head()
  expect(await w.push()).toMatchObject({ kind: "pushed" })
  expect(w.ctx.state.get().approvedForeignCommits).toEqual([first])
  expect(await w.push()).toMatchObject({ kind: "pushed" })
  expect(w.ctx.asks.filter(ask => ask.kind === "confirm")).toHaveLength(1)

  w.fx.write(path, source.replace("count = 1", "count = 3"))
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", message])
  const second = await w.git.head()
  w.ctx.ask = async (kind, payload) => { w.ctx.asks.push({ kind, payload }); return false as never }
  expect(await w.push()).toMatchObject({ kind: "failed", message: expect.stringContaining("not approved") })
  const question = JSON.stringify(w.ctx.asks.at(-1)?.payload)
  expect(question).toContain(second.slice(0, 12))
  expect(question).not.toContain(first.slice(0, 12))
  expect(w.fx.remoteSha(w.branch)).toBe(first)
  expect(w.ctx.state.get().lastPush?.sha).toBe(first)
  expect(w.ctx.state.get().approvedForeignCommits).toEqual([first])
})

it("measures wizard commits against their parents after an owner merge changes consent", async () => {
  const w = await setup(true)
  const commit = () => stageAndCommit({ ...w, step: "rehearsal" as const, runId: RUN_ID, message: "wizard fixture", round: null, allowlist: [path], managed: [], npmFiles: [], connectionIds: [] })
  w.fx.write(path, source.replace("count = 1", "count = 2"))
  expect((await commit()).kind).toBe("committed")
  const first = await w.git.head()
  w.fx.git(["switch", "main"])
  w.fx.write(path, source.replace('"revoke"', '"grant"'))
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", "owner base consent change"])
  const owner = await w.git.head()
  w.fx.git(["switch", w.branch]); w.fx.git(["merge", "--no-edit", "main"])
  const merge = await w.git.head()
  w.fx.write(path, source.replace('"revoke"', '"grant"').replace("count = 1", "count = 3"))
  expect((await commit()).kind).toBe("committed")
  const second = await w.git.head()
  expect(w.ctx.state.get().wizardCommits).toEqual([first, second])
  expect(await w.push()).toMatchObject({ kind: "pushed" })
  expect(w.ctx.state.get().ownerBoundary).toMatchObject({ state: "checked", wizardCommits: [first, second] })
  expect(w.ctx.state.get().approvedForeignCommits).toEqual(expect.arrayContaining([owner, merge]))
  expect(w.fx.remoteSha(w.branch)).toBe(second)
})

it("refuses a wizard consent edit even if a later owner commit undoes it", async () => {
  const w = await setup(true)
  w.fx.write(path, source.replace('"revoke"', '"grant"'))
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", "unsafe wizard fixture"])
  const unsafe = await w.git.head()
  w.ctx.state.update(state => { state.wizardCommits = [unsafe] })
  w.fx.write(path, source)
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", "owner restored original fixture"])
  expect(await w.push()).toMatchObject({ kind: "failed", message: expect.stringContaining(path) })
  expect(w.ctx.state.get().ownerBoundary?.wizardCommits).toEqual([unsafe])
  expect(w.fx.remoteSha(w.branch)).toBeNull()
  expect(w.ctx.asks).toHaveLength(0)
})
