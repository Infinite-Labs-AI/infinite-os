import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { infiniteOsHome, parseDotEnv } from "@infinite-os/config";

// The 4 keys the CLI writes into the project-local .growth-os/.env that the
// desktop/daemon also needs to bootstrap. We mirror them into the machine-home
// ~/.growth-os/.env so the desktop reads one canonical rendezvous file regardless
// of which workspace root the CLI was run in.
export const MACHINE_HOME_MIRROR_KEYS = [
  "DATABASE_URL",
  "GROWTH_OS_ENCRYPTION_KEY",
  "GROWTH_OS_READ_TOKEN",
  "GROWTH_OS_OPERATOR_TOKEN"
] as const;

export type MirrorKey = (typeof MACHINE_HOME_MIRROR_KEYS)[number];

// Keys whose values are structural/security-critical: a mismatch between an
// incoming value and an already-populated machine-home value means two different
// projects are trying to share one machine home. Silently clobbering would
// repoint/corrupt the rendezvous for whichever project wrote first, so we throw
// rather than overwrite. The user must resolve the conflict (e.g. set a distinct
// GROWTH_OS_HOME per project).
const CONFLICT_THROW_KEYS = new Set<MirrorKey>(["DATABASE_URL", "GROWTH_OS_ENCRYPTION_KEY"]);

// Returns true when `hostname` is a plain docker-compose service name — i.e. a
// bare label (no dots, not localhost/127.x/::1). Such hosts are only reachable
// inside the docker network; mirroring them to the host-side machine-home .env
// makes DATABASE_URL unreachable for a host desktop spawning the daemon.
function isDockerInternalHost(hostname: string): boolean {
  if (!hostname) return false;
  if (hostname === "localhost") return false;
  // IPv4 loopback block or any dotted host (real domain or external IP).
  if (hostname.includes(".")) return false;
  // IPv6 literal (already stripped of brackets by the caller).
  if (hostname.includes(":")) return false;
  // What remains is a bare label with no dots — a docker service name.
  return true;
}

/**
 * Mirror the 4 runtime secret keys into the machine-home ~/.growth-os/.env.
 *
 * Merge semantics: any keys already in that file that are NOT in the mirror set
 * are preserved unchanged. Only the 4 keys are updated (if defined in `keys`).
 * The file is written atomically (pid-unique temp + renameSync) at mode 0o600;
 * the directory is created 0700 if absent.
 *
 * Conflict guard: if DATABASE_URL or GROWTH_OS_ENCRYPTION_KEY already exists
 * in the machine-home .env with a DIFFERENT value, an Error is thrown rather
 * than silently clobbering — prevents a second project from corrupting the
 * rendezvous of an already-configured machine home.
 *
 * Host-reachability filter: DATABASE_URL is only mirrored when its host is
 * reachable from outside a docker network (localhost, 127.x, ::1, or any dotted
 * host / IP literal). A bare service name like "postgres" is docker-internal and
 * would make the host desktop unable to connect.
 *
 * No-op when the project-local growthDir IS the machine home (same resolved path).
 */
export function mirrorMachineHomeEnv(
  projectGrowthDir: string,
  keys: Partial<Record<MirrorKey, string>>,
  env: NodeJS.ProcessEnv = process.env
): void {
  const machineHome = infiniteOsHome(env);
  const resolvedProjectDir = resolve(projectGrowthDir);
  // Same path — nothing to mirror.
  if (resolvedProjectDir === machineHome) {
    return;
  }
  mkdirSync(machineHome, { recursive: true, mode: 0o700 });
  const machineEnvPath = join(machineHome, ".env");
  // Read existing machine-home env, preserving unknown keys.
  const existing: Record<string, string> = existsSync(machineEnvPath)
    ? parseDotEnv(readFileSync(machineEnvPath, "utf8"))
    : {};

  // FIX A1: conflict guard — check structural keys before merging.
  for (const key of MACHINE_HOME_MIRROR_KEYS) {
    const incoming = keys[key];
    const current = existing[key];
    if (typeof incoming !== "string" || incoming === "") continue;
    if (typeof current !== "string" || current === "") continue;
    if (incoming === current) continue;
    if (CONFLICT_THROW_KEYS.has(key)) {
      throw new Error(
        `mirrorMachineHomeEnv: conflict on ${key} — the machine-home ~/.growth-os/.env already ` +
          `has a value from a different source (REDACTED) and the incoming value (REDACTED) ` +
          `differs. A second project appears to be sharing the same machine home. ` +
          `Set GROWTH_OS_HOME to a project-specific directory to isolate them.`
      );
    }
    // For token keys (READ_TOKEN, OPERATOR_TOKEN) a mismatch is less catastrophic —
    // warn so the operator can investigate without blocking the mirror.
    console.warn(
      `mirrorMachineHomeEnv: warning — ${key} in machine-home .env differs from the ` +
        `incoming value; overwriting (existing REDACTED → incoming REDACTED).`
    );
  }

  // FIX A3: host-reachability filter for DATABASE_URL.
  // The CLI's DATABASE_URL may point at a docker-compose service name (e.g.
  // "postgres") that only resolves inside the docker network. Mirroring such a
  // URL to the host machine-home .env makes the desktop unable to connect to the
  // DB. Skip DATABASE_URL when its host is a bare service label (no dots, not
  // localhost). Tokens and the encryption key are always mirrored — the desktop
  // needs them for discover-mode auth regardless of DB reachability.
  const effectiveKeys: Partial<Record<MirrorKey, string>> = { ...keys };
  const dbUrl = keys["DATABASE_URL"];
  if (typeof dbUrl === "string" && dbUrl !== "") {
    try {
      const parsed = new URL(dbUrl);
      // URL.hostname for IPv6 literals includes brackets; strip them.
      const host = parsed.hostname.replace(/^\[|\]$/g, "");
      if (isDockerInternalHost(host)) {
        // Drop DATABASE_URL from the mirror set — leave the host-side value unchanged.
        delete effectiveKeys["DATABASE_URL"];
      }
    } catch {
      // Unparseable DATABASE_URL — skip the reachability filter and let it mirror.
      // A bad URL will surface at connect time with a clearer error.
    }
  }

  // Merge: update only the keys that are defined in the effective set.
  const merged: Record<string, string> = { ...existing };
  for (const key of MACHINE_HOME_MIRROR_KEYS) {
    const val = effectiveKeys[key];
    if (typeof val === "string" && val !== "") {
      merged[key] = val;
    }
  }
  const content =
    Object.entries(merged)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";

  // FIX A2: atomic write — pid-unique temp in same dir, then renameSync.
  // Mirrors the pattern in apps/app/src/daemon-descriptor.ts so a concurrent
  // desktop reader sees either the old file or the whole new one, never a
  // half-written or truncated .env.
  const tmp = `${machineEnvPath}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, machineEnvPath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
