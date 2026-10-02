// The line left in the user's scrollback after the TTY UI leaves the alternate screen (everything drawn in
// the alt screen is wiped): the run id, the PR URL and the report path, so the next step is always findable.
// Each URL/path sits after a plain separator so a terminal can select it cleanly.
//
// Adapted from PostHog wizard v2.74.1 (`src/ui/tui/exit-line.ts`), MIT, Copyright (c) 2025 PostHog.
import type { Styles } from "./ansi.js"

export interface ExitLineInput {
  displayId: string
  exitCode: number
  prUrl: string | null
  reportPath: string | null
}

const EXIT_WORD: Record<number, string> = {
  0: "done",
  1: "failed",
  2: "stopped",
  3: "paused (run npx infinite-tag again to continue)",
  4: "needs the Infinite app",
  130: "interrupted (run npx infinite-tag again to continue)"
}

export function exitLine(input: ExitLineInput, styles: Styles): string {
  const word = EXIT_WORD[input.exitCode] ?? `exit ${input.exitCode}`
  const mark = input.exitCode === 0 ? styles.ok("◆") : input.exitCode === 3 || input.exitCode === 130 ? styles.warn("◆") : styles.bad("◆")
  const parts = [`${mark} infinite-tag run ${input.displayId}: ${word}`]
  if (input.prUrl) parts.push(`PR ${input.prUrl}`)
  if (input.reportPath) parts.push(`report ${input.reportPath}`)
  return parts.join(" · ")
}
