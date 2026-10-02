// §3e.6 of the wizard build plan: the edit receipt. Every file the wizard (or an agent, through O3's
// fence) changes is recorded in `.infinite/install.json` `edits` with its before/after hashes and the
// EXACT text edits in original-file coordinates, so `uninstall` can reverse any kept edit byte for
// byte — and refuses to touch a file that changed since ("changed since; left as is").
//
// Records for one file form a chain in array order: record k's `beforeHash` is record k-1's
// `afterHash`. Reversal runs newest first. A `null` beforeHash means the edit CREATED the file.
import { createHash } from "node:crypto"

import { reverseTextEdits } from "../server-lane/text-edits.js"
import type { ManagedTextEdit } from "../types.js"
import type { WizardEditRecord } from "../wizard/contracts/jobs.js"

/** The record the receipt stores (F0's `WizardEditRecord`, §3e.6). */
export type EditRecord = WizardEditRecord

/** `sha256:<64 hex>` of the exact bytes (utf8). The receipt's hash format. */
export function sha256Tagged(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
}

export const TAGGED_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

/** One hunk spanning the first to the last differing character (common prefix and suffix kept). */
function singleHunk(before: string, after: string, base = 0): ManagedTextEdit[] {
  if (before === after) return []
  let start = 0
  const limit = Math.min(before.length, after.length)
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start += 1
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore -= 1
    endAfter -= 1
  }
  return [{ offset: base + start, removed: before.slice(start, endBefore), inserted: after.slice(start, endAfter) }]
}

/** Lines with their terminators kept (so a concatenation is the exact text). */
function splitLines(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines.push(text.slice(start, index + 1))
      start = index + 1
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

/** Above this many changed lines the line diff gives up and records one hunk (still exact). */
const MAX_LINE_DIFF_D = 1_000

/**
 * Myers' O((N+M)·D) shortest edit script over lines. Returns, per `before` line, whether it is kept,
 * and per `after` line, whether it is kept; null when D exceeds the cap.
 */
function lineDiff(a: readonly string[], b: readonly string[]): { keptA: boolean[]; keptB: boolean[] } | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, MAX_LINE_DIFF_D)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    if (found >= 0) break
  }
  if (found < 0) return null
  const keptA = new Array<boolean>(n).fill(false)
  const keptB = new Array<boolean>(m).fill(false)
  let x = n
  let y = m
  for (let d = found; d >= 0; d -= 1) {
    const vd = trace[d]!
    const k = x - y
    const prevK = d === 0 ? 0 : k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : vd[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x -= 1
      y -= 1
      keptA[x] = true
      keptB[y] = true
    }
    x = prevX
    y = prevY
  }
  return { keptA, keptB }
}

/**
 * The exact text edits turning `before` into `after`, one hunk per changed run of lines (so a lockfile
 * changed near its top and its bottom records two small hunks, never the whole file), each hunk
 * trimmed to its differing characters. `[]` when the two are equal. Offsets are in `before`'s
 * coordinates, ascending and non-overlapping, so the result always satisfies
 * `applyTextEdits(before, edits) === after` and `reverseTextEdits(after, edits) === before`.
 */
export function textEditsBetween(before: string, after: string): ManagedTextEdit[] {
  if (before === after) return []
  const a = splitLines(before)
  const b = splitLines(after)
  const diff = lineDiff(a, b)
  if (!diff) return singleHunk(before, after)
  const edits: ManagedTextEdit[] = []
  let i = 0
  let j = 0
  let offset = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && diff.keptA[i] && diff.keptB[j]) {
      offset += a[i]!.length
      i += 1
      j += 1
      continue
    }
    const start = offset
    let removed = ""
    let inserted = ""
    while (i < a.length && !diff.keptA[i]) {
      removed += a[i]!
      offset += a[i]!.length
      i += 1
    }
    while (j < b.length && !diff.keptB[j]) {
      inserted += b[j]!
      j += 1
    }
    edits.push(...singleHunk(removed, inserted, start))
  }
  return edits
}

/** A stable record id: `ed_` + 16 hex of (runId, file, the record's after hash, its sequence). */
export function editRecordId(runId: string, file: string, afterHash: string, seq: number): string {
  return `ed_${createHash("sha256").update(`${runId}\n${file}\n${afterHash}\n${seq}`, "utf8").digest("hex").slice(0, 16)}`
}

export interface MakeEditRecordInput {
  /** Repo-root-relative POSIX path (monorepo-safe). */
  file: string
  /** The file's content before the edit; null = the edit created it. */
  before: string | null
  after: string
  jobId: string | null
  planLineId: string | null
  by: "wizard" | "agent"
  runId: string
  /** Disambiguates two records of one file in one run (default 0). */
  seq?: number
}

export function makeEditRecord(input: MakeEditRecordInput): EditRecord {
  const afterHash = sha256Tagged(input.after)
  return {
    id: editRecordId(input.runId, input.file, afterHash, input.seq ?? 0),
    file: input.file,
    jobId: input.jobId,
    planLineId: input.planLineId,
    by: input.by,
    beforeHash: input.before === null ? null : sha256Tagged(input.before),
    afterHash,
    textEdits: textEditsBetween(input.before ?? "", input.after),
    runId: input.runId
  }
}

