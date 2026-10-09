// Lane O4: GitOps over a real bare remote + clone (no network). Every rule has a negative case.
import { existsSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createGitFixture, type GitFixture } from "../../test/wizard/git-fixture.js"
import { WIZARD_BRANCH_PREFIX } from "../wizard/contracts/state.js"
import { computeStageSet } from "./commit.js"
import { createGitOps } from "./index.js"
import { assertSafeGitArgv, GitSafetyError, spawnProcess, type ProcessRunner } from "./run.js"

const BRANCH = `${WIZARD_BRANCH_PREFIX}2026-10-02-7f3c2a`
const fixtures: GitFixture[] = []
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup()
})

function fixture(files?: Record<string, string>): GitFixture {
  const value = createGitFixture(files ? { files } : {})
  fixtures.push(value)
  return value
}

/** A runner that records every argv and env before spawning the real git. */
function recordingRunner(): { runner: ProcessRunner; calls: Array<{ args: readonly string[]; env: Readonly<Record<string, string | undefined>> }> } {
  const calls: Array<{ args: readonly string[]; env: Readonly<Record<string, string | undefined>> }> = []
  return {
    calls,
    runner: async (command, args, options) => {
      calls.push({ args, env: options.env })
      return spawnProcess(command, args, options)
    }
  }
}

describe("the git argv guard (§3g.1)", () => {
  it("allows the wizard's own argv", () => {
    expect(() => assertSafeGitArgv(["push", "-u", "origin", BRANCH], { base: "main" })).not.toThrow()
    expect(() => assertSafeGitArgv(["commit", "-F", "-"])).not.toThrow()
    expect(() => assertSafeGitArgv(["add", "--", "app/layout.tsx"])).not.toThrow()
    expect(() => assertSafeGitArgv(["worktree", "remove", "--force", "/x/review-1"])).not.toThrow()
    expect(() => assertSafeGitArgv(["merge", "--ff-only", `origin/${BRANCH}`])).not.toThrow()
  })

  it.each([
    [["push", "-f", "origin", BRANCH]],
    [["push", "-u", "origin", `+${BRANCH}`]],
    [["push", "-u", "origin", `HEAD:main`]],
    [["push", "--delete", "origin", BRANCH]],
    [["commit", "-n", "-F", "-"]],
    [["commit", "--amend", "-F", "-"]],
    [["add", "-f", "--", ".env"]],
    [["reset", "--hard", "HEAD~1"]],
  ])("refuses %j", (args) => {
    expect(() => assertSafeGitArgv(args, { base: "main" })).toThrow(GitSafetyError)
  })
})

describe("the PR branch (§3g.1)", () => {
  it("is created from origin/<base> and HEAD == origin/<base> before any edit", async () => {
    const fx = fixture()
    // A local, unpushed commit on main must NOT leak into the PR branch.
    fx.write("local-only.txt", "not pushed\n")
    fx.git(["add", "--", "local-only.txt"])
    fx.git(["commit", "-q", "-m", "local only"])
    const git = createGitOps({ cwd: fx.root, env: fx.env })
    const { baseSha } = await git.createBranch("main", BRANCH)
    expect(baseSha).toBe(fx.remoteSha("main"))
    expect(await git.head()).toBe(fx.remoteSha("main"))
    expect(await git.currentBranch()).toBe(BRANCH)
    expect(existsSync(join(fx.root, "local-only.txt"))).toBe(false)
  })

  it("refuses a branch outside infinite/tag/ and the base itself (negative)", async () => {
    const fx = fixture()
    const git = createGitOps({ cwd: fx.root, env: fx.env })
    await expect(git.createBranch("main", "feature/x")).rejects.toThrow(/unsafe PR branch/)
    await expect(git.createBranch("main", "main")).rejects.toThrow()
  })
})

