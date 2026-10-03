// Discovery of the Infinite desktop tag bridge (§3a.1): find `<home>/desktop-tag/bridge.json`, refuse it
// unless it is provably the current user's own, owner-only file from a running app, and decode it.
//
// Rules (each refusal is a BridgeDiscoveryError carrying the WizardCode the link step reports):
// - home = `$GROWTH_OS_HOME`, else `~/.growth-os` (each Dev instance has its own home);
// - the `desktop-tag` dir: a real directory (lstat, never a symlink), mode exactly 0700, owned by this uid;
// - `bridge.json`: opened with O_NOFOLLOW, a regular file, mode exactly 0600, owned by this uid, ≤ 16 KB;
// - `service` = `infinite-desktop-tag`, the protocol range includes 1, `url` = `http://127.0.0.1:<port>`,
//   the pid is alive, the token has the descriptor's shape;
// - no descriptor: `state.json` = `signed_out` → INF_WIZ_SIGNED_OUT; else darwin → INF_WIZ_NO_APP; any
//   other OS → INF_WIZ_NOT_MAC.
//
// The reader never follows a symlink, never reads another user's file and never prints the token. It reads
// only `desktop-tag/` (never Cmd+L's `desktop-cmdl/`).
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  BRIDGE_DESCRIPTOR_FILENAME,
  BRIDGE_DESCRIPTOR_SHAPE,
  BRIDGE_DIRNAME,
  BRIDGE_DIR_MODE,
  BRIDGE_FILE_MODE,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SERVICE,
  BRIDGE_STATE_FILENAME,
  BRIDGE_TOKEN_PATTERN,
  DEFAULT_GROWTH_OS_HOME_DIRNAME,
  GROWTH_OS_HOME_ENV,
  RUNTIME_VARIANT_PATTERN,
  type BridgeAppState,
  type BridgeDescriptor
} from "../wizard/contracts/bridge.js"
import { shapeErrors } from "../wizard/contracts/shape.js"
import { BridgeDiscoveryError } from "./errors.js"

/** A descriptor is a few hundred bytes; anything bigger is not ours. */
export const MAX_DESCRIPTOR_BYTES = 16 * 1024

/** The file-system calls discovery makes (a seam so tests can inject a stat with another uid). */
export interface DescriptorFs {
  lstat(path: string): Stats
  openNoFollow(path: string): number
  fstat(fd: number): Stats
  readFd(fd: number): string
  close(fd: number): void
}

export const nodeDescriptorFs: DescriptorFs = {
  lstat: (path) => lstatSync(path),
  openNoFollow: (path) => openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)),
  fstat: (fd) => fstatSync(fd),
  readFd: (fd) => readFileSync(fd, "utf8"),
  close: (fd) => closeSync(fd)
}

export interface DiscoveryOptions {
  env: Readonly<Record<string, string | undefined>>
  platform: string
  /** Defaults to `os.homedir()`. */
  homeDir?: string
  /** Defaults to `process.getuid()`; on a platform without uids the owner check is skipped. */
  getuid?: () => number | null
  /** Defaults to `process.kill(pid, 0)` (EPERM counts as alive). */
  isPidAlive?: (pid: number) => boolean
  fs?: DescriptorFs
}

/** `$GROWTH_OS_HOME`, else `~/.growth-os`. */
export function growthOsHome(env: Readonly<Record<string, string | undefined>>, homeDir: string = homedir()): string {
  const fromEnv = env[GROWTH_OS_HOME_ENV]
  return fromEnv && fromEnv.trim() ? fromEnv : join(homeDir, DEFAULT_GROWTH_OS_HOME_DIRNAME)
}

export function bridgeDescriptorPath(home: string): string {
  return join(home, BRIDGE_DIRNAME, BRIDGE_DESCRIPTOR_FILENAME)
}

export function bridgeStatePath(home: string): string {
  return join(home, BRIDGE_DIRNAME, BRIDGE_STATE_FILENAME)
}

