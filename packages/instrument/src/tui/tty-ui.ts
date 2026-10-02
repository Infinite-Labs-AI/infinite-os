// Contains code adapted from PostHog wizard v2.74.1, MIT, Copyright (c) 2025 PostHog (notice: packages/instrument/LICENSE).
// The TTY UI: an ANSI renderer in the terminal's alternate screen. It follows O1's store, redraws only the
// lines that changed, drives one overlay per pending ask, and gives the terminal back cleanly: raw mode
// restored, cursor shown, alt screen left, then the outro and ONE exit line printed into scrollback. It also
// restores the terminal after Ctrl+C (then hands off to the engine's SIGINT path) and after a `read EIO`.
//
// Alt-screen lifecycle, EIO swallow and the exit-line idea adapted from PostHog wizard v2.74.1
// (`src/ui/tui/start-tui.ts`, `terminal.ts`, `exit-line.ts`), MIT, Copyright (c) 2025 PostHog.
import type { AskKind } from "../wizard/contracts/asks.js"
import type { WizardStoreSnapshot } from "../wizard/contracts/state.js"
import { SEQ, SPINNER_FRAMES, colorEnabled, makeStyles, type Styles } from "./ansi.js"
import { exitLine } from "./exit-line.js"
import { renderFrame } from "./frame.js"
import { RawKeyboard, type Key, type KeyboardInput } from "./keys.js"
import { OVERLAYS, answered } from "./overlays/index.js"
import { handoverLine } from "./overlays/tty-handover.js"
import type { OverlayContext, OverlayView } from "./overlays/types.js"
import type { UntrustedSanitizer, WizardStoreView, WizardUi } from "./ui.js"

export interface TtyOutput {
  write(chunk: string): unknown
  columns?: number
  rows?: number
  isTTY?: boolean
  on?(event: "resize", listener: () => void): unknown
  off?(event: "resize", listener: () => void): unknown
}

export interface TtyUiOptions {
  stdin: KeyboardInput
  stdout: TtyOutput
  env: Readonly<Record<string, string | undefined>>
  /** Lane O3's sanitizeUntrusted (required: there is no second sanitiser). */
  sanitize: UntrustedSanitizer
  /** Ctrl+C, after raw mode is restored. Defaults to raising SIGINT on this process (O1's signal handler). */
  onInterrupt?: () => void
  /** Spinner tick; 0 disables the timer (tests). Default 100 ms. */
  spinnerIntervalMs?: number
  /** Also restore the terminal on `process.exit` (default true). */
  registerExitHook?: boolean
}

interface OverlaySlot {
  askId: string
  kind: AskKind
  state: unknown
}

export class TtyUi implements WizardUi {
  private store: WizardStoreView | null = null
  private unsubscribe: (() => void) | null = null
  private readonly keyboard: RawKeyboard
  private readonly styles: Styles
  private previous: string[] = []
  private fullRedraw = true
  private renderQueued = false
  private spinnerIndex = 0
  private spinnerTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private stopped = false
  private suspended = false
  private outro: string | null = null
  private overlay: OverlaySlot | null = null
  private dismissed = false
  private dismissWaiters: Array<() => void> = []
  private readonly onResize = () => {
    this.fullRedraw = true
    this.scheduleRender()
  }
  private readonly onProcessExit = () => this.stop()

  constructor(private readonly options: TtyUiOptions) {
    this.styles = makeStyles(colorEnabled(options.env, options.stdout.isTTY === true))
    this.keyboard = new RawKeyboard(options.stdin, {
      onKey: (key) => this.handleKey(key),
      onInterrupt: () => (options.onInterrupt ?? defaultInterrupt)()
    })
  }

  start(store: WizardStoreView): void {
    if (this.started) throw new Error("TtyUi.start: already started")
    this.started = true
    this.store = store
    this.write(SEQ.enterAltScreen + SEQ.hideCursor + SEQ.clearScreen + SEQ.cursorHome)
    this.keyboard.start()
    this.unsubscribe = store.subscribe(() => this.scheduleRender())
    this.options.stdout.on?.("resize", this.onResize)
    const interval = this.options.spinnerIntervalMs ?? 100
    if (interval > 0) {
      this.spinnerTimer = setInterval(() => {
        if (!this.isAnimating()) return
        this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length
        this.render()
      }, interval)
      this.spinnerTimer.unref?.()
    }
    if (this.options.registerExitHook !== false) process.once("exit", this.onProcessExit)
    this.render()
  }

