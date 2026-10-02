// One frame of the TTY UI, as plain lines (pure: snapshot in, lines out; `tty-ui.ts` diffs and writes them).
//
// Regions (the design's terminal, `infinite-tag-wizard.html` + `src/engine.js`):
// - the header bar: "Infinite setup · infinite-tag <version>" and the run id (+ the runtime variant when it
//   is not `prod`, so a Dev/sandbox run is never mistaken for production);
// - the Learn card (left) beside the 13-row step list (right); below 80 columns the Learn card is dropped;
// - the progress bar ("46% · step 6 of 12");
// - the live region: the status line (or the agent's narration, "Claude Code › …") and the last 5 sub-statuses
//   of the current step ("a little magical, not real-time everything": the store already throttles them);
// - ONE overlay box for the pending ask, in place of the live region;
// - the outro (the before/after text) when the run has one.
// Every store string that can carry outside text (sub-statuses, statuses, narration, the outro, ask payloads)
// goes through the injected sanitiser; step titles and Learn cards are the wizard's own constants.
import { EVENT_LIMITS } from "../wizard/contracts/events.js"
import type { StoreStepRow, WizardStoreSnapshot } from "../wizard/contracts/state.js"
import { WIZARD_STEP_IDS, WIZARD_STEP_META, type Who } from "../wizard/contracts/steps.js"
import { SPINNER_FRAMES, fit, layoutSafeLine, truncate, visibleWidth, wrapAnsi, wrapText, type Styles } from "./ansi.js"
import { STEP_COPY, learnCard, type LearnTone } from "./learn.js"
import type { OverlayContext, OverlayView } from "./overlays/types.js"
import type { UntrustedSanitizer } from "./ui.js"

/** Below this many columns the Learn card is dropped (§O2). */
export const LEARN_MIN_COLUMNS = 80
export const LEARN_WIDTH = 38
const COLUMN_GAP = 3
/** Sub-statuses shown under the status line: 5 on a short terminal, up to all 8 the store keeps on a tall one. */
const FEED_LINES = 5
const FEED_LINES_MAX = 8
/** The status line (or the step's description) wraps instead of being cut, up to this many rows. */
const STATUS_ROWS_MAX = 3
/** A sub-status wraps to at most this many rows (its text is capped at 120 characters). */
const SUB_ROWS_MAX = 2
/**
 * The overlay box uses the terminal's width up to this (a line longer than ~150 columns is hard to read). The
 * old cap of 100 left 20 columns unused at 120 and cut the plan's lines (final verify F1).
 */
const OVERLAY_MAX_WIDTH = 160
const OUTRO_LINE_CAP = 400

export interface FrameInput {
  snapshot: WizardStoreSnapshot
  width: number
  height: number
  styles: Styles
  sanitize: UntrustedSanitizer
  spinnerIndex: number
  /** Draws the pending ask's overlay into a box of the given size; null when there is no visible overlay. */
  overlay: ((ctx: OverlayContext) => OverlayView) | null
  /** The outro text (replaces the step screen when set). */
  outro: string | null
}

const AGENT_LABEL = { claude_code: "Claude Code", codex: "Codex" } as const

function owner(who: readonly Who[]): Who {
  for (const candidate of ["agent", "you", "infinite"] as const) if (who.includes(candidate)) return candidate
  return "code"
}

function chip(who: Who, styles: Styles): string {
  if (who === "agent") return styles.agent("your agent")
  if (who === "you") return styles.you("you")
  if (who === "infinite") return styles.infinite("Infinite")
  return ""
}

function stepMark(row: StoreStepRow, spinner: string, styles: Styles): string {
  switch (row.state) {
    case "ok":
      return styles.ok("■")
    case "skipped":
      return styles.dim("–")
    case "parked":
      return styles.warn("‖")
    case "blocked":
      return styles.warn("!")
    case "failed":
      return styles.bad("✗")
    case "running":
      return styles.accent(spinner)
    default:
      return styles.dim("□")
  }
}

/** Splits a design-style sub ("✓ Approved", "! GA4 twice") into its glyph tone and text. */
function subParts(text: string, tone: StoreStepRow["subs"][number]["tone"]): { tone: typeof tone; text: string } {
  if (text.startsWith("✓ ")) return { tone: "ok", text: text.slice(2) }
  if (text.startsWith("! ")) return { tone: "warn", text: text.slice(2) }
  return { tone, text }
}