export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isErrno(error) && error.code === "EPERM"
  }
}

function defaultGetuid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error
}

function isMissing(error: unknown): boolean {
  return isErrno(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")
}

function isForeign(stat: Stats, uid: number | null): boolean {
  return uid !== null && stat.uid !== uid
}

/**
 * Read and validate the descriptor. Throws BridgeDiscoveryError on every refusal; never returns a
 * descriptor that failed a check.
 */
export function readBridgeDescriptor(options: DiscoveryOptions): BridgeDescriptor {
  const fs = options.fs ?? nodeDescriptorFs
  const uid = (options.getuid ?? defaultGetuid)()
  const home = growthOsHome(options.env, options.homeDir)
  const dir = join(home, BRIDGE_DIRNAME)
  const file = bridgeDescriptorPath(home)

  let dirStat: Stats
  try {
    dirStat = fs.lstat(dir)
  } catch (error) {
    if (isMissing(error)) throw noDescriptor(options, home)
    throw new BridgeDiscoveryError("descriptor_unsafe", "the bridge directory could not be checked")
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new BridgeDiscoveryError("descriptor_unsafe", "the bridge directory is not a real directory")
  }
  if ((dirStat.mode & 0o777) !== BRIDGE_DIR_MODE) {
    throw new BridgeDiscoveryError("descriptor_unsafe", "the bridge directory is not owner-only (0700)")
  }
  if (isForeign(dirStat, uid)) {
    throw new BridgeDiscoveryError("descriptor_unsafe", "the bridge directory belongs to another user")
  }

  let fd: number
  try {
    fd = fs.openNoFollow(file)
  } catch (error) {
    if (isMissing(error)) throw noDescriptor(options, home)
    // ELOOP: the descriptor is a symlink (O_NOFOLLOW refused it).
    throw new BridgeDiscoveryError("descriptor_unsafe", "the bridge file is not a regular file")
  }
  let text: string
  try {
    const stat = fs.fstat(fd)
    if (!stat.isFile()) throw new BridgeDiscoveryError("descriptor_unsafe", "the bridge file is not a regular file")
    if ((stat.mode & 0o777) !== BRIDGE_FILE_MODE) {
      throw new BridgeDiscoveryError("descriptor_unsafe", "the bridge file is not owner-only (0600)")
    }
    if (isForeign(stat, uid)) throw new BridgeDiscoveryError("descriptor_unsafe", "the bridge file belongs to another user")
    if (stat.size > MAX_DESCRIPTOR_BYTES) throw new BridgeDiscoveryError("descriptor_unsafe", "the bridge file is too large")
    text = fs.readFd(fd)
  } finally {
    fs.close(fd)
  }

  const descriptor = decodeDescriptor(text)
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive
  if (!isPidAlive(descriptor.pid)) throw new BridgeDiscoveryError("stale_descriptor")
  return descriptor
}

/** Strictly typed decode of the descriptor JSON. Unknown keys are ignored (a newer app may add fields). */
export function decodeDescriptor(text: string): BridgeDescriptor {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BridgeDiscoveryError("descriptor_invalid", "the bridge file is not JSON")
  }
  const errors = shapeErrors(raw, BRIDGE_DESCRIPTOR_SHAPE).filter((error) => !error.includes("unknown key"))
  if (errors.length > 0) throw new BridgeDiscoveryError("descriptor_invalid", errors[0])
  const value = raw as Record<string, unknown>
  if (value.service !== BRIDGE_SERVICE) throw new BridgeDiscoveryError("wrong_service")
  if (value.schemaVersion !== 1) throw new BridgeDiscoveryError("descriptor_invalid", "unknown schemaVersion")
  const protocol = value.protocol as Record<string, unknown>
  if (!Number.isSafeInteger(protocol.min) || !Number.isSafeInteger(protocol.max)) {
    throw new BridgeDiscoveryError("descriptor_invalid", "the protocol range is not a pair of integers")
  }
  if ((protocol.min as number) > BRIDGE_PROTOCOL_VERSION || (protocol.max as number) < BRIDGE_PROTOCOL_VERSION) {
    throw new BridgeDiscoveryError("protocol_mismatch", `the app speaks ${String(protocol.min)}–${String(protocol.max)}, this tag speaks 1`)
  }
  if (!Array.isArray(value.capabilities) || !value.capabilities.every((item) => typeof item === "string")) {
    throw new BridgeDiscoveryError("descriptor_invalid", "capabilities is not a list of strings")
  }
  const url = parseLoopbackUrl(value.url)
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) {
    throw new BridgeDiscoveryError("descriptor_invalid", "pid is not a positive integer")
  }
  for (const key of ["bootId", "desktopVersion", "startedAt"] as const) {
    if (typeof value[key] !== "string" || !(value[key] as string).trim()) {
      throw new BridgeDiscoveryError("descriptor_invalid", `${key} is missing`)
    }
  }
  if (typeof value.token !== "string" || !BRIDGE_TOKEN_PATTERN.test(value.token)) {
    throw new BridgeDiscoveryError("descriptor_invalid", "the token does not have the bridge token's shape")
  }
  const runtime = value.runtime as Record<string, unknown>
  if (typeof runtime.variant !== "string" || !RUNTIME_VARIANT_PATTERN.test(runtime.variant) || typeof runtime.label !== "string") {
    throw new BridgeDiscoveryError("descriptor_invalid", "the runtime variant is not prod, dev, devN or clean")
  }
  return {
    schemaVersion: 1,
    service: BRIDGE_SERVICE,
    protocol: { min: protocol.min as number, max: protocol.max as number },
    capabilities: [...(value.capabilities as string[])],
    url,
    pid: value.pid as number,
    bootId: value.bootId as string,
    desktopVersion: value.desktopVersion as string,
    runtime: { variant: runtime.variant as BridgeDescriptor["runtime"]["variant"], label: runtime.label },
    token: value.token,
    startedAt: value.startedAt as string
  }
}

