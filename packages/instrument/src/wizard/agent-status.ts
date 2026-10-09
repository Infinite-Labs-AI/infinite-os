/** One phase/count line for the worker, review fixes and read-only reviewer. Inputs are trusted tool events. */
export function agentStatusLine(input: {
  phase: string
  position?: number
  total?: number
  read: number
  edited: number
  thinking: number
  claimed?: number
  elapsedMs: number
  budgetMs: number
}): string {
  const item = input.total && input.position ? ` · job ${input.position} of ${input.total}` : ""
  const claims = input.total !== undefined && input.claimed !== undefined ? ` · ${input.claimed} of ${input.total} claimed` : ""
  return `${input.phase}${item} · ${input.read} files read · ${input.edited} edited · thinking ${input.thinking} s${claims} · ${Math.max(0, Math.floor(input.elapsedMs / 60_000))} of ${Math.round(input.budgetMs / 60_000)} min`
}
