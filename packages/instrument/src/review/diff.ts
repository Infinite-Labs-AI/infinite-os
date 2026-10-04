// A unified-diff reader (lane O4): which lines a diff adds, and which new-side lines GitHub will accept an
// inline review comment on (any line inside a hunk, context included, on the RIGHT side).

export interface DiffFile {
  path: string
  /** Added lines with their new-side line numbers. */
  added: Array<{ line: number; text: string }>
  removed: Array<{ line: number; text: string }>
  /** New-side line ranges covered by hunks (inclusive). */
  hunks: Array<{ start: number; end: number }>
}

function unquote(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path) as string
    } catch {
      return path.slice(1, -1)
    }
  }
  return path
}

/**
 * Parses `git diff` output. Hunk bodies are consumed by their line counts, so a content line that happens to
 * start with `---`, `+++` or `diff --git` is never read as a header.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let newLine = 0
  let oldLine = 0
  let oldLeft = 0
  let newLeft = 0
  for (const raw of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith("\\")) continue
      if (raw.startsWith("+")) {
        current?.added.push({ line: newLine, text: raw.slice(1) })
        newLine += 1
        newLeft -= 1
      } else if (raw.startsWith("-")) {
        current?.removed.push({ line: oldLine, text: raw.slice(1) })
        oldLine += 1
        oldLeft -= 1
      } else {
        newLine += 1
        oldLine += 1
        newLeft -= 1
        oldLeft -= 1
      }
      continue
    }
    if (raw.startsWith("diff --git ")) {
      current = null
      continue
    }
    if (raw.startsWith("+++ ")) {
      const target = unquote(raw.slice(4).trim())
      if (target === "/dev/null") {
        current = null
        continue
      }
      current = { path: target.replace(/^b\//, ""), added: [], removed: [], hunks: [] }
      files.push(current)
      continue
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      newLine = Number(hunk[3])
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
      if (current && newLeft > 0) current.hunks.push({ start: newLine, end: newLine + newLeft - 1 })
    }
  }
  return files
}

/** Whether GitHub accepts an inline comment on `path:line` for this diff. */
export function lineInHunk(files: readonly DiffFile[], path: string, line: number): boolean {
  const file = files.find((candidate) => candidate.path === path)
  return file ? file.hunks.some((hunk) => line >= hunk.start && line <= hunk.end) : false
}
