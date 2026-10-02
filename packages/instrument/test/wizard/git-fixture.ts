// A bare remote plus a clone, for lane O4's tests (and I1's E2E). Real `git`, no network: the remote is a local
// bare repo. Git runs with an isolated config (no global or system file), so a developer's own hooks path,
// signing setting or pull.rebase can never leak into a test.
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export interface GitFixture {
  /** The temp dir holding everything. */
  dir: string
  /** The bare remote (`origin`). */
  remote: string
  /** The working clone (the "customer's repo"). */
  root: string
  /** The env every git (and fake gh) call in the test uses. */
  env: Record<string, string>
  git(args: readonly string[], cwd?: string): string
  write(path: string, text: string): void
  /** The SHA of `refs/heads/<branch>` on the bare remote, or null. */
  remoteSha(branch: string): string | null
  cleanup(): void
}

export function createGitFixture(options: { files?: Record<string, string>; base?: string } = {}): GitFixture {
  const dir = mkdtempSync(join(tmpdir(), "infinite-tag-o4-"))
  const home = join(dir, "home")
  mkdirSync(home)
  const globalConfig = join(dir, "gitconfig")
  writeFileSync(
    globalConfig,
    ["[user]", "\tname = Fixture User", "\temail = fixture@users.noreply.github.com", "[commit]", "\tgpgsign = false", "[init]", "\tdefaultBranch = main", ""].join("\n")
  )
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C"
  }
  const base = options.base ?? "main"
  const remote = join(dir, "remote.git")
  const root = join(dir, "work")
  const git = (args: readonly string[], cwd: string = root): string =>
    execFileSync("git", [...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git(["init", "--bare", "-q", `--initial-branch=${base}`, remote], dir)
  git(["clone", "-q", remote, root], dir)
  const write = (path: string, text: string): void => {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, text)
  }
  git(["symbolic-ref", "HEAD", `refs/heads/${base}`])
  const files = options.files ?? { "README.md": "# acme store\n", "app/layout.tsx": "export default function Layout() { return null }\n" }
  for (const [path, text] of Object.entries(files)) write(path, text)
  git(["add", "-A"])
  git(["commit", "-q", "-m", "initial"])
  git(["push", "-q", "-u", "origin", base])
  git(["remote", "set-head", "origin", base])
  return {
    dir,
    remote,
    root,
    env,
    git,
    write,
    remoteSha(branch) {
      try {
        return execFileSync("git", ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
      } catch {
        return null
      }
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Installs a pre-commit hook in the fixture clone (a shell script body). */
export function installPreCommitHook(fixture: GitFixture, body: string): void {
  const hook = join(fixture.root, ".git", "hooks", "pre-commit")
  writeFileSync(hook, `#!/bin/sh\n${body}\n`)
  chmodSync(hook, 0o755)
}
