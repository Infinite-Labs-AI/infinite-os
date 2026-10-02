// ANSI primitives for the TTY UI: colour on/off (`NO_COLOR`, `FORCE_COLOR`), styles, the spinner, terminal
// control sequences, and width-aware truncation/padding so a frame never wraps.
//
// Terminal sequences adapted from PostHog wizard v2.74.1 (`src/ui/tui/terminal.ts`), MIT,
// Copyright (c) 2025 PostHog. See packages/instrument/LICENSE.

export const ESC = "\x1b["
export const SEQ = {
  reset: "\x1b[0m",
  enterAltScreen: "\x1b[?1049h",
  leaveAltScreen: "\x1b[?1049l",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  clearScreen: "\x1b[2J",
  cursorHome: "\x1b[H",
  clearLine: "\x1b[2K",
  clearToEnd: "\x1b[0J",
  moveTo: (row: number, col = 1) => `\x1b[${row};${col}H`
} as const

/** Braille spinner frames (the design's). */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

/**
 * Colour is on when stdout is a TTY, unless `NO_COLOR` is set (any non-empty value, no-color.org) or
 * `FORCE_COLOR` is `0`/`false`. `FORCE_COLOR` with any other value forces it on (also off a TTY).
 */
export function colorEnabled(env: Readonly<Record<string, string | undefined>>, isTTY: boolean): boolean {
  const noColor = env.NO_COLOR
  if (noColor !== undefined && noColor !== "") return false
  const force = env.FORCE_COLOR
  if (force !== undefined) {
    const value = force.trim().toLowerCase()
    if (value === "0" || value === "false") return false
    return true
  }
  if (env.TERM === "dumb") return false
  return isTTY
}

type Paint = (text: string) => string

export interface Styles {
  enabled: boolean
  bold: Paint
  dim: Paint
  ok: Paint
  warn: Paint
  bad: Paint
  info: Paint
  accent: Paint
  you: Paint
  agent: Paint
  infinite: Paint
  inverse: Paint
}

const wrap = (open: string, close: string): Paint => (text) => (text ? `${ESC}${open}m${text}${ESC}${close}m` : text)

export function makeStyles(enabled: boolean): Styles {
  if (!enabled) {
    const id: Paint = (text) => text
    return { enabled, bold: id, dim: id, ok: id, warn: id, bad: id, info: id, accent: id, you: id, agent: id, infinite: id, inverse: id }
  }
  return {
    enabled,
    bold: wrap("1", "22"),
    dim: wrap("2", "22"),
    ok: wrap("32", "39"),
    warn: wrap("33", "39"),
    bad: wrap("31", "39"),
    info: wrap("36", "39"),
    accent: wrap("35", "39"),
    you: wrap("33", "39"),
    agent: wrap("35", "39"),
    infinite: wrap("36", "39"),
    inverse: wrap("7", "27")
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "")
}

function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0x20e3
  )
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

/** Display width of a string with no ANSI sequences in it. */
export function charsWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (isZeroWidth(code)) continue
    width += isWide(code) ? 2 : 1
  }
  return width
}

/** Display width, ignoring ANSI sequences. */
export function visibleWidth(text: string): number {
  return charsWidth(stripAnsi(text))
}

/**
 * Cut a string (which may carry ANSI sequences) to at most `width` columns, adding `…` when it cut. Styling
 * sequences are kept and a reset is appended after a cut so colour never bleeds.
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return ""
  if (visibleWidth(text) <= width) return text
  const target = width - 1
  let out = ""
  let used = 0
  let index = 0
  let sawAnsi = false
  while (index < text.length) {
    ANSI_PATTERN.lastIndex = index
    const match = ANSI_PATTERN.exec(text)
    if (match && match.index === index) {
      out += match[0]
      sawAnsi = true
      index += match[0].length
      continue
    }
    const code = text.codePointAt(index) ?? 0
    const char = String.fromCodePoint(code)
    const w = isZeroWidth(code) ? 0 : isWide(code) ? 2 : 1
    if (used + w > target) break
    out += char
    used += w
    index += char.length
  }
  return `${out}…${sawAnsi ? SEQ.reset : ""}`
}

/** Pad (with spaces) or cut to exactly `width` columns. */
export function fit(text: string, width: number): string {
  const cut = truncate(text, width)
  const pad = width - visibleWidth(cut)
  return pad > 0 ? cut + " ".repeat(pad) : cut
}

/** Word-wrap plain text (no ANSI) to `width` columns; long words are hard-cut. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return []
  const lines: string[] = []
  for (const paragraph of text.split("\n")) {
    let line = ""
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let rest = word
      while (charsWidth(rest) > width) {
        if (line) {
          lines.push(line)
          line = ""
        }
        let head = ""
        for (const char of rest) {
          if (charsWidth(head + char) > width) break
          head += char
        }
        lines.push(head)
        rest = rest.slice(head.length)
      }
      if (!rest) continue
      if (!line) line = rest
      else if (charsWidth(`${line} ${rest}`) <= width) line = `${line} ${rest}`
      else {
        lines.push(line)
        line = rest
      }
    }
    lines.push(line)
  }
  return lines
}
