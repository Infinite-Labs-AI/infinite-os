// The fence (§3f.6, NORMATIVE; R1-04, R2-04, R2-22): what an agent turn may change, and the undo for
// everything else.
//
// BEFORE a turn (`Fence.begin`) it snapshots, OUTSIDE the repo and outside `$TMPDIR` (Codex can read
// `/tmp`; `$HOME` is denied to it), in `~/Library/Caches/infinite-tag/snapshots/<runId>/<turn>/` (dir 0700,
// files 0600):
//   - full copies of every allowlisted file;
//   - full copies of every file that differs from HEAD (staged, unstaged, untracked): `install`'s
//     uncommitted edits, the npm job's `package.json` + lockfile and the gitignore fence live there until
//     the rehearsal commit, so a revert restores the POST-INSTALL bytes, never HEAD's;
//   - full copies of every existing path matching the global deny (§3e.2), ignored ones included (`.env*`,
//     `.infinite/**`, `.claude/**`, `.codex/**`), plus `.git/config`, `.git/HEAD`, `.git/hooks/**`,
//     `.git/info/**` (git status never shows those);
//   - every other ignored file, copied up to a size cap (fingerprinted above it);
//   - for the heavy ignored dirs (`node_modules`, `.next`, `dist`, `build`, `out`): a marker file, and after
//     the turn `find <dir> -cnewer <marker>` (ctime, which a process cannot set back).
// `git status --porcelain=v1 -z --ignored --untracked-files=all` runs before and after (the heavy dirs are
// pathspec-excluded; the marker covers them), plus content hashes of every copied path, so a rename, a
// re-edit of an already-dirty file and a write to an ignored file are all seen.
//
// AFTER the turn (`end`): a write under a heavy ignored dir → everything is restored and
// `FenceTamperError` (INF_WIZ_FENCE_TAMPER, "reinstall your dependencies; nothing was built") is thrown
// BEFORE any build or T0. Otherwise every change outside the allowlist, every global-deny path, every
// deletion (no v1 job deletes a file) and every new file not listed in a job's `create` is reverted from
// the copies (a new file is deleted) and blocks its job `outside_allowlist`; a hunk that touches a consent
// call is reverted on its own and blocks its job `consent_touched`; a change containing the literal bridge
// or MCP token is reverted. Then the post-turn gate (`turnGate`, O9, §3f.9) runs on what is left; a hit
// reverts its hunk and blocks its job. The kept changes come back as `WizardEditRecord`s whose
// `textEdits` are exact, in original-file coordinates (a line diff against the copy), so uninstall can
// reverse them byte-for-byte.
//
// `abort()` restores everything from the snapshot (out of usage, timeout, SIGINT). The snapshot dir holds
// a manifest, so a crashed turn can be restored later with `Fence.load(dir).abort()`, which
// `recoverCrashedTurns` does for every snapshot a dead process left behind; it is deleted once the turn is
// settled (it holds `.env` copies). If settling itself fails (a throwing gate), the turn is restored in
// full before the error goes on, so a turn is never left half-settled.
//
// Git itself is fenced too (review O3 F1). An agent with a shell can plant `core.fsmonitor`, a hook or a
// filter in `.git/config`, commit, move a branch or stage bytes. So after a turn, BEFORE the fence's first
// git call, `.git/config`, `.git/config.worktree`, `.git/HEAD`, `.git/hooks/**` and `.git/info/**` are put
// back from the snapshot with plain file I/O (and every fence git call runs with fsmonitor and hooks off,
// `git-exec.ts`). Then the branch and tag refs and the index (`ls-files -s -v`, which shows content and
// the assume-unchanged / skip-worktree bits) are compared with the snapshot and restored with
// `update-ref` / the index copy, and the job is blocked.
//
// The settled tree is SEALED (`seal` on the result): `verifySeal` re-reads it right before the build/T0
// and before anything is staged, because a process the agent left running (a `setsid` grandchild escapes
// the process-group kill) can still write after the turn.
//
// Nested mode (§3d.7, §3z.12 B8 — the ONE nested implementation) uses `mode: "report"`: on `--resume` EVERY
// rejected edit (outside the seeded allowlists, a global-deny path, a deletion, a consent hunk, a gate hit)
// is reverted to its snapshot bytes BEFORE any check, the parent agent's own bytes are kept under
// `<snapshot>/nested/rejected/<path>` (0600, outside the repo) and reported. Report mode never resets refs or
// the index (the parent agent may have pulled or committed on purpose); a HEAD that no longer descends from
// the hand-off's HEAD throws `NestedBranchMovedError` (→ INF_WIZ_BRANCH_FAILED).
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"

import type { ManagedTextEdit } from "../types.js"
import type { ChecklistItem, CheckResult, Claim, TurnDiff, WizardEditRecord } from "../wizard/contracts/jobs.js"
import { GLOBAL_DENY_GLOBS } from "../wizard/contracts/jobs.js"
import { git, gitOk, parsePorcelainZ, type StatusEntry } from "./git-exec.js"
import { matchesAnyGlob, normalizeRelPath } from "./glob.js"
import { TURN_GATE_RULES, type TurnGateRule } from "../checks/turn-gate.js"
import { applySomeHunks, hunkLines, hunksOf, hunksToTextEdits, splitLines, type LineHunk } from "./line-diff.js"

export const FENCE_SNAPSHOT_SCHEMA = "infinite-tag.fence-snapshot.v1" as const

/** Ignored dirs that are never copied; a write inside one stops the run (INF_WIZ_FENCE_TAMPER). */
export const HEAVY_DIR_NAMES = ["node_modules", ".next", "dist", "build", "out"] as const

/** Other ignored files are copied up to these caps; above them they are fingerprinted (a change → tamper). */
export const IGNORED_COPY_LIMITS = { perFileBytes: 2 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 } as const

/**
 * A hunk that adds or removes a line matching one of these touches a consent call: never the agent's job
 * (§3e.1 "Never the agent's job"). `gtag('consent'` is the §3e.2 example; the rest are the common CMP APIs.
 */