function header(input: FrameInput, width: number): string {
  const s = input.styles
  const run = input.snapshot.run
  const left = ` Infinite setup · infinite-tag ${run.tagVersion}`
  const variant = run.runtimeVariant && run.runtimeVariant !== "prod" ? ` · Infinite ${run.runtimeVariant}` : ""
  const right = `run ${run.displayId}${variant} `
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right))
  return s.inverse(fit(`${left}${" ".repeat(gap)}${right}`, width))
}

function taskLines(input: FrameInput, width: number): { rows: string[]; currentIndex: number; progress: string } {
  const { snapshot, styles: s } = input
  const spinner = SPINNER_FRAMES[input.spinnerIndex % SPINNER_FRAMES.length] ?? "⠋"
  const byId = new Map(snapshot.steps.map((row) => [row.id, row]))
  const rows: string[] = []
  let currentIndex = 0
  WIZARD_STEP_IDS.forEach((id, index) => {
    const meta = WIZARD_STEP_META[id]
    const row: StoreStepRow = byId.get(id) ?? { id, title: meta.title, state: "pending", status: null, code: null, subs: [] }
    const isCurrent = snapshot.currentStep === id
    if (isCurrent) currentIndex = index
    const mark = stepMark(row, spinner, s)
    const title = isCurrent ? s.bold(row.title) : row.state === "pending" ? s.dim(row.title) : row.title
    let line = `${mark} ${title}`
    if (isCurrent) {
      const who = chip(owner(meta.who), s)
      if (who) line += `  ${who}`
    }
    if ((row.state === "parked" || row.state === "blocked" || row.state === "failed") && row.status) {
      line += s.dim(` · ${input.sanitize(row.status, EVENT_LIMITS.statusTextMaxChars)}`)
    }
    rows.push(truncate(line, width))
  })
  const finished = snapshot.steps.filter((row) => row.state !== "pending" && row.state !== "running").length
  const total = WIZARD_STEP_IDS.length
  const pct = Math.round((Math.min(finished, total) / total) * 100)
  const barWidth = Math.max(10, Math.min(40, width - 24))
  const filled = Math.round((pct / 100) * barWidth)
  const bar = s.accent("━".repeat(filled)) + s.dim("─".repeat(barWidth - filled))
  const stepN = snapshot.currentStep ? WIZARD_STEP_META[snapshot.currentStep].n : finished >= total ? total - 1 : 0
  return { rows, currentIndex, progress: truncate(`${bar} ${pct}% · step ${stepN} of ${total - 1}`, width) }
}

function learnLines(input: FrameInput, width: number): string[] {
  const s = input.styles
  const learnId = input.snapshot.learn ?? (input.snapshot.currentStep ? WIZARD_STEP_META[input.snapshot.currentStep].learn : "link")
  const card = learnCard(learnId, input.snapshot.learnFacts, (text) => input.sanitize(text, 60))
  const lines = [
    s.dim("Learn"),
    ...wrapText(card.title, width).map((line) => s.bold(line)),
    ...wrapText(card.sub, width).map((line) => s.dim(line))
  ]
  const paint = (tone: LearnTone, text: string) => (tone === "g" ? s.ok(text) : tone === "y" ? s.you(text) : tone === "i" ? s.info(text) : text)
  for (const [label, value, tone] of card.rows) {
    const room = width - visibleWidth(label) - 2
    if (visibleWidth(value) <= room) {
      const dots = s.dim(" " + "·".repeat(Math.max(0, room - visibleWidth(value) - 1)) + " ")
      lines.push(`${label}${dots}${paint(tone, value)}`)
    } else {
      lines.push(label)
      for (const part of wrapText(value, width - 2)) lines.push(`  ${paint(tone, part)}`)
    }
  }
  return lines
}

/** Wraps one live line; a line that still does not fit its rows ends in "…" (never the case for capped store text at 60+ columns). */
function wrapRows(line: string, width: number, hangingIndent: number, maxRows: number): string[] {
  const rows = wrapAnsi(line, width, hangingIndent)
  if (rows.length <= maxRows) return rows
  const kept = rows.slice(0, maxRows)
  kept[maxRows - 1] = truncate(`${kept[maxRows - 1]} …`, width)
  return kept
}

