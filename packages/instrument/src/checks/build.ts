// The build check (lane O6): run the site's own build through its package manager, behind the same
// boundary as T0 (`sandboxedSpawn`: minimal env, temp HOME, the user's secrets unreadable on macOS), with
// network ON because a build may fetch packages. The baseline (taken in `before`, on the untouched tree)
// and every later build reduce their output to a FAILURE SIGNATURE, so the wizard can tell a failure the
// change introduced from one the site already had:
//   • `build` / `build_green_or_baseline` pass when the build is green, or when it fails exactly as the
//     baseline did (reported, never blamed on this run); a NEW failure is a problem (job 15's trigger);
//   • no build script → info (nothing to build, e.g. a static site); a deadline or a sandbox that cannot
//     be applied → undetermined (test error), never a pass.
// Agent-written `next.config.*` and page modules are evaluated by the build, which is why O9's post-turn
// gate runs BEFORE any build (§3a.9 item 5) and why the build never runs in the wizard's own process.
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { detectPackageManager } from "../package-manager.js"
import type { PackageManager } from "../types.js"
import type { BuildResult, CheckResult } from "../wizard/contracts/jobs.js"
import { defaultDenyReads, sandboxedSpawn, SandboxUnavailableError, type DenyReadSet, type SandboxedSpawnFn, type SandboxedSpawnResult } from "../t0/sandbox.js"

export const BUILD_DEFAULT_TIMEOUT_MS = 10 * 60_000

export type BuildSkipReason = "no_package_json" | "no_build_script" | "ambiguous_lockfiles"

/** A `BuildResult` with what the wizard needs to explain it. */
export interface BuildRun extends BuildResult {
  skipped: BuildSkipReason | null
  exitCode: number | null
  timedOut: boolean
  /** The build could not run at all (the sandbox could not be applied, or the spawn failed). */
  error: string | null
  sandboxed: boolean
  packageManager: PackageManager | null
  /** The last lines of output, normalised (no ANSI, the repo path replaced with `<root>`), for the report. */
  outputTail: string[]
}

export interface BuildOptions {
  root: string
  /** Absolute, or relative to `root`. */
  appRoot: string
  packageManager?: PackageManager
  timeoutMs?: number
  signal?: AbortSignal
  spawn?: SandboxedSpawnFn
  denyReads?: DenyReadSet
  platform?: NodeJS.Platform
  now?: () => number
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

const ERROR_LINE =
  /(?:\berror\b(?!s?\s*:?\s*0\b)|\bType error\b|\bModule not found\b|\bSyntaxError\b|\bReferenceError\b|\bTypeError\b|\bFailed to compile\b|\bnpm ERR!|\bERR_PNPM_|\bBuild failed\b|\bCannot find module\b)/i

/** A signature longer than this keeps its first lines plus one line carrying a hash of the WHOLE set. */
export const FAILURE_SIGNATURE_MAX_LINES = 200

/** Lines a package manager prints about the run itself (where its log went), never about the failure. */
const RUN_BOOKKEEPING = /complete log of this run can be found|^npm (?:error|ERR!) A complete log|^npm (?:error|ERR!) +\/|_logs\/.*-debug(?:-\d+)?\.log/i

/** The per-run throwaway HOME `sandboxedSpawn` creates, wherever it appears (`/private/var/…/infinite-tag-sbx-Qz98Lk`). */
const SANDBOX_HOME = /(?:\/private)?\/[^\s'"`]*?infinite-tag-sbx-[A-Za-z0-9]+/g

/** ISO-like timestamps, including npm's log-file spelling `2026-10-02T03_19_02_877Z`. */
const ISO_STAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}[_:]\d{2}[_:]\d{2}(?:[_.]\d+)?Z?/g

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Reduce build output to a stable, comparable set of failures: the repo path → `<root>`, the sandbox's
 * per-run HOME → `<home>`, positions, timings, timestamps and hashes stripped, and the package
 * manager's "a complete log of this run is at …" bookkeeping dropped (review O6-R3: on npm that line
 * made every pre-existing failure look new). The WHOLE set is compared (review O6-R25): past
 * `FAILURE_SIGNATURE_MAX_LINES`, the tail is replaced by one line holding the hash of the full set, so
 * any difference still shows.
 */