/** `http://127.0.0.1:<port>` exactly: no other host, no userinfo, path, query or fragment. */
function parseLoopbackUrl(value: unknown): string {
  if (typeof value !== "string") throw new BridgeDiscoveryError("descriptor_invalid", "url is missing")
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new BridgeDiscoveryError("descriptor_invalid", "url is not a URL")
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new BridgeDiscoveryError("descriptor_invalid", "url is not http://127.0.0.1:<port>")
  }
  return parsed.origin
}

/** The app's own state file (`booting` / `signed_out` / `ready`), read with the same owner-only rules; null when absent or unsafe. */
export function readBridgeAppState(options: DiscoveryOptions): BridgeAppState | null {
  const fs = options.fs ?? nodeDescriptorFs
  const uid = (options.getuid ?? defaultGetuid)()
  const file = bridgeStatePath(growthOsHome(options.env, options.homeDir))
  let fd: number
  try {
    fd = fs.openNoFollow(file)
  } catch {
    return null
  }
  try {
    const stat = fs.fstat(fd)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || isForeign(stat, uid) || stat.size > MAX_DESCRIPTOR_BYTES) return null
    const raw = JSON.parse(fs.readFd(fd)) as unknown
    if (typeof raw !== "object" || raw === null) return null
    const state = (raw as Record<string, unknown>).state
    return state === "booting" || state === "signed_out" || state === "ready" ? state : null
  } catch {
    return null
  } finally {
    fs.close(fd)
  }
}

function noDescriptor(options: DiscoveryOptions, home: string): BridgeDiscoveryError {
  const state = readBridgeAppState({ ...options, env: { ...options.env, [GROWTH_OS_HOME_ENV]: home } })
  if (state === "signed_out") return new BridgeDiscoveryError("signed_out")
  if (options.platform !== "darwin") return new BridgeDiscoveryError("not_mac")
  return new BridgeDiscoveryError("no_app")
}
