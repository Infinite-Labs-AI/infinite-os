// Reading the working tree (lane O4, §3g.1): repo detection, the porcelain status, the remote, and the
// `.gitignore` rule (the wizard commits its own fence block and nothing else in that file).
import { GITIGNORE_FENCE_END, GITIGNORE_FENCE_START } from "../harness/outputs.js"

/** One `git status --porcelain=v1 -z` entry. `x` = index, `y` = worktree; `??` untracked, `!!` ignored. */
export interface StatusEntry {
  x: string
  y: string
  path: string
  /** The source path of a rename or copy. */
  origPath?: string
}

/** Parses `git status --porcelain=v1 -z` output (NUL-separated; a rename carries its source as the next field). */
export function parsePorcelainZ(output: string): StatusEntry[] {
  const fields = output.split("\0")
  const entries: StatusEntry[] = []
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!
    if (field.length < 4) continue
    const x = field[0]!
    const y = field[1]!
    const path = field.slice(3)
    const entry: StatusEntry = { x, y, path }
    if (x === "R" || x === "C") {
      entry.origPath = fields[i + 1]
      i += 1
    }
    entries.push(entry)
  }
  return entries
}

/** A deletion in the index or the worktree. No v1 job deletes a file, so the wizard never stages one. */
export function isDeletion(entry: StatusEntry): boolean {
  return entry.x === "D" || entry.y === "D"
}

/**
 * Removes every `# infinite:start` … `# infinite:end` block (and a blank line the block left behind) so two
 * `.gitignore` texts can be compared for changes OUTSIDE the wizard's fence.
 */
export function stripGitignoreFence(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  let inside = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!inside && trimmed === GITIGNORE_FENCE_START) {
      inside = true
      continue
    }
    if (inside) {
      if (trimmed === GITIGNORE_FENCE_END) inside = false
      continue
    }
    out.push(line)
  }
  return out.join("\n").replace(/\n+$/, "")
}

/**
 * §3g.1: `.gitignore` may be staged only when its change against HEAD is the wizard's fence block. Any other
 * change (the user's own edit) → the wizard refuses rather than committing the user's lines.
 */
export function gitignoreChangeIsFenceOnly(headText: string | null, worktreeText: string | null): boolean {
  if (worktreeText === null) return headText === null
  return stripGitignoreFence(headText ?? "") === stripGitignoreFence(worktreeText)
}
