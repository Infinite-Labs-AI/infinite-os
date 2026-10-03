// Small pure helpers the runtime needs and nothing else in the package provides: a line diff (added and
// removed lines with their line numbers, for the post-turn gate's `TurnDiff`) and a glob matcher for the
// allowlist's global-deny patterns (`**/`, `/**`, `*`; Node 18 has no `path.matchesGlob`).

export interface LineChange {
  added: Array<{ line: number; text: string }>
  removed: Array<{ line: number; text: string }>
}

/** Above this many cells the LCS table is skipped and the whole file counts as replaced (conservative). */
const MAX_LCS_CELLS = 4_000_000

function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines.map((line) => line.replace(/\r$/, ""))
}

/**
 * Lines added (1-based numbers in `after`) and removed (1-based numbers in `before`). `before: null` = the
 * file is new (every line added); `after: null` = the file was deleted (every line removed).
 */
export function diffLines(before: string | null, after: string | null): LineChange {
  const a = before === null ? [] : splitLines(before)
  const b = after === null ? [] : splitLines(after)
  if (a.length * b.length > MAX_LCS_CELLS) {
    return {
      added: b.map((text, index) => ({ line: index + 1, text })),
      removed: a.map((text, index) => ({ line: index + 1, text }))
    }
  }
  // Trim the common prefix and suffix first: most edits are local.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const n = midA.length
  const m = midB.length
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const added: LineChange["added"] = []
  const removed: LineChange["removed"] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      i += 1
      j += 1
    } else if (j < m && (i >= n || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      added.push({ line: start + j + 1, text: midB[j]! })
      j += 1
    } else {
      removed.push({ line: start + i + 1, text: midA[i]! })
      i += 1
    }
  }
  return { added, removed }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^${}()|[\]\\?]/g, "\\$&")
}

// A glob as a RegExp over repo-relative POSIX paths: a leading-dirs wildcard (two stars + slash), a
// trailing everything-below wildcard (slash + two stars), and a one-segment star.
export function globToRegExp(glob: string): RegExp {
  let source = ""
  let index = 0
  while (index < glob.length) {
    if (glob.startsWith("**/", index)) {
      source += "(?:.*/)?"
      index += 3
    } else if (glob.startsWith("/**", index) && index + 3 === glob.length) {
      source += "(?:/.*)?"
      index += 3
    } else if (glob.startsWith("**", index)) {
      source += ".*"
      index += 2
    } else if (glob[index] === "*") {
      source += "[^/]*"
      index += 1
    } else {
      source += escapeRegExp(glob[index]!)
      index += 1
    }
  }
  return new RegExp(`^${source}$`)
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path))
}
