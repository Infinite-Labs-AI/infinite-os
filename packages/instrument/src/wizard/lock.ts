// `.infinite/wizard/run.lock` (§3d.6): `{pid, startedAt, hostname}`, created exclusively, so two wizard
// runs in one repo never interleave (the second gets INF_WIZ_LOCKED). A lock whose pid is dead on this
// host is stale and is taken over; a lock from another host is never assumed stale (its pid cannot be
// checked from here).
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
}

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

async function readLock(path: string): Promise<RunLock | null | "corrupt"> {
  let text: string
  try {
    text = await fsp.readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fsp.writeFile(path, `${JSON.stringify(lock)}\n`, { flag: "wx", mode: 0o600 })
      return { ok: true, handle: makeHandle(path, lock), tookOverStale }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const holder = await readLock(path)
    if (holder === null) continue
    if (holder !== "corrupt") {
      const sameHost = holder.hostname === lock.hostname
      if (!sameHost || isPidAlive(holder.pid)) return { ok: false, holder, path }
      tookOverStale = holder
    }
    // Stale (dead pid on this host) or unreadable: take it over. The `wx` retry still loses to a
    // concurrent taker, which then holds the lock.
    await fsp.rm(path, { force: true })
  }
  return { ok: false, holder: null, path }
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
