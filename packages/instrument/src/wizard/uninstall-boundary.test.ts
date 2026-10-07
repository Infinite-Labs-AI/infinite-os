import { rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createGitFixture, type GitFixture } from "../../test/wizard/git-fixture.js"
import { fakeDeps, RUN_ID } from "../../test/wizard/runtime-fakes.js"
import { createGitOps } from "../git/index.js"
import { createGitLabAdapter } from "../hosts/gitlab.js"
import { nodeWizardFs } from "./fs.js"
import { createRunState } from "./run-state.js"
import { runUninstallFlow } from "./uninstall-flow.js"

const fixtures: GitFixture[] = []
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup() })
async function fixture(unsafe = false, gitlab = false) {
  const path = "src/tracking.ts"
  const source = unsafe ? "function boot(){ fbq('consent','revoke'); }\n" : "export const count = 1;\n"
  const fx = createGitFixture({ files: { [path]: source, ".infinite/install.json": "{}\n", ".gitignore": ".infinite/wizard/\n" } }); fixtures.push(fx)
  const git = createGitOps({ cwd: fx.root, env: fx.env })
  const bundle = fakeDeps()
  bundle.deps.git = git; bundle.deps.fs = nodeWizardFs
  if (gitlab) bundle.deps.host = createGitLabAdapter(git)
  bundle.deps.installer.uninstall = async () => {
    fx.write(path, unsafe ? source.replace("revoke", "grant") : "export const count = 0;\n")
    rmSync(join(fx.root, ".infinite/install.json"))
    return { reversed: [path, ".infinite/install.json"], leftAsIs: [] }
  }
  const state = createRunState({ root: fx.root, appRoot: ".", tagVersion: "0.0.0", now: new Date("2026-10-07T00:00:00Z") })
  state.runId = RUN_ID
  const run = () => runUninstallFlow({ root: fx.root, state, ask: async () => "__timeout__" as never, print() {}, now: () => new Date("2026-10-07T00:01:00Z"), base: "main" }, bundle.deps)
  return { fx, git, run, path }
}

it("refuses an uninstall change to an owner unit before committing or pushing", async () => {
  const w = await fixture(true)
  const base = await w.git.head()
  const result = await w.run()
  expect(result.code).toBe("INF_WIZ_PUSH_REFUSED")
  expect(result.lines.join("\n")).toContain(w.path)
  expect(await w.git.head()).toBe(base)
  expect(w.git.calls.some(args => args[0] === "push")).toBe(false)
})

it.each([false, true])("pins the recorded measured uninstall commit across a newer branch head (GitLab %s)", async gitlab => {
  const w = await fixture(false, gitlab)
  let pushedSha: string | undefined
  const advance = () => { w.fx.write(w.path, "fbq('consent','grant');\n"); w.fx.git(["add", w.path]); w.fx.git(["commit", "-m", "later owner fixture"]) }
  const push = w.git.push.bind(w.git)
  const options = w.git.pushWithOptions.bind(w.git)
  if (gitlab) w.git.pushWithOptions = async (branch, pushOptions, sha) => { pushedSha = sha; advance(); await options(branch, pushOptions, sha) }
  else w.git.push = async (branch, sha) => { pushedSha = sha; advance(); await push(branch, sha) }
  const result = await w.run()
  expect(result.record?.wizardCommits).toEqual([pushedSha])
  expect(result.record?.ownerBoundary?.state).toBe("checked")
  expect(result.record?.lastPush?.sha).toBe(pushedSha)
  expect(w.fx.remoteSha(result.record!.branch)).toBe(pushedSha)
  expect(await w.git.head()).not.toBe(pushedSha)
})
