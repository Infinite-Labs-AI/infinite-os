import { basename } from "node:path";

/**
 * Single source for the canonical GROWTH_OS_HOME → macOS Desktop app-name map.
 *
 * MIRROR of the map the Desktop app owns in `runtime-identity.ts`
 * (`resolveDesktopRuntimeIdentity`, 1bu-1 `apps/desktop/src/main`). DRIFT RISK:
 * the mapping is DUPLICATED across repos because the public CLI cannot import
 * Desktop code. If Desktop renames an app (`productName`) or adds/removes a
 * slot, THIS FILE must be updated in lockstep — a stale entry launches the
 * wrong app or silently falls through to guide-only. This module is the ONLY
 * place the mapping lives in `infinite-os`; never hand-copy it elsewhere.
 *
 *   ~/.growth-os        → "Infinite"         (prod)
 *   ~/.growth-os-dev    → "Infinite Dev"     (dev instance 1 — bare, no number)
 *   ~/.growth-os-dev<N> → "Infinite Dev <N>" (dev instance N ≥ 2)
 *   ~/.growth-os-clean  → "Infinite Clean"   (clean sandbox)
 *
 * Notes mirrored from runtime-identity:
 * - There is NO numbered instance-1 home — instance 1 is the bare
 *   `~/.growth-os-dev`; numbered homes only exist for N ≥ 2. So
 *   `.growth-os-dev0` / `.growth-os-dev1` match no launchable app.
 * - Leading-zero homes (`.growth-os-dev02`) are never created by Desktop
 *   (its variant parser rejects padded dev tokens), so they map to null
 *   rather than aliasing another instance's app.
 */

export type CanonicalVariant = "prod" | "dev" | "clean" | `dev${number}`;

export interface CanonicalHomeEntry {
  /** Home directory basename, always directly under the user's HOME. */
  home: string;
  /** The Desktop app's Electron `productName` (launchable via `open -a`). */
  appName: string;
  variant: CanonicalVariant;
}

/** Highest dev instance enumerated in the manifest. This is a LISTING cap only
 *  (the known persistent dev fleet); `appNameForHome` matches ANY N ≥ 2. */
const MANIFEST_MAX_DEV_INSTANCE = 10;

function numberedDevEntries(): CanonicalHomeEntry[] {
  const entries: CanonicalHomeEntry[] = [];
  for (let n = 2; n <= MANIFEST_MAX_DEV_INSTANCE; n += 1) {
    entries.push({
      home: `.growth-os-dev${n}`,
      appName: `Infinite Dev ${n}`,
      variant: `dev${n}` as CanonicalVariant
    });
  }
  return entries;
}

export const CANONICAL_HOMES: ReadonlyArray<CanonicalHomeEntry> = [
  { home: ".growth-os", appName: "Infinite", variant: "prod" },
  { home: ".growth-os-dev", appName: "Infinite Dev", variant: "dev" },
  ...numberedDevEntries(),
  { home: ".growth-os-clean", appName: "Infinite Clean", variant: "clean" }
];

// Group 1 (`clean`) captures the `-clean` suffix; group 2 (`devDigits`) captures
// the digits after `-dev` ("" for the bare `-dev` instance-1 home).
const CANONICAL_HOME_RE = /^\.growth-os(?:(-clean)|-dev(\d*))?$/u;

/**
 * Map a GROWTH_OS_HOME path to its Desktop app name, or null when the home's
 * basename is not a canonical Infinite install home.
 *
 * Matches on the BASENAME only. Callers that require the home to sit directly
 * under the user's HOME (the launch path does — `open -a` attaches the app to
 * its DEFAULT home, never a custom one) must enforce that policy themselves.
 */
export function appNameForHome(home: string): string | null {
  const match = CANONICAL_HOME_RE.exec(basename(home));
  if (!match) return null;
  const [, clean, devDigits] = match;
  if (clean) return "Infinite Clean";
  if (devDigits === undefined) return "Infinite"; // bare .growth-os (prod)
  if (devDigits === "") return "Infinite Dev"; // bare .growth-os-dev (instance 1)
  // Padded digits ("02") never name a real home — reject rather than alias.
  if (devDigits.length > 1 && devDigits.startsWith("0")) return null;
  const instance = Number(devDigits);
  // Only N ≥ 2 are real numbered dev installs; dev0/dev1 are not launchable.
  return instance >= 2 ? `Infinite Dev ${instance}` : null;
}
