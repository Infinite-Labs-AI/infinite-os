// The process boundary every piece of SITE code the wizard executes runs behind (lane O6, §3a.9 item 5).
//
// WHY A CHILD PROCESS. After an agent turn the page JS and the build config are agent-written, and
// `node:vm` is not a security boundary: `stub.constructor.constructor('return process')()` hands page
// code the host's `process`. So T0 never runs in the wizard's own process, and neither does the build.
// `sandboxedSpawn` starts a separate process with a MINIMAL environment (no `INFINITE_TAG_*`, no
// `GROWTH_OS_HOME`, `HOME` = a fresh temp dir), kills it on a deadline, and on macOS wraps it in the
// built-in `sandbox-exec` with a profile that denies `file-read*` of the user's secrets (the Infinite
// session, agent credentials, ssh/aws/npm/netrc, the wizard's own token and snapshot cache) and, for T0,
// every network operation. The build reuses it with network ON (a build may fetch packages) and the same
// read denies.
//
// FAIL CLOSED. On darwin a sandbox that cannot be applied (for example inside another sandbox) is an
// error (`SandboxUnavailableError`), never a silent unsandboxed run. On other platforms (the hosted CI
// runners) the child is a plain process with the same minimal env; that is the documented v1 boundary,
// and `sandboxed:false` in the result says so.
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir, userInfo } from "node:os"
import { join } from "node:path"

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec" as const

/** Environment names a sandboxed child never inherits, whatever the caller passes. */
const FORBIDDEN_ENV = /^(?:INFINITE_TAG_|GROWTH_OS_|CLAUDE|CODEX_|ANTHROPIC_|OPENAI_|GH_|GITHUB_|NPM_TOKEN$|NODE_AUTH_TOKEN$|VERCEL_|AWS_|SSH_AUTH_SOCK$)/

export interface SandboxedSpawnOptions {
  /** Absolute paths whose reads are denied (each path and everything under it). Use `defaultDenyReads()`. */
  denyReads: readonly string[]
  /** Path PREFIXES whose reads are denied, e.g. `<home>/.growth-os` also covers `.growth-os-dev`. */
  denyReadPrefixes?: readonly string[]
  /** `false` for T0 (no network at all); `true` for the build (it may fetch packages). */
  network: boolean
  cwd?: string
  /** Extra variables on top of the minimal env. Forbidden names are dropped. */
  env?: Readonly<Record<string, string>>
  /** Written to the child's stdin, then stdin is closed. */
  input?: string
  /** Kill the whole child (SIGKILL) after this many ms. */
  timeoutMs: number
  signal?: AbortSignal
  /** stdout/stderr are each truncated to this many bytes (default 4 MiB). */
  maxOutputBytes?: number
  /** Test seam: the platform to behave as (default `process.platform`). */
  platform?: NodeJS.Platform
}

export interface SandboxedSpawnResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  /** True only when the child ran under `sandbox-exec`. */
  sandboxed: boolean
  /** The pid of the spawned process (sandbox-exec execs the command, so it is the command's pid). */
  pid: number | null
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export type SandboxedSpawnFn = (cmd: string, args: readonly string[], options: SandboxedSpawnOptions) => Promise<SandboxedSpawnResult>

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SandboxUnavailableError"
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The user's real home directories (HOME may be overridden; the account's home is what holds secrets). */
export function userHomes(): string[] {
  const homes = new Set<string>()
  for (const home of [homedir(), safeUserInfoHome()]) {
    if (!home || home === "/") continue
    homes.add(home)
    homes.add(realpathOrSelf(home))
  }
  return [...homes]
}

function safeUserInfoHome(): string | null {
  try {
    return userInfo().homedir
  } catch {
    return null
  }
}

export interface DenyReadSet {
  /** Whole subtrees. */
  paths: string[]
  /** Name prefixes (`<home>/.growth-os` denies `.growth-os`, `.growth-os-dev`, …). */
  prefixes: string[]
}

/**
 * The §3a.9 item 2 read denies for one home directory: `~/.growth-os*`, the Infinite userData dirs,
 * `~/.codex`, `~/.claude*`, `~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.netrc`, and the wizard's token + snapshot
 * cache (`~/Library/Caches/infinite-tag`). `GROWTH_OS_HOME` (when it points elsewhere) and any extra paths
 * the caller names are added. Every entry is also added in its realpath form, because the sandbox matches
 * resolved vnode paths (`/var` is `/private/var` on macOS).
 */
export function defaultDenyReads(options: { homes?: readonly string[]; growthOsHome?: string | null; extra?: readonly string[] } = {}): DenyReadSet {
  const homes = options.homes ?? userHomes()
  const paths = new Set<string>()
  const prefixes = new Set<string>()
  const addPath = (path: string) => {
    paths.add(path)
    paths.add(realpathOrSelf(path))
  }
  const addPrefix = (path: string) => {
    prefixes.add(path)
    prefixes.add(join(realpathOrSelf(join(path, "..")), path.slice(path.lastIndexOf("/") + 1)))
  }
  for (const home of homes) {
    addPrefix(join(home, ".growth-os"))
    addPrefix(join(home, ".claude"))
    addPrefix(join(home, "Library/Application Support/Infinite"))
    addPath(join(home, ".codex"))
    addPath(join(home, ".ssh"))
    addPath(join(home, ".aws"))
    addPath(join(home, ".npmrc"))
    addPath(join(home, ".netrc"))
    addPath(join(home, "Library/Caches/infinite-tag"))
  }
  const growthOsHome = options.growthOsHome === undefined ? process.env.GROWTH_OS_HOME ?? null : options.growthOsHome
  if (growthOsHome && growthOsHome.startsWith("/")) addPath(growthOsHome)
  for (const extra of options.extra ?? []) {
    if (!extra.startsWith("/")) throw new Error(`deny path must be absolute: ${extra}`)
    addPath(extra)
  }
  return { paths: [...paths].sort(), prefixes: [...prefixes].sort() }
}

