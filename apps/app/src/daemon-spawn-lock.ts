import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { infiniteOsHome } from "@infinite-os/config";

// ---------------------------------------------------------------------------
// Cross-process spawn lock (~/.growth-os/daemon.lock)
//
// Prevents two concurrent cold-starts (CLI + desktop both racing) from each
// running migrate/bind at the same time. The lock is a file created with O_EXCL
// (atomic on all POSIX filesystems and NTFS). Only one process wins the create;
// the other detects an existing lock, checks liveness, and either defers or
// reclaims a stale lock.
//
// LIFETIME: acquired BEFORE runMigrations, released AFTER writeDaemonDescriptor
// (so a concurrent starter can re-check discovery and find a healthy daemon).
// On crash-before-descriptor the TTL (default 30 s) frees it automatically.
// ---------------------------------------------------------------------------

const LOCK_FILE_NAME = "daemon.lock";
const DEFAULT_TTL_MS = 30_000;

interface LockPayload {
  pid: number;
  startedAt: number;
}

function lockPath(env: NodeJS.ProcessEnv): string {
  return join(infiniteOsHome(env), LOCK_FILE_NAME);
}

function parseLockPayload(raw: string): LockPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "number") {
      return { pid: parsed.pid, startedAt: parsed.startedAt };
    }
    return null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = no such process (dead). EPERM = exists but we lack permission (alive).
    return code === "EPERM";
  }
}

/**
 * Try to create the lock file atomically (O_EXCL). Returns a release handle on
 * success, or null if another live process holds the lock within TTL.
 *
 * @param env   - process.env (injectable for tests via GROWTH_OS_HOME)
 * @param opts  - ttlMs: stale-lock age threshold; now: injectable clock for tests
 */
export function acquireDaemonSpawnLock(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { ttlMs?: number; now?: () => number }
): { release(): void } | null {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? (() => Date.now());
  const path = lockPath(env);

  try {
    return tryCreate(path, now());
  } catch (createErr) {
    const code = (createErr as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      // Unexpected error (e.g. ENOENT for missing home dir, EACCES). Return null
      // so the caller treats this as "someone else is spawning" and defers safely.
      return null;
    }

    // Lock already exists — read it and decide whether to reclaim.
    let existing: LockPayload | null = null;
    try {
      existing = parseLockPayload(readFileSync(path, "utf8"));
    } catch {
      // Unreadable / deleted between our create-failure and now — reclaim below.
    }

    const shouldReclaim =
      existing === null ||                             // corrupt / vanished
      !isProcessAlive(existing.pid) ||                // holder is dead (ESRCH)
      existing.pid === process.pid ||                  // we own it (re-entrant)
      now() - existing.startedAt > ttlMs;             // holder is stale

    if (!shouldReclaim) {
      // A live, fresh, different process holds the lock — defer to it.
      return null;
    }

    // Reclaim: unlink the stale lock and retry the create ONCE.
    try {
      unlinkSync(path);
    } catch {
      // Another process may have just reclaimed and removed it — that is fine.
    }
    try {
      return tryCreate(path, now());
    } catch {
      // Someone else beat us to the re-create — defer.
      return null;
    }
  }
}

function tryCreate(path: string, startedAt: number): { release(): void } {
  // openSync with "wx" = O_WRONLY | O_CREAT | O_EXCL — atomically fails with
  // EEXIST if the file is already there. Write then close; keep path in closure
  // for release().
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt }));
  } finally {
    closeSync(fd);
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        unlinkSync(path);
      } catch {
        // Already removed (crash cleanup, TTL reclaim by another process) — fine.
      }
    }
  };
}