export const CONSENT_CALL_PATTERNS: readonly RegExp[] = [
  /gtag\s*\(\s*['"`]consent['"`]/,
  /fbq\s*\(\s*['"`]consent['"`]/,
  /\b__tcfapi\s*\(/,
  /\b__uspapi\s*\(/,
  /\b__gpp\s*\(/,
  /\b(OneTrust|Optanon)\b/,
  /\bCookiebot\b/,
  /\bDidomi\b/,
  /\bUC_UI\b|\busercentrics\b/i,
  /\bklaro\b/i,
  /\bposthog\s*\.\s*(opt_in_capturing|opt_out_capturing)\b/,
  /['"`]consent['"`]\s*,\s*['"`](default|update)['"`]/,
  // Google Consent Mode keys: a line naming one is consent state, wherever the call starts.
  /\b(ad_storage|analytics_storage|ad_user_data|ad_personalization|functionality_storage|personalization_storage|security_storage|wait_for_update)\b/
]

/**
 * Where a consent CALL starts (review O3 F3). A hunk that changes any line inside the call's bracket span
 * (in the text before OR after the turn) touches consent, so a key flipped on a continuation line of a
 * Prettier-formatted `gtag('consent', 'default', {\n ad_storage: … })` is caught like a one-line call.
 * `call` = the match holds the call's own "(" (the span runs to its matching ")"); `enclosing` = the match
 * is inside the arguments (the span runs to the bracket that closes them, e.g. `dataLayer.push([…])`).
 */
const CONSENT_SPAN_STARTS: ReadonlyArray<{ pattern: RegExp; mode: "call" | "enclosing" }> = [
  { pattern: /gtag\s*\(\s*['"`]consent['"`]/g, mode: "call" },
  { pattern: /fbq\s*\(\s*['"`]consent['"`]/g, mode: "call" },
  { pattern: /\b__tcfapi\s*\(/g, mode: "call" },
  { pattern: /\b__uspapi\s*\(/g, mode: "call" },
  { pattern: /\b__gpp\s*\(/g, mode: "call" },
  { pattern: /\bposthog\s*\.\s*(?:opt_in_capturing|opt_out_capturing)\s*\(/g, mode: "call" },
  { pattern: /['"`]consent['"`]\s*,\s*['"`](?:default|update)['"`]/g, mode: "enclosing" }
]

/**
 * `outside_allowlist` = a path outside every allowlist, a global-deny path, a deletion, a token in the diff, git's
 * own files; `consent_touched` = a consent hunk. A post-turn GATE hit is never a block (§3x.2): it is a `gateHit`.
 */
export type FenceBlockReason = "outside_allowlist" | "consent_touched"

/**
 * §3x.2 One post-turn gate refusal: the hunk was reverted (no forbidden line stays in the tree), and the items it is
 * attributed to get a failed `turn_gate` S check with `note` (the jobs step decides; the fence blocks nothing for it).
 * `rule` is the gate's rule id, or `turn_gate` for a gate that could not check the turn (it then reverts every hunk).
 * `line` is the evidence line (0 when the gate gave none); `hunk` is the hunk's index in the file (-1 = the whole file).
 */
export interface FenceGateHit {
  rule: TurnGateRule | "turn_gate"
  file: string
  line: number
  hunk: number
  itemIds: string[]
  note: string
}

/** §3x.2 For each kept edit, the items each of its text edits is attributed to (same order as `textEdits`). */
export interface FenceEditAttribution {
  editId: string
  textEditItems: string[][]
}

export interface FenceBlock {
  itemId: string
  reason: FenceBlockReason
  paths: string[]
  note: string
}

export interface FenceEndResult {
  /** Repo-relative paths whose turn changes were (fully or partly) undone. */
  reverted: string[]
  blocked: FenceBlock[]
  edits: WizardEditRecord[]
  /** The gate's results on this turn (problems already acted on). */
  gate: CheckResult[]
  /** §3x.2 The gate's refusals: each hunk reverted, each attributed to the items whose S check it fails. */
  gateHits: FenceGateHit[]
  /** §3x.2 Per kept edit, the items each text edit is attributed to (for the per-item undo). */
  attribution: FenceEditAttribution[]
  /** Report mode only: rejected paths (reverted; the parent agent's bytes kept under `rejectedDir`). */
  reportedOutside: string[]
  /** Report mode only: where the parent agent's bytes of every reverted path were kept. */
  rejectedDir?: string
  /** The settled tree, for `verifySeal` right before the build/T0 and before anything is staged. */
  seal: TreeSeal
}

/** The settled tree after a turn (review O3 F11): what `verifySeal` compares against. */
export interface TreeSeal {
  root: string
  /** `git status` entries (heavy dirs excluded, `.infinite/**` excluded: the wizard writes there). */
  status: Array<[string, string]>
  /** Content hash (or a size/time fingerprint above the copy cap) of every listed file + git internals. */
  files: Array<[string, string]>
  /** HEAD, branch/tag refs and the index listing. */
  git: string
  heavyDirs: string[]
  heavyInodes: HeavyInode[]
  /** A file written when the seal was taken: a heavy-dir entry changed after it = a write after the turn. */
  marker: string
}

/** Report mode: the parent agent moved HEAD off the hand-off's line (§3z.12 §3d.7 → INF_WIZ_BRANCH_FAILED). */
/** The wizard's own run dir (repo-relative), skipped by a report-mode settle. */
const WIZARD_RUN_DIR = ".infinite/wizard"

/** The report-mode subdir that keeps the parent agent's rejected bytes (`<snapshot>/nested/rejected/<path>`). */
export const REJECTED_SUBDIR = "rejected"

export class NestedBranchMovedError extends Error {
  readonly code = "INF_WIZ_BRANCH_FAILED" as const
  constructor(
    readonly handoffHead: string,
    readonly head: string | null
  ) {
    super(`HEAD (${head?.slice(0, 12) ?? "none"}) no longer descends from the commit the jobs were handed off at (${handoffHead.slice(0, 12)}); switch back to the wizard's branch, then run npx infinite-tag --resume --json.`)
    this.name = "NestedBranchMovedError"
  }
}

export class FenceTamperError extends Error {
  readonly code = "INF_WIZ_FENCE_TAMPER" as const
  constructor(readonly paths: string[]) {
    super(`An agent wrote inside a dependency or build folder (${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", …" : ""}). Reinstall your dependencies; nothing was built.`)
    this.name = "FenceTamperError"
  }
}

export interface FenceItemAllow {
  itemId: string
  jobId: string
  files: string[]
  create: string[]
  /** §3x.2 The item's trigger evidence lines (repo-relative), for attributing a hunk; absent in older snapshots. */
  evidence?: Array<{ file: string; line: number }>
}

interface ManifestEntry {
  rel: string
  existed: boolean
  copy: string | null
  sha256: string | null
  mode: number | null
  symlink: string | null
}

interface Fingerprint {
  rel: string
  size: number
  mtimeMs: number
  ctimeMs: number
}

interface HeavyInode {
  dir: string
  dev: number
  ino: number
}

/** HEAD, the branch and tag refs, and the index (copy + listing) before the turn (review O3 F1). */
interface GitSnapshot {
  head: string | null
  refs: Array<[string, string]>
  /** sha256 of `git ls-files -s -v -z` (content + assume-unchanged/skip-worktree bits, never stat info). */
  indexListing: string | null
  /** Snapshot-relative copy of `.git/index`, or null when there was none (or `.git` is not a directory). */
  indexCopy: string | null
}

interface FenceManifest {
  schema: typeof FENCE_SNAPSHOT_SCHEMA
  root: string
  runId: string
  turn: string
  createdAt: string
  mode: "revert" | "report"
  allow: FenceItemAllow[]
  entries: ManifestEntry[]
  statusBefore: Array<[string, string]>
  heavyDirs: string[]
  fingerprints: Fingerprint[]
  gitInternal: string[]
  marker: string
  heavyInodes?: HeavyInode[]
  git?: GitSnapshot | null
  /** The process that owns the turn (crash recovery skips a live one). */
  pid?: number
}

export interface FenceBeginOptions {
  /** Repo root (absolute). */
  root: string
  /** The snapshot dir (absolute, outside the repo and $TMPDIR). Created 0700. */
  snapshotDir: string
  runId: string
  turn: string | number
  items: readonly ChecklistItem[]
  mode?: "revert" | "report"
}

export interface FenceEndOptions {
  /** This turn's claims (to attribute a stray edit to the job that claimed it). */
  claims?: readonly Claim[]
  /** Literal tokens no change may contain (the bridge token, the MCP token). */
  secretLiterals?: readonly string[]
  /** §3f.9: runs on the kept diff BEFORE any build or T0. */
  turnGate?: (diff: TurnDiff) => Promise<CheckResult[]>
}

const HEAVY = new Set<string>(HEAVY_DIR_NAMES)

export class Fence {
  private settled = false
  private closing: { kind: "abort" | "end"; promise: Promise<unknown> } | null = null

  private constructor(private readonly manifest: FenceManifest, private readonly dir: string) {}

  get snapshotDir(): string {
    return this.dir
  }

  /** True once `abort()` or `end()` has started (the turn is being, or has been, settled). */
  get isSettled(): boolean {
    return this.settled || this.closing !== null
  }

  static async begin(options: FenceBeginOptions): Promise<Fence> {
    const root = options.root
    const dir = options.snapshotDir
    if (isInside(dir, root)) throw new Error("the fence snapshot must live outside the repo")
    await mkdir(join(dir, "files"), { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    const heavyDirs = await discoverHeavyDirs(root)
    const marker = join(dir, "heavy.marker")
    await writeFile(marker, `${Date.now()}\n`, { mode: 0o600 })
    const statusBefore = await statusOf(root, heavyDirs)
    const allow: FenceItemAllow[] = options.items.map((item) => ({
      itemId: item.id,
      jobId: item.jobId,
      files: item.allow.files.map(normalizeRelPath),
      create: item.allow.create.map(normalizeRelPath),
      evidence: item.trigger.evidence
        .filter((entry): entry is { file: string; line: number } => "file" in entry && typeof entry.line === "number")
        .map((entry) => ({ file: normalizeRelPath(entry.file), line: entry.line }))
    }))

    const toCopy = new Set<string>()
    const fingerprintOnly: string[] = []
    for (const rule of allow) for (const file of [...rule.files, ...rule.create]) if (!file.includes("*")) toCopy.add(file)
    let ignoredBytes = 0
    for (const entry of statusBefore) {
      if (entry.xy !== "!!") {
        toCopy.add(entry.path)
        if (entry.from) toCopy.add(entry.from)
        continue
      }
      if (matchesAnyGlob(entry.path, GLOBAL_DENY_GLOBS)) {
        toCopy.add(entry.path)
        continue
      }
      const info = await lstatOrNull(join(root, entry.path))
      if (info && info.isFile() && info.size <= IGNORED_COPY_LIMITS.perFileBytes && ignoredBytes + info.size <= IGNORED_COPY_LIMITS.totalBytes) {
        ignoredBytes += info.size
        toCopy.add(entry.path)
      } else {
        fingerprintOnly.push(entry.path)
      }
    }
    const tracked = (await gitOk(root, ["ls-files", "-z"])).toString("utf8").split("\0").filter(Boolean)
    for (const path of tracked) if (matchesAnyGlob(path, GLOBAL_DENY_GLOBS) && !underHeavy(path, heavyDirs)) toCopy.add(path)
    const gitInternal = await listGitInternal(root)
    for (const path of gitInternal) toCopy.add(path)

    const entries: ManifestEntry[] = []
    let index = 0
    for (const rel of [...toCopy].sort()) {
      const absolute = join(root, rel)
      const info = await lstatOrNull(absolute)
      if (!info || info.isDirectory()) {
        entries.push({ rel, existed: false, copy: null, sha256: null, mode: null, symlink: null })
        continue
      }
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute)
        entries.push({ rel, existed: true, copy: null, sha256: sha256Hex(`symlink:${target}`), mode: null, symlink: target })
        continue
      }
      const bytes = await readFile(absolute)
      const copy = join("files", String(index))
      index += 1
      await writeFile(join(dir, copy), bytes, { mode: 0o600 })
      entries.push({ rel, existed: true, copy, sha256: sha256Hex(bytes), mode: info.mode & 0o777, symlink: null })
    }
    const fingerprints: Fingerprint[] = []
    for (const rel of fingerprintOnly) {
      const info = await lstatOrNull(join(root, rel))
      if (info) fingerprints.push({ rel, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs })
    }
    const heavyInodes = await heavyInodesOf(root, heavyDirs)
    const gitState = await captureGit(root)
    let indexCopy: string | null = null
    if (gitState.indexPath) {
      const bytes = await readFile(gitState.indexPath).catch(() => null)
      if (bytes) {
        indexCopy = join("files", "git-index")
        await writeFile(join(dir, indexCopy), bytes, { mode: 0o600 })
      }
    }
    const manifest: FenceManifest = {
      schema: FENCE_SNAPSHOT_SCHEMA,
      root,
      runId: options.runId,
      turn: String(options.turn),
      createdAt: new Date().toISOString(),
      mode: options.mode ?? "revert",
      allow,
      entries,
      statusBefore: statusBefore.map((entry) => [entry.path, entry.xy]),
      heavyDirs,
      fingerprints,
      gitInternal,
      marker,
      heavyInodes,
      git: { head: gitState.head, refs: gitState.refs, indexListing: gitState.indexListing, indexCopy },
      pid: process.pid
    }
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 })
    return new Fence(manifest, dir)
  }

  /** Re-opens a snapshot written by `begin` (crash recovery: `Fence.load(dir).abort()`). */
  static async load(snapshotDir: string): Promise<Fence> {
    const manifest = JSON.parse(await readFile(join(snapshotDir, "manifest.json"), "utf8")) as FenceManifest
    if (manifest.schema !== FENCE_SNAPSHOT_SCHEMA) throw new Error("not a fence snapshot")
    return new Fence(manifest, snapshotDir)
  }

  /**
   * Restores every path the turn touched, exactly as it was before the turn. Idempotent: a second call (a
   * SIGINT racing the turn's own abort) gets the first call's result; after `end()` it is a no-op.
   */
  abort(): Promise<{ restored: string[]; unrestorable: string[] }> {
    if (this.closing?.kind === "abort") return this.closing.promise as Promise<{ restored: string[]; unrestorable: string[] }>
    if (this.closing || this.settled) {
      const settledAlready = this.closing?.promise ?? Promise.resolve()
      return settledAlready.then(
        () => ({ restored: [], unrestorable: [] }),
        () => ({ restored: [], unrestorable: [] })
      )
    }
    const promise = this.abortNow()
    this.closing = { kind: "abort", promise }
    return promise
  }

  private async abortNow(): Promise<{ restored: string[]; unrestorable: string[] }> {
    const { restored, unrestorable } = await this.restoreEverything()
    await this.dispose()
    return { restored, unrestorable }
  }

  /** Puts every path the turn touched back (git internals first, then refs and the index, then files). */
  private async restoreEverything(): Promise<{ restored: string[]; unrestorable: string[] }> {
    const gitFiles = await this.restoreGitInternals()
    const gitState = await this.restoreGitState()
    const touched = await this.touched()
    const restored: string[] = [...gitFiles, ...gitState]
    for (const rel of touched.paths) {
      await this.restore(rel)
      restored.push(rel)
    }
    return { restored: [...new Set(restored)].sort(), unrestorable: touched.tamper }
  }

  end(options: FenceEndOptions = {}): Promise<FenceEndResult> {
    try {
      this.assertOpen()
    } catch (error) {
      return Promise.reject(error)
    }
    const promise = this.endNow(options)
    this.closing = { kind: "end", promise }
    return promise
  }

  private async endNow(options: FenceEndOptions): Promise<FenceEndResult> {
    try {
      return await this.settleTurn(options)
    } catch (error) {
      // Never half-settled (review O3 F9): a throwing gate (or any other failure) restores the whole turn
      // before the error goes on. If even that fails, the snapshot is KEPT for `recoverCrashedTurns`.
      if (!this.settled) {
        try {
          await this.restoreEverything()
          await this.dispose()
        } catch {
          // keep the snapshot on disk
        }
      }
      throw error
    }
  }

  private async settleTurn(options: FenceEndOptions): Promise<FenceEndResult> {
    const manifest = this.manifest
    const root = manifest.root
    const report = manifest.mode === "report"
    // Git first, with plain file I/O, so no agent-planted config runs in the fence's own git calls.
    const gitFiles = await this.restoreGitInternals()
    // Report mode (nested, B8) never resets refs or the index; it only refuses a HEAD off the hand-off's line.
    const gitState = report ? await this.checkHeadDescends() : await this.restoreGitState()
    const touched = await this.touched()
    if (touched.tamper.length > 0) {
      for (const rel of touched.paths) await this.restore(rel)
      await this.dispose()
      throw new FenceTamperError(touched.tamper)
    }
    const blocks = new Map<string, FenceBlock>()
    const reverted = new Set<string>()
    const reportedOutside: string[] = []
    const block = (rel: string, reason: FenceBlockReason, note: string) => {
      for (const itemId of this.itemsFor(rel, options.claims ?? [])) {
        const key = `${itemId}\u0000${reason}`
        const existing = blocks.get(key)
        if (existing) {
          if (!existing.paths.includes(rel)) existing.paths.push(rel)
        } else {
          blocks.set(key, { itemId, reason, paths: [rel], note })
        }
      }
    }
    const rejectedDir = join(this.dir, REJECTED_SUBDIR)
    /** Report mode: keep the parent agent's bytes of a path before it is put back (never inside the repo). */
    const keepRejected = async (rel: string) => {
      if (!report) return
      const bytes = await readFile(join(root, rel)).catch(() => null)
      if (bytes === null) return
      const copy = join(rejectedDir, rel)
      await mkdir(dirname(copy), { recursive: true, mode: 0o700 })
      await writeFile(copy, bytes, { mode: 0o600 })
    }
    const revert = async (rel: string, reason: FenceBlockReason, note: string) => {
      await keepRejected(rel)
      await this.restore(rel)
      reverted.add(rel)
      if (report) reportedOutside.push(rel)
      block(rel, reason, note)
    }
    // Git internals, refs and the index are undone in BOTH modes: an agent never runs git (§3f "Do not").
    for (const rel of gitFiles) {
      reverted.add(rel)
      block(rel, "outside_allowlist", `Undid the change to ${rel}: the agent changed git's own files.`)
    }
    for (const rel of gitState) {
      reverted.add(rel)
      block(rel, "outside_allowlist", `Undid ${rel}: the agent ran git (a commit, a branch or staging). The wizard makes every commit itself.`)
    }

    interface Candidate {
      rel: string
      before: string | null
      after: string
      beforeLines: string[]
      afterLines: string[]
      hunks: LineHunk[]
      keep: boolean[]
    }
    const candidates: Candidate[] = []
    for (const rel of touched.paths) {
      // Report mode spans two wizard runs: the wizard's own run files (state.json, run.lock, the hand-offs)
      // change between the hand-off and the resume by the wizard itself, never by the parent agent's job.
      if (report && rel.startsWith(`${WIZARD_RUN_DIR}/`)) continue
      const absolute = join(root, rel)
      const beforeBytes = await this.originalBytes(rel)
      const nowInfo = await lstatOrNull(absolute)
      const denied = isDenied(rel)
      const deleted = beforeBytes !== null && !nowInfo
      const created = beforeBytes === null
      const allowedFile = this.allowsFile(rel)
      const allowedCreate = this.allowsCreate(rel)
      let outside: string | null = null
      if (denied) outside = "a protected path (the global deny list)"
      else if (deleted) outside = "a deleted file (no job may delete a file)"
      else if (nowInfo && !nowInfo.isFile()) outside = "not a regular file"
      else if (created && !allowedCreate) outside = "a new file no job may create"
      else if (!created && !allowedFile && !allowedCreate) outside = "a file outside the job's allowed files"
      if (outside === null && this.entry(rel)?.symlink != null) outside = "a symlink"
      if (outside !== null) {
        // Both modes revert BEFORE any check (B8). Report mode keeps the parent agent's bytes aside and
        // reports the path; it blocks no job (no job owns that file, and the rest proceeds: §4.3 (e)).
        if (report) {
          await keepRejected(rel)
          await this.restore(rel)
          reverted.add(rel)
          reportedOutside.push(rel)
          continue
        }
        await revert(rel, "outside_allowlist", `Undid the change to ${rel}: ${outside}.`)
        continue
      }
      const afterBytes = await readFile(absolute)
      const before = beforeBytes === null ? "" : decodeText(beforeBytes)
      const after = decodeText(afterBytes)
      if (before === null || after === null) {
        await revert(rel, "outside_allowlist", `Undid the change to ${rel}: not a text file.`)
        continue
      }
      const literals = (options.secretLiterals ?? []).filter((literal) => literal.length >= 8)
      if (literals.some((literal) => after.includes(literal) && !before.includes(literal))) {
        await revert(rel, "outside_allowlist", `Undid the change to ${rel}: it contained a wizard token.`)
        continue
      }
      const beforeLines = splitLines(before)
      const afterLines = splitLines(after)
      const hunks = hunksOf(beforeLines, afterLines)
      const keep = hunks.map(() => true)
      const spansBefore = consentLineSpans(before)
      const spansAfter = consentLineSpans(after)
      hunks.forEach((hunk, index) => {
        const { added, removed } = hunkLines(beforeLines, afterLines, hunk)
        const byPattern = [...added, ...removed].some((line) => CONSENT_CALL_PATTERNS.some((pattern) => pattern.test(line.text)))
        const inCall = added.some((line) => inSpans(line.line, spansAfter)) || removed.some((line) => inSpans(line.line, spansBefore))
        if (byPattern || inCall) {
          keep[index] = false
          block(rel, "consent_touched", `Undid a change to a consent call in ${rel}: consent is never the agent's job.`)
        }
      })
      candidates.push({ rel, before: beforeBytes === null ? null : before, after, beforeLines, afterLines, hunks, keep })
    }

    // §3f.9: the post-turn gate runs on what is still kept, BEFORE any build or T0.
    let gate: CheckResult[] = []
    const gateHits: FenceGateHit[] = []
    if (options.turnGate) {
      const diff: TurnDiff = { files: [] }
      for (const candidate of candidates) {
        const added: Array<{ line: number; text: string }> = []
        const removed: Array<{ line: number; text: string }> = []
        candidate.hunks.forEach((hunk, index) => {
          if (!candidate.keep[index]) return
          const lines = hunkLines(candidate.beforeLines, candidate.afterLines, hunk)
          added.push(...lines.added)
          removed.push(...lines.removed)
        })
        if (added.length > 0 || removed.length > 0) diff.files.push({ path: candidate.rel, added, removed })
      }
      if (diff.files.length > 0) gate = await options.turnGate(diff)
      for (const result of gate) {
        if (result.state !== "problem") continue
        const fileEvidence = (result.evidence ?? []).filter((evidence): evidence is { file: string; line: number } => "file" in evidence)
        const rule = gateRuleOf(result.reason)
        const words = gateWordsOf(result.reason)
        if (fileEvidence.length === 0) {
          // A gate that could not say where (a crash: o9 makes it a problem) checked nothing: every hunk goes.
          for (const candidate of candidates) {
            candidate.keep = candidate.keep.map(() => false)
            gateHits.push({
              rule,
              file: candidate.rel,
              line: 0,
              hunk: -1,
              itemIds: this.coveringItems(candidate.rel),
              note: `the wizard's safety check could not check the change to ${candidate.rel}${words ? ` (${words})` : ""}`
            })
          }
          continue
        }
        for (const evidence of fileEvidence) {
          const candidate = candidates.find((entry) => entry.rel === normalizeRelPath(evidence.file))
          if (!candidate) continue
          // The evidence line can be a NEW-file line (an added line) or an OLD-file line (a removed line,
          // e.g. O9's `autoconfig_opt_out_removed`); `CheckResult` does not say which (review O3 F2). So every
          // hunk the line could belong to is dropped, on either side; when none matches, the whole file is.
          const hits = candidate.hunks
            .map((hunk, index) => ({ hunk, index }))
            .filter(({ hunk }) => (evidence.line > hunk.bStart && evidence.line <= hunk.bEnd) || (evidence.line > hunk.aStart && evidence.line <= hunk.aEnd))
          const dropped = hits.length === 0 ? candidate.hunks.map((hunk, index) => ({ hunk, index })) : hits
          const note = `the wizard's safety check refused ${candidate.rel}:${evidence.line}: ${words || "the edit broke a safety rule"}`
          for (const { hunk, index } of dropped) {
            candidate.keep[index] = false
            gateHits.push({ rule, file: candidate.rel, line: evidence.line, hunk: hits.length === 0 ? -1 : index, itemIds: this.attributeHunk(candidate.rel, hunk, options.claims ?? []), note })
          }
        }
      }
    }

    const edits: WizardEditRecord[] = []
    const attribution: FenceEditAttribution[] = []
    let editIndex = 0
    for (const candidate of candidates) {
      const absolute = join(root, candidate.rel)
      const anyDropped = candidate.keep.some((kept) => !kept)
      const keptHunks = candidate.hunks.filter((_, index) => candidate.keep[index])
      if (anyDropped) {
        reverted.add(candidate.rel)
        await keepRejected(candidate.rel)
        if (report && !reportedOutside.includes(candidate.rel)) reportedOutside.push(candidate.rel)
        if (keptHunks.length === 0) {
          await this.restore(candidate.rel)
          continue
        }
        const rebuilt = applySomeHunks(candidate.beforeLines, candidate.afterLines, candidate.hunks, (_, index) => candidate.keep[index]!)
        await writeFile(absolute, rebuilt)
      }
      if (keptHunks.length === 0) continue
      const final = await readFile(absolute)
      const textEdits: ManagedTextEdit[] = hunksToTextEdits(candidate.beforeLines, candidate.afterLines, keptHunks)
      // §3x.2 Every kept hunk is attributed like a gate hit, so the jobs step can undo per item.
      const textEditItems = keptHunks.map((hunk) => this.attributeHunk(candidate.rel, hunk, options.claims ?? []))
      const editId = `agent-${manifest.runId.replace(/[^0-9a-f]/gi, "").slice(0, 8) || "run"}-t${manifest.turn}-${editIndex}`
      attribution.push({ editId, textEditItems })
      const firstItem = textEditItems.flat()[0]
      edits.push({
        id: editId,
        file: candidate.rel,
        jobId: (firstItem ? this.manifest.allow.find((entry) => entry.itemId === firstItem)?.jobId : undefined) ?? this.jobFor(candidate.rel, options.claims ?? []),
        planLineId: null,
        by: "agent",
        beforeHash: candidate.before === null ? null : `sha256:${sha256Hex(Buffer.from(candidate.before, "utf8"))}`,
        afterHash: `sha256:${sha256Hex(final)}`,
        textEdits,
        runId: manifest.runId
      })
      editIndex += 1
    }
    const seal = await takeSeal(root, manifest.heavyDirs, join(dirname(this.dir), `${basename(this.dir)}.seal`))
    await this.dispose()
    return {
      reverted: [...reverted].sort(),
      blocked: [...blocks.values()],
      edits,
      gate,
      gateHits,
      attribution,
      reportedOutside: [...new Set(reportedOutside)].sort(),
      seal,
      ...(report ? { rejectedDir } : {})
    }
  }

  /**
   * Puts `.git/config`, `config.worktree`, `HEAD`, `hooks/**` and `info/**` back from the snapshot with
   * plain file I/O (no git call), and deletes any such file the turn created. Returns what it changed.
   */
  private async restoreGitInternals(): Promise<string[]> {
    const changed: string[] = []
    // Report mode (B8) never moves HEAD: a switch is checked by `checkHeadDescends` instead.
    const keepHead = this.manifest.mode === "report"
    for (const rel of this.manifest.gitInternal) {
      if (keepHead && rel === ".git/HEAD") continue
      const entry = this.entry(rel)
      if (!entry) continue
      if ((await currentHash(join(this.manifest.root, rel))) === entry.sha256) continue
      await this.restore(rel)
      changed.push(rel)
    }
    for (const rel of await listGitInternal(this.manifest.root)) {
      if (this.entry(rel)) continue
      // New since the snapshot: deleted directly (never via a git call).
      await removePath(join(this.manifest.root, rel))
      changed.push(rel)
    }
    return changed.sort()
  }

  /** Report mode: refs and the index stay as the parent agent left them; HEAD must still descend from the hand-off. */
  private async checkHeadDescends(): Promise<string[]> {
    const before = this.manifest.git
    if (!before?.head) return []
    const now = await captureGit(this.manifest.root)
    if (now.head === before.head) return []
    const ancestor = now.head ? await git(this.manifest.root, ["merge-base", "--is-ancestor", before.head, now.head]) : null
    if (!ancestor || ancestor.code !== 0) throw new NestedBranchMovedError(before.head, now.head)
    return []
  }

  /** Branch/tag refs, HEAD and the index back to the snapshot (git is safe again by now). */
  private async restoreGitState(): Promise<string[]> {
    const before = this.manifest.git
    if (!before) return []
    const root = this.manifest.root
    const now = await captureGit(root)
    const changed: string[] = []
    const refsBefore = new Map(before.refs)
    const refsNow = new Map(now.refs)
    for (const [ref, sha] of refsBefore) {
      if (refsNow.get(ref) === sha) continue
      await gitOk(root, ["update-ref", "--no-deref", ref, sha])
      changed.push(`.git/${ref}`)
    }
    for (const [ref] of refsNow) {
      if (refsBefore.has(ref)) continue
      await gitOk(root, ["update-ref", "--no-deref", "-d", ref])
      changed.push(`.git/${ref}`)
    }
    // A detached HEAD moved by a commit: `.git/HEAD` itself was restored with the git internals.
    if (now.indexPath && now.indexListing !== before.indexListing) {
      if (before.indexCopy) await writeFile(now.indexPath, await readFile(join(this.dir, before.indexCopy)))
      else await rm(now.indexPath, { force: true })
      changed.push(".git/index")
    }
    return changed.sort()
  }

  /** Deletes the snapshot (it holds `.env` copies). */
  async dispose(): Promise<void> {
    this.settled = true
    if (this.manifest.mode !== "report") {
      await rm(this.dir, { recursive: true, force: true })
      return
    }
    // Report mode keeps the parent agent's rejected bytes (reported to the user); everything else (the
    // snapshot copies, `.env` included) is deleted.
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (name !== REJECTED_SUBDIR) await rm(join(this.dir, name), { recursive: true, force: true })
    }
  }

  private assertOpen(): void {
    if (this.settled || this.closing) throw new Error("this fence turn is already settled")
  }

  private entry(rel: string): ManifestEntry | undefined {
    return this.manifest.entries.find((entry) => entry.rel === rel)
  }

  /** Every path the turn changed (heavy-dir writes and un-restorable ignored files go to `tamper`). */
  private async touched(): Promise<{ paths: string[]; tamper: string[] }> {
    const manifest = this.manifest
    const root = manifest.root
    const before = new Map(manifest.statusBefore)
    const afterList = await statusOf(root, manifest.heavyDirs)
    const after = new Map<string, string>()
    for (const entry of afterList) {
      after.set(entry.path, entry.xy)
      if (entry.from && !after.has(entry.from)) after.set(entry.from, "D ")
    }
    const tamper: string[] = []
    const paths = new Set<string>()
    for (const [rel, xy] of after) {
      if (before.get(rel) === xy) continue
      if (xy === "!!" && segmentsOf(rel).some((segment) => HEAVY.has(segment))) {
        tamper.push(rel)
        continue
      }
      paths.add(rel)
    }
    for (const [rel] of before) {
      if (after.has(rel)) continue
      if (this.fingerprint(rel)) tamper.push(rel)
      else paths.add(rel)
    }
    for (const entry of manifest.entries) {
      if (paths.has(entry.rel)) continue
      if ((await currentHash(join(root, entry.rel))) !== entry.sha256) paths.add(entry.rel)
    }
    const gitNow = await listGitInternal(root)
    for (const rel of gitNow) if (!this.entry(rel)) paths.add(rel)
    for (const fingerprint of manifest.fingerprints) {
      const info = await lstatOrNull(join(root, fingerprint.rel))
      if (!info || info.size !== fingerprint.size || info.mtimeMs !== fingerprint.mtimeMs || info.ctimeMs !== fingerprint.ctimeMs) {
        tamper.push(fingerprint.rel)
        paths.delete(fingerprint.rel)
      }
    }
    if (manifest.heavyDirs.length > 0) {
      const hits = await findNewer(root, manifest.heavyDirs, manifest.marker)
      tamper.push(...hits)
    }
    // A heavy dir deleted or swapped for another (`rm -rf node_modules`): `find` sees nothing there (F18).
    tamper.push(...(await heavyDirsReplaced(root, manifest.heavyInodes ?? [])))
    return { paths: [...paths].sort(), tamper: [...new Set(tamper)].sort() }
  }

  private fingerprint(rel: string): Fingerprint | undefined {
    return this.manifest.fingerprints.find((entry) => entry.rel === rel)
  }

  /** The bytes the path held before the turn, or null when it did not exist. */
  private async originalBytes(rel: string): Promise<Buffer | null> {
    const entry = this.entry(rel)
    if (entry) {
      if (!entry.existed) return null
      if (entry.symlink !== null) return Buffer.from(`symlink:${entry.symlink}`)
      return readFile(join(this.dir, entry.copy!))
    }
    const statusBefore = new Map(this.manifest.statusBefore)
    if (statusBefore.has(rel)) return null
    return headBytes(this.manifest.root, rel)
  }

  /** Puts one path back exactly as it was before the turn (deletes it when it did not exist). */
  private async restore(rel: string): Promise<void> {
    const absolute = join(this.manifest.root, rel)
    if (!isInside(absolute, this.manifest.root)) throw new Error(`refusing to restore a path outside the repo: ${rel}`)
    const entry = this.entry(rel)
    const statusBefore = new Map(this.manifest.statusBefore)
    let bytes: Buffer | null = null
    let link: string | null = null
    let mode: number | null = null
    if (entry) {
      if (entry.existed) {
        if (entry.symlink !== null) link = entry.symlink
        else {
          bytes = await readFile(join(this.dir, entry.copy!))
          mode = entry.mode
        }
      }
    } else if (!statusBefore.has(rel)) {
      bytes = await headBytes(this.manifest.root, rel)
      mode = bytes === null ? null : await headMode(this.manifest.root, rel)
    }
    await removePath(absolute)
    if (bytes === null && link === null) {
      await pruneEmptyParents(dirname(absolute), this.manifest.root)
      return
    }
    await mkdir(dirname(absolute), { recursive: true })
    if (link !== null) {
      await symlink(link, absolute)
      return
    }
    await writeFile(absolute, bytes!)
    if (mode !== null) await chmod(absolute, mode)
  }

  private allowsFile(rel: string): boolean {
    return this.manifest.allow.some((rule) => rule.files.some((file) => sameOrGlob(file, rel)))
  }

  private allowsCreate(rel: string): boolean {
    return this.manifest.allow.some((rule) => rule.create.some((file) => sameOrGlob(file, rel)))
  }

  /** Which items a changed path counts against (§3f.6 "blocks its job"). */
  private itemsFor(rel: string, claims: readonly Claim[]): string[] {
    const covering = this.manifest.allow
      .filter((rule) => [...rule.files, ...rule.create].some((file) => sameOrGlob(file, rel)))
      .map((rule) => rule.itemId)
    if (covering.length > 0) return covering
    const known = new Set(this.manifest.allow.map((rule) => rule.itemId))
    const byFile = claims.filter((claim) => known.has(claim.jobId) && (claim.files ?? []).map(normalizeRelPath).includes(rel)).map((claim) => claim.jobId)
    if (byFile.length > 0) return [...new Set(byFile)]
    const done = claims.filter((claim) => known.has(claim.jobId) && claim.status === "done").map((claim) => claim.jobId)
    if (done.length > 0) return [...new Set(done)]
    return [...known]
  }

  /** The turn's items whose allowlist covers `rel`. */
  private coveringItems(rel: string): string[] {
    return this.manifest.allow.filter((rule) => [...rule.files, ...rule.create].some((file) => sameOrGlob(file, rel))).map((rule) => rule.itemId)
  }

  /**
   * §3x.2 Which items one hunk of `rel` belongs to. Candidates are the turn's items whose allowlist covers the file:
   * (a) those that claimed `done` naming the file (or naming no files); (b) when (a) gives more than one, those whose
   * trigger evidence in the file lies within the hunk's OLD range ±3 lines (else all of (a)); (c) when (a) is empty,
   * the candidates whose evidence lies in the hunk, else every candidate.
   */
  attributeHunk(rel: string, hunk: LineHunk, claims: readonly Claim[]): string[] {
    const candidates = this.manifest.allow.filter((rule) => [...rule.files, ...rule.create].some((file) => sameOrGlob(file, rel)))
    const evidenceIn = (rule: FenceItemAllow, slack: number) =>
      (rule.evidence ?? []).some((entry) => entry.file === rel && entry.line >= hunk.aStart + 1 - slack && entry.line <= Math.max(hunk.aEnd, hunk.aStart + 1) + slack)
    const claimedDone = candidates.filter((rule) =>
      claims.some((claim) => claim.jobId === rule.itemId && claim.status === "done" && (claim.files === undefined || claim.files.length === 0 || claim.files.map(normalizeRelPath).includes(rel)))
    )
    if (claimedDone.length === 1) return [claimedDone[0]!.itemId]
    if (claimedDone.length > 1) {
      const near = claimedDone.filter((rule) => evidenceIn(rule, 3))
      return (near.length > 0 ? near : claimedDone).map((rule) => rule.itemId)
    }
    const inHunk = candidates.filter((rule) => evidenceIn(rule, 0))
    return (inHunk.length > 0 ? inHunk : candidates).map((rule) => rule.itemId)
  }

  private jobFor(rel: string, claims: readonly Claim[]): string | null {
    const items = this.itemsFor(rel, claims)
    const rule = this.manifest.allow.find((entry) => entry.itemId === items[0])
    return rule?.jobId ?? null
  }
}

// ---- helpers ----

/** The gate rule a `turn_gate` problem names (`<rule>: the edit …`), or `turn_gate` when it names none. */
function gateRuleOf(reason: string | undefined): TurnGateRule | "turn_gate" {
  const head = (reason ?? "").split(":")[0]?.trim() ?? ""
  return head in TURN_GATE_RULES ? (head as TurnGateRule) : "turn_gate"
}

/** The gate's words after the rule (`the edit …`), or the whole reason when it names no rule. */
function gateWordsOf(reason: string | undefined): string {
  const text = (reason ?? "").trim()
  const colon = text.indexOf(":")
  return colon >= 0 && text.slice(0, colon).trim() in TURN_GATE_RULES ? text.slice(colon + 1).trim() : text
}

function sameOrGlob(pattern: string, rel: string): boolean {
  return pattern.includes("*") ? matchesAnyGlob(rel, [pattern]) : normalizeRelPath(pattern) === rel
}

function isDenied(rel: string): boolean {
  return rel === ".git" || matchesAnyGlob(rel, GLOBAL_DENY_GLOBS)
}

function segmentsOf(rel: string): string[] {
  return rel.split("/")
}

function underHeavy(rel: string, heavyDirs: readonly string[]): boolean {
  return heavyDirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`))
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith("/"))
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

async function currentHash(path: string): Promise<string | null> {
  const info = await lstatOrNull(path)
  if (!info || info.isDirectory()) return null
  if (info.isSymbolicLink()) return sha256Hex(`symlink:${await readlink(path)}`)
  return sha256Hex(await readFile(path))
}

// `ignoreBOM: true` keeps a UTF-8 BOM in the text, so hashes and `textEdits` offsets match the file (F17).
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null
  try {
    return UTF8.decode(bytes)
  } catch {
    return null
  }
}

async function removePath(path: string): Promise<void> {
  const info = await lstatOrNull(path)
  if (!info) return
  if (info.isDirectory()) await rm(path, { recursive: true, force: true })
  else await unlink(path)
}

async function pruneEmptyParents(dir: string, root: string): Promise<void> {
  let current = dir
  while (current !== root && isInside(current, root)) {
    try {
      await rmdir(current)
    } catch {
      return
    }
    current = dirname(current)
  }
}

async function headBytes(root: string, rel: string): Promise<Buffer | null> {
  const result = await git(root, ["cat-file", "--filters", `HEAD:${rel}`])
  return result.code === 0 ? result.stdout : null
}

async function headMode(root: string, rel: string): Promise<number | null> {
  const result = await git(root, ["ls-tree", "-z", "HEAD", "--", rel])
  const match = /^(\d{6}) /.exec(result.stdout.toString("utf8"))
  if (!match) return null
  return match[1] === "100755" ? 0o755 : 0o644
}

/** Ignored directories named like a heavy dir (`git ls-files --others --ignored --directory`). */
async function discoverHeavyDirs(root: string): Promise<string[]> {
  const result = await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"])
  if (result.code !== 0) return []
  const out: string[] = []
  for (const raw of result.stdout.toString("utf8").split("\0")) {
    if (!raw.endsWith("/")) continue
    const dir = raw.slice(0, -1)
    const segments = segmentsOf(dir)
    if (HEAVY.has(segments[segments.length - 1]!)) out.push(dir)
  }
  return out.sort()
}

/** `git status --porcelain=v1 -z --ignored --untracked-files=all`, the heavy dirs pathspec-excluded. */
async function statusOf(root: string, heavyDirs: readonly string[]): Promise<StatusEntry[]> {
  const args = ["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=all", "--", "."]
  for (const dir of heavyDirs) args.push(`:(top,exclude,literal)${dir}`)
  return parsePorcelainZ(await gitOk(root, args))
}

/** `.git/config`, `.git/HEAD`, `.git/hooks/**`, `.git/info/**` (repo-relative), or `.git` itself when it is a file. */
async function listGitInternal(root: string): Promise<string[]> {
  const dotGit = join(root, ".git")
  const info = await lstatOrNull(dotGit)
  if (!info) return []
  if (!info.isDirectory()) return [".git"]
  const out: string[] = []
  for (const name of ["config", "config.worktree", "HEAD"]) if (await lstatOrNull(join(dotGit, name))) out.push(`.git/${name}`)
  for (const sub of ["hooks", "info"]) out.push(...(await walkFiles(join(dotGit, sub), `.git/${sub}`)))
  return out.sort()
}

async function walkFiles(dir: string, prefix: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) {
    const info = await lstatOrNull(join(dir, name))
    if (!info) continue
    if (info.isDirectory()) out.push(...(await walkFiles(join(dir, name), `${prefix}/${name}`)))
    else out.push(`${prefix}/${name}`)
  }
  return out
}

/** `find <dirs> -cnewer <marker>`: any entry whose inode changed after the marker was written. */
function findNewer(root: string, dirs: readonly string[], marker: string): Promise<string[]> {
  return new Promise((resolveFind) => {
    execFile(
      "find",
      [...dirs.map((dir) => `./${dir}`), "-cnewer", marker, "-print"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
      (_error, stdout) => {
        const hits = String(stdout)
          .split("\n")
          .filter(Boolean)
          .map((line) => normalizeRelPath(line))
        resolveFind(hits.slice(0, 50))
      }
    )
  })
}

// ---- git state (review O3 F1) ----

interface GitNow {
  head: string | null
  refs: Array<[string, string]>
  indexListing: string | null
  /** Absolute `.git/index` when `.git` is a directory in the repo (a linked worktree's index lives outside it). */
  indexPath: string | null
}

async function captureGit(root: string): Promise<GitNow> {
  const dotGit = await lstatOrNull(join(root, ".git"))
  if (!dotGit) return { head: null, refs: [], indexListing: null, indexPath: null }
  const head = await git(root, ["rev-parse", "-q", "--verify", "HEAD"])
  const refsOut = await git(root, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/tags"])
  const refs: Array<[string, string]> = []
  for (const line of refsOut.stdout.toString("utf8").split("\n")) {
    const [ref, sha] = line.split("\0")
    if (ref && sha) refs.push([ref, sha])
  }
  const listing = await git(root, ["ls-files", "-s", "-v", "-z"])
  return {
    head: head.code === 0 ? head.stdout.toString("utf8").trim() : null,
    refs: refs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    indexListing: listing.code === 0 ? sha256Hex(listing.stdout) : null,
    indexPath: dotGit.isDirectory() ? join(root, ".git", "index") : null
  }
}

async function heavyInodesOf(root: string, dirs: readonly string[]): Promise<HeavyInode[]> {
  const out: HeavyInode[] = []
  for (const dir of dirs) {
    const info = await lstatOrNull(join(root, dir))
    if (info && info.isDirectory()) out.push({ dir, dev: info.dev, ino: info.ino })
  }
  return out
}

async function heavyDirsReplaced(root: string, inodes: readonly HeavyInode[]): Promise<string[]> {
  const out: string[] = []
  for (const before of inodes) {
    const info = await lstatOrNull(join(root, before.dir))
    if (!info || !info.isDirectory() || info.ino !== before.ino || info.dev !== before.dev) out.push(before.dir)
  }
  return out
}

// ---- consent call spans (review O3 F3) ----

/** 1-based, inclusive line ranges of every consent call in `text` (its whole bracket span). */
export function consentLineSpans(text: string): Array<[number, number]> {
  if (text === "") return []
  const lineStarts: number[] = [0]
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lineStarts.push(index + 1)
  const lineOf = (offset: number) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (lineStarts[mid]! <= offset) low = mid
      else high = mid - 1
    }
    return low + 1
  }
  const spans: Array<[number, number]> = []
  for (const { pattern, mode } of CONSENT_SPAN_STARTS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0
      const end = mode === "call" ? callEnd(text, start) : enclosingEnd(text, start + match[0].length)
      const span: [number, number] = [lineOf(start), lineOf(Math.max(start, end))]
      if (!spans.some(([first, last]) => first === span[0] && last === span[1])) spans.push(span)
    }
  }
  return spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])
}

function inSpans(line: number, spans: ReadonlyArray<[number, number]>): boolean {
  return spans.some(([first, last]) => line >= first && line <= last)
}

const SPAN_SCAN_LIMIT = 20_000
const OPENERS = new Set(["(", "[", "{"])
const CLOSERS = new Set([")", "]", "}"])

/** Offset of the bracket that closes the first "(" at or after `from` (or the scan limit). */
function callEnd(text: string, from: number): number {
  const open = text.indexOf("(", from)
  if (open === -1) return from
  let depth = 0
  return scan(text, open, (char, index) => {
    if (OPENERS.has(char)) depth += 1
    else if (CLOSERS.has(char)) {
      depth -= 1
      if (depth <= 0) return index
    }
    return null
  })
}

/** Offset of the bracket that closes the group `from` sits inside (or the scan limit). */
function enclosingEnd(text: string, from: number): number {
  let depth = 0
  return scan(text, from, (char, index) => {
    if (OPENERS.has(char)) depth += 1
    else if (CLOSERS.has(char)) {
      if (depth === 0) return index
      depth -= 1
    }
    return null
  })
}

/** Walks code from `from`, skipping strings and comments; `visit` returns an offset to stop there. */
function scan(text: string, from: number, visit: (char: string, index: number) => number | null): number {
  const limit = Math.min(text.length, from + SPAN_SCAN_LIMIT)
  let index = from
  while (index < limit) {
    const char = text[index]!
    if (char === "'" || char === '"' || char === "`") {
      index += 1
      while (index < limit && text[index] !== char) index += text[index] === "\\" ? 2 : 1
      index += 1
      continue
    }
    if (char === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index)
      index = newline === -1 ? limit : newline
      continue
    }
    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2)
      index = close === -1 ? limit : close + 2
      continue
    }
    const stop = visit(char, index)
    if (stop !== null) return stop
    index += 1
  }
  return limit - 1
}

// ---- the seal (review O3 F11) ----

const SEAL_SKIP = /^\.infinite(\/|$)/

async function sealEntries(root: string, heavyDirs: readonly string[]): Promise<{ status: Array<[string, string]>; files: Array<[string, string]>; git: string }> {
  const statusList = (await statusOf(root, heavyDirs)).filter((entry) => !SEAL_SKIP.test(entry.path))
  const status: Array<[string, string]> = statusList.map((entry) => [entry.path, `${entry.xy}${entry.from ? `<${entry.from}` : ""}`])
  const files: Array<[string, string]> = []
  const paths = new Set<string>([...statusList.map((entry) => entry.path), ...(await listGitInternal(root))])
  for (const rel of [...paths].sort()) {
    const info = await lstatOrNull(join(root, rel))
    if (!info || info.isDirectory()) {
      files.push([rel, "absent-or-dir"])
      continue
    }
    if (info.isFile() && info.size > IGNORED_COPY_LIMITS.perFileBytes) {
      files.push([rel, `fp:${info.size}:${info.mtimeMs}:${info.ctimeMs}`])
      continue
    }
    files.push([rel, (await currentHash(join(root, rel))) ?? "none"])
  }
  const state = await captureGit(root)
  return { status, files, git: sha256Hex(JSON.stringify([state.head, state.refs, state.indexListing])) }
}

async function takeSeal(root: string, heavyDirs: readonly string[], marker: string): Promise<TreeSeal> {
  await writeFile(marker, `${Date.now()}\n`, { mode: 0o600 })
  const entries = await sealEntries(root, heavyDirs)
  return { root, ...entries, heavyDirs: [...heavyDirs], heavyInodes: await heavyInodesOf(root, heavyDirs), marker }
}

/**
 * Re-reads the tree a turn settled (review O3 F11). `changed` lists what moved since the seal: a file, a
 * status entry, git's own files, refs or the index, and (with `heavy`, the default) a write inside a heavy
 * dir. Run it right before the build/T0 and before anything is staged; `heavy:false` once the wizard's
 * own build has written its output dirs.
 */
export async function verifySeal(seal: TreeSeal, options: { heavy?: boolean; ignore?: (rel: string) => boolean } = {}): Promise<{ ok: boolean; changed: string[] }> {
  const now = await sealEntries(seal.root, seal.heavyDirs)
  const changed = new Set<string>()
  const statusBefore = new Map(seal.status)
  const statusNow = new Map(now.status)
  for (const [rel, xy] of statusNow) if (statusBefore.get(rel) !== xy) changed.add(rel)
  for (const [rel] of statusBefore) if (!statusNow.has(rel)) changed.add(rel)
  const filesBefore = new Map(seal.files)
  for (const [rel, hash] of now.files) if (filesBefore.get(rel) !== hash) changed.add(rel)
  for (const [rel] of filesBefore) if (!now.files.some(([path]) => path === rel)) changed.add(rel)
  if (now.git !== seal.git) changed.add(".git (refs or the index)")
  if (options.heavy !== false && seal.heavyDirs.length > 0) {
    if (await lstatOrNull(seal.marker)) for (const hit of await findNewer(seal.root, seal.heavyDirs, seal.marker)) changed.add(hit)
    else changed.add("(the seal marker is gone)")
    for (const dir of await heavyDirsReplaced(seal.root, seal.heavyInodes)) changed.add(dir)
  }
  // A caller that ran a build ignores ONLY what a build may write (its output dirs; review I1 P1-3).
  if (options.ignore) for (const rel of [...changed]) if (options.ignore(rel)) changed.delete(rel)
  return { ok: changed.size === 0, changed: [...changed].sort() }
}

/** A seal of the tree as it is now (no heavy dirs), its marker at `marker` (outside the repo). */
export async function sealTreeNow(root: string, marker: string): Promise<TreeSeal> {
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 })
  return takeSeal(root, [], marker)
}

/**
 * Review I1 P1-3: keeps a given seal as the run's final seal, so the rehearsal refuses to stage a tree that
 * moved after it (used when the wizard's own build changed files outside its output dirs).
 */
export async function keepAsFinalSeal(seal: TreeSeal, sealPath: string): Promise<void> {
  await mkdir(dirname(sealPath), { recursive: true, mode: 0o700 })
  await writeFile(sealPath, JSON.stringify(seal), { mode: 0o600 })
}

/** Deletes the seal's marker file (nothing secret in it; it only dates the seal). */
export async function disposeSeal(seal: TreeSeal | null | undefined): Promise<void> {
  if (seal) await rm(seal.marker, { force: true })
}

/**
 * §3z.12 §3f.6 (B21): before the FIRST agent turn the jobs step lays the heavy-dir marker and waits a quiet
 * window. Any write under `node_modules` / `.next` / `dist` / `build` / `out` meanwhile is a running dev
 * server (or watcher), not the agent: the run parks INF_WIZ_DEV_SERVER_RUNNING instead of every turn
 * reading as tamper. Returns the paths written in the window (empty = quiet). The marker lives in
 * `scratchDir` (outside the repo).
 */
export async function heavyDirWritesDuring(input: { root: string; scratchDir: string; ms: number; sleep(ms: number): Promise<void> }): Promise<string[]> {
  const heavyDirs = await discoverHeavyDirs(input.root)
  if (heavyDirs.length === 0) return []
  await mkdir(input.scratchDir, { recursive: true, mode: 0o700 })
  const marker = join(input.scratchDir, `quiet-window.${process.pid}.marker`)
  await writeFile(marker, "", { mode: 0o600 })
  try {
    await input.sleep(input.ms)
    return await findNewer(input.root, heavyDirs, marker)
  } finally {
    await rm(marker, { force: true })
  }
}

/**
 * §3z.12 §3f.6 (B5/B29): the tree the agent jobs left, sealed at the END of the jobs step (after the failed
 * jobs' edits were undone), so the rehearsal can re-read it right before it stages anything: a process an
 * agent left running (a `setsid` grandchild) that writes later is caught, never committed. Heavy dirs are not
 * compared (the wizard's own build writes them).
 */
export async function sealFinalTree(root: string, sealPath: string): Promise<void> {
  await mkdir(dirname(sealPath), { recursive: true, mode: 0o700 })
  const seal = await takeSeal(root, [], `${sealPath}.marker`)
  await writeFile(sealPath, JSON.stringify(seal), { mode: 0o600 })
}

/** The final seal's verdict (`null` = no seal: no agent ran this run, or it was already verified). */
export async function verifyFinalSeal(root: string, sealPath: string): Promise<{ ok: boolean; changed: string[] } | null> {
  let seal: TreeSeal
  try {
    seal = JSON.parse(await readFile(sealPath, "utf8")) as TreeSeal
  } catch {
    return null
  }
  if (seal.root !== root) return null
  const verdict = await verifySeal(seal, { heavy: false })
  if (verdict.ok) {
    await disposeSeal(seal)
    await rm(sealPath, { force: true })
  }
  return verdict
}

// ---- crash recovery (review O3 F10) ----

/**
 * Restores every worker-turn snapshot a DEAD process left for this repo (the wizard was killed mid-turn),
 * so an agent's unvetted edits never become the next turn's baseline, and deletes the snapshot (it holds
 * `.env` copies). A report-mode (nested) snapshot is kept on purpose and skipped, and so is a turn whose
 * process is still alive.
 */
export async function recoverCrashedTurns(input: { snapshotsRoot: string; root: string }): Promise<Array<{ dir: string; restored: string[] }>> {
  const out: Array<{ dir: string; restored: string[] }> = []
  let runs: string[]
  try {
    runs = await readdir(input.snapshotsRoot)
  } catch {
    return out
  }
  for (const run of runs.sort()) {
    let turns: string[]
    try {
      turns = await readdir(join(input.snapshotsRoot, run))
    } catch {
      continue
    }
    for (const turn of turns.sort()) {
      const dir = join(input.snapshotsRoot, run, turn)
      let manifest: FenceManifest
      try {
        manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as FenceManifest
      } catch {
        continue
      }
      if (manifest.schema !== FENCE_SNAPSHOT_SCHEMA || manifest.mode !== "revert" || manifest.root !== input.root) continue
      if (manifest.pid !== undefined && manifest.pid !== process.pid && processAlive(manifest.pid)) continue
      if (manifest.pid === process.pid) continue
      const fence = await Fence.load(dir)
      const result = await fence.abort()
      out.push({ dir, restored: result.restored })
    }
  }
  return out
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
