// The one place the wizard spawns `git` and `gh` (lane O4, §3g.1). Two jobs:
//
// 1. A small process runner (argv only, never a shell; stdin is the only way a value travels; a timeout and
//    an AbortSignal kill the child), injectable so tests can record argv.
// 2. The argv guard. The wizard never force-pushes, never amends, never rebases, never skips hooks or
//    signing, never stages everything, and never pushes to the base (§3g.1). Those rules are checked HERE,
//    on the exact argv, before any spawn, so no caller can get them wrong.
import { spawn } from "node:child_process"

import { WIZARD_BRANCH_PREFIX } from "../wizard/contracts/state.js"

export interface ProcessResult {
  status: number | null
  stdout: string
  stderr: string
  /** Spawn failure (ENOENT when the binary is not installed), a timeout or an abort. */
  error?: string
}

export interface ProcessOptions {
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  /** Written to stdin, then the pipe is closed. */
  input?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export type ProcessRunner = (command: string, args: readonly string[], options: ProcessOptions) => Promise<ProcessResult>

const KILL_GRACE_MS = 1_000

function cleanEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  return out
}

/** Spawns one process with argv only (no shell) and buffers its output. */
export const spawnProcess: ProcessRunner = (command, args, options) =>
  new Promise((resolveResult) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    let child: ReturnType<typeof spawn>
    const finish = (result: ProcessResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      resolveResult(result)
    }
    const kill = (reason: string): void => {
      if (settled) return
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref()
      finish({ status: null, stdout, stderr, error: reason })
    }
    const onAbort = (): void => kill("aborted")
    let timer: NodeJS.Timeout | undefined
    try {
      child = spawn(command, [...args], { cwd: options.cwd, env: cleanEnv(options.env), stdio: ["pipe", "pipe", "pipe"] })
    } catch (error) {
      resolveResult({ status: null, stdout, stderr, error: error instanceof Error ? error.message : String(error) })
      return
    }
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", (error) => finish({ status: null, stdout, stderr, error: error.message }))
    child.on("close", (code) => finish({ status: code, stdout, stderr }))
    child.stdin?.on("error", () => undefined)
    child.stdin?.end(options.input ?? "")
    if (options.timeoutMs !== undefined) timer = setTimeout(() => kill("timeout"), options.timeoutMs)
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener("abort", onAbort, { once: true })
    }
  })

// ---------------------------------------------------------------------------------------------
// The env every git child gets (§3g.1)
// ---------------------------------------------------------------------------------------------

/**
 * `GIT_TERMINAL_PROMPT=0` always (a credential prompt would hang the wizard), and SSH in BatchMode unless
 * the TTY was handed over to the user (then their agent / passphrase prompt may run). A user's own
 * `GIT_SSH_COMMAND` is kept and BatchMode is appended to it.
 */
export function gitChildEnv(
  base: Readonly<Record<string, string | undefined>>,
  options: { ttyHandedOver?: boolean } = {}
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }
  if (!options.ttyHandedOver) {
    const own = base.GIT_SSH_COMMAND?.trim()
    env.GIT_SSH_COMMAND = own ? `${own} -o BatchMode=yes` : "ssh -o BatchMode=yes"
  }
  return env
}

// ---------------------------------------------------------------------------------------------
// The argv guard
// ---------------------------------------------------------------------------------------------

export class GitSafetyError extends Error {
  constructor(message: string) {
    super(`refused git argv: ${message}`)
    this.name = "GitSafetyError"
  }
}

/** The only git subcommands the wizard runs. Anything else (rebase, reset, clean, pull, filter-*) is refused. */
const ALLOWED_SUBCOMMANDS = new Set([
  "rev-parse",
  "status",
  "remote",
  "fetch",
  "switch",
  "add",
  "restore",
  "commit",
  "push",
  "worktree",
  "diff",
  "merge-base",
  "merge",
  "ls-files",
  "ls-tree",
  "show",
  "config",
  "symbolic-ref",
  "cat-file",
  "log",
  "check-ignore"
])

const FORBIDDEN_ANYWHERE = ["--no-verify", "--no-gpg-sign", "--amend", "--force", "--force-with-lease", "--force-if-includes", "--mirror"]

export interface GitGuardContext {
  /** The base branch: never pushed to. */
  base?: string | null
  pushRemote?: string | null
}

