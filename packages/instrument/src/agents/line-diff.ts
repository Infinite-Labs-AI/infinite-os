// A zero-dependency line diff (Myers, O((N+M)·D)) for the fence (§3f.6): it turns an agent's change to a
// file into hunks, so the fence can revert single hunks (a consent call, a post-turn gate hit) and record
// the kept change as exact `textEdits` in ORIGINAL-file coordinates (`server-lane/text-edits.ts` applies
// and reverses them byte-for-byte; uninstall reverses agent edits that way, R1-16). Pure.
import type { ManagedTextEdit } from "../types.js"

/** Lines WITH their terminators, so `lines.join("") === text` exactly (a last line may have none). */
export function splitLines(text: string): string[] {
  if (text === "") return []
  const out: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      out.push(text.slice(start, index + 1))
      start = index + 1
    }
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}

/** One changed region: lines [aStart, aEnd) of the original replaced by lines [bStart, bEnd) of the new text. */
export interface LineHunk {
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
}

type Op = 0 | 1 | 2 // equal, delete (from a), insert (from b)

/** The hunks that turn `before` into `after`, ascending and non-overlapping. */
export function diffLines(before: string, after: string): LineHunk[] {
  return hunksOf(splitLines(before), splitLines(after))
}

export function hunksOf(a: readonly string[], b: readonly string[]): LineHunk[] {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1
  const ops = myers(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix))
  const hunks: LineHunk[] = []
  let ai = prefix
  let bi = prefix
  let open: LineHunk | null = null
  for (const op of ops) {
    if (op === 0) {
      if (open) {
        hunks.push(open)
        open = null
      }
      ai += 1
      bi += 1
      continue
    }
    if (!open) open = { aStart: ai, aEnd: ai, bStart: bi, bEnd: bi }
    if (op === 1) {
      ai += 1
      open.aEnd = ai
    } else {
      bi += 1
      open.bEnd = bi
    }
  }
  if (open) hunks.push(open)
  return hunks
}

function myers(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n === 0) return new Array<Op>(m).fill(2)
  if (m === 0) return new Array<Op>(n).fill(1)
  const max = n + m
  const offset = max
  let v = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  outer: for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice())
    const next = v.slice()
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!
      else x = v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      next[offset + k] = x
      if (x >= n && y >= m) {
        v = next
        trace.push(v.slice())
        break outer
      }
    }
    v = next
  }
  // Backtrack from (n, m).
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d -= 1) {
    const prev = trace[d]!
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!)) prevK = k + 1
    else prevK = k - 1
    const prevX = prev[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push(0)
      x -= 1
      y -= 1
    }
    if (d === 0) break
    if (x === prevX) {
      ops.push(2)
      y -= 1
    } else {
      ops.push(1)
      x -= 1
    }
  }
  while (x > 0 && y > 0) {
    ops.push(0)
    x -= 1
    y -= 1
  }
  while (x > 0) {
    ops.push(1)
    x -= 1
  }
  while (y > 0) {
    ops.push(2)
    y -= 1
  }
  return ops.reverse()
}

/** Rebuilds the text with only the hunks `keep` accepts applied (the rest stay as in `before`). */
export function applySomeHunks(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  hunks: readonly LineHunk[],
  keep: (hunk: LineHunk, index: number) => boolean
): string {
  let out = ""
  let cursor = 0
  hunks.forEach((hunk, index) => {
    out += beforeLines.slice(cursor, hunk.aStart).join("")
    out += keep(hunk, index) ? afterLines.slice(hunk.bStart, hunk.bEnd).join("") : beforeLines.slice(hunk.aStart, hunk.aEnd).join("")
    cursor = hunk.aEnd
  })
  return out + beforeLines.slice(cursor).join("")
}

/** The kept hunks as `ManagedTextEdit`s in ORIGINAL coordinates (ascending, non-overlapping). */
export function hunksToTextEdits(beforeLines: readonly string[], afterLines: readonly string[], hunks: readonly LineHunk[]): ManagedTextEdit[] {
  const starts: number[] = []
  let total = 0
  for (const line of beforeLines) {
    starts.push(total)
    total += line.length
  }
  starts.push(total)
  return hunks.map((hunk) => ({
    offset: starts[hunk.aStart]!,
    removed: beforeLines.slice(hunk.aStart, hunk.aEnd).join(""),
    inserted: afterLines.slice(hunk.bStart, hunk.bEnd).join("")
  }))
}

/** 1-based line numbers: the added lines (in the new text) and removed lines (in the old) of each hunk. */
export function hunkLines(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  hunk: LineHunk
): { added: Array<{ line: number; text: string }>; removed: Array<{ line: number; text: string }> } {
  const strip = (line: string) => line.replace(/\r?\n$/, "")
  const added: Array<{ line: number; text: string }> = []
  const removed: Array<{ line: number; text: string }> = []
  for (let index = hunk.bStart; index < hunk.bEnd; index += 1) added.push({ line: index + 1, text: strip(afterLines[index]!) })
  for (let index = hunk.aStart; index < hunk.aEnd; index += 1) removed.push({ line: index + 1, text: strip(beforeLines[index]!) })
  return { added, removed }
}
