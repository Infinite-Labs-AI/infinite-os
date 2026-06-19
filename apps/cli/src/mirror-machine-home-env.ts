import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Mirror the 4 runtime secret keys into the machine-home ~/.growth-os/.env.
 *
 * Merge semantics: any keys already in that file that are NOT in the mirror set
 * are preserved unchanged. Only the 4 keys are updated (if defined in `keys`).
 * The file is written 0600; the directory is created 0700 if absent.
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
  // Merge: update only the keys that are defined in the incoming set.
  const merged: Record<string, string> = { ...existing };
  for (const key of MACHINE_HOME_MIRROR_KEYS) {
    const val = keys[key];
    if (typeof val === "string" && val !== "") {
      merged[key] = val;
    }
  }
  const content =
    Object.entries(merged)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
  writeFileSync(machineEnvPath, content, { mode: 0o600 });
  chmodSync(machineEnvPath, 0o600);
}