export type ReverseEditOutcome =
  /** `content: null` = the edit created the file and reversing it leaves nothing: remove the file. */
  | { ok: true; content: string | null }
  | { ok: false; reason: "changed_since" | "edits_do_not_match" | "missing" }

/**
 * Reverse ONE record against the file's current content. Only when the current hash equals the
 * record's `afterHash`; the result must hash to `beforeHash` (or be empty for a created file), else
 * nothing is written. Never a partial reversal.
 */
export function reverseEditRecord(current: string | null, record: EditRecord): ReverseEditOutcome {
  if (current === null) return { ok: false, reason: "missing" }
  if (sha256Tagged(current) !== record.afterHash) return { ok: false, reason: "changed_since" }
  let restored: string
  try {
    restored = reverseTextEdits(current, record.textEdits)
  } catch {
    return { ok: false, reason: "edits_do_not_match" }
  }
  if (record.beforeHash === null) return restored === "" ? { ok: true, content: null } : { ok: false, reason: "edits_do_not_match" }
  if (sha256Tagged(restored) !== record.beforeHash) return { ok: false, reason: "edits_do_not_match" }
  return { ok: true, content: restored }
}

export interface RefreshIo {
  /** The file at HEAD (after hooks ran and the commit landed); null when absent. */
  readHead(file: string): string | null
  /**
   * The exact text a record was made from (cached when the record was made; null = the record created
   * the file, undefined = not known in this checkout).
   */
  beforeOf(record: EditRecord): string | null | undefined
}

export interface RefreshResult {
  records: EditRecord[]
  /** Files whose newest record was rebased onto the committed blob. */
  refreshed: string[]
  /** Files whose newest record's "before" is not known or does not hash right (left unchanged; never guessed). */
  unverifiable: string[]
}

/**
 * §3e.6: `afterHash` is recomputed from the committed blob after hooks run. For each file whose HEAD
 * blob no longer equals its newest record's `afterHash` (a hook reformatted it), the NEWEST record is
 * rebased: its `textEdits` and `afterHash` now describe its own before → HEAD, so uninstall (newest
 * first) still restores the exact pre-edit bytes, and the older records reverse on top of that. The
 * record's "before" must hash to its `beforeHash`, so a wrong cache is never papered over. Pure; the
 * caller writes the receipt.
 */
export function refreshFromHead(records: readonly EditRecord[], io: RefreshIo): RefreshResult {
  const out = records.map((record) => ({ ...record, textEdits: record.textEdits.map((edit) => ({ ...edit })) }))
  const refreshed: string[] = []
  const unverifiable: string[] = []
  const files = [...new Set(out.map((record) => record.file))]
  for (const file of files) {
    const indexes = out.flatMap((record, index) => (record.file === file ? [index] : []))
    const newestIndex = indexes[indexes.length - 1]!
    const newest = out[newestIndex]!
    const head = io.readHead(file)
    if (head === null || sha256Tagged(head) === newest.afterHash) continue
    const before = io.beforeOf(newest)
    if (before === undefined || !chainMatches(before, newest.beforeHash)) {
      unverifiable.push(file)
      continue
    }
    out[newestIndex] = { ...newest, afterHash: sha256Tagged(head), textEdits: textEditsBetween(before ?? "", head) }
    refreshed.push(file)
  }
  return { records: out, refreshed, unverifiable }
}

/** The text a record was made from, derived from the file it produced (null = the record created it). */
export function beforeTextOf(after: string, record: EditRecord): string | null | undefined {
  if (sha256Tagged(after) !== record.afterHash) return undefined
  let before: string
  try {
    before = reverseTextEdits(after, record.textEdits)
  } catch {
    return undefined
  }
  if (record.beforeHash === null) return before === "" ? null : undefined
  return sha256Tagged(before) === record.beforeHash ? before : undefined
}

function chainMatches(content: string | null, beforeHash: string | null): boolean {
  if (beforeHash === null) return content === null
  return content !== null && sha256Tagged(content) === beforeHash
}

/** A structural check of one record (used by the manifest's shape check). */
export function isEditRecordShape(value: unknown): value is EditRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  // The nine §3e.6 fields must be there; a NEWER tag's extra fields are tolerated (never "corrupt").
  for (const key of ["afterHash", "beforeHash", "by", "file", "id", "jobId", "planLineId", "runId", "textEdits"]) {
    if (!(key in record)) return false
  }
  return (
    typeof record.id === "string" &&
    typeof record.file === "string" &&
    record.file.length > 0 &&
    (record.jobId === null || typeof record.jobId === "string") &&
    (record.planLineId === null || typeof record.planLineId === "string") &&
    (record.by === "wizard" || record.by === "agent") &&
    (record.beforeHash === null || (typeof record.beforeHash === "string" && TAGGED_SHA256_PATTERN.test(record.beforeHash))) &&
    typeof record.afterHash === "string" &&
    TAGGED_SHA256_PATTERN.test(record.afterHash) &&
    typeof record.runId === "string" &&
    Array.isArray(record.textEdits) &&
    record.textEdits.every(
      (edit) =>
        typeof edit === "object" &&
        edit !== null &&
        Number.isInteger((edit as Record<string, unknown>).offset) &&
        ((edit as Record<string, unknown>).offset as number) >= 0 &&
        typeof (edit as Record<string, unknown>).removed === "string" &&
        typeof (edit as Record<string, unknown>).inserted === "string"
    )
  )
}