function liveLines(input: FrameInput, width: number, feedLines: number = FEED_LINES): string[] {
  const { snapshot, styles: s, sanitize } = input
  const spinner = SPINNER_FRAMES[input.spinnerIndex % SPINNER_FRAMES.length] ?? "⠋"
  const lastStarted = [...snapshot.steps].reverse().find((row) => row.state !== "pending")
  const row = snapshot.steps.find((candidate) => candidate.id === snapshot.currentStep) ?? lastStarted
  if (!row) return [s.dim("◆ Starting…")]
  const meta = WIZARD_STEP_META[row.id]
  const lines: string[] = []
  const narration = snapshot.narration[snapshot.narration.length - 1]
  if (row.state === "running" && meta.who.includes("agent") && narration) {
    lines.push(...wrapRows(`${s.agent(`${AGENT_LABEL[narration.agent]} ›`)} ${sanitize(narration.text, EVENT_LIMITS.narrateTextMaxChars)}`, width, 2, STATUS_ROWS_MAX))
  } else if (row.status) {
    lines.push(...wrapRows(`${s.accent("◆")} ${sanitize(row.status, EVENT_LIMITS.statusTextMaxChars)}`, width, 2, STATUS_ROWS_MAX))
  } else {
    lines.push(...wrapRows(`${s.accent("◆")} ${s.dim(STEP_COPY[row.id].what)}`, width, 2, STATUS_ROWS_MAX))
  }
  const subs = row.subs.slice(-feedLines)
  subs.forEach((sub, index) => {
    const parts = subParts(sanitize(sub.text, EVENT_LIMITS.subTextMaxChars), sub.tone)
    const isLast = index === subs.length - 1
    const glyph =
      parts.tone === "ok"
        ? s.ok("✓")
        : parts.tone === "warn"
          ? s.warn("!")
          : parts.tone === "pending" && isLast && row.state === "running"
            ? s.accent(spinner)
            : s.dim("·")
    lines.push(...wrapRows(`  ${glyph} ${parts.text}`, width, 4, SUB_ROWS_MAX))
  })
  return lines
}

function overlayBox(input: FrameInput, width: number, maxBodyLines: number): string[] {
  if (!input.overlay) return []
  const s = input.styles
  const boxWidth = Math.min(width, OVERLAY_MAX_WIDTH)
  const inner = Math.max(10, boxWidth - 4)
  const spinner = SPINNER_FRAMES[input.spinnerIndex % SPINNER_FRAMES.length] ?? "⠋"
  const view = input.overlay({ width: inner, maxBodyLines, styles: s, sanitize: input.sanitize, spinner })
  const step = input.snapshot.currentStep ? WIZARD_STEP_META[input.snapshot.currentStep].title : "infinite-tag"
  const content: string[] = [
    s.accent(`◆ ${step}`),
    // The box title is the step's title; an overlay whose heading says the same words does not say them twice.
    ...(view.heading && view.heading !== step ? [s.dim(view.heading)] : []),
    ...wrapText(view.question, inner).map((line) => s.bold(line)),
    "",
    // Nothing in a question box is cut: a body line wider than the box wraps (styled or not), under its own indent.
    ...view.body.flatMap((line) => (visibleWidth(line) > inner ? wrapAnsi(line, inner, leadingSpaces(line)) : [line])),
    ...(view.keys.length > 0 ? ["", ...keyRows(view.keys, inner, s)] : [])
  ]
  const top = s.dim(`╭${"─".repeat(boxWidth - 2)}╮`)
  const bottom = s.dim(`╰${"─".repeat(boxWidth - 2)}╯`)
  const side = s.dim("│")
  return [top, ...content.map((line) => `${side} ${fit(line, inner)} ${side}`), bottom]
}

function leadingSpaces(line: string): number {
  // eslint-disable-next-line no-control-regex
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "")
  return plain.length - plain.trimStart().length
}

/** The key hints, on as many rows as they need (a hint is never split or cut). */
function keyRows(keys: readonly string[], width: number, s: Styles): string[] {
  const separator = "  ·  "
  const rows: string[] = []
  let row = ""
  let rowWidth = 0
  for (const hint of keys) {
    const [key, ...rest] = hint.split(" ")
    const hintWidth = visibleWidth(hint)
    if (row && rowWidth + separator.length + hintWidth > width) {
      rows.push(row)
      row = ""
      rowWidth = 0
    }
    row += `${row ? s.dim(separator) : ""}${s.bold(key ?? "")} ${rest.join(" ")}`
    rowWidth += (rowWidth > 0 ? separator.length : 0) + hintWidth
  }
  if (row) rows.push(row)
  return rows
}

/**
 * The closing screen: the verdict, the before/after text and the keys. The keys are always on screen: when the
 * text is taller than the terminal, what fits is shown and one line says the rest follows when the view closes
 * (`TtyUi.stop` prints the whole text into scrollback).
 */
