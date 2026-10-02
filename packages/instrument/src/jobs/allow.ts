// §3e.2 allowlist rules (lane O8). Every agent job gets the files it may touch from here; the fence
// (lane O3) enforces the same rules after every turn, for ignored paths too (§3f.6).
//
// NORMATIVE rules:
// - Paths are repo-root relative (monorepo-safe), POSIX, never absolute, never `..`.
// - The global deny overrides any job: `.git/**`, `.env*` anywhere, lockfiles, `package.json` (the npm
//   job is code-only), `.infinite/**`, `.claude/**`, `.codex/**`, `dist|build|.next|out|node_modules`,
//   every detected CMP / banner file, and any hunk touching a consent call or a CMP API.
// - No v1 job deletes a file; a deletion is refused.
// - New files are allowed only where a job lists them in `create`.
import { GLOBAL_DENY_GLOBS } from "../wizard/contracts/jobs.js"
import { firstMatchingGlob } from "./glob.js"

/** The global deny as one sentence, for the briefs. */
export const GLOBAL_DENY_TEXT =
  "Never touch .git, any .env file, a lockfile, package.json, .infinite, .claude, .codex, build output or node_modules, or a cookie-banner / consent-manager file. No file is ever deleted."

/** Normalises a repo-relative path, or null when it is absolute, escapes the repo or is empty. */
export function normalizeRepoPath(path: string): string | null {
  if (path.includes("\\") || path.includes("\u0000")) return null
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null
  const segments: string[] = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") return null
    segments.push(segment)
  }
  return segments.length === 0 ? null : segments.join("/")
}

export type DenyReason = { kind: "global_deny"; glob: string } | { kind: "cmp_file" } | { kind: "invalid_path" }

/** Why a path may never be touched by any agent job, or null when the global deny does not cover it. */
export function globalDenyReason(path: string, cmpFiles: readonly string[]): DenyReason | null {
  const normalized = normalizeRepoPath(path)
  if (normalized === null) return { kind: "invalid_path" }
  const glob = firstMatchingGlob(normalized, GLOBAL_DENY_GLOBS)
  if (glob !== null) return { kind: "global_deny", glob }
  if (cmpFiles.includes(normalized)) return { kind: "cmp_file" }
  return null
}

/**
 * Consent calls and CMP APIs. Any added or removed line matching one makes the hunk a consent hunk: the
 * fence reverts it and the job is `blocked:consent_touched`. Infinite never changes consent wiring.
 */
export const CONSENT_CALL_PATTERNS: readonly RegExp[] = [
  /\bgtag\s*\(\s*["'`]consent["'`]/,
  /\bdataLayer\s*\.\s*push\s*\(\s*\[?\s*["'`]consent["'`]/,
  /\bfbq\s*\(\s*["'`]consent["'`]/,
  /\b__tcfapi\s*\(/,
  /\b__cmp\s*\(/,
  /\b__uspapi\s*\(/,
  /\b__gpp\s*\(/,
  /\bOneTrust\s*\./,
  /\bOptanon\w*/,
  /\bCookiebot\s*\./,
  /\bCookieConsent\s*\./,
  /\bUC_UI\s*\./,
  /\bDidomi\w*\s*\./,
  /\bposthog\s*\.\s*(?:opt_in_capturing|opt_out_capturing|has_opted_in_capturing|has_opted_out_capturing|clear_opt_in_out_capturing)\b/,
  /\bINFINITE_CONSENT_STORAGE_KEY\b/,
  /\blocalStorage\s*\.\s*(?:setItem|removeItem)\s*\([^)]*consent/i,
  /cdn\.cookielaw\.org|otSDKStub\.js|consent\.cookiebot\.com|usercentrics\.eu/
]

/** True when the line is a consent call / CMP API use. */
export function isConsentLine(text: string): boolean {
  return CONSENT_CALL_PATTERNS.some((pattern) => pattern.test(text))
}

/** True when any line of the hunk (added or removed) touches consent. */
export function touchesConsent(lines: ReadonlyArray<string>): boolean {
  return lines.some(isConsentLine)
}

export interface AllowSpec {
  files: string[]
  create: string[]
}

/**
 * Builds a job's allowlist from candidate paths: normalised, de-duplicated, sorted, and with every
 * globally denied path (and every CMP file) REMOVED, so a list can never include one.
 */
export function buildAllow(files: readonly string[], create: readonly string[], cmpFiles: readonly string[]): AllowSpec {
  const clean = (paths: readonly string[]): string[] => {
    const out = new Set<string>()
    for (const path of paths) {
      const normalized = normalizeRepoPath(path)
      if (normalized === null) continue
      if (globalDenyReason(normalized, cmpFiles) !== null) continue
      out.add(normalized)
    }
    return [...out].sort()
  }
  const createList = clean(create)
  return { files: clean(files).filter((path) => !createList.includes(path)), create: createList }
}

export type EditKind = "modify" | "create" | "delete"

export type EditVerdict =
  | { ok: true }
  | { ok: false; reason: "outside_allowlist" | "deletion_refused" | "creation_not_listed"; path: string }
  | { ok: false; reason: "denied"; path: string; deny: DenyReason }

/**
 * Whether one edit is inside an item's allowlist (§3e.2). The global deny wins over the job's own list;
 * no v1 job deletes a file; a new file must be listed in `create`.
 */
export function checkEdit(allow: AllowSpec, path: string, kind: EditKind, cmpFiles: readonly string[]): EditVerdict {
  const normalized = normalizeRepoPath(path)
  if (normalized === null) return { ok: false, reason: "denied", path, deny: { kind: "invalid_path" } }
  const deny = globalDenyReason(normalized, cmpFiles)
  if (deny !== null) return { ok: false, reason: "denied", path: normalized, deny }
  if (kind === "delete") return { ok: false, reason: "deletion_refused", path: normalized }
  if (kind === "create") {
    return allow.create.includes(normalized) ? { ok: true } : { ok: false, reason: "creation_not_listed", path: normalized }
  }
  return allow.files.includes(normalized) || allow.create.includes(normalized) ? { ok: true } : { ok: false, reason: "outside_allowlist", path: normalized }
}

/** The union of several allowlists (job 15 `build_fix` and job 16 `review_comments` use the run's union). */
export function unionAllow(specs: readonly AllowSpec[], cmpFiles: readonly string[]): AllowSpec {
  return buildAllow(
    specs.flatMap((spec) => spec.files),
    specs.flatMap((spec) => spec.create),
    cmpFiles
  )
}