function sbplString(value: string): string {
  if (/[\u0000-\u001f]/.test(value)) throw new Error("sandbox path contains a control character")
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/**
 * An SBPL regex literal `#"^<prefix>"`. The literal is passed to the regex engine as written (no string
 * escape processing), so regex metacharacters get ONE backslash; doubling them (string-style) would make
 * the pattern match nothing and silently drop the deny (the sandbox test catches that).
 */
function sbplRegexForPrefix(prefix: string): string {
  if (/["\u0000-\u001f]/.test(prefix)) throw new Error("sandbox prefix contains a quote or a control character")
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return `#"^${escaped}"`
}

/** The SBPL profile: allow by default, then deny reads of each secret location, and the network when off. */
export function buildSandboxProfile(options: { denyReads: readonly string[]; denyReadPrefixes?: readonly string[]; network: boolean }): string {
  const lines = ["(version 1)", "(allow default)"]
  if (!options.network) lines.push("(deny network*)")
  for (const path of options.denyReads) {
    if (!path.startsWith("/")) throw new Error(`deny path must be absolute: ${path}`)
    lines.push(`(deny file-read* (subpath ${sbplString(path)}))`)
  }
  for (const prefix of options.denyReadPrefixes ?? []) {
    if (!prefix.startsWith("/")) throw new Error(`deny prefix must be absolute: ${prefix}`)
    lines.push(`(deny file-read* (regex ${sbplRegexForPrefix(prefix)}))`)
  }
  return lines.join("\n")
}

/**
 * The environment a sandboxed child gets: PATH (so the build finds node and the package manager),
 * a throwaway HOME / TMPDIR, a neutral locale, and nothing else from the parent.
 */
export function minimalChildEnv(home: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    LANG: "en_US.UTF-8",
    NO_COLOR: "1"
  }
  for (const [name, value] of Object.entries(extra)) {
    if (FORBIDDEN_ENV.test(name)) continue
    env[name] = value
  }
  return env
}

let sandboxProbe: { ok: boolean; detail: string } | null = null

/** Whether `sandbox-exec` can apply a profile here (it cannot inside another macOS sandbox). Cached. */
export function probeSandboxExec(): { ok: boolean; detail: string } {
  if (sandboxProbe) return sandboxProbe
  const result = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8", timeout: 10_000 })
  sandboxProbe =
    result.status === 0
      ? { ok: true, detail: "sandbox-exec applies profiles" }
      : { ok: false, detail: (result.error?.message ?? result.stderr ?? `exit ${result.status}`).trim() }
  return sandboxProbe
}

/**
 * Spawn `cmd args` behind the boundary. Resolves (never rejects) once the child exits or is killed;
 * throws `SandboxUnavailableError` up front on darwin when no profile can be applied.
 */
export const sandboxedSpawn: SandboxedSpawnFn = (cmd, args, options) => {
  const platform = options.platform ?? process.platform
  const maxBytes = options.maxOutputBytes ?? 4 * 1024 * 1024
  let argv0 = cmd
  let argv = [...args]
  let sandboxed = false
  if (platform === "darwin") {
    const probe = probeSandboxExec()
    if (!probe.ok) {
      return Promise.reject(new SandboxUnavailableError(`macOS sandbox-exec could not apply a profile (${probe.detail}); refusing to run site code unsandboxed.`))
    }
    const profile = buildSandboxProfile({ denyReads: options.denyReads, denyReadPrefixes: options.denyReadPrefixes ?? [], network: options.network })
    argv0 = SANDBOX_EXEC
    argv = ["-p", profile, cmd, ...args]
    sandboxed = true
  }
  const home = mkdtempSync(join(realpathOrSelf(tmpdir()), "infinite-tag-sbx-"))
  const env = minimalChildEnv(home, options.env)

  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let aborted = false
    let settled = false
    const child = spawn(argv0, argv, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: false })
    const kill = () => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, options.timeoutMs)
    const onAbort = () => {
      aborted = true
      kill()
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > maxBytes) {
        stdout += chunk.slice(0, Math.max(0, maxBytes - stdout.length))
        stdoutTruncated = true
      } else stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length + chunk.length > maxBytes) {
        stderr += chunk.slice(0, Math.max(0, maxBytes - stderr.length))
        stderrTruncated = true
      } else stderr += chunk
    })
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        /* best effort: a temp dir */
      }
      resolve({
        exitCode,
        signal,
        stdout,
        stderr: error ? `${stderr}${stderr ? "\n" : ""}${error.message}` : stderr,
        timedOut,
        aborted,
        sandboxed,
        pid: child.pid ?? null,
        stdoutTruncated,
        stderrTruncated
      })
    }
    child.on("error", (error) => finish(null, null, error))
    child.on("close", (code, signal) => finish(code, signal))
    child.stdin.on("error", () => {
      /* the child may exit before reading its input */
    })
    child.stdin.end(options.input ?? "")
  })
}