/**
 * Throws GitSafetyError when the argv breaks a §3g.1 rule. `args` starts with the subcommand (the wizard
 * never puts `-c` or `-C` before it; the cwd is the spawn's cwd).
 */
export function assertSafeGitArgv(args: readonly string[], context: GitGuardContext = {}): void {
  const [sub, ...rest] = args
  if (!sub || !ALLOWED_SUBCOMMANDS.has(sub)) throw new GitSafetyError(`subcommand ${JSON.stringify(sub ?? "")} is not allowed`)
  for (const arg of rest) {
    for (const flag of FORBIDDEN_ANYWHERE) {
      if (arg === flag || arg.startsWith(`${flag}=`)) {
        // `worktree remove --force` removes OUR scratch worktree (it holds untracked review inputs); it
        // touches no branch, ref or remote.
        if (sub === "worktree" && rest[0] === "remove" && arg === "--force") continue
        throw new GitSafetyError(`${arg} is never used`)
      }
    }
  }
  switch (sub) {
    case "commit":
      // An allowlist: the message comes on stdin (`-F -`). No `-n`, `-a`, `--amend`, `--no-verify`,
      // `--no-gpg-sign`, `--allow-empty` or bundles of them can ever get through.
      for (const arg of rest) {
        if (arg === "-F" || arg === "-" || arg === "-q" || arg === "--quiet" || arg === "--cleanup=strip") continue
        throw new GitSafetyError(`commit ${arg} is never used`)
      }
      if (!rest.includes("-F")) throw new GitSafetyError("commit takes its message on stdin (-F -)")
      return
    case "add":
      for (const arg of rest) {
        if (arg === "-A" || arg === "--all" || arg === "-f" || arg === "-u" || arg === "--update" || arg === "." || arg === ":/") {
          throw new GitSafetyError(`add ${arg} is never used (the wizard stages an explicit path list)`)
        }
      }
      if (!rest.includes("--")) throw new GitSafetyError("add needs `--` before its paths")
      return
    case "push": {
      // Exactly: push -u origin <branch> [-o <option>]… (an allowlist: -f, --delete, --all, --tags,
      // --mirror and every other flag are refused below).
      const positional: string[] = []
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i]!
        if (arg === "-u" || arg === "--set-upstream" || arg === "--porcelain") continue
        if (arg === "-o" || arg === "--push-option") {
          i += 1
          continue
        }
        if (arg.startsWith("-")) throw new GitSafetyError(`push ${arg} is not allowed`)
        positional.push(arg)
      }
      if (positional.length !== 2 || (positional[0] !== "origin" && positional[0] !== context.pushRemote)) throw new GitSafetyError("push must target origin or the approved fork")
      const branch = positional[1]!
      if (branch.includes(":") || branch.startsWith("+")) throw new GitSafetyError(`push refspec ${branch} is never used`)
      if (context.base && (branch === context.base || branch === `refs/heads/${context.base}`)) {
        throw new GitSafetyError(`never push to the base branch ${context.base}`)
      }
      if (!branch.startsWith(WIZARD_BRANCH_PREFIX)) throw new GitSafetyError(`the wizard pushes only ${WIZARD_BRANCH_PREFIX}* branches`)
      return
    }
    case "switch":
      for (const arg of rest) {
        if (arg === "-C" || arg === "--force-create" || arg === "--discard-changes" || arg === "-f") {
          throw new GitSafetyError(`switch ${arg} is never used`)
        }
      }
      return
    case "merge":
      if (!rest.includes("--ff-only")) throw new GitSafetyError("merge is used only with --ff-only")
      return
    case "worktree":
      if (rest[0] !== "add" && rest[0] !== "remove" && rest[0] !== "prune") throw new GitSafetyError(`worktree ${rest[0] ?? ""} is not allowed`)
      if (rest[0] === "add" && !rest.includes("--detach")) throw new GitSafetyError("worktree add is always --detach")
      return
    case "config":
      if (rest[0] !== "--get") throw new GitSafetyError("config is read-only (--get)")
      return
    case "restore":
      if (!rest.includes("--staged") || rest.includes("--worktree") || rest.includes("-W")) {
        throw new GitSafetyError("restore is used only to unstage (--staged)")
      }
      return
    case "remote":
      if (rest[0] !== "get-url") throw new GitSafetyError("remote is read-only (get-url)")
      return
    default:
      return
  }
}
