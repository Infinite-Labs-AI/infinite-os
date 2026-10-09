// Who made a kept hunk: credited by claim, not by line distance (live run 2).
//
// The brief makes the agent finish and claim ONE job at a time, and the fence takes a snapshot of the job files at each
// `job_claim`. So the change between one claim and the next is the claiming job's work. Before this, a hunk went to
// every job whose allow-list covered the file unless one job's evidence line was within 3 lines of it: in live run 2 the
// lead job and the silent-form job both covered `pages/mailing-list.tsx`, the lead's evidence was in its API route, and
// three of the four blocks the lead job wrote on the page were credited to both jobs. The silent-form job was not
// verified, so the settlement put back the lead's lines too.
//
// Rules:
//   - interval k is the change from the previous claim's snapshot (the turn's start for the first claim) to claim k's;
//     it is credited to claim k's job when that job's files cover the file;
//   - a final hunk (the turn's start → its end) is credited to every interval whose change it still contains, including
//     one a later interval rewrote (the later job builds on it, so both own the lines);
//   - a hunk no credited interval explains (made after the last claim, or in a turn with no claim, or claimed by a job
//     whose files do not cover the file) goes to ONE job: the nearest by evidence line (`nearestOwner`), never to all.
import { hunksOf, type LineHunk } from "./line-diff.js"

/** One claim's snapshot of one file: its lines when the claim came in, and whether the claim's job may own them. */
export interface ClaimMark {
  jobId: string
  /** The file's lines at the claim (an absent file is no lines). */
  lines: readonly string[]
  /** False when the claiming job's files do not cover this file: the interval still ends here, but credits nobody. */
  credit: boolean
}

/** A half-open line range in the final text; `start === end` is the point between lines `start - 1` and `start`. */
interface Range {
  start: number
  end: number
}

function overlaps(a: Range, b: Range): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start
  if (a.start === a.end) return b.start <= a.start && a.start < b.end
  if (b.start === b.end) return a.start <= b.start && b.start < a.end
  return a.start < b.end && b.start < a.end
}

/**
 * Maps ranges of `from` into `to` (`hunksOf(from, to)`): an unchanged line keeps its place shifted by the hunks before
 * it; a line a later hunk rewrote maps onto that hunk's whole span in `to` (the later change builds on it).
 */
class RangeMap {
  private readonly hunks: LineHunk[]

  constructor(from: readonly string[], to: readonly string[]) {
    this.hunks = hunksOf(from, to)
  }

  /** How far a line (or a point) at `at` moved: every hunk ending at or before it (an insertion AT it comes before it). */
  private shiftBefore(at: number): number {
    let shift = 0
    for (const hunk of this.hunks) if (hunk.aEnd <= at) shift += hunk.bEnd - hunk.bStart - (hunk.aEnd - hunk.aStart)
    return shift
  }

  map(range: Range): Range {
    if (range.start === range.end) {
      const point = range.start
      const inside = this.hunks.find((hunk) => (hunk.aStart < point && point < hunk.aEnd) || (hunk.aStart === hunk.aEnd && hunk.aStart === point))
      if (inside) return { start: inside.bStart, end: inside.bEnd }
      const at = point + this.shiftBefore(point)
      return { start: at, end: at }
    }
    let start = Number.POSITIVE_INFINITY
    let end = Number.NEGATIVE_INFINITY
    for (let line = range.start; line < range.end; line += 1) {
      const rewritten = this.hunks.find((hunk) => hunk.aStart <= line && line < hunk.aEnd)
      const span = rewritten ? { start: rewritten.bStart, end: rewritten.bEnd } : { start: line + this.shiftBefore(line), end: line + this.shiftBefore(line) + 1 }
      start = Math.min(start, span.start)
      end = Math.max(end, span.end)
    }
    return { start, end }
  }
}

/**
 * For each hunk of `hunksOf(before, after)` (given as `hunks`), the jobs whose claim intervals made it, in claim order.
 * An empty list means no credited interval explains the hunk (the caller then picks one nearest job).
 */
export function claimOwners(before: readonly string[], after: readonly string[], marks: readonly ClaimMark[], hunks: readonly LineHunk[]): string[][] {
  if (marks.length === 0) return hunks.map(() => [])
  const regions: Array<{ jobId: string; ranges: Range[] }> = []
  let previous = before
  for (const mark of marks) {
    const changed = hunksOf(previous, mark.lines)
    if (mark.credit && changed.length > 0) {
      const toEnd = new RangeMap(mark.lines, after)
      regions.push({ jobId: mark.jobId, ranges: changed.map((hunk) => toEnd.map({ start: hunk.bStart, end: hunk.bEnd })) })
    }
    previous = mark.lines
  }
  return hunks.map((hunk) => {
    const final: Range = { start: hunk.bStart, end: hunk.bEnd }
    const owners: string[] = []
    for (const region of regions) if (!owners.includes(region.jobId) && region.ranges.some((range) => overlaps(range, final))) owners.push(region.jobId)
    return owners
  })
}

/**
 * The ONE job a hunk no claim explains goes to: among `candidates` (the jobs whose files cover the file, in seeded order),
 * the one with an evidence line in this file nearest the hunk (in the turn-start text's 1-based lines); else the last
 * claim that named the file; else the first candidate. Never every candidate.
 */
export function nearestOwner(
  rel: string,
  hunk: LineHunk,
  candidates: ReadonlyArray<{ itemId: string; evidence?: ReadonlyArray<{ file: string; line: number }> }>,
  namedBy: readonly string[] = []
): string | null {
  const first = hunk.aStart + 1
  const last = Math.max(hunk.aEnd, hunk.aStart + 1)
  let best: { itemId: string; distance: number } | null = null
  for (const candidate of candidates) {
    for (const entry of candidate.evidence ?? []) {
      if (entry.file !== rel) continue
      const distance = entry.line < first ? first - entry.line : entry.line > last ? entry.line - last : 0
      if (best === null || distance < best.distance) best = { itemId: candidate.itemId, distance }
    }
  }
  if (best) return best.itemId
  const named = [...namedBy].reverse().find((itemId) => candidates.some((candidate) => candidate.itemId === itemId))
  return named ?? candidates[0]?.itemId ?? null
}