function outroLines(input: FrameInput, width: number, maxLines: number, outro: string): string[] {
  const s = input.styles
  // The outro is the wizard's own report table: keep its column padding (never the whitespace-collapsing
  // untrusted-text sanitiser), only strip what could drive the terminal. A line wider than the screen wraps.
  const lines = outro.split("\n").flatMap((line) => {
    const safe = layoutSafeLine(line, OUTRO_LINE_CAP)
    return visibleWidth(safe) > width ? wrapAnsi(safe, width, leadingSpaces(safe) + 2) : [safe]
  })
  const keys = `${s.bold("ENTER")} close  ${s.dim("·")}  ${s.bold("Q")} quit`
  const room = Math.max(1, maxLines - 2)
  if (lines.length <= room) return [...lines, "", keys]
  const more = lines.length - (room - 1)
  return [...lines.slice(0, room - 1), s.dim(`… ${more} more line${more === 1 ? "" : "s"}: the full table stays in your terminal when you close this`), "", keys]
}

/** The full frame: exactly `height` lines or fewer, each at most `width - 1` columns. */
export function renderFrame(input: FrameInput): string[] {
  const width = Math.max(20, input.width)
  const height = Math.max(8, input.height)
  const inner = width - 2
  const pad = (line: string) => ` ${fit(line, inner)}`
  const out: string[] = [header(input, width - 1), ""]

  if (input.outro !== null) {
    for (const line of outroLines(input, inner, height - out.length, input.outro)) out.push(pad(line))
    return out.slice(0, height)
  }

  const showLearn = width >= LEARN_MIN_COLUMNS
  const tasksWidth = showLearn ? inner - LEARN_WIDTH - COLUMN_GAP : inner
  const tasks = taskLines(input, tasksWidth)
  const taskColumn = [input.styles.dim("Tasks"), ...tasks.rows, "", tasks.progress]
  const learnColumn = showLearn ? learnLines(input, LEARN_WIDTH) : []
  const footer = input.styles.dim("Ctrl+C stop")

  // The overlay gets what is left after the header, the footer and a compact step list.
  let body: string[]
  let lower: string[]
  if (input.overlay) {
    const compactTasks = 4
    const chrome = 8
    // A tall terminal gives the box its rows (the plan shows every line at once when they fit).
    const maxBodyLines = Math.max(3, Math.min(60, height - out.length - 2 - compactTasks - chrome))
    lower = overlayBox(input, inner, maxBodyLines)
  } else {
    // The full step list needs its rows first; what is left over (5 to 8) goes to the sub-statuses.
    const spare = height - out.length - Math.max(taskColumn.length, learnColumn.length) - 2 - STATUS_ROWS_MAX
    lower = liveLines(input, inner, Math.max(FEED_LINES, Math.min(FEED_LINES_MAX, spare)))
  }
  // Rows left for the step list after the header, a blank line, the live region / overlay and the footer.
  const room = height - out.length - 1 - lower.length - 1
  const columnHeight = Math.max(taskColumn.length, learnColumn.length)
  if (columnHeight <= room) {
    body = zipColumns(taskColumn, learnColumn, tasksWidth)
  } else if (room >= 2) {
    // Not enough rows: keep the steps around the current one, then the progress line.
    const keep = room - 1
    const start = Math.max(0, Math.min(tasks.currentIndex - Math.floor(keep / 2), tasks.rows.length - keep))
    const windowed = tasks.rows.slice(start, start + keep)
    body = zipColumns([...windowed, tasks.progress], showLearn ? learnColumn.slice(0, keep + 1) : [], tasksWidth)
  } else {
    // A very short terminal: the overlay (the question) wins over the step list.
    body = room === 1 ? [tasks.progress] : []
  }
  for (const line of body) out.push(pad(line))
  if (body.length > 0) out.push("")
  for (const line of lower) out.push(pad(line))
  out.push(pad(footer))
  return out.slice(0, height)
}

function zipColumns(tasks: string[], learn: string[], tasksWidth: number): string[] {
  if (learn.length === 0) return tasks
  const rows = Math.max(tasks.length, learn.length)
  const lines: string[] = []
  for (let index = 0; index < rows; index++) {
    lines.push(`${fit(learn[index] ?? "", LEARN_WIDTH)}${" ".repeat(COLUMN_GAP)}${fit(tasks[index] ?? "", tasksWidth)}`)
  }
  return lines
}
