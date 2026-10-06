// The process boundary every piece of SITE code the wizard executes runs behind (lane O6, §3a.9 item 5).
//
// WHY A CHILD PROCESS. After an agent turn the page JS and the build config are agent-written, and
// `node:vm` is not a security boundary: `stub.constructor.constructor('return process')()` hands page
// code the host's `process`. So T0 never runs in the wizard's own process, and neither does the build.
// `sandboxedSpawn` starts a separate process with a MINIMAL environment (no `INFINITE_TAG_*`, no
// `GROWTH_OS_HOME`, `HOME` = a fresh temp dir), kills it on a deadline, and on macOS wraps it in the
// built-in `sandbox-exec` with a profile that denies `file-read*` of the user's secrets (the Infinite
// session, agent credentials, ssh/aws/npm/netrc, CLI credential stores, the wizard's own token and
// snapshot cache), denies EVERY `file-write*` except the child's own temp HOME and the subtrees the
// caller names (T0 names none; the build names the repo, minus `.git`, `.husky` and `.infinite`), and,
// for T0, every network operation. The build reuses it with network ON (a build may fetch packages).
// Writes matter as much as reads: escaped page code that could write would plant a git hook the
// wizard's own (unsandboxed) commit then runs, clobber `~/.growth-os/.env`, or add shell persistence.
//
// THE DEADLINE HOLDS FOR THE WHOLE TREE. The child is its own process group (`detached`); a deadline,
// an abort, or the parent's own exit kills the GROUP, so a grandchild that keeps stdout open (`pnpm` →
// `next build`) can neither hang the wizard nor survive it. After the child exits, its stdio gets a
// short grace period to drain, then the group is killed and the streams are destroyed.
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
  /**
   * Subtrees the child may WRITE besides its own temp HOME (every other write is denied on macOS). T0
   * passes none; the build passes the repo root. Each is also added in realpath form.
   */
  allowWrites?: readonly string[]
  /** Subtrees never writable, even inside `allowWrites` (the build: `<root>/.git`, `.husky`, `.infinite`). */
  denyWrites?: readonly string[]
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
  /** Progress from the child while it is running (never fed back into the child). */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void
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
  /** The child's throwaway HOME / TMPDIR (already deleted), so callers can normalise it out of output. */
  home: string
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

/** Credential stores of CLIs a founder's machine typically has (Vercel, GitHub, git, Docker, gcloud, kube, gpg). */
export const CLI_CREDENTIAL_STORES = [
  "Library/Application Support/com.vercel.cli",
  ".local/share/com.vercel.cli",
  ".config/gh",
  ".git-credentials",
  ".docker",
  ".config/gcloud",
  ".kube",
  ".gnupg",
  ".pgpass"
] as const

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
    // CLI credential stores beyond §3a.9's list (review O6-R20): the build runs with the network ON, so a
    // token it could read it could also send.
    for (const store of CLI_CREDENTIAL_STORES) addPath(join(home, store))
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

/** Device files a process may always write (its own stdio redirections, `/dev/null`). */
const DEVICE_WRITES = ['(literal "/dev/null")', '(literal "/dev/zero")', '(literal "/dev/tty")', '(literal "/dev/dtracehelper")', '(regex #"^/dev/fd/")']

function absolute(path: string, what: string): string {
  if (!path.startsWith("/")) throw new Error(`${what} must be absolute: ${path}`)
  return path
}

/**
 * The SBPL profile. Later rules win, so the order is the policy: allow by default; deny the network
 * when off; deny reads of each secret location; deny EVERY write, re-allow the writable roots and the
 * device files; then deny writes again under `denyWrites` and under every secret location (so a
 * writable root that happens to contain one cannot reopen it).
 */
