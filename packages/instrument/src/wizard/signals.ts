// SIGINT / SIGTERM (§3d.5 exit 130, README §4 "lock + SIGINT"): abort the run, kill the agent tree,
// restore the fence snapshot, release the lock, exit 130 — in exactly that order, so no agent can write
// after the snapshot is restored and no second wizard can start before the tree is back.
//
// A second signal while the first is still unwinding exits at once (the user insists).
import { WIZARD_EXIT } from "./contracts/codes.js"

export interface InterruptDeps {
  /** Aborts the run's AbortController (every step, ask and poll sees it). */
  abort(): void
  /** `AgentRunner.killAll()`: SIGTERM to every agent process group, then SIGKILL. */
  killAgents(): Promise<void>
  /** The fence's `abort()`: restores the uncommitted agent edits from the snapshot. Absent = nothing to restore. */
  fenceAbort?: () => Promise<void>
  releaseLock(): Promise<void>
  exit(code: number): void
  /** Where the one-line notice goes. */
  notice?: (text: string) => void
}

export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown
}

/** Runs the interrupt sequence once. Each stage runs even if an earlier one throws. */
export async function runInterruptSequence(deps: InterruptDeps): Promise<void> {
  const errors: unknown[] = []
  const stage = async (fn: () => void | Promise<void>) => {
    try {
      await fn()
    } catch (error) {
      errors.push(error)
    }
  }
  await stage(() => deps.abort())
  await stage(() => deps.killAgents())
  if (deps.fenceAbort) await stage(() => deps.fenceAbort!())
  await stage(() => deps.releaseLock())
  if (errors.length > 0) {
    deps.notice?.(`Interrupted; ${errors.length} clean-up stage(s) reported a problem: ${errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")}`)
  }
  deps.exit(WIZARD_EXIT.interrupted)
}

/** Installs the handlers; returns the uninstaller. */
export function installInterruptHandlers(deps: InterruptDeps, source: SignalSource = process): () => void {
  let running = false
  const listener = () => {
    if (running) {
      deps.exit(WIZARD_EXIT.interrupted)
      return
    }
    running = true
    deps.notice?.("Stopping: the agent is stopped, its unsaved edits are undone, and nothing is lost. Run npx infinite-tag again to resume.")
    void runInterruptSequence(deps)
  }
  source.on("SIGINT", listener)
  source.on("SIGTERM", listener)
  return () => {
    source.off("SIGINT", listener)
    source.off("SIGTERM", listener)
  }
}
