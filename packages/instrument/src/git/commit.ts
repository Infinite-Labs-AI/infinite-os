// What the wizard stages and how it commits (lane O4, §3g.1).
//
// Stage = the jobs' allowlists ∪ the wizard's managed files ∪ the npm job's recorded package.json + lockfile
// edits (the PR imports the package it installed) ∪ `.infinite/install.json` ∪ the `.gitignore` fence. Never
// `git add -A`; never a deletion (no v1 job deletes a file); never the wizard's own state under
// `.infinite/wizard/`; and `.gitignore` only when its change is the fence alone (otherwise refuse).
//
// Commit = `git commit -F -` with the `Infinite-Tag-Run` trailer (plus `Infinite-Review-Round` on fix
// rounds). Hooks run; signing runs; nothing is amended.
import { GLOBAL_DENY_GLOBS } from "../wizard/contracts/jobs.js"
import type { StatusEntry } from "./status.js"
import { isDeletion } from "./status.js"

export const INSTALL_MANIFEST_PATH = ".infinite/install.json"
export const WIZARD_STATE_DIR = ".infinite/wizard/"

/** Lockfiles the npm job may touch (and the only files beside package.json it may commit for it). */
export const LOCKFILE_NAMES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "npm-shrinkwrap.json"] as const

function basename(path: string): string {
  const index = path.lastIndexOf("/")
  return index === -1 ? path : path.slice(index + 1)
}

export function isPackageOrLockfile(path: string): boolean {
  const name = basename(path)
  return name === "package.json" || (LOCKFILE_NAMES as readonly string[]).includes(name)
}

/** A tiny glob → RegExp for the §3e.2 deny list and allowlist entries (`**` = any depth, `*` = one segment). */
export function globToRegExp(glob: string): RegExp {
  let out = ""
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!
    if (char === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/"
        out += slash ? "(?:.*/)?" : ".*"
        i += slash ? 2 : 1
      } else {
        out += "[^/]*"
      }
    } else if (char === "?") {
      out += "[^/]"
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${out}$`)
}

const GLOBAL_DENY = GLOBAL_DENY_GLOBS.map(globToRegExp)

export function isGloballyDenied(path: string): boolean {
  return GLOBAL_DENY.some((pattern) => pattern.test(path))
}

/** An allowlist entry matches a path exactly, or as a glob when it carries `*`. */
export function allowEntryMatches(entry: string, path: string): boolean {
  const normalized = entry.replace(/^\.\//, "")
  return normalized.includes("*") ? globToRegExp(normalized).test(path) : normalized === path
}

export interface StageSetInput {
  /** `git status --porcelain=v1 -z --untracked-files=all` entries. */
  entries: readonly StatusEntry[]
  /** The union of the run's job allowlists (`allow.files` ∪ `allow.create`), repo-root relative. */
  allowlist: readonly string[]
  /** Files the wizard's own install manages (manifest `files`, ownership keys, server-lane paths, wizard edits). */
  managed: readonly string[]
  /** package.json / lockfiles the npm job recorded edits for (empty when the npm line did not run). */
  npmFiles: readonly string[]
  /** Whether `.gitignore`'s change against HEAD is the wizard's fence alone. */
  gitignoreFenceOnly: boolean
}

export interface StageSet {
  stage: string[]
  /** Changed paths the wizard will not commit, each with why (shown to the user, never staged). */
  leftOut: Array<{ path: string; why: "not_in_allowlist" | "deletion" | "denied" | "wizard_state" }>
  /** Set when the wizard must refuse to commit (the user changed `.gitignore`). */
  refusal: string | null
}

/** §3g.1 stage rules as a pure function (the step stages exactly `stage`). */
export function computeStageSet(input: StageSetInput): StageSet {
  const stage: string[] = []
  const leftOut: StageSet["leftOut"] = []
  let refusal: string | null = null
  const npm = new Set(input.npmFiles)
  const managed = new Set(input.managed)
  for (const entry of input.entries) {
    if (entry.x === "!" && entry.y === "!") continue
    const path = entry.path
    if (path.startsWith(WIZARD_STATE_DIR)) {
      leftOut.push({ path, why: "wizard_state" })
      continue
    }
    if (isDeletion(entry)) {
      leftOut.push({ path, why: "deletion" })
      continue
    }
    if (path === ".gitignore") {
      if (input.gitignoreFenceOnly) stage.push(path)
      else {
        refusal =
          "Your .gitignore has changes the wizard did not make. Commit or undo them yourself, then run `npx infinite-tag --resume`; " +
          "the wizard commits only its own fenced block in that file."
      }
      continue
    }
    if (path === INSTALL_MANIFEST_PATH) {
      stage.push(path)
      continue
    }
    if (isPackageOrLockfile(path)) {
      // Agents never touch these (global deny); the wizard's own npm job does, and the PR imports the package.
      if (npm.has(path)) stage.push(path)
      else leftOut.push({ path, why: "denied" })
      continue
    }
    if (isGloballyDenied(path)) {
      leftOut.push({ path, why: "denied" })
      continue
    }
    if (managed.has(path) || input.allowlist.some((entryGlob) => allowEntryMatches(entryGlob, path))) {
      stage.push(path)
      continue
    }
    leftOut.push({ path, why: "not_in_allowlist" })
  }
  return { stage: [...new Set(stage)].sort(), leftOut, refusal }
}

/** The commit message with its trailers as the final paragraph (git reads `Key: value` lines there). */
export function buildCommitMessage(message: string, trailers: Readonly<Record<string, string>>): string {
  const subject = message.trim()
  const lines = Object.entries(trailers).map(([key, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(key)) throw new Error(`invalid trailer key ${JSON.stringify(key)}`)
    if (/[\r\n]/.test(value)) throw new Error(`trailer ${key} must be one line`)
    return `${key}: ${value}`
  })
  return lines.length > 0 ? `${subject}\n\n${lines.join("\n")}\n` : `${subject}\n`
}

export type CommitFailureKind = "nothing_to_commit" | "hook_failed" | "signing" | "other"

export class GitCommitError extends Error {
  constructor(
    readonly kind: CommitFailureKind,
    readonly stderr: string,
    /** The staged paths named in the hook's output (a hook that failed on OUR files starts a fix round). */
    readonly pathsInOutput: string[]
  ) {
    super(`git commit failed (${kind})`)
    this.name = "GitCommitError"
  }
}

/**
 * Classifies a failed `git commit` from its output. git prints nothing of its own when a pre-commit or
 * commit-msg hook exits non-zero, so a failure while a commit hook is installed counts as the hook's.
 */
export function classifyCommitFailure(output: string, stagedPaths: readonly string[], commitHookInstalled: boolean): GitCommitError {
  const text = output
  const named = stagedPaths.filter((path) => text.includes(path))
  if (/nothing (added )?to commit|no changes added to commit/i.test(text)) return new GitCommitError("nothing_to_commit", text, named)
  if (/gpg failed to sign|error: gpg|signing failed|ssh-keygen.*sign|cannot run gpg|pinentry|failed to sign/i.test(text)) {
    return new GitCommitError("signing", text, named)
  }
  if (commitHookInstalled || /\bhook\b|husky|lint-staged/i.test(text)) return new GitCommitError("hook_failed", text, named)
  return new GitCommitError("other", text, named)
}