  stop(): void {
    if (!this.started || this.stopped) return
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.spinnerTimer) clearInterval(this.spinnerTimer)
    this.spinnerTimer = null
    this.options.stdout.off?.("resize", this.onResize)
    if (this.options.registerExitHook !== false) process.off("exit", this.onProcessExit)
    this.keyboard.stop()
    const snapshot = this.store?.getSnapshot() ?? null
    let tail = ""
    if (!this.suspended) tail += SEQ.showCursor + SEQ.reset + SEQ.leaveAltScreen
    else tail += SEQ.showCursor + SEQ.reset
    const outro = this.currentOutro(snapshot)
    if (outro) tail += outro.split("\n").map((line) => this.options.sanitize(line, 400)).join("\n") + "\n"
    if (snapshot?.exit) {
      tail +=
        exitLine(
          { displayId: snapshot.run.displayId, exitCode: snapshot.exit.exitCode, prUrl: snapshot.exit.prUrl, reportPath: snapshot.exit.reportPath },
          this.styles
        ) + "\n"
    }
    this.write(tail)
    this.resolveDismiss()
  }

  setOutro(text: string | null): void {
    this.outro = text
    this.dismissed = false
    this.fullRedraw = true
    this.scheduleRender()
  }

  waitForDismiss(): Promise<void> {
    const snapshot = this.store?.getSnapshot() ?? null
    if (this.stopped || this.dismissed || !this.currentOutro(snapshot)) return Promise.resolve()
    return new Promise((resolve) => this.dismissWaiters.push(resolve))
  }

  /** For tests: the last frame drawn (lines, with ANSI). */
  lastFrame(): readonly string[] {
    return this.previous
  }

  // -------------------------------------------------------------------------------------------

  private write(chunk: string): void {
    if (chunk) this.options.stdout.write(chunk)
  }

  private currentOutro(snapshot: WizardStoreSnapshot | null): string | null {
    return this.outro ?? snapshot?.outro ?? null
  }

  private isAnimating(): boolean {
    if (this.stopped || this.suspended || !this.store) return false
    const snapshot = this.store.getSnapshot()
    return snapshot.steps.some((row) => row.state === "running") || snapshot.pendingAsk?.kind === "link-code"
  }

  private scheduleRender(): void {
    if (this.renderQueued || this.stopped) return
    this.renderQueued = true
    queueMicrotask(() => {
      this.renderQueued = false
      this.render()
    })
  }

  private syncOverlay(snapshot: WizardStoreSnapshot): void {
    const pending = snapshot.pendingAsk
    if (!pending) {
      this.overlay = null
      return
    }
    if (this.overlay?.askId === pending.askId) return
    const overlay = OVERLAYS[pending.kind]
    this.overlay = { askId: pending.askId, kind: pending.kind, state: overlay.init(pending.payload as never) }
  }

  private render(): void {
    if (!this.store || this.stopped) return
    const snapshot = this.store.getSnapshot()
    this.syncOverlay(snapshot)

    if (snapshot.pendingAsk?.kind === "tty-handover") {
      if (!this.suspended) this.suspend(snapshot.pendingAsk.payload as { reason: "gpg" | "ssh" | "hook"; command: string })
      return
    }
    if (this.suspended) this.resume()

    const width = this.options.stdout.columns ?? 80
    const height = this.options.stdout.rows ?? 24
    const outro = this.currentOutro(snapshot)
    const slot = this.overlay
    const pending = snapshot.pendingAsk
    const overlay =
      slot && pending && outro === null
        ? (ctx: OverlayContext): OverlayView => OVERLAYS[slot.kind].render(pending.payload as never, slot.state as never, ctx)
        : null
    const lines = renderFrame({
      snapshot,
      width,
      height,
      styles: this.styles,
      sanitize: this.options.sanitize,
      spinnerIndex: this.spinnerIndex,
      overlay,
      outro
    })
    let out = ""
    if (this.fullRedraw) out += SEQ.clearScreen
    lines.forEach((line, index) => {
      if (this.fullRedraw || this.previous[index] !== line) out += SEQ.moveTo(index + 1) + SEQ.clearLine + line
    })
    if (lines.length < this.previous.length) out += SEQ.moveTo(lines.length + 1) + SEQ.clearToEnd
    this.fullRedraw = false
    this.previous = lines
    this.write(out)
  }

  private suspend(payload: { reason: "gpg" | "ssh" | "hook"; command: string }): void {
    this.suspended = true
    this.keyboard.stop()
    this.write(SEQ.showCursor + SEQ.reset + SEQ.leaveAltScreen + handoverLine(payload, this.options.sanitize) + "\n")
  }

  private resume(): void {
    this.suspended = false
    this.fullRedraw = true
    this.write(SEQ.enterAltScreen + SEQ.hideCursor + SEQ.clearScreen + SEQ.cursorHome)
    this.keyboard.start()
  }

  private handleKey(key: Key): void {
    if (!this.store || this.stopped || this.suspended) return
    const snapshot = this.store.getSnapshot()
    if (this.currentOutro(snapshot) !== null) {
      if (key.name === "enter" || key.name === "escape" || (key.name === "char" && key.char.toLowerCase() === "q")) {
        this.dismissed = true
        this.resolveDismiss()
      }
      return
    }
    this.syncOverlay(snapshot)
    const slot = this.overlay
    const pending = snapshot.pendingAsk
    if (!slot || !pending || pending.askId !== slot.askId) return
    const outcome = OVERLAYS[slot.kind].onKey(pending.payload as never, slot.state as never, key)
    slot.state = outcome.state
    if (answered(outcome)) {
      this.overlay = null
      this.store.answerAsk(slot.askId, outcome.answer)
    }
    this.scheduleRender()
  }

  private resolveDismiss(): void {
    const waiters = this.dismissWaiters
    this.dismissWaiters = []
    for (const resolve of waiters) resolve()
  }
}

function defaultInterrupt(): void {
  process.kill(process.pid, "SIGINT")
}

export function createTtyUi(options: TtyUiOptions): TtyUi {
  return new TtyUi(options)
}
