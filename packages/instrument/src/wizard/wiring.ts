// The seam between the wizard runtime (this lane) and the pieces other lanes build: the desktop bridge
// client and the UIs (O2), the agent runner and fence (O3), git and the PR host (O4), the checks (O6/O9),
// the registry (O8) and the installer (O7). `command.ts` asks the wiring for them; integration (I1) sets
// the real wiring with `setWizardWiring`. Until then the command says plainly that the wizard is not
// wired, and exits 2 (INF_WIZ_NOT_BUILT) — a published build can never pretend the wizard ran.
import type { WizardDeps, WizardOptions } from "./contracts/deps.js"
import type { WizardRunState } from "./contracts/state.js"
import type { TtyPrompter } from "./asks.js"
import type { EngineOptions } from "./engine.js"
import type { WizardStore } from "./store.js"

/** The process surface the command uses (tests pass fakes). */
export interface WizardIo {
  stdin: { isTTY?: boolean }
  stdout: { isTTY?: boolean; columns?: number; write(text: string): unknown }
  stderr: { write(text: string): unknown }
  env: Readonly<Record<string, string | undefined>>
  platform: string
  cwd(): string
  /** Used only by the SIGINT path (exit 130); the normal path returns the code. */
  exit(code: number): void
}

/** What a UI is to the command (lane O2's `WizardUi` satisfies it). */
export interface WizardUiLike {
  start(store: WizardStore): void
  stop(): void
  /**
   * Resolves once the user closed the closing screen (TTY: ENTER, Q, ESC or Ctrl+C). A UI without a closing
   * screen leaves it out, and the command does not wait.
   */
  waitForDismiss?(): Promise<void>
}

export interface CreateDepsInput {
  root: string
  appRoot: string
  options: WizardOptions
  env: Readonly<Record<string, string | undefined>>
  platform: string
  /** The resolved `INSTRUMENT_VERSION` (printed in `run.start`). */
  tagVersion: string
  /** Every collaborator stops on this (SIGINT/SIGTERM). */
  signal: AbortSignal
  /**
   * The run state as the engine holds it (in memory; null before it exists). Collaborators that need the
   * run (its id, the chosen worker, the merge time) read it through this getter, never from a stale file.
   */
  state?: () => Readonly<WizardRunState> | null
}

export interface WizardWiring {
  createDeps(input: CreateDepsInput): Promise<WizardDeps>
  createUi(kind: "tty" | "json", store: WizardStore, io: WizardIo): WizardUiLike
  /** The fence's snapshot restore, for the SIGINT sequence (lane O3). */
  fenceAbort?(): Promise<void>
  /** The wizard's own /dev/tty prompt (nested mode); default `openDevTtyPrompter`. */
  ttyPrompter?(): TtyPrompter | null
  /** Engine overrides (tests pass a fake step Record). */
  engine?: Omit<EngineOptions, "resumedFrom">
}

let current: WizardWiring | null = null

export function setWizardWiring(wiring: WizardWiring | null): void {
  current = wiring
}

export function getWizardWiring(): WizardWiring | null {
  return current
}
