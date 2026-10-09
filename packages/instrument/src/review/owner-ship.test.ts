import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "../../test/wizard/git-fixture.js"
import { fakeBridge, initialState, RUN_ID, testContext, testDeps } from "../../test/wizard/o4-fakes.js"
import { type AskNonAnswer } from "../wizard/contracts/asks.js"
import { createGitOps } from "../git/index.js"
import { createScanner } from "./scan.js"
import { pushBranch, stageAndCommit } from "./ship.js"

const fixtures: GitFixture[] = []
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup() })
const path = "src/tracking.ts"
const source = 'export function boot() {\n  fbq?.("consent", "revoke");\n}\nexport const count = 1;\n'
async function setup(approveForeign: boolean | AskNonAnswer = false) {
  const fx = createGitFixture({ files: { [path]: source, ".gitignore": ".infinite/\n" } }); fixtures.push(fx)
  const git = createGitOps({ cwd: fx.root, env: fx.env })
  const branch = "infinite/tag/owner-proof"
  const { baseSha } = await git.createBranch("main", branch)
  const ctx = testContext({ root: fx.root, state: initialState({ git: { base: "main", baseSource: "vercel", baseSha, headSha: baseSha, branch }, jobs: [], wizardCommits: [], commitHistory: { version: 1, priorHeads: [] } }), answers: { confirm: approveForeign } })
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
it("commits only the selected wizard paths beside unrelated owner changes and binary files", async () => {
  const w = await setup()
  w.fx.write("assets/logo.png", "original image")
  w.fx.git(["add", "assets/logo.png"]); w.fx.git(["commit", "-m", "owner image fixture"])
  const files = [".DS_Store", "design/mock.png", "notes.docx", "assets/logo.png"]
  const bytes = Buffer.from([0, 255, 128, 23])
  for (const file of files) { w.fx.write(file, ""); writeFileSync(join(w.fx.root, file), bytes) }
  w.fx.write("pages/privacy.tsx", "export default function Privacy() { return <p>Owner draft</p> }\n")
  w.fx.write(path, source.replace("count = 1", "count = 2"))
  const result = await stageAndCommit({ ...w, step: "rehearsal", runId: RUN_ID, message: "fixture", round: null, allowlist: [path], managed: [], npmFiles: [], connectionIds: [] })
  expect(result).toMatchObject({ kind: "committed", staged: [path] })
  expect(w.ctx.state.get().ownerBoundary).toMatchObject({ state: "checked", files: [path], issues: [] })
  expect(w.fx.git(["show", "--name-only", "--format=", "HEAD"]).trim()).toBe(path)
  for (const file of files) expect(readFileSync(join(w.fx.root, file))).toEqual(bytes)
  expect(w.fx.git(["status", "--porcelain", "--", "assets/logo.png"])).toContain(" M assets/logo.png")
  expect(readFileSync(join(w.fx.root, "pages/privacy.tsx"), "utf8")).toContain("Owner draft")
})
it("refuses a recorded wizard commit that touched an owner unit before any push", async () => {
  const w = await setup(); w.fx.write(path, source.replace('  fbq', '  return;\n  fbq'))
  w.fx.git(["add", path]); w.fx.git(["commit", "-m", "owner change fixture"])
  const sha = await w.git.head()
  w.ctx.state.update(state => { state.wizardCommits = [sha] })
  expect(await w.push()).toMatchObject({ kind: "failed", message: expect.stringContaining(path) })
  expect(w.fx.remoteSha(w.branch)).toBeNull()
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

