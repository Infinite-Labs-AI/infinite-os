// §3e.6 of the wizard build plan: the edit receipt. Every file the wizard (or an agent, through O3's
// fence) changes is recorded in `.infinite/install.json` `edits` with its before/after hashes and the
// EXACT text edits in original-file coordinates, so `uninstall` can reverse any kept edit byte for
// byte — and refuses to touch a file that changed since ("changed since; left as is").
//
// Records for one file form a chain in array order: record k's `beforeHash` is record k-1's
// `afterHash`. Reversal runs newest first. A `null` beforeHash means the edit CREATED the file.
import { createHash } from "node:crypto"

import { applyTextEdits, reverseTextEdits } from "../server-lane/text-edits.js"
import type { ManagedTextEdit } from "../types.js"
import type { WizardEditRecord } from "../wizard/contracts/jobs.js"

/** The record the receipt stores (F0's `WizardEditRecord`, §3e.6). */
export type EditRecord = WizardEditRecord

/** `sha256:<64 hex>` of the exact bytes (utf8). The receipt's hash format. */
export function sha256Tagged(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
}

export const TAGGED_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

/**
 * The exact, minimal text edit turning `before` into `after`: one hunk spanning the first to the last
 * differing character (common prefix and suffix kept). `[]` when the two are equal. The result always
 * satisfies `applyTextEdits(before, edits) === after` and `reverseTextEdits(after, edits) === before`.
 */
export function textEditsBetween(before: string, after: string): ManagedTextEdit[] {
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
  return [{ offset: start, removed: before.slice(start, endBefore), inserted: after.slice(start, endAfter) }]
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
  /** The file at the branch base (before this run); null when absent. */
  readBase(file: string): string | null
}

export interface RefreshResult {
  records: EditRecord[]
  /** Files whose newest record was rebased onto the committed blob. */
  refreshed: string[]
  /** Files whose chain could not be rebuilt from the base (left unchanged; never guessed). */
  unverifiable: string[]
}

/**
 * §3e.6: `afterHash` is recomputed from the committed blob after hooks run. For each file whose HEAD
 * blob no longer equals its newest record's `afterHash` (a hook reformatted it), the chain is replayed
 * from the base blob — each record's `beforeHash` must match, so a broken chain is never papered over —
 * and the NEWEST record is rebased: its `textEdits` and `afterHash` now describe its before → HEAD, so
 * uninstall still restores the exact pre-edit bytes. Pure; the caller writes the receipt.
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
    // Replay the chain from the base to reach the newest record's own "before".
    let content: string | null = io.readBase(file)
    let intact = true
    for (const index of indexes.slice(0, -1)) {
      const record = out[index]!
      if (!chainMatches(content, record.beforeHash)) {
        intact = false
        break
      }
      try {
        content = applyTextEdits(content ?? "", record.textEdits)
      } catch {
        intact = false
        break
      }
    }
    if (!intact || !chainMatches(content, newest.beforeHash)) {
      unverifiable.push(file)
      continue
    }
    out[newestIndex] = { ...newest, afterHash: sha256Tagged(head), textEdits: textEditsBetween(content ?? "", head) }
    refreshed.push(file)
  }
  return { records: out, refreshed, unverifiable }
}

function chainMatches(content: string | null, beforeHash: string | null): boolean {
  if (beforeHash === null) return content === null
  return content !== null && sha256Tagged(content) === beforeHash
}

/** A structural check of one record (used by the manifest's shape check). */
export function isEditRecordShape(value: unknown): value is EditRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(",")
  if (keys !== "afterHash,beforeHash,by,file,id,jobId,planLineId,runId,textEdits") return false
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