export function failureSignature(output: string, root: string, options: { home?: string | null } = {}): string[] {
  const rootPattern = new RegExp(escapeRegExp(root), "g")
  const homePattern = options.home ? new RegExp(escapeRegExp(options.home), "g") : null
  const lines = output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => {
      let out = line
      if (homePattern) out = out.replace(homePattern, "<home>")
      return out.replace(SANDBOX_HOME, "<home>").replace(rootPattern, "<root>").trim()
    })
  const signature = new Set<string>()
  for (const line of lines) {
    if (!ERROR_LINE.test(line) || RUN_BOOKKEEPING.test(line)) continue
    const normalised = line
      .replace(/\((\d+),(\d+)\)/g, "")
      .replace(/:\d+:\d+\b/g, "")
      .replace(/:\d+\b(?=\s|$)/g, "")
      .replace(ISO_STAMP, "<time>")
      .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, "")
      .replace(/\b[0-9a-f]{8,}\b/gi, "<hash>")
      .replace(/\s+/g, " ")
      .trim()
    if (normalised) signature.add(normalised)
  }
  const sorted = [...signature].sort()
  if (sorted.length <= FAILURE_SIGNATURE_MAX_LINES) return sorted
  const digest = createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16)
  return [...sorted.slice(0, FAILURE_SIGNATURE_MAX_LINES - 1), `…${sorted.length - FAILURE_SIGNATURE_MAX_LINES + 1} more failure lines (set ${digest})`]
}

/** A signature with no recognised error line (only an exit code or a timeout) cannot be compared. */
function opaqueSignature(signature: readonly string[]): boolean {
  return signature.length > 0 && signature.every((line) => /^(?:(?:build|lint): )?(?:exit_code:|timeout$)/.test(line))
}

/**
 * Review I1 P1-3: the ONLY places a build may write (under the repo root and the app root): its output and
 * cache folders and the two files Next / tsc regenerate. Never a source file, `package.json`, a hook config
 * (`.lintstagedrc`, `lefthook.yml`, …) or anything else the wizard later commits or its own `git commit` runs.
 */
export const BUILD_OUTPUT_DIRS = [".next", "dist", "build", "out", ".output", ".nuxt", ".svelte-kit", ".astro", ".turbo", ".vercel/output", ".cache", "node_modules/.cache", "node_modules/.vite", "node_modules/.astro"] as const
export const BUILD_OUTPUT_FILES = ["next-env.d.ts", "tsconfig.tsbuildinfo", ".eslintcache"] as const

