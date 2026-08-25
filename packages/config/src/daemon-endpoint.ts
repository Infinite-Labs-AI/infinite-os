import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { infiniteOsHome } from "./growth-os-home.js";

// ---------------------------------------------------------------------------
// Daemon descriptor (relocated from apps/app/src/daemon-descriptor.ts)
// ---------------------------------------------------------------------------
//
// The descriptor a freshly-spawned daemon drops so the desktop OR a downloaded
// CLI can discover the live address without guessing the port. When the app binds
// port 0 the OS picks an ephemeral port, so the descriptor is the ONLY source of
// truth for where the daemon actually listens.
//
// Lives in @infinite-os/config (not apps/app) so BOTH the CLI and the desktop can
// read it without taking a dependency edge on @infinite-os/app — the missing edge
// is precisely why the CLI couldn't discover the daemon before (design §1, §7).
//
// SECURITY: tokens NEVER go in here. Discovery only. The convergence fingerprints
// (databaseId/keyId) are non-secret by construction (HMAC keyed by the secret /
// password-stripped DB hash — see encryptionKeyFingerprint in @infinite-os/core
// and databaseFingerprint below). The operator/read tokens stay in the daemon's
// own config; the descriptor just answers "is a daemon up, on what URL/pid, and
// does it converge on my DB + key?".
export interface DaemonDescriptor {
  url: string;
  pid: number;
  version: string;
  startedAt: string;
  // Identity + convergence fields (PR1 — daemon-discovery §3/§4). Optional so an
  // OLDER daemon's descriptor still parses (version-skew shim, §6.5): a reader
  // treats a missing field as "unknown, don't hard-fail".
  nonce?: string;
  databaseId?: string;
  keyId?: string;
}

const DAEMON_DESCRIPTOR_FILE = "daemon.json";

export function daemonDescriptorPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(infiniteOsHome(env), DAEMON_DESCRIPTOR_FILE);
}

export function readDaemonDescriptor(env: NodeJS.ProcessEnv = process.env): DaemonDescriptor | null {
  try {
    const raw = readFileSync(daemonDescriptorPath(env), "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonDescriptor>;
    if (
      typeof parsed.url === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.version === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      const descriptor: DaemonDescriptor = {
        url: parsed.url,
        pid: parsed.pid,
        version: parsed.version,
        startedAt: parsed.startedAt
      };
      // Carry the optional identity/convergence fields through only when present
      // and well-typed — an older daemon simply omits them (version-skew shim).
      if (typeof parsed.nonce === "string") descriptor.nonce = parsed.nonce;
      if (typeof parsed.databaseId === "string") descriptor.databaseId = parsed.databaseId;
      if (typeof parsed.keyId === "string") descriptor.keyId = parsed.keyId;
      return descriptor;
    }
    return null;
  } catch {
    return null;
  }
}

// Remove the descriptor on shutdown so a stale file never advertises a dead port.
// Best-effort: a missing file is fine, and we never throw out of the close hook.
export function removeDaemonDescriptor(env: NodeJS.ProcessEnv = process.env): void {
  try {
    rmSync(daemonDescriptorPath(env), { force: true });
  } catch {
    // Cleanup is best-effort; the next daemon overwrites any leftover anyway.
  }
}

// ---------------------------------------------------------------------------
// databaseId convergence fingerprint (design §4 / §10 — password-stripped)
// ---------------------------------------------------------------------------

// Domain-separation label. A FIXED public label is domain separation, not entropy
// — equivalent DBs across installs MUST hash equal so convergence comparison works.
const DB_ID_LABEL = "infinite-os/dbId/v1";
const DB_ID_HEX_LENGTH = 24; // 12 bytes = 96 bits.

function isPostgresUrl(databaseUrl: string): boolean {
  return /^postgres(ql)?:\/\//i.test(databaseUrl.trim());
}

// Resolve a PGlite-selecting URL (pglite://, file://, bare path, :memory:) to its
// canonical absolute data-dir path. Inlined here (NOT imported from @infinite-os/db)
// because db depends on config — importing db back into config would be a cycle.
// Mirrors resolvePgliteDataDir in packages/db/src/pglite-adapter.ts.
function canonicalPgliteDataDir(databaseUrl: string, env: NodeJS.ProcessEnv): string {
  const trimmed = databaseUrl.trim();
  if (trimmed === "" || trimmed === "pglite://" || trimmed === "pglite:") {
    return resolve(join(infiniteOsHome(env), "pglite"));
  }
  if (trimmed === "memory://" || trimmed === ":memory:") {
    return "memory://";
  }
  const pgliteMatch = /^pglite:(?:\/\/)?(.*)$/i.exec(trimmed);
  if (pgliteMatch) {
    const path = pgliteMatch[1];
    if (path === "") {
      return resolve(join(infiniteOsHome(env), "pglite"));
    }
    return isAbsolute(path) ? resolve(path) : resolve(path);
  }
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return resolve(fileURLToPath(trimmed));
    } catch {
      return trimmed;
    }
  }
  // Bare path.
  return resolve(trimmed);
}

