import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireDaemonSpawnLock } from "../src/daemon-spawn-lock.js";

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

  it("reclaims a lock older than the TTL even if the pid appears alive", () => {
    // Simulate a lock held by our parent (alive) but started well past TTL.
    const livePid = process.ppid ?? 1;
    const lockFile = join(home, "daemon.lock");
    const ttlMs = 1_000;
    const staleStartedAt = Date.now() - ttlMs - 500; // 500 ms past TTL
    writeFileSync(lockFile, JSON.stringify({ pid: livePid, startedAt: staleStartedAt }));

    // Inject a frozen clock so `now() - startedAt` exceeds the TTL
    const frozenNow = Date.now();
    const lock = acquireDaemonSpawnLock(env, {
      ttlMs,
      now: () => frozenNow
    });
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
});
