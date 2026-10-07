// Lane O4: GitOps over a real bare remote + clone (no network). Every rule has a negative case.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createGitFixture, installPreCommitHook, type GitFixture } from "../../test/wizard/git-fixture.js"
import { WIZARD_BRANCH_PREFIX } from "../wizard/contracts/state.js"
import { resolveBase } from "./branch.js"
import { computeStageSet, GitCommitError } from "./commit.js"
import { createGitOps } from "./index.js"
import { GitPushError, pushArgv, gitlabMergeRequestPushOptions } from "./push.js"
import { assertSafeGitArgv, gitChildEnv, GitSafetyError, spawnProcess, type ProcessRunner } from "./run.js"
import { gitignoreChangeIsFenceOnly, parsePorcelainZ } from "./status.js"

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
    [["push", "--force", "-u", "origin", BRANCH]],
    [["push", "--force-with-lease", "-u", "origin", BRANCH]],
    [["push", "-u", "origin", `+${BRANCH}`]],
    [["push", "-u", "origin", `HEAD:main`]],
    [["push", "--delete", "origin", BRANCH]],
    [["push", "-u", "origin", "main"]],
    [["push", "-u", "origin", "feature/not-ours"]],
    [["commit", "-n", "-F", "-"]],
    [["commit", "--no-verify", "-F", "-"]],
    [["commit", "--no-gpg-sign", "-F", "-"]],
    [["commit", "--amend", "-F", "-"]],
    [["commit", "-a", "-F", "-"]],
    [["commit", "-m", "x"]],
    [["add", "-A"]],
    [["add", "--", "."]],
    [["add", "-f", "--", ".env"]],
    [["rebase", "main"]],
    [["reset", "--hard", "HEAD~1"]],
    [["pull", "--rebase"]],
    [["merge", "origin/main"]],
    [["switch", "-C", BRANCH]],
    [["config", "user.email", "x@y.z"]],
    [["restore", "app/layout.tsx"]],
    [["clean", "-fdx"]]
  ])("refuses %j", (args) => {
    expect(() => assertSafeGitArgv(args, { base: "main" })).toThrow(GitSafetyError)
  })

  it("the child env never prompts and runs SSH in BatchMode unless the TTY was handed over", () => {
    const env = gitChildEnv({ PATH: "/bin" })
    expect(env.GIT_TERMINAL_PROMPT).toBe("0")
    expect(env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes")
    expect(gitChildEnv({ GIT_SSH_COMMAND: "ssh -i ~/.ssh/deploy" }).GIT_SSH_COMMAND).toBe("ssh -i ~/.ssh/deploy -o BatchMode=yes")
    // Negative: handed over → the user's passphrase prompt may run.
    expect(gitChildEnv({ PATH: "/bin" }, { ttyHandedOver: true }).GIT_SSH_COMMAND).toBeUndefined()
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

  it("resolves the base: Vercel, then defaultBranchRef, then origin/HEAD, labelling the last two fallback", async () => {
    const host = (defaultBranch: string | null) => ({
      repoFacts: async () => ({ isPrivate: true, defaultBranch, viewerPermission: "WRITE" })
    })
    const vercel = { provider: "vercel" as const, vercel: { productionBranch: "production" } as never }
    expect(await resolveBase({ hosting: vercel, host: host("main"), originHead: async () => "main" })).toMatchObject({ base: "production", baseSource: "vercel", fallback: false })
    const fromHost = await resolveBase({ hosting: { provider: "none", vercel: null }, host: host("trunk"), originHead: async () => "main" })
    expect(fromHost).toMatchObject({ base: "trunk", baseSource: "default_branch", fallback: true })
    expect(fromHost!.label).toMatch(/fallback/)
    const fromOrigin = await resolveBase({ hosting: null, host: { repoFacts: async () => ({ unsupported: true }) }, originHead: async () => "develop" })
    expect(fromOrigin).toMatchObject({ base: "develop", baseSource: "origin_head", fallback: true })
    // Negative: nothing known → null (never a guessed "main").
    expect(await resolveBase({ hosting: null, host: { repoFacts: async () => ({ unsupported: true }) }, originHead: async () => null })).toBeNull()
  })

  it("reads origin/HEAD from the clone", async () => {
    const fx = fixture()
    expect(await createGitOps({ cwd: fx.root, env: fx.env }).originHead()).toBe("main")
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

  it("does NOT stage package.json or a lockfile the npm job did not record (negative)", () => {
    const set = computeStageSet({ entries: [entry("package.json"), entry("yarn.lock")], allowlist: ["package.json"], managed: [], npmFiles: [], gitignoreFenceOnly: true })
    expect(set.stage).toEqual([])
  })

  it("refuses when .gitignore holds a change outside the wizard's fence (negative)", () => {
    expect(gitignoreChangeIsFenceOnly("node_modules\n", "node_modules\n# infinite:start\n.infinite/wizard/\n# infinite:end\n")).toBe(true)
    expect(gitignoreChangeIsFenceOnly("node_modules\n", "node_modules\ndist\n# infinite:start\n.infinite/wizard/\n# infinite:end\n")).toBe(false)
    const set = computeStageSet({ entries: [entry(".gitignore")], allowlist: [], managed: [], npmFiles: [], gitignoreFenceOnly: false })
    expect(set.refusal).toMatch(/\.gitignore has changes the wizard did not make/)
    expect(set.stage).toEqual([])
  })

  it("parses NUL-separated porcelain, renames included", () => {
    expect(parsePorcelainZ(" M a.ts\0R  new.ts\0old.ts\0?? b c.ts\0")).toEqual([
      { x: " ", y: "M", path: "a.ts" },
      { x: "R", y: " ", path: "new.ts", origPath: "old.ts" },
      { x: "?", y: "?", path: "b c.ts" }
    ])
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

  it("detects a hook that rewrote a staged file", async () => {
    const fx = fixture()
    const git = createGitOps({ cwd: fx.root, env: fx.env })
    await git.createBranch("main", BRANCH)
    installPreCommitHook(fx, `printf '// formatted\\n' >> app/layout.tsx && git add app/layout.tsx`)
    fx.write("app/layout.tsx", "export default function Layout() { return 'x' }\n")
    await git.stage(["app/layout.tsx"])
    const { sha, hookRewrote } = await git.commit({ message: "m", trailers: { "Infinite-Tag-Run": "r" } })
    expect(hookRewrote).toEqual(["app/layout.tsx"])
    expect(fx.git(["show", `${sha}:app/layout.tsx`])).toMatch(/formatted/)
  })

  it("a failing pre-commit hook is reported as hook_failed, with the wizard's files it names (negative: nothing committed)", async () => {
    const fx = fixture()
    const git = createGitOps({ cwd: fx.root, env: fx.env })
    const { baseSha } = await git.createBranch("main", BRANCH)
    installPreCommitHook(fx, `echo "lint error in app/layout.tsx" >&2; exit 1`)
    fx.write("app/layout.tsx", "bad\n")
    await git.stage(["app/layout.tsx"])
    const error = await git.commit({ message: "m", trailers: { "Infinite-Tag-Run": "r" } }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitCommitError)
    expect((error as GitCommitError).kind).toBe("hook_failed")
    expect((error as GitCommitError).pathsInOutput).toEqual(["app/layout.tsx"])
    expect(await git.head()).toBe(baseSha)
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

  it("a refused push surfaces as GitPushError (negative: nothing on the remote)", async () => {
    const fx = fixture()
    const git = createGitOps({ cwd: fx.root, env: fx.env })
    await git.createBranch("main", BRANCH)
    fx.git(["remote", "set-url", "origin", join(fx.dir, "missing.git")])
    await expect(git.push(BRANCH)).rejects.toBeInstanceOf(GitPushError)
    expect(fx.remoteSha(BRANCH)).toBeNull()
  })

  it("GitLab push options open a draft merge request (argv only)", () => {
    expect(pushArgv(BRANCH, gitlabMergeRequestPushOptions("main", "Infinite: analytics"))).toEqual([
      "push",
      "-u",
      "-o",
      "merge_request.create",
      "-o",
      "merge_request.target=main",
      "-o",
      "merge_request.draft",
      "-o",
      "merge_request.title=Infinite: analytics",
      "origin",
      BRANCH
    ])
    expect(() => assertSafeGitArgv(pushArgv(BRANCH, gitlabMergeRequestPushOptions("main", "t")), { base: "main" })).not.toThrow()
  })

  it("isAncestor, a fast-forward pull and the detached review worktree", async () => {
    const fx = fixture()
    const git = createGitOps({ cwd: fx.root, env: fx.env, worktreeRoot: join(fx.dir, "worktrees") })
    const { baseSha } = await git.createBranch("main", BRANCH)
    fx.write("app/layout.tsx", "one\n")
    await git.stage(["app/layout.tsx"])
    const first = (await git.commit({ message: "m", trailers: { "Infinite-Tag-Run": "r" } })).sha
    await git.push(BRANCH)
    expect(await git.isAncestor(baseSha, first)).toBe(true)
    expect(await git.isAncestor(first, baseSha)).toBe(false)
    // Someone (gh pr update-branch) adds a commit on the remote branch: fast-forward only.
    const other = join(fx.dir, "other")
    fx.git(["clone", "-q", "--branch", BRANCH, fx.remote, other], fx.dir)
    fx.git(["commit", "-q", "--allow-empty", "-m", "merge base into branch"], other)
    fx.git(["push", "-q", "origin", BRANCH], other)
    const { headSha } = await git.pullFfOnly(BRANCH)
    expect(headSha).toBe(fx.remoteSha(BRANCH))
    expect(await git.isAncestor(first, headSha)).toBe(true)
    const { dir } = await git.worktreeAddDetached(headSha)
    expect(readFileSync(join(dir, "app/layout.tsx"), "utf8")).toBe("one\n")
    expect(existsSync(join(dir, ".git"))).toBe(true)
    await git.worktreeRemove(dir)
    expect(existsSync(dir)).toBe(false)
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
