// Run T0 sessions in the sandboxed child and return the recordings (lane O6).
//
// T0 NEVER RUNS IN-PROCESS. This module only spawns `child.js` through `sandboxedSpawn` (minimal env,
// temp HOME; on macOS network denied and the user's secrets unreadable), sends the sessions on stdin,
// and parses one JSON answer from stdout under a deadline. A crash, a deadline, a sandbox that cannot be
// applied, or output that does not parse is returned as a failure with a reason; the caller turns it into
// `undetermined (test error)`, never a pass.
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { T0_PROTOCOL_VERSION, type T0ChildRequest, type T0ChildResponse, type T0Session } from "./protocol.js"
import { defaultDenyReads, sandboxedSpawn, SandboxUnavailableError, type DenyReadSet, type SandboxedSpawnFn } from "./sandbox.js"

export const T0_DEFAULT_DEADLINE_MS = 60_000

export type T0RunFailureReason = "timeout" | "crash" | "bad_output" | "sandbox_unavailable" | "aborted" | "not_built"

export type T0RunOutcome =
  | { ok: true; response: T0ChildResponse; sandboxed: boolean; childPid: number }
  | { ok: false; reason: T0RunFailureReason; detail: string }

export interface T0RunOptions {
  deadlineMs?: number
  /** Test seam (a spy); defaults to the real `sandboxedSpawn`. */
  spawn?: SandboxedSpawnFn
  /** Absolute path of the built child (defaults to `dist/src/t0/child.js` next to this module). */
  childEntry?: string
  denyReads?: DenyReadSet
  signal?: AbortSignal
  platform?: NodeJS.Platform
}

/**
 * The built child next to this module. Under vitest this module is the `.ts` source, which Node cannot run
 * as a child, so the package's built `dist` copy is used (the package builds before its tests run).
 */
export function resolveT0ChildEntry(moduleUrl: string = import.meta.url): string {
  const here = fileURLToPath(moduleUrl)
  if (here.endsWith(".ts")) return here.replace(/\/src\/t0\/[^/]+\.ts$/, "/dist/src/t0/child.js")
  return fileURLToPath(new URL("./child.js", moduleUrl))
}

export async function runT0Sessions(sessions: readonly T0Session[], options: T0RunOptions = {}): Promise<T0RunOutcome> {
  const entry = options.childEntry ?? resolveT0ChildEntry()
  if (!existsSync(entry)) return { ok: false, reason: "not_built", detail: `the T0 child is missing at ${entry}; build infinite-tag first` }
  const request: T0ChildRequest = { protocol: T0_PROTOCOL_VERSION, sessions: [...sessions] }
  const deny = options.denyReads ?? defaultDenyReads()
  const spawnFn = options.spawn ?? sandboxedSpawn
  let result
  try {
    result = await spawnFn(process.execPath, ["--max-old-space-size=512", "--no-warnings", entry], {
      denyReads: deny.paths,
      denyReadPrefixes: deny.prefixes,
      network: false,
      cwd: "/",
      input: JSON.stringify(request),
      timeoutMs: options.deadlineMs ?? T0_DEFAULT_DEADLINE_MS,
      signal: options.signal,
      maxOutputBytes: 32 * 1024 * 1024,
      platform: options.platform
    })
  } catch (error) {
    if (error instanceof SandboxUnavailableError) return { ok: false, reason: "sandbox_unavailable", detail: error.message }
    return { ok: false, reason: "crash", detail: error instanceof Error ? error.message : String(error) }
  }
  if (result.aborted) return { ok: false, reason: "aborted", detail: "the run was cancelled" }
  if (result.timedOut) return { ok: false, reason: "timeout", detail: `T0 did not finish within ${options.deadlineMs ?? T0_DEFAULT_DEADLINE_MS} ms` }
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-3).join(" | ")
    return { ok: false, reason: "crash", detail: `the T0 child exited ${result.exitCode ?? result.signal}: ${tail}` }
  }
  if (result.stdoutTruncated) return { ok: false, reason: "bad_output", detail: "the T0 child's output exceeded the limit" }
  let response: T0ChildResponse
  try {
    response = JSON.parse(result.stdout.trim().split("\n").pop() ?? "") as T0ChildResponse
  } catch {
    return { ok: false, reason: "bad_output", detail: "the T0 child's output was not JSON" }
  }
  if (response.protocol !== T0_PROTOCOL_VERSION || !Array.isArray(response.sessions) || response.sessions.length !== sessions.length) {
    return { ok: false, reason: "bad_output", detail: "the T0 child answered with the wrong shape" }
  }
  return { ok: true, response, sandboxed: result.sandboxed, childPid: response.pid }
}
