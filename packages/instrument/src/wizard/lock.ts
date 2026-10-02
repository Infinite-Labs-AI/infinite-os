// `.infinite/wizard/run.lock` (§3d.6): `{pid, startedAt, hostname}`, created exclusively, so two wizard
// runs in one repo never interleave (the second gets INF_WIZ_LOCKED). A lock whose pid is dead on this
// host is stale and is taken over; a lock from another host is never assumed stale (its pid cannot be
// checked from here).
//
// Taking over a stale lock is serialised by a short-lived `run.lock.takeover` mutex (created
// exclusively): under it the lock is re-read and removed only while it still holds the exact stale bytes
// that were judged stale. So a racer can never delete the fresh lock another process just took, and at
// most one process holds `run.lock` at a time.
import { promises as fsp } from "node:fs"
import { hostname as osHostname } from "node:os"
import { dirname, join } from "node:path"

import { RUN_LOCK_SHAPE, WIZARD_PATHS, type RunLock } from "./contracts/state.js"
import { shapeErrors } from "./contracts/shape.js"
import { WIZARD_DIR_MODE } from "./fs.js"

export interface RunLockHandle {
  readonly path: string
  readonly lock: RunLock
  /** Idempotent; only removes the file while it still holds this run's lock. */
  release(): Promise<void>
}

export type AcquireResult =
  | { ok: true; handle: RunLockHandle; tookOverStale: RunLock | null }
  | { ok: false; holder: RunLock | null; path: string }

export interface AcquireOptions {
  pid?: number
  hostname?: string
  now?: () => Date
  /** True while the pid runs (default: `process.kill(pid, 0)`). */
  isPidAlive?: (pid: number) => boolean
  /** Test seam: runs after a lock was judged stale and before it is taken over. */
  beforeTakeover?: () => Promise<void>
}

/** A takeover mutex older than this is a crash leftover (a live one is held for milliseconds). */
export const TAKEOVER_MUTEX_STALE_MS = 30_000
const TAKEOVER_TRIES = 50
const TAKEOVER_WAIT_MS = 20

export function lockFilePath(root: string): string {
  return join(root, WIZARD_PATHS.lock)
}

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists, owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await fsp.readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function parseLock(text: string): RunLock | "corrupt" {
  try {
    const parsed: unknown = JSON.parse(text)
    if (shapeErrors(parsed, RUN_LOCK_SHAPE).length > 0) return "corrupt"
    const lock = parsed as RunLock
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) return "corrupt"
    return lock
  } catch {
    return "corrupt"
  }
}

async function readLock(path: string): Promise<RunLock | null | "corrupt"> {
  const text = await readText(path)
  return text === null ? null : parseLock(text)
}

/** Runs `fn` under the takeover mutex; "busy" when another process holds it the whole time. */
async function underTakeoverMutex<T>(path: string, fn: () => Promise<T>): Promise<T | "busy"> {
  const mutex = `${path}.takeover`
  for (let attempt = 0; attempt < TAKEOVER_TRIES; attempt += 1) {
    try {
      await fsp.writeFile(mutex, `${process.pid}\n`, { flag: "wx", mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const age = await fsp.stat(mutex).then(
        (stat) => Date.now() - stat.mtimeMs,
        () => 0
      )
      if (age > TAKEOVER_MUTEX_STALE_MS) await fsp.rm(mutex, { force: true })
      else await new Promise((resolve) => setTimeout(resolve, TAKEOVER_WAIT_MS))
      continue
    }
    try {
      return await fn()
    } finally {
      await fsp.rm(mutex, { force: true })
    }
  }
  return "busy"
}

export async function acquireRunLock(root: string, options: AcquireOptions = {}): Promise<AcquireResult> {
  const path = lockFilePath(root)
  const lock: RunLock = {
    pid: options.pid ?? process.pid,
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    hostname: options.hostname ?? osHostname()
  }
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive
  await fsp.mkdir(dirname(path), { recursive: true, mode: WIZARD_DIR_MODE })
  let tookOverStale: RunLock | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fsp.writeFile(path, `${JSON.stringify(lock)}\n`, { flag: "wx", mode: 0o600 })
      return { ok: true, handle: makeHandle(path, lock), tookOverStale }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const staleText = await readText(path)
    if (staleText === null) continue
    const holder = parseLock(staleText)
    if (holder !== "corrupt") {
      const sameHost = holder.hostname === lock.hostname
      if (!sameHost || isPidAlive(holder.pid)) return { ok: false, holder, path }
    }
    // Stale (dead pid on this host) or unreadable: take it over, but only under the takeover mutex and
    // only while the file still holds exactly the bytes judged stale (never a fresh lock a racer took).
    await options.beforeTakeover?.()
    const removed = await underTakeoverMutex(path, async () => {
      if ((await readText(path)) !== staleText) return false
      await fsp.rm(path, { force: true })
      return true
    })
    if (removed === "busy") return { ok: false, holder: holder === "corrupt" ? null : holder, path }
    if (removed && holder !== "corrupt") tookOverStale = holder
  }
  const holder = await readLock(path)
  return { ok: false, holder: holder && holder !== "corrupt" ? holder : null, path }
}

function makeHandle(path: string, lock: RunLock): RunLockHandle {
  let released = false
  return {
    path,
    lock,
    async release() {
      if (released) return
      released = true
      const current = await readLock(path).catch(() => null)
      if (current && current !== "corrupt" && current.pid === lock.pid && current.startedAt === lock.startedAt) {
        await fsp.rm(path, { force: true })
      }
    }
  }
}
