import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createGitFixture, installPreCommitHook, type GitFixture } from "../../test/wizard/git-fixture.js"
import { fakeDeps, RUN_ID } from "../../test/wizard/runtime-fakes.js"
import { createGitOps } from "../git/index.js"
import { createGitLabAdapter } from "../hosts/gitlab.js"
import { nodeWizardFs } from "./fs.js"
import { createRunState } from "./run-state.js"
import { runUninstallFlow } from "./uninstall-flow.js"
import type { AskFn } from "./contracts/deps.js"

const fixtures: GitFixture[] = []
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup() })
async function fixture(unsafe = false, gitlab = false, path = "src/tracking.ts") {
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
  const run = (ask: AskFn = async () => "__timeout__" as never) => runUninstallFlow({ root: fx.root, state, ask, print() {}, now: () => new Date("2026-10-07T00:01:00Z"), base: "main" }, bundle.deps)
  return { fx, git, run, path, bundle, state }
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

it.each([ "commit"])("redacts env literals and neutralizes markup in %s boundary filenames", async scope => {
  const rootSecret = "RootSensitiveFixture42", appSecret = "AppSensitiveFixture73"
  const path = `apps/web/src/${rootSecret}-${appSecret}-<!--@owner-[link](target)-![image](target).ts`
  const w = await fixture(scope === "working_tree", false, path)
  w.state.appRoot = "apps/web"
  w.fx.write(".git/info/exclude", ".env*\n")
  w.fx.write(".env.local", `PRIVATE_TOKEN=${rootSecret}\n`)
  w.fx.write("apps/web/.env.local", `PRIVATE_TOKEN=${appSecret}\n`)
  if (scope === "commit") {
    const commit = w.git.commit.bind(w.git)
    w.git.commit = async input => {
      w.fx.write(path, "fbq('consent','grant');\n")
      w.fx.git(["add", "--", path])
      return commit(input)
    }
  }
  const result = await w.run()
  expect(result.code).toBe("INF_WIZ_PUSH_REFUSED")
  const displayed = result.lines.join("\n")
  for (const unsafe of [rootSecret, appSecret, "<!--", "@owner", "[link](", "![image]("]) expect(displayed).not.toContain(unsafe)
  expect(displayed).toContain("‹!--＠owner-［link］(target)-!［image］(target).ts")
  expect(w.git.calls.some(args => args[0] === "push")).toBe(false)
  expect(readFileSync(join(w.fx.root, path), "utf8")).toContain("'consent','grant'")
  if (scope === "commit") {
    expect(result.record?.ownerBoundary?.issues.map(issue => issue.file)).toContain(path)
    expect(w.fx.git(["show", `HEAD:${path}`])).toContain("'consent','grant'")
  }
})

it("refuses a consent edit introduced by the uninstall commit hook", async () => {
  const w = await fixture()
  installPreCommitHook(w.fx, `printf "fbq('consent','grant');\\n" > ${w.path}\ngit add ${w.path}`)
  const result = await w.run()
  expect(result.code).toBe("INF_WIZ_PUSH_REFUSED")
  expect(result.record?.wizardCommits).toEqual([await w.git.head()])
  expect(result.record?.ownerBoundary?.state).toBe("changed")
  expect(w.fx.remoteSha(result.record!.branch)).toBeNull()
})

it.each([false,])("requires approval for an unrecorded commit even with the run's trailer (approved %s)", async approved => {
  const w = await fixture()
  let ownSha = "", foreignSha = "", question = ""
  const commit = w.git.commit.bind(w.git)
  w.git.commit = async input => {
    const result = await commit(input)
    ownSha = result.sha
    w.fx.write(w.path, "fbq('consent','grant');\n")
    w.fx.git(["add", w.path])
    w.fx.git(["commit", "-m", `owner consent fixture\n\nInfinite-Tag-Run: ${RUN_ID}`])
    foreignSha = await w.git.head()
    return result
  }
  const result = await w.run((async (kind, payload) => {
    expect(kind).toBe("confirm")
    question = (payload as { question: string }).question
    return approved
  }) as AskFn)
  expect(question).toContain(foreignSha.slice(0, 12))
  expect(result.record?.wizardCommits).toEqual([ownSha])
  expect(result.record?.ownerBoundary).toMatchObject({ state: "checked", wizardCommits: [ownSha] })
  expect(w.fx.remoteSha(result.record!.branch)).toBe(approved ? foreignSha : null)
  expect(result.record?.approvedForeignCommits).toEqual(approved ? [foreignSha] : [])
})

