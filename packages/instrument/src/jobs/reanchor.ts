// §3x.3 (D, §2.2) The checklist's trigger evidence is found by `before` on the site AS IT WAS (the base commit); the
// install then edits some of those files (an import line, a mount) before any agent turn. Each evidence line in such a
// file is mapped through that change (a line-offset map from the base's lines to the current ones), so the brief and
// the fence point at the right lines. Run 3's brief said 27/32/41 for lines that were 28/33/42 after the install.
import { hunksOf, splitLines } from "../agents/line-diff.js"
import type { ChecklistItem, Evidence } from "../wizard/contracts/jobs.js"

/** Maps a 1-based base line to the same line in `now`, through the line diff of `base` → `now`. */
export function lineMapper(base: string, now: string): (line: number) => number {
  const hunks = hunksOf(splitLines(base), splitLines(now))
  return (line) => {
    let shift = 0
    for (const hunk of hunks) {
      // Lines [aStart, aEnd) (0-based) of the base were replaced by [bStart, bEnd) of `now`.
      if (line - 1 < hunk.aStart) break
      if (line - 1 < hunk.aEnd) {
        // A line the change rewrote: the same position inside the replacement (its last line at most).
        const into = line - 1 - hunk.aStart
        return Math.min(hunk.bStart + into, Math.max(hunk.bStart, hunk.bEnd - 1)) + 1
      }
      shift += hunk.bEnd - hunk.bStart - (hunk.aEnd - hunk.aStart)
    }
    return line + shift
  }
}

/**
 * The items with every file evidence line re-anchored to the current tree. `readBase(file)` = the file at the base
 * commit (null when it did not exist), `readNow(file)` = the file now (null when unreadable); a file the install did not
 * change keeps its lines.
 */
export async function reanchorEvidence(
  items: readonly ChecklistItem[],
  readBase: (file: string) => Promise<string | null>,
  readNow: (file: string) => Promise<string | null>
): Promise<ChecklistItem[]> {
  const mappers = new Map<string, ((line: number) => number) | null>()
  const mapperFor = async (file: string) => {
    if (!mappers.has(file)) {
      const [base, now] = await Promise.all([readBase(file), readNow(file)])
      mappers.set(file, base === null || now === null || base === now ? null : lineMapper(base, now))
    }
    return mappers.get(file) ?? null
  }
  const out: ChecklistItem[] = []
  for (const item of items) {
    const evidence: Evidence[] = []
    for (const entry of item.trigger.evidence) {
      if (!("file" in entry)) {
        evidence.push(entry)
        continue
      }
      const map = await mapperFor(entry.file)
      evidence.push(map ? { file: entry.file, line: map(entry.line) } : entry)
    }
    out.push({ ...item, trigger: { ...item.trigger, evidence } })
  }
  return out
}