export function buildSandboxProfile(options: {
  denyReads: readonly string[]
  denyReadPrefixes?: readonly string[]
  network: boolean
  /** Subtrees the child may write (its temp HOME + the caller's `allowWrites`). */
  writableRoots: readonly string[]
  denyWrites?: readonly string[]
}): string {
  const lines = ["(version 1)", "(allow default)"]
  if (!options.network) lines.push("(deny network*)")
  const readPaths = options.denyReads.map((path) => `(subpath ${sbplString(absolute(path, "deny path"))})`)
  const readPrefixes = (options.denyReadPrefixes ?? []).map((prefix) => `(regex ${sbplRegexForPrefix(absolute(prefix, "deny prefix"))})`)
  for (const filter of readPaths) lines.push(`(deny file-read* ${filter})`)
  for (const filter of readPrefixes) lines.push(`(deny file-read* ${filter})`)
  lines.push("(deny file-write*)")
  const writable = options.writableRoots.map((path) => `(subpath ${sbplString(absolute(path, "writable root"))})`)
  lines.push(`(allow file-write* ${[...writable, ...DEVICE_WRITES].join(" ")})`)
  for (const path of options.denyWrites ?? []) lines.push(`(deny file-write* (subpath ${sbplString(absolute(path, "deny-write path"))}))`)
  for (const filter of [...readPaths, ...readPrefixes]) lines.push(`(deny file-write* ${filter})`)
  return lines.join("\n")
}

function withRealpaths(paths: readonly string[]): string[] {
  const out = new Set<string>()
  for (const path of paths) {
    out.add(path)
    out.add(realpathOrSelf(path))
  }
  return [...out]
}

/** Process groups of children still running; killed if the wizard itself exits first. */
const liveGroups = new Set<number>()
let exitHookInstalled = false

function killGroup(pid: number | undefined): void {
  if (!pid) return
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    /* the group is already gone */
  }
}

function trackGroup(pid: number | undefined): void {
  if (!pid) return
  liveGroups.add(pid)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once("exit", () => {
    for (const group of liveGroups) killGroup(group)
  })
}

/** After the child exits, how long its stdio may stay open (a grandchild holding it) before it is cut. */
export const STDIO_GRACE_MS = 500

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
  }
  const home = mkdtempSync(join(realpathOrSelf(tmpdir()), "infinite-tag-sbx-"))
  if (platform === "darwin") {
    let profile: string
    try {
      profile = buildSandboxProfile({
        denyReads: options.denyReads,
        denyReadPrefixes: options.denyReadPrefixes ?? [],
        network: options.network,
        writableRoots: withRealpaths([home, ...(options.allowWrites ?? [])]),
        denyWrites: withRealpaths(options.denyWrites ?? [])
      })
    } catch (error) {
      rmSync(home, { recursive: true, force: true })
      return Promise.reject(error)
    }
    argv0 = SANDBOX_EXEC
    argv = ["-p", profile, cmd, ...args]
    sandboxed = true
  }
  const env = minimalChildEnv(home, options.env)

  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let aborted = false
    let settled = false
    let grace: NodeJS.Timeout | null = null
    // Its own process group, so the whole tree can be killed (POSIX; the platform seam keeps linux here).
    const child = spawn(argv0, argv, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true })
    trackGroup(child.pid)
    const kill = () => {
      killGroup(child.pid)
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
      options.onOutput?.(chunk, "stdout")
      if (stdout.length + chunk.length > maxBytes) {
        stdout += chunk.slice(0, Math.max(0, maxBytes - stdout.length))
        stdoutTruncated = true
      } else stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      options.onOutput?.(chunk, "stderr")
      if (stderr.length + chunk.length > maxBytes) {
        stderr += chunk.slice(0, Math.max(0, maxBytes - stderr.length))
        stderrTruncated = true
      } else stderr += chunk
    })
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      options.signal?.removeEventListener("abort", onAbort)
      // Whatever the child left behind in its group (a daemon, a worker holding stdout) dies with it.
      killGroup(child.pid)
      if (child.pid) liveGroups.delete(child.pid)
      child.stdout.destroy()
      child.stderr.destroy()
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
        home,
        stdoutTruncated,
        stderrTruncated
      })
    }
    child.on("error", (error) => finish(null, null, error))
    child.on("close", (code, signal) => finish(code, signal))
    // A grandchild may hold stdout open after the child itself exited: give the pipes a short grace to
    // drain, then cut them (and the group) and settle with the child's own exit status.
    child.on("exit", (code, signal) => {
      grace = setTimeout(() => finish(code, signal), STDIO_GRACE_MS)
    })
    child.stdin.on("error", () => {
      /* the child may exit before reading its input */
    })
    child.stdin.end(options.input ?? "")
  })
}
