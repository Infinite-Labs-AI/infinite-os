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
// a manifest, so a crashed turn can be restored later with `Fence.load(dir).abort()`; it is deleted once
// the turn is settled (it holds `.env` copies).
//
// Nested mode (§3d.7) uses `mode: "report"`: edits outside the allowlists are left in place (unstaged by
// O4) and reported, while consent hunks and gate hits are still reverted and block their job.
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"

import type { ManagedTextEdit } from "../types.js"
import type { ChecklistItem, CheckResult, Claim, TurnDiff, WizardEditRecord } from "../wizard/contracts/jobs.js"
import { GLOBAL_DENY_GLOBS } from "../wizard/contracts/jobs.js"
import { git, gitOk, parsePorcelainZ, type StatusEntry } from "./git-exec.js"
import { matchesAnyGlob, normalizeRelPath } from "./glob.js"
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
  /['"`]consent['"`]\s*,\s*['"`](default|update)['"`]/
]

export type FenceBlockReason = "outside_allowlist" | "consent_touched"

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
  /** Report mode only: paths changed outside the allowlists, left in place (never staged). */
  reportedOutside: string[]
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

  private constructor(private readonly manifest: FenceManifest, private readonly dir: string) {}

  get snapshotDir(): string {
    return this.dir
  }

  get isSettled(): boolean {
    return this.settled
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
    const allow = options.items.map((item) => ({
      itemId: item.id,
      jobId: item.jobId,
      files: item.allow.files.map(normalizeRelPath),
      create: item.allow.create.map(normalizeRelPath)
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
      marker
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

  /** Restores every path the turn touched, exactly as it was before the turn. */
  async abort(): Promise<{ restored: string[]; unrestorable: string[] }> {
    this.assertOpen()
    const touched = await this.touched()
    const restored: string[] = []
    for (const rel of touched.paths) {
      await this.restore(rel)
      restored.push(rel)
    }
    await this.dispose()
    return { restored, unrestorable: touched.tamper }
  }

  async end(options: FenceEndOptions = {}): Promise<FenceEndResult> {
    this.assertOpen()
    const manifest = this.manifest
    const root = manifest.root
    const touched = await this.touched()
    if (touched.tamper.length > 0) {
      for (const rel of touched.paths) await this.restore(rel)
      await this.dispose()
      throw new FenceTamperError(touched.tamper)
    }
    const blocks = new Map<string, FenceBlock>()
    const reverted = new Set<string>()
    const reportedOutside: string[] = []
    const report = manifest.mode === "report"
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
    const revert = async (rel: string, reason: FenceBlockReason, note: string) => {
      await this.restore(rel)
      reverted.add(rel)
      block(rel, reason, note)
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
        if (report) {
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
      hunks.forEach((hunk, index) => {
        const { added, removed } = hunkLines(beforeLines, afterLines, hunk)
        if ([...added, ...removed].some((line) => CONSENT_CALL_PATTERNS.some((pattern) => pattern.test(line.text)))) {
          keep[index] = false
          block(rel, "consent_touched", `Undid a change to a consent call in ${rel}: consent is never the agent's job.`)
        }
      })
      candidates.push({ rel, before: beforeBytes === null ? null : before, after, beforeLines, afterLines, hunks, keep })
    }

    // §3f.9: the post-turn gate runs on what is still kept, BEFORE any build or T0.
    let gate: CheckResult[] = []
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
        const note = `The post-turn check ${result.checkId} found a problem${result.reason ? ` (${result.reason})` : ""}; that change was undone.`
        if (fileEvidence.length === 0) {
          for (const candidate of candidates) {
            candidate.keep = candidate.keep.map(() => false)
            block(candidate.rel, "outside_allowlist", note)
          }
          continue
        }
        for (const evidence of fileEvidence) {
          const candidate = candidates.find((entry) => entry.rel === normalizeRelPath(evidence.file))
          if (!candidate) continue
          const hit = candidate.hunks.findIndex((hunk) => evidence.line >= hunk.bStart + 1 && evidence.line <= Math.max(hunk.bEnd, hunk.bStart + 1))
          if (hit === -1) candidate.keep = candidate.keep.map(() => false)
          else candidate.keep[hit] = false
          block(candidate.rel, "outside_allowlist", note)
        }
      }
    }

    const edits: WizardEditRecord[] = []
    let editIndex = 0
    for (const candidate of candidates) {
      const absolute = join(root, candidate.rel)
      const anyDropped = candidate.keep.some((kept) => !kept)
      const keptHunks = candidate.hunks.filter((_, index) => candidate.keep[index])
      if (anyDropped) {
        reverted.add(candidate.rel)
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
      edits.push({
        id: `agent-${manifest.runId.replace(/[^0-9a-f]/gi, "").slice(0, 8) || "run"}-t${manifest.turn}-${editIndex}`,
        file: candidate.rel,
        jobId: this.jobFor(candidate.rel, options.claims ?? []),
        planLineId: null,
        by: "agent",
        beforeHash: candidate.before === null ? null : `sha256:${sha256Hex(Buffer.from(candidate.before, "utf8"))}`,
        afterHash: `sha256:${sha256Hex(final)}`,
        textEdits,
        runId: manifest.runId
      })
      editIndex += 1
    }
    await this.dispose()
    return { reverted: [...reverted].sort(), blocked: [...blocks.values()], edits, gate, reportedOutside: reportedOutside.sort() }
  }

  /** Deletes the snapshot (it holds `.env` copies). */
  async dispose(): Promise<void> {
    this.settled = true
    await rm(this.dir, { recursive: true, force: true })
  }

  private assertOpen(): void {
    if (this.settled) throw new Error("this fence turn is already settled")
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

  private jobFor(rel: string, claims: readonly Claim[]): string | null {
    const items = this.itemsFor(rel, claims)
    const rule = this.manifest.allow.find((entry) => entry.itemId === items[0])
    return rule?.jobId ?? null
  }
}

// ---- helpers ----

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

const UTF8 = new TextDecoder("utf-8", { fatal: true })

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
  for (const name of ["config", "HEAD"]) if (await lstatOrNull(join(dotGit, name))) out.push(`.git/${name}`)
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
