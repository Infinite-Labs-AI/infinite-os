import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { infiniteOsHome } from "./growth-os-home.js";

export class NoActiveProjectError extends Error {
  constructor(message = "No active project. Run `infinite setup` or `infinite project new <name>`.") {
    super(message);
    this.name = "NoActiveProjectError";
  }
}

interface InfiniteOsState {
  // Legacy sticky pointer: tolerated on read, never auto-promoted to a default.
  activeProjectId?: string;
  // The optional persisted default — off unless the operator sets one. Loaded
  // into the in-process session pin at session start (see the CLI).
  defaultProjectId?: string;
  // One-shot latch: set once the legacy-`activeProjectId` migration notice has
  // been shown, so it never repeats across sessions.
  migrationNoticeShown?: boolean;
}

export function infiniteOsStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(infiniteOsHome(env), "state.json");
}

// Read the whole state object, tolerating a missing/corrupt file (never throws).
// This is the single read used by every accessor so writers can read-modify-write
// and preserve sibling keys (e.g. `defaultProjectId` survives an `activeProjectId`
// write, and vice-versa).
function readState(env: NodeJS.ProcessEnv): InfiniteOsState {
  const path = infiniteOsStatePath(env);
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as InfiniteOsState;
    }
    return {};
  } catch {
    // Corrupt state.json must never throw — degrade to an empty state.
    return {};
  }
}

function readTrimmedId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return id ? id : undefined;
}

export function readActiveProjectId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readTrimmedId(readState(env).activeProjectId);
}

// The persisted default project, if the operator set one. Note: a legacy
// `activeProjectId` is NOT treated as a default — no silent auto-promotion.
export function readDefaultProjectId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readTrimmedId(readState(env).defaultProjectId);
}

function writeStateAtomic(state: InfiniteOsState, env: NodeJS.ProcessEnv): void {
  const home = infiniteOsHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = infiniteOsStatePath(env);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path); // atomic on the same filesystem
}

// Merge `patch` over the current on-disk state, then write atomically. Keys set
// to `undefined` in `patch` are deleted; all other existing keys are preserved.
// This is what keeps `writeActiveProjectId` from clobbering `defaultProjectId`.
function mergeStateAtomic(patch: InfiniteOsState, env: NodeJS.ProcessEnv): void {
  const next: InfiniteOsState = { ...readState(env), ...patch };
  for (const key of Object.keys(patch) as Array<keyof InfiniteOsState>) {
    if (patch[key] === undefined) {
      delete next[key];
    }
  }
  writeStateAtomic(next, env);
}

export function writeActiveProjectId(activeProjectId: string, env: NodeJS.ProcessEnv = process.env): void {
  mergeStateAtomic({ activeProjectId }, env); // preserves defaultProjectId
}

export function clearActiveProjectId(env: NodeJS.ProcessEnv = process.env): void {
  mergeStateAtomic({ activeProjectId: undefined }, env); // preserves defaultProjectId
}

export function writeDefaultProjectId(defaultProjectId: string, env: NodeJS.ProcessEnv = process.env): void {
  mergeStateAtomic({ defaultProjectId }, env); // preserves activeProjectId
}

export function clearDefaultProjectId(env: NodeJS.ProcessEnv = process.env): void {
  mergeStateAtomic({ defaultProjectId: undefined }, env); // preserves activeProjectId
}

// True once the legacy-`activeProjectId` migration notice has been shown.
export function readMigrationNoticeShown(env: NodeJS.ProcessEnv = process.env): boolean {
  return readState(env).migrationNoticeShown === true;
}

export function markMigrationNoticeShown(env: NodeJS.ProcessEnv = process.env): void {
  mergeStateAtomic({ migrationNoticeShown: true }, env); // preserves sibling keys
}
