import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireDaemonSpawnLock } from "../src/daemon-spawn-lock.js";

// ---------------------------------------------------------------------------
// Helper: a non-existent subdirectory path rooted under a temp dir. Used to
// verify C1 (fresh-machine bootstrap: acquireDaemonSpawnLock must create the
// home dir itself before attempting the O_EXCL create).
// ---------------------------------------------------------------------------
function nonExistentSubdir(parent: string): string {
  return join(parent, "nested", "deep", "growth-os-home");
}

describe("acquireDaemonSpawnLock", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "growth-os-spawn-lock-"));
    env = { GROWTH_OS_HOME: home };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns a release handle and creates the lock file", () => {
    const lock = acquireDaemonSpawnLock(env);
    expect(lock).not.toBeNull();
    expect(existsSync(join(home, "daemon.lock"))).toBe(true);
    lock!.release();
    expect(existsSync(join(home, "daemon.lock"))).toBe(false);
  });

  it("returns null while the lock is held by this live pid", () => {
    // We are the live holder (same pid) — but the module's logic treats
    // process.pid === holder.pid as a re-entrant reclaim, so to test the
    // "live different pid" path we write a lock for a pid that we know is
    // alive (process.pid) but fake a *different* pid in the file by writing
    // a synthetic lock file manually. Use a pid we can't trivially fake as
    // alive; instead rely on testing that a fresh call when OUR pid already
    // holds it via acquireDaemonSpawnLock reclaims (re-entrant). So we write
    // a lock file for pid=process.pid but also force non-re-entrant path by
    // using process.ppid (our parent — almost certainly alive).
    const livePid = process.ppid ?? 1; // parent process — very likely alive
    const lockFile = join(home, "daemon.lock");
    writeFileSync(lockFile, JSON.stringify({ pid: livePid, startedAt: Date.now() }));

    const result = acquireDaemonSpawnLock(env);
    expect(result).toBeNull();
    // Clean up: file was NOT removed by the failed acquire
    expect(existsSync(lockFile)).toBe(true);
  });

  it("reclaims a lock whose holder pid is dead", () => {
    // Write a lock for a pid we are confident is dead. On macOS/Linux,
    // pid 0 is never a real user process (it's the idle/swapper kernel process
    // and kill(0, 0) sends to the entire process group — use a high pid that
    // is extremely unlikely to be in use). We use pid 2_000_000 which is
    // above typical PID_MAX (32768 on Linux, 99999 on macOS).
    const deadPid = 2_000_000;
    const lockFile = join(home, "daemon.lock");
    writeFileSync(lockFile, JSON.stringify({ pid: deadPid, startedAt: Date.now() }));

    const lock = acquireDaemonSpawnLock(env);
    // Should have reclaimed the stale lock
    expect(lock).not.toBeNull();
    expect(existsSync(lockFile)).toBe(true); // new lock file written by us
    lock!.release();
  });

  // C2: a provably-ALIVE holder must NOT be reclaimed by TTL alone.
  it("does NOT reclaim a live holder's lock even when the TTL has elapsed", () => {
    const livePid = process.ppid ?? 1; // parent process — very likely alive
    const lockFile = join(home, "daemon.lock");
    const ttlMs = 1_000;
    const staleStartedAt = Date.now() - ttlMs - 500; // well past TTL
    writeFileSync(lockFile, JSON.stringify({ pid: livePid, startedAt: staleStartedAt }));

    // Inject a frozen clock so `now() - startedAt` exceeds the TTL — this
    // MUST NOT be sufficient to reclaim a lock whose pid is provably alive.
    const frozenNow = Date.now();
    const result = acquireDaemonSpawnLock(env, {
      ttlMs,
      now: () => frozenNow
    });
    expect(result).toBeNull(); // live holder; must NOT be stolen
    // Lock file must be untouched — the live holder still owns it.
    expect(existsSync(lockFile)).toBe(true);
  });

  // C2: dead pid IS reclaimed regardless of TTL.
  it("reclaims a lock whose holder pid is dead (ESRCH) even within TTL", () => {
    const deadPid = 2_000_000;
    const lockFile = join(home, "daemon.lock");
    // startedAt is very recent — well within a generous TTL
    writeFileSync(lockFile, JSON.stringify({ pid: deadPid, startedAt: Date.now() }));

    const lock = acquireDaemonSpawnLock(env, { ttlMs: 60_000 });
    expect(lock).not.toBeNull();
    expect(existsSync(lockFile)).toBe(true); // new lock written by us
    lock!.release();
  });

  // C2: corrupt/unreadable payload IS reclaimed.
  it("reclaims a lock with unknowable pid (pid <= 0) only when past TTL", () => {
    const lockFile = join(home, "daemon.lock");
    const ttlMs = 1_000;
    // pid=0 is unknowable; started well past TTL
    writeFileSync(lockFile, JSON.stringify({ pid: 0, startedAt: Date.now() - ttlMs - 500 }));

    const frozenNow = Date.now();
    const lock = acquireDaemonSpawnLock(env, { ttlMs, now: () => frozenNow });
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it("release is idempotent — calling twice does not throw", () => {
    const lock = acquireDaemonSpawnLock(env);
    expect(lock).not.toBeNull();
    lock!.release();
    expect(() => lock!.release()).not.toThrow();
  });

  it("reclaims a corrupt/unparseable lock file", () => {
    const lockFile = join(home, "daemon.lock");
    writeFileSync(lockFile, "not valid json {{{{");

    const lock = acquireDaemonSpawnLock(env);
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it("second acquire after release succeeds (file is gone)", () => {
    const lock1 = acquireDaemonSpawnLock(env);
    expect(lock1).not.toBeNull();
    lock1!.release();

    const lock2 = acquireDaemonSpawnLock(env);
    expect(lock2).not.toBeNull();
    lock2!.release();
  });

  // C1 regression: fresh machine — home dir does NOT pre-exist. acquireDaemonSpawnLock
  // must create it (and the lock file inside it) without returning null.
  it("creates the home dir and lock file when the home dir does not yet exist", () => {
    // Point GROWTH_OS_HOME at a deeply nested path that has never been created.
    const freshHome = nonExistentSubdir(home);
    const freshEnv: NodeJS.ProcessEnv = { GROWTH_OS_HOME: freshHome };

    expect(existsSync(freshHome)).toBe(false); // precondition: dir absent

    const lock = acquireDaemonSpawnLock(freshEnv);

    // Home dir must have been created
    expect(existsSync(freshHome)).toBe(true);
    // Lock file must exist inside it
    expect(existsSync(join(freshHome, "daemon.lock"))).toBe(true);
    // Must return a valid handle, not null
    expect(lock).not.toBeNull();

    lock!.release();
    expect(existsSync(join(freshHome, "daemon.lock"))).toBe(false);
  });
});