describe("the stage set (§3g.1)", () => {
  const entry = (path: string, x = " ", y = "M") => ({ x, y, path })

  it("stages only allowlisted + managed files, the npm job's package.json/lockfile, install.json and the fence", () => {
    const set = computeStageSet({
      entries: [
        entry("app/layout.tsx"),
        entry("lib/infinite-server-lane.ts", "?", "?"),
        entry("package.json"),
        entry("package-lock.json"),
        entry(".infinite/install.json", "?", "?"),
        entry(".infinite/wizard/state.json", "?", "?"),
        entry(".gitignore"),
        entry("README.md"),
        entry(".env.local", "?", "?"),
        entry("app/old.tsx", " ", "D")
      ],
      allowlist: ["app/layout.tsx"],
      managed: ["lib/infinite-server-lane.ts"],
      npmFiles: ["package.json", "package-lock.json"],
      gitignoreFenceOnly: true
    })
    expect(set.refusal).toBeNull()
    expect(set.stage).toEqual([".gitignore", ".infinite/install.json", "app/layout.tsx", "lib/infinite-server-lane.ts", "package-lock.json", "package.json"])
    expect(set.leftOut).toEqual(
      expect.arrayContaining([
        { path: "README.md", why: "not_in_allowlist" },
        { path: ".env.local", why: "denied" },
        { path: "app/old.tsx", why: "deletion" },
        { path: ".infinite/wizard/state.json", why: "wizard_state" }
      ])
    )
  })
})

describe("commit and push (§3g.1)", () => {
  it("commits with the Infinite-Tag-Run trailer and never -n, --no-verify, --no-gpg-sign or --amend", async () => {
    const fx = fixture()
    const { runner, calls } = recordingRunner()
    const git = createGitOps({ cwd: fx.root, env: fx.env, runner })
    await git.createBranch("main", BRANCH)
    fx.write("app/layout.tsx", "export default function Layout() { return 'tagged' }\n")
    await git.stage(["app/layout.tsx"])
    const { sha, hookRewrote } = await git.commit({ message: "infinite-tag: set up analytics", trailers: { "Infinite-Tag-Run": "run-1", "Infinite-Review-Round": "1" } })
    expect(hookRewrote).toEqual([])
    const message = fx.git(["log", "-1", "--format=%B", sha])
    expect(message).toMatch(/Infinite-Tag-Run: run-1/)
    expect(fx.git(["log", "-1", "--format=%(trailers:key=Infinite-Review-Round,valueonly)", sha]).trim()).toBe("1")
    const all = calls.flatMap((call) => call.args)
    for (const forbidden of ["-n", "--no-verify", "--no-gpg-sign", "--amend", "-f", "--force"]) expect(all).not.toContain(forbidden)
  })

  it("pushes the branch (never -f; GIT_TERMINAL_PROMPT=0; SSH BatchMode) and refuses the base", async () => {
    const fx = fixture()
    const { runner, calls } = recordingRunner()
    const git = createGitOps({ cwd: fx.root, env: fx.env, runner })
    await git.createBranch("main", BRANCH)
    fx.write("app/layout.tsx", "tagged\n")
    await git.stage(["app/layout.tsx"])
    const { sha } = await git.commit({ message: "m", trailers: { "Infinite-Tag-Run": "r" } })
    await git.push(BRANCH)
    expect(fx.remoteSha(BRANCH)).toBe(sha)
    const push = calls.find((call) => call.args[0] === "push")!
    expect(push.args).toEqual(["push", "-u", "origin", BRANCH])
    expect(push.env.GIT_TERMINAL_PROMPT).toBe("0")
    expect(push.env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes")
    await expect(git.push("main")).rejects.toThrow(GitSafetyError)
    expect(fx.remoteSha("main")).not.toBe(sha)
  })
})

it("pushes exactly the measured commit even if the local branch advances", async () => {
  const fx = fixture()
  const git = createGitOps({ cwd: fx.root, env: fx.env })
  await git.createBranch("main", BRANCH)
  fx.write("measured.txt", "measured\n")
  fx.git(["add", "measured.txt"])
  fx.git(["commit", "-m", "measured fixture"])
  const measured = await git.head()
  fx.write("later.txt", "not measured\n")
  fx.git(["add", "later.txt"])
  fx.git(["commit", "-m", "later fixture"])
  await git.push(BRANCH, measured)
  expect(fx.remoteSha(BRANCH)).toBe(measured)
  expect(await git.head()).not.toBe(measured)
  expect(() => assertSafeGitArgv(["push", "origin", `${measured}:refs/heads/main`], { base: "main" })).toThrow(GitSafetyError)
  expect(() => assertSafeGitArgv(["push", "origin", `+${measured}:refs/heads/${BRANCH}`], { base: "main" })).toThrow(GitSafetyError)
})
