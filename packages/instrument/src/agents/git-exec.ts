// The few git calls the fence and the runner need (status, ls-files, cat-file, rev-parse, and the fence's
// own undo of an agent's commit or staging: update-ref). GitOps (lane O4) owns every other git call that
// changes the repo.
//
// Every call is hardened against config an agent could have planted in `.git/config` during its turn
// (review O3 F1): `core.fsmonitor` (git status RUNS it), hooks (update-ref runs reference-transaction) and
// the system config are switched off on the command line, which outranks every config file. The fence
// also restores `.git/config` and friends from its snapshot BEFORE its first git call after a turn.
import { execFile } from "node:child_process"

export interface GitResult {
  code: number
  stdout: Buffer
  stderr: string
}

const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C"
}

/** `-c` flags on every call: no fsmonitor command, no hooks, no pager, quoted paths off. */
export const GIT_HARDENING_ARGS = [
  "-c",
  "core.quotepath=off",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.pager=cat"
] as const

export function gitEnv(base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) out[key] = value
  return { ...out, ...GIT_ENV }
}

export function git(cwd: string, args: readonly string[], env?: Record<string, string>): Promise<GitResult> {
  return new Promise((resolveGit) => {
    execFile(
      "git",
      [...GIT_HARDENING_ARGS, ...args],
      { cwd, env: env ?? gitEnv(), encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0
        resolveGit({ code, stdout: stdout as Buffer, stderr: (stderr as Buffer).toString("utf8") })
      }
    )
  })
}

export async function gitOk(cwd: string, args: readonly string[], env?: Record<string, string>): Promise<Buffer> {
  const result = await git(cwd, args, env)
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`)
  return result.stdout
}

/** One `git status --porcelain=v1 -z` entry. `from` is set for renames/copies. */
export interface StatusEntry {
  xy: string
  path: string
  from?: string
}

export function parsePorcelainZ(output: Buffer | string): StatusEntry[] {
  const text = typeof output === "string" ? output : output.toString("utf8")
  const tokens = text.split("\0")
  const out: StatusEntry[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.length < 4) continue
    const xy = token.slice(0, 2)
    const path = token.slice(3)
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      out.push({ xy, path, from: tokens[index + 1] ?? "" })
      index += 1
    } else {
      out.push({ xy, path })
    }
  }
  return out
}
