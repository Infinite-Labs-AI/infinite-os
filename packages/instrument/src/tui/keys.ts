// Contains code adapted from PostHog wizard v2.74.1, MIT, Copyright (c) 2025 PostHog (notice: packages/instrument/LICENSE).
// Raw keyboard input for the TTY UI: ENTER, ESC, ↑ ↓ ← →, SPACE, BACKSPACE, TAB, letters (E, Q, Y, N…),
// Ctrl+C. The keyboard owns raw mode: it records the mode it found, and `stop()` always restores it, also
// after Ctrl+C. A `read EIO` (macOS raises one on stdin when raw mode is torn down with a read pending) is
// swallowed and reading continues, as in PostHog wizard v2.74.1 `start-tui.ts`, MIT, Copyright (c) 2025 PostHog.

export type Key =
  | { name: "enter" }
  | { name: "escape" }
  | { name: "up" }
  | { name: "down" }
  | { name: "left" }
  | { name: "right" }
  | { name: "space" }
  | { name: "backspace" }
  | { name: "tab" }
  | { name: "ctrl_c" }
  | { name: "char"; char: string }

/** Split one raw `data` chunk into keys. Unknown escape sequences are dropped. */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = []
  let index = 0
  while (index < chunk.length) {
    const rest = chunk.slice(index)
    if (rest.startsWith("\x1b[A") || rest.startsWith("\x1bOA")) {
      keys.push({ name: "up" })
      index += 3
      continue
    }
    if (rest.startsWith("\x1b[B") || rest.startsWith("\x1bOB")) {
      keys.push({ name: "down" })
      index += 3
      continue
    }
    if (rest.startsWith("\x1b[C") || rest.startsWith("\x1bOC")) {
      keys.push({ name: "right" })
      index += 3
      continue
    }
    if (rest.startsWith("\x1b[D") || rest.startsWith("\x1bOD")) {
      keys.push({ name: "left" })
      index += 3
      continue
    }
    if (rest.startsWith("\x1b[")) {
      // Some other CSI sequence (F-keys, Home, …): skip it whole.
      const match = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(rest)
      index += match ? match[0].length : 2
      continue
    }
    const char = String.fromCodePoint(chunk.codePointAt(index) ?? 0)
    index += char.length
    switch (char) {
      case "\r":
      case "\n":
        keys.push({ name: "enter" })
        break
      case "\x1b":
        keys.push({ name: "escape" })
        break
      case "\x03":
        keys.push({ name: "ctrl_c" })
        break
      case " ":
        keys.push({ name: "space" })
        break
      case "\x7f":
      case "\b":
        keys.push({ name: "backspace" })
        break
      case "\t":
        keys.push({ name: "tab" })
        break
      default: {
        const code = char.codePointAt(0) ?? 0
        if (code >= 0x20 && code !== 0x7f) keys.push({ name: "char", char })
      }
    }
  }
  return keys
}

/** The slice of `process.stdin` the keyboard uses (a seam so tests can drive it). */
export interface KeyboardInput {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?(mode: boolean): unknown
  setEncoding?(encoding: BufferEncoding): unknown
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown
  off(event: "data", listener: (chunk: string | Buffer) => void): unknown
  off(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown
  resume?(): unknown
  pause?(): unknown
}

export interface KeyboardOptions {
  onKey(key: Key): void
  /** Ctrl+C: raw mode is restored first, then this runs (the engine's SIGINT path). */
  onInterrupt(): void
}

export class RawKeyboard {
  private active = false
  private wasRaw = false
  private readonly onData = (chunk: string | Buffer) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    for (const key of parseKeys(text)) {
      if (!this.active) return
      if (key.name === "ctrl_c") {
        this.stop()
        this.options.onInterrupt()
        return
      }
      this.options.onKey(key)
    }
  }
  private readonly onError = (error: NodeJS.ErrnoException) => {
    // A pending read torn down by a raw-mode change (e.g. around a tty hand-over) surfaces as EIO. It is not
    // the end of input: swallow it and KEEP reading, as PostHog's wizard does, so the next ask can still be
    // answered. Raw mode is re-asserted while active (the terminal is restored on stop, Ctrl+C and exit).
    if (error.code === "EIO") {
      if (this.active) {
        if (this.input.isTTY && typeof this.input.setRawMode === "function" && this.input.isRaw !== true) this.input.setRawMode(true)
        this.input.resume?.()
      }
      return
    }
    this.stop()
    throw error
  }

  constructor(
    private readonly input: KeyboardInput,
    private readonly options: KeyboardOptions
  ) {}

  get isActive(): boolean {
    return this.active
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.wasRaw = this.input.isRaw === true
    // The error listener stays for the life of the process: a late EIO must never become an uncaught crash.
    this.input.off("error", this.onError)
    this.input.on("error", this.onError)
    if (this.input.isTTY && typeof this.input.setRawMode === "function") this.input.setRawMode(true)
    this.input.setEncoding?.("utf8")
    this.input.on("data", this.onData)
    this.input.resume?.()
  }

  /** Restores the raw mode it found. Safe to call more than once. */
  stop(): void {
    if (!this.active) return
    this.active = false
    this.input.off("data", this.onData)
    if (this.input.isTTY && typeof this.input.setRawMode === "function") this.input.setRawMode(this.wasRaw)
    this.input.pause?.()
  }
}