/**
 * Non-secret convergence fingerprint of the DATABASE_URL, published in /health and
 * the descriptor so a CLI can ASSERT it points at the desktop's database.
 *
 * SECURITY (verified — design §10): this MUST strip the password and hash ONLY the
 * canonical non-secret components. Hashing the full DATABASE_URL is an offline
 * password-cracking oracle (every other component is a known compose default). For
 * postgres URLs we hash `${user}@${host}:${port}/${dbname}` with host
 * localhost<->127.0.0.1 normalized and the default port 5432 applied; for pglite /
 * file / bare-path URLs we hash the normalized absolute data-dir path. NEVER the
 * password. Truncated to 96 bits.
 */
export function databaseFingerprint(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  let canonical: string;
  if (isPostgresUrl(databaseUrl)) {
    let parsed: URL;
    try {
      parsed = new URL(databaseUrl.trim());
    } catch {
      // Unparseable postgres URL — fall back to hashing the SCHEME+structure only,
      // never the raw string (which could embed a password). Use a stable marker so
      // two equally-malformed URLs converge, distinct from any real DB.
      canonical = "postgres:invalid";
      return hashCanonical(canonical);
    }
    const user = decodeURIComponent(parsed.username || "");
    let host = (parsed.hostname || "").toLowerCase();
    // Normalize the loopback aliases so localhost and 127.0.0.1 converge.
    if (host === "localhost") {
      host = "127.0.0.1";
    }
    const port = parsed.port && parsed.port !== "" ? parsed.port : "5432";
    // Strip the leading "/" from the path to get the bare dbname; drop any trailing slash.
    const dbname = decodeURIComponent(parsed.pathname.replace(/^\//, "").replace(/\/+$/, ""));
    // Password (parsed.password) is INTENTIONALLY never read.
    canonical = `${user}@${host}:${port}/${dbname}`;
  } else {
    canonical = canonicalPgliteDataDir(databaseUrl, env);
  }
  return hashCanonical(canonical);
}

function hashCanonical(canonical: string): string {
  return createHash("sha256")
    .update(`${DB_ID_LABEL}|${canonical}`)
    .digest("hex")
    .slice(0, DB_ID_HEX_LENGTH);
}

// ---------------------------------------------------------------------------
// resolveDaemonEndpoint — identity-validated, descriptor-first discovery (§3)
// ---------------------------------------------------------------------------

export interface DaemonIdentity {
  status?: string;
  service?: string;
  runtime?: string;
  pid?: number;
  version?: string;
  nonce?: string;
  databaseId?: string;
  keyId?: string;
}

export interface ResolvedDaemonEndpoint {
  url: string;
}

export interface ResolveDaemonEndpointOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const DAEMON_SERVICE = "growth-os-app";

// Strip a trailing slash so `${url}/health` never double-slashes.
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * GET `${url}/health` with a short AbortSignal timeout and parse the identity body.
 * Returns the parsed DaemonIdentity ONLY when the body is the Infinite OS daemon
 * (`service === "growth-os-app"`); returns null on any error, timeout, non-2xx, or
 * a foreign server. NEVER throws — discovery is best-effort.
 *
 * Exported so the CLI's readiness path can reuse the exact identity probe.
 */
export async function probeDaemonIdentity(
  url: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<DaemonIdentity | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const base = normalizeBaseUrl(url);
  try {
    const res = await fetchImpl(`${base}/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as DaemonIdentity;
    // Identity assertion: a foreign server (e.g. `next dev`) can NEVER satisfy this,
    // so it can never be mistaken for the daemon on any transport.
    if (!body || body.service !== DAEMON_SERVICE) {
      return null;
    }
    return body;
  } catch {
    // Timeout / connection refused / DNS / JSON parse — not a usable daemon here.
    return null;
  }
}

// Is the candidate error an ECONNREFUSED? Used to invalidate the memo so a freshly
// (re)started daemon is rediscovered rather than serving a stale "no daemon" answer.
function isConnRefused(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  return code === "ECONNREFUSED" || cause?.code === "ECONNREFUSED";
}

// process.kill(pid, 0) probes liveness WITHOUT sending a signal:
//   - throws ESRCH  -> the pid is dead  -> evict
//   - throws EPERM  -> the pid EXISTS under another user -> treat as ALIVE (§6.6)
//   - resolves      -> alive
// Authoritative liveness is still the /health pid+nonce cross-check; this is a cheap
// pre-filter so we don't even probe a descriptor whose process is gone.
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EPERM") {
      return true; // exists under another user
    }
    return false; // ESRCH (or anything else) -> treat as dead
  }
}

// Per-process memo. resolveDaemonEndpoint is called from a readiness preflight that
// can run several times in one CLI session; memoizing avoids re-probing on every
// call, while invalidate() lets a caller force rediscovery (e.g. after a connection
// refused, when a daemon may have just (re)started on a new port).
let memo: ResolvedDaemonEndpoint | null | undefined;

export function invalidateResolvedDaemonEndpoint(): void {
  memo = undefined;
}

/**
 * Resolve the live daemon base URL, descriptor-first and identity-validated.
 *
 * Ladder (each candidate identity-probed; first match wins):
 *   1. GROWTH_OS_API_URL  — explicit override / escape hatch.
 *   2. the descriptor     — ~/.growth-os/daemon.json, accepted only if its pid is
 *      alive AND /health echoes the same pid AND the same nonce (anti-stale).
 *   3. configBaseUrl      — http://${appHost}:${appPort} (default 127.0.0.1:3000),
 *      the fixed port the dockerized `infinite start` app is reachable on.
 *
 * Returns { url } on the first validated candidate, or null when nothing answers as
 * the daemon. Memoized per process; pass through invalidateResolvedDaemonEndpoint()
 * to force a re-resolve. Invalidates the memo automatically on ECONNREFUSED so a
 * daemon that just (re)started is rediscovered.
 *
 * NEVER throws — a missing daemon is a null, so the caller can show a fast, friendly
 * "no daemon — launch the desktop / run `infinite start`" instead of hanging.
 */
export async function resolveDaemonEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveDaemonEndpointOptions = {}
): Promise<ResolvedDaemonEndpoint | null> {
  if (memo !== undefined) {
    return memo;
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let sawConnRefused = false;

  // Wrap the injected fetch so we can notice an ECONNREFUSED for the memo policy
  // even though probeDaemonIdentity swallows it.
  const trackingFetch: typeof fetch = async (input, init) => {
    try {
      return await fetchImpl(input, init);
    } catch (err) {
      if (isConnRefused(err)) {
        sawConnRefused = true;
      }
      throw err;
    }
  };

  // Candidate 1: explicit override.
  const override = env.GROWTH_OS_API_URL?.trim();
  if (override) {
    const identity = await probeDaemonIdentity(override, { timeoutMs, fetchImpl: trackingFetch });
    if (identity) {
      return cache({ url: normalizeBaseUrl(override) }, sawConnRefused);
    }
  }

  // Candidate 2: the descriptor — pid-alive + pid/nonce cross-check.
  const descriptor = readDaemonDescriptor(env);
  if (descriptor && isPidAlive(descriptor.pid)) {
    const identity = await probeDaemonIdentity(descriptor.url, {
      timeoutMs,
      fetchImpl: trackingFetch
    });
    if (
      identity &&
      identity.pid === descriptor.pid &&
      // nonce is optional on an older daemon; when the descriptor HAS one, the live
      // /health nonce MUST match (anti-stale: a recycled pid on a fresh process has
      // a new boot nonce). When the descriptor lacks one (version-skew), the pid
      // cross-check above is the liveness gate.
      (descriptor.nonce === undefined || identity.nonce === descriptor.nonce)
    ) {
      return cache({ url: normalizeBaseUrl(descriptor.url) }, sawConnRefused);
    }
  }

  // Candidate 3: configBaseUrl (the fixed docker port).
  const appHost = env.GROWTH_OS_APP_HOST?.trim() || "127.0.0.1";
  const appPort = env.GROWTH_OS_APP_PORT?.trim() || "3000";
  // A wildcard bind host is not connectable as a client target — rewrite to loopback.
  const host = appHost === "0.0.0.0" || appHost === "::" ? "127.0.0.1" : appHost;
  const configBaseUrl = `http://${host}:${appPort}`;
  const cfgIdentity = await probeDaemonIdentity(configBaseUrl, {
    timeoutMs,
    fetchImpl: trackingFetch
  });
  if (cfgIdentity) {
    return cache({ url: normalizeBaseUrl(configBaseUrl) }, sawConnRefused);
  }

  return cache(null, sawConnRefused);
}

function cache(
  value: ResolvedDaemonEndpoint | null,
  sawConnRefused: boolean
): ResolvedDaemonEndpoint | null {
  // Don't memoize a null that was caused purely by a connection refusal — the daemon
  // may be (re)starting; the next call should re-probe rather than serve a stale miss.
  if (value === null && sawConnRefused) {
    memo = undefined;
    return null;
  }
  memo = value;
  return value;
}