/** True for a repo-relative path a build may have written (its output, caches, `*.tsbuildinfo`). */
export function isBuildOutputPath(rel: string): boolean {
  const path = rel.replace(/^\.\//, "")
  if (/\.tsbuildinfo$/.test(path)) return true
  const name = path.split("/").pop() ?? path
  if ((BUILD_OUTPUT_FILES as readonly string[]).includes(name)) return true
  return BUILD_OUTPUT_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`) || path.includes(`/${dir}/`) || path.endsWith(`/${dir}`))
}

/** The writable subtrees of a build: the output dirs and regenerated files, at the repo root and the app root. */
export function buildAllowedWrites(root: string, appRoot: string): string[] {
  const bases = [...new Set([root, appRoot])]
  return bases.flatMap((base) => [...BUILD_OUTPUT_DIRS, ...BUILD_OUTPUT_FILES].map((entry) => join(base, entry)))
}

/** Paths a build may never write even inside the repo: git (hooks, config), husky hooks, the wizard's own state. */
export function buildDeniedWrites(root: string, appRoot: string): string[] {
  return [...new Set([join(root, ".git"), join(root, ".husky"), join(root, ".infinite"), join(appRoot, ".infinite")])]
}

function readValidationScripts(appRoot: string): { scripts: Array<"build" | "lint"> } | { reason: BuildSkipReason } {
  const path = join(appRoot, "package.json")
  if (!existsSync(path)) return { reason: "no_package_json" }
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, unknown> }
    const scripts = (["build", "lint"] as const).filter((name) => typeof manifest.scripts?.[name] === "string" && (manifest.scripts[name] as string).trim())
    return scripts.length > 0 ? { scripts } : { reason: "no_build_script" }
  } catch {
    return { reason: "no_package_json" }
  }
}

/** The package manager for an app root: its own lockfile, else the repo root's (a monorepo), else npm. */
export function buildPackageManager(root: string, appRoot: string, override?: PackageManager): PackageManager | "ambiguous" {
  if (override) return override
  for (const dir of appRoot === root ? [root] : [appRoot, root]) {
    const detected = detectPackageManager(dir)
    if (detected.kind === "ambiguous") return "ambiguous"
    if (detected.kind !== "unknown") return detected.kind
  }
  // No lockfile anywhere: `npm run build` runs the package.json script without installing anything.
  return "npm"
}

export async function runBuild(options: BuildOptions): Promise<BuildRun> {
  const root = resolve(options.root)
  const appRoot = resolve(root, options.appRoot)
  const clock = options.now ?? Date.now
  const started = clock()
  const base = { ok: false, failureSignature: [] as string[], durationMs: 0, exitCode: null, timedOut: false, error: null, sandboxed: false, outputTail: [] as string[] }
  const scripts = readValidationScripts(appRoot)
  if ("reason" in scripts) return { ...base, ok: true, skipped: scripts.reason, packageManager: null }
  const manager = buildPackageManager(root, appRoot, options.packageManager)
  if (manager === "ambiguous") return { ...base, skipped: "ambiguous_lockfiles", packageManager: null }
  const deny = options.denyReads ?? defaultDenyReads()
  const spawnFn = options.spawn ?? sandboxedSpawn
  const runs: Array<{ name: "build" | "lint"; result: SandboxedSpawnResult; output: string }> = []
  for (const name of scripts.scripts) {
    let result: SandboxedSpawnResult
    try {
      result = await spawnFn(manager, ["run", name], {
      denyReads: deny.paths,
      denyReadPrefixes: deny.prefixes,
      network: true,
      // Writes: the build's output and cache folders and the throwaway HOME only (review I1 P1-3): agent-written
      // config or page code run by the build can never rewrite a source file, plant a hook config the wizard's
      // own `git commit` would run, or touch `.git`, `.husky` or `.infinite`.
      allowWrites: buildAllowedWrites(root, appRoot),
      denyWrites: buildDeniedWrites(root, appRoot),
      cwd: appRoot,
      // No telemetry, no update notifier, no funding/audit calls: the build talks to the registry only if
      // the site's own build script needs a package.
      env: {
        NEXT_TELEMETRY_DISABLED: "1",
        ASTRO_TELEMETRY_DISABLED: "1",
        CI: "1",
        NO_UPDATE_NOTIFIER: "1",
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false"
      },
      timeoutMs: options.timeoutMs ?? BUILD_DEFAULT_TIMEOUT_MS,
      signal: options.signal,
      platform: options.platform
      })
    } catch (error) {
      const message = error instanceof SandboxUnavailableError || error instanceof Error ? error.message : String(error)
      return { ...base, durationMs: clock() - started, skipped: null, error: message, packageManager: manager }
    }
    runs.push({ name, result, output: `${result.stdout}\n${result.stderr}` })
    if (result.timedOut || result.aborted) break
  }
  const outputTail = runs.flatMap(({ name, result, output }) => output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.split(root).join("<root>").split(result.home).join("<home>").replace(SANDBOX_HOME, "<home>").trimEnd())
    .filter(Boolean)
    .map((line) => scripts.scripts.length > 1 ? `${name}: ${line}` : line)).slice(-20)
  const ok = runs.length === scripts.scripts.length && runs.every(({ result }) => result.exitCode === 0 && !result.timedOut && !result.aborted)
  const signature = runs.flatMap(({ name, result, output }) => {
    if (result.exitCode === 0 && !result.timedOut && !result.aborted) return []
    const lines = failureSignature(output, root, { home: result.home })
    return (lines.length > 0 ? lines : [result.timedOut ? "timeout" : `exit_code:${result.exitCode ?? result.signal}`]).map((line) => scripts.scripts.length > 1 ? `${name}: ${line}` : line)
  })
  const missing = runs.find(({ result, output }) => result.exitCode === 127 && /(?:command )?not found|is not recognized/i.test(output))
  const stopped = runs.find(({ result }) => result.timedOut || result.aborted)
  const failed = runs.find(({ result }) => result.exitCode !== 0)
  return {
    ok,
    failureSignature: ok ? [] : signature.length ? signature : ["exit_code:unknown"],
    durationMs: clock() - started,
    skipped: null,
    exitCode: failed?.result.exitCode ?? null,
    timedOut: stopped?.result.timedOut ?? false,
    error: missing ? `the site's ${missing.name} script could not run: its executable was not found (install this site's dependencies, then resume)` : stopped?.result.aborted ? "site validation was cancelled" : null,
    sandboxed: runs.every(({ result }) => result.sandboxed),
    packageManager: manager,
    outputTail
  }
}

function isBuildRun(value: BuildResult): value is BuildRun {
  return "skipped" in value
}

/**
 * Grade a build against the baseline (B tier). Pass: green, or red with no failure the baseline lacked.
 * Problem: a new failure. Info: nothing to build. Undetermined: the build could not run or timed out.
 */
export function gradeBuild(checkId: string, current: BuildResult, baseline: BuildResult | null, ctx: { runId: string | null; now(): Date }): CheckResult {
  const make = (state: CheckResult["state"], code: string | null, detail: string): CheckResult => ({
    checkId,
    state,
    reason: code ? `${code} — ${detail}` : detail,
    tier: "B",
    at: ctx.now().toISOString(),
    runId: ctx.runId
  })
  if (isBuildRun(current)) {
    if (current.skipped === "no_package_json" || current.skipped === "no_build_script") return make("info", "no_build_script", "the app has no build or lint script, so there is nothing to check")
    if (current.skipped === "ambiguous_lockfiles") return make("undetermined", "test_error", "several lockfiles: the package manager to build with is ambiguous")
    if (current.error) return make("undetermined", "test_error", current.error)
    if (current.timedOut) return make("undetermined", "test_error", `the build did not finish within ${Math.round(current.durationMs / 1000)} s`)
  }
  if (current.ok) return make("pass", null, "the build is green")
  if (!baseline) return make("problem", "build_failed", `the build fails (${current.failureSignature.slice(0, 3).join("; ")}) and there is no baseline to compare with`)
  // Both red, but at least one side printed no recognisable error line: equal exit codes prove nothing.
  if (!baseline.ok && (opaqueSignature(current.failureSignature) || opaqueSignature(baseline.failureSignature)))
    return make("undetermined", "test_error", "the build fails, and its output has no recognisable error line to compare with the baseline's failure")
  const fresh = current.failureSignature.filter((line) => !baseline.failureSignature.includes(line))
  if (baseline.ok || fresh.length) {
    return make("problem", "new_build_failures", `${(baseline.ok ? current.failureSignature : fresh).slice(0, 5).join("; ")}`)
  }
  return make("pass", null, "the build fails exactly as it did before this run (the baseline was already red); nothing new broke")
}

/**
 * The B verdict the jobs step and a review fix round share (B26): a build that could not run (an `error`, e.g.
 * no sandbox inside another sandbox or a spawn failure) or that ended red with no failure signature proves
 * nothing, so it is UNDETERMINED (`test_error`), never a pass; red counts as a pass only when every failure is
 * already in the baseline's. `baseline` is read only when it is needed.
 */
export async function buildVerdict(
  build: BuildResult,
  baseline: () => Promise<Pick<BuildResult, "failureSignature">>
): Promise<{ state: "pass" | "problem" | "undetermined"; reason?: string }> {
  const couldNotRun = (build as { error?: string | null }).error
  if (!build.ok && couldNotRun) return { state: "undetermined", reason: `test_error — the build could not run: ${couldNotRun}` }
  if (build.ok) return { state: "pass" }
  if (build.failureSignature.length === 0) return { state: "undetermined", reason: "test_error — the build did not run to a verdict" }
  const known = (await baseline()).failureSignature
  if (opaqueSignature(build.failureSignature) || opaqueSignature(known)) return { state: "undetermined", reason: "test_error — the site checks did not print a comparable failure" }
  const fresh = build.failureSignature.filter((failure) => !known.includes(failure))
  if (fresh.length === 0) return { state: "pass", reason: "red before this run too; no new failures" }
  return { state: "problem", reason: `new build failures: ${fresh.slice(0, 3).join("; ")}` }
}
