// `plan` (§3d.3): the one plan screen. It shows the user's four decisions (consent mode, conversion names,
// privacy text, the npm-install line) and every plan line. Lines that need approval start ticked (ENTER
// approves the plan as shown); SPACE skips a line ("that job is skipped"); E edits an editable line (the
// consent line flips between its two values, the others take text). ESC leaves it for later (the run parks).
//
// The consent mode is never assumed: when the plan has a consent line and no value was chosen, ENTER moves to
// it and asks for a choice instead of answering.
//
// Reading before approving (final verify F1b, F11):
// - every line can be read in full at any terminal size. A short terminal drops the "Your decisions" summary
//   (each decision is also a plan line) and gives its rows to the lines; a line taller than the room scrolls by
//   its wrapped ROWS (↓ reads on, ↑ goes back);
// - ENTER never approves a line that was not on screen. While a line that needs the user (an approval line or
//   a thing only they can do) has not been shown in full, ENTER shows the next unread lines and says how many
//   are left; ENTER approves once every one was shown. The overlay learns what was on screen from the box size
//   the TTY UI passes to `onKey` (the same `OverlayContext` the frame drew with), and marks ONLY that screen:
//   the screen after a key is drawn in a box measured for the new state, which can be a row shorter (final
//   verify F18), so it is marked on the next key, once it was drawn.
// - the box keeps its height while the plan scrolls (F19): the body takes every row it was given, so a notice
//   or a shorter window never shrinks the box and brings the step list back above it.
import { ASK_CANCELLED, type AskPayloads, type PlanLine } from "../../wizard/contracts/asks.js"
import { wrapAnsi } from "../ansi.js"
import type { Key } from "../keys.js"
import { editBuffer, inputLine } from "./text.js"
import type { KeyOutcome, Overlay, OverlayContext, OverlayView } from "./types.js"
import { OVERLAY_TEXT_CAPS } from "./types.js"

export interface PlanState {
  cursor: number
  /** Per approval line: false = skipped. Absent = approved (the plan as shown). */
  skipped: string[]
  edits: Record<string, string>
  editing: { lineId: string; buffer: string } | null
  notice: string | null
  /** Ids of the plan lines that were on screen in full. */
  seen: string[]
  /** For a line taller than the room: the first wrapped row shown (0 = the line's start). */
  lineScroll: number
  /** For a line taller than the room: how many of its rows were read so far, from its start. */
  readRows: Record<string, number>
}

const CONSENT_VALUES = ["not_required", "required"] as const
const CONSENT_LABEL: Record<string, string> = {
  not_required: "collect by default (covers Infinite only)",
  required: "wait for consent (your banner decides; Infinite never changes it)"
}
const EDIT_MAX = 2000

type PlanPayload = AskPayloads["plan"]

function consentLine(payload: PlanPayload): PlanLine | undefined {
  return payload.lines.find((line) => line.kind === "consent_mode")
}

function consentValue(payload: PlanPayload, state: PlanState): string | null {
  const line = consentLine(payload)
  if (line && state.edits[line.id] !== undefined) return state.edits[line.id] ?? null
  return payload.decisions.consentMode
}

function decisionsView(payload: PlanPayload, state: PlanState, ctx: OverlayContext): string[] {
  const s = ctx.styles
  const consent = consentValue(payload, state)
  const conversionsLine = payload.lines.find((line) => line.kind === "conversion_names")
  const conversions =
    conversionsLine && state.edits[conversionsLine.id] !== undefined
      ? (state.edits[conversionsLine.id] ?? "")
      : payload.decisions.conversionNames.join(" · ")
  const privacyLine = payload.lines.find((line) => line.kind === "privacy_text")
  const privacy = privacyLine && state.edits[privacyLine.id] !== undefined ? state.edits[privacyLine.id] : payload.decisions.privacyText
  const privacyShown = privacy ? `${privacy.split("\n").filter((l) => l.trim()).length} drafted lines for your privacy page` : "—"
  const npm = payload.decisions.npmInstall ? ctx.sanitize(payload.decisions.npmInstall, OVERLAY_TEXT_CAPS.line) : "—"
  return [
    s.bold("Your decisions"),
    ...[
      `· Consent: ${consent ? (CONSENT_LABEL[consent] ?? consent) : s.you("— choose it (E on the consent line)")}`,
      `· Conversions: ${conversions ? ctx.sanitize(conversions, OVERLAY_TEXT_CAPS.line) : "—"}`,
      `· Privacy: ${privacyShown}`,
      `· npm: ${npm}`
    ].flatMap((line) => wrapAnsi(line, ctx.width, 2))
  ]
}

function lineMark(line: PlanLine, state: PlanState, ctx: OverlayContext): string {
  const s = ctx.styles
  if (line.requires === "approval") return state.skipped.includes(line.id) ? s.dim("[ ]") : s.ok("[✓]")
  if (line.requires === "user_action") return s.you(" → ")
  return s.dim(" · ")
}

function lineText(line: PlanLine, state: PlanState, ctx: OverlayContext): string {
  let text = ctx.sanitize(line.text, OVERLAY_TEXT_CAPS.line)
  if (line.measured) text += ctx.styles.dim(` (${ctx.sanitize(String(line.measured.value), 40)} · ${ctx.sanitize(line.measured.window, 40)})`)
  const edit = state.edits[line.id]
  // The consent line's edit is one of two values: the marker says it in words (never the stored value).
  if (edit !== undefined && line.kind === "consent_mode") text += ctx.styles.info(` → chosen: ${CONSENT_LABEL[edit] ?? ctx.sanitize(edit, OVERLAY_TEXT_CAPS.label)}`)
  else if (edit !== undefined && line.kind !== "privacy_text") text += ctx.styles.info(` → ${ctx.sanitize(edit, OVERLAY_TEXT_CAPS.label)}`)
  return text
}

/** "▸ [✓] " : the columns before a plan line's text; a wrapped line continues under the text. */
const ROW_PREFIX_WIDTH = 6

/**
 * One plan line as screen rows: the FULL text, wrapped under a hanging indent (final verify F1: a plan line is
 * never cut, because the user approves what the line says).
 */
function lineRows(line: PlanLine, index: number, state: PlanState, ctx: OverlayContext): string[] {
  const s = ctx.styles
  const pointer = index === state.cursor ? s.accent("▸") : " "
  const body = `${pointer} ${lineMark(line, state, ctx)} ${lineText(line, state, ctx)}`
  return wrapAnsi(index === state.cursor ? s.bold(body) : body, ctx.width, ROW_PREFIX_WIDTH)
}

/**
 * The plan lines that fit `room` rows, as whole lines around the cursor (a line is shown in full or not at all).
 * The cursor's line is always in the window; a cursor line taller than the room is drawn by `layout` instead.
 */
function windowRows(rows: readonly string[][], cursor: number, room: number): { start: number; end: number } {
  const height = (from: number, to: number) => rows.slice(from, to).reduce((sum, row) => sum + row.length, 0)
  if (height(0, rows.length) <= room) return { start: 0, end: rows.length }
  let start = Math.max(0, Math.min(cursor, rows.length - 1))
  let end = start + 1
  // Grow down first (the next lines to read), then up, while whole lines still fit.
  for (;;) {
    if (end < rows.length && height(start, end + 1) <= room) end += 1
    else if (start > 0 && height(start - 1, end) <= room) start -= 1
    else break
  }
  return { start, end }
}

/** With the summary on screen the plan list keeps at least this many rows; below that the summary goes. */
const MIN_LIST_ROWS = 8

interface PlanLayout {
  /** True when every plan line is on screen at once. */
  fits: boolean
  /** The "Your decisions" summary and the list's own heading (empty on a short terminal). */
  top: string[]
  footer: string[]
  /** Rows the plan lines may use. */
  room: number
  /** The plan lines on screen: `start` to `end` (exclusive). */
  start: number
  end: number
  /** Set when the cursor's line is taller than the room: the slice of its wrapped rows on screen. */
  tall: { from: number; to: number; height: number } | null
  rows: string[][]
}

function footerRows(payload: PlanPayload, state: PlanState, ctx: OverlayContext, compact: boolean): string[] {
  const s = ctx.styles
  const gap = compact ? [] : [""]
  const footer: string[] = []
  if (state.editing) {
    const line = payload.lines.find((candidate) => candidate.id === state.editing?.lineId)
    footer.push(...gap, s.bold(`Editing: ${line ? ctx.sanitize(line.text, OVERLAY_TEXT_CAPS.label) : ""}`), inputLine(state.editing.buffer, ctx.width))
  }
  if (state.notice) footer.push(...gap, ...wrapAnsi(s.you(state.notice), ctx.width))
  return footer
}

/** Where everything sits for this state and box size. `render` draws it; `onKey` reads what was on screen from it. */
function layout(payload: PlanPayload, state: PlanState, ctx: OverlayContext): PlanLayout {
  const rows = payload.lines.map((line, index) => lineRows(line, index, state, ctx))
  const total = rows.reduce((sum, row) => sum + row.length, 0)
  const tallest = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const top = [...decisionsView(payload, state, ctx), "", ctx.styles.bold("The plan")]
  const footer = footerRows(payload, state, ctx, false)
  const withSummary = ctx.maxBodyLines - top.length - footer.length
  if (total <= withSummary) return { fits: true, top, footer, room: withSummary, start: 0, end: rows.length, tall: null, rows }
  // The plan scrolls: two rows are kept for the "more above / more below" lines.
  let room = withSummary - 2
  let shownTop = top
  let shownFooter = footer
  if (room < Math.max(MIN_LIST_ROWS, tallest)) {
    // A short terminal: the lines the user approves get the rows.
    shownTop = []
    shownFooter = footerRows(payload, state, ctx, true)
    room = Math.max(1, ctx.maxBodyLines - shownFooter.length - 2)
  }
  const cursor = Math.max(0, Math.min(state.cursor, rows.length - 1))
  const cursorHeight = rows[cursor]?.length ?? 0
  if (cursorHeight > room) {
    const from = Math.max(0, Math.min(state.lineScroll, cursorHeight - room))
    return { fits: false, top: shownTop, footer: shownFooter, room, start: cursor, end: cursor + 1, tall: { from, to: from + room, height: cursorHeight }, rows }
  }
  return { fits: false, top: shownTop, footer: shownFooter, room, ...windowRows(rows, cursor, room), tall: null, rows }
}

/** The state after the user was shown this screen: the lines on it in full are `seen`. */
function observe(payload: PlanPayload, state: PlanState, ctx: OverlayContext): PlanState {
  const at = layout(payload, state, ctx)
  const seen = new Set(state.seen)
  let readRows = state.readRows
  if (at.tall) {
    const id = payload.lines[at.start]?.id
    if (id !== undefined) {
      const read = readRows[id] ?? 0
      // Rows count as read only in order from the line's start (a jump past unread rows reads nothing).
      const now = at.tall.from <= read ? Math.max(read, at.tall.to) : read
      if (now !== read) readRows = { ...readRows, [id]: now }
      if (now >= at.tall.height) seen.add(id)
    }
  } else {
    for (const line of payload.lines.slice(at.start, at.end)) seen.add(line.id)
  }
  if (seen.size === state.seen.length && readRows === state.readRows) return state
  return { ...state, seen: [...seen], readRows }
}

/** A line needs the user when they approve it or must do it themselves; a plain note does not. */
function unseenLines(payload: PlanPayload, state: PlanState): PlanLine[] {
  return payload.lines.filter((line) => line.requires !== "info" && !state.seen.includes(line.id))
}

function render(payload: PlanPayload, state: PlanState, ctx: OverlayContext): OverlayView {
  const s = ctx.styles
  const at = layout(payload, state, ctx)
  const count = payload.lines.length
  const lines = (n: number) => `${n} more line${n === 1 ? "" : "s"}`
  const above = at.tall && at.tall.from > 0 ? `↑ this line starts above (↑ to go back)${at.start > 0 ? ` · ${lines(at.start)} above` : ""}` : at.start > 0 ? `↑ ${lines(at.start)} above (↑ to read ${at.start === 1 ? "it" : "them"})` : null
  const below =
    at.tall && at.tall.to < at.tall.height
      ? `↓ this line continues (↓ to read on)${count - at.end > 0 ? ` · ${lines(count - at.end)} below` : ""}`
      : at.end < count
        ? `↓ ${lines(count - at.end)} below (↓ to read ${count - at.end === 1 ? "it" : "them"})`
        : null
  const shown = at.tall ? (at.rows[at.start] ?? []).slice(at.tall.from, at.tall.to) : at.rows.slice(at.start, at.end).flat()
  const rows = [...(above ? [s.dim(`      ${above}`)] : []), ...shown, ...(below ? [s.dim(`      ${below}`)] : [])]
  // F19: a scrolling plan holds the box at the rows it was given (blank rows above the footer), so the box does
  // not jump by a few rows on every key at 80 × 24.
  const used = at.top.length + rows.length + at.footer.length
  const hold = at.fits ? [] : Array.from({ length: Math.max(0, ctx.maxBodyLines - used) }, () => "")
  const counts = countLines(payload)
  // What ENTER does next: it approves only when every line that needs the user was on screen (this one counts).
  const unread = unseenLines(payload, observe(payload, state, ctx)).length
  const position = at.end - at.start === 1 ? `line ${at.start + 1} of ${count}` : `lines ${at.start + 1}–${at.end} of ${count}`
  return {
    heading: at.fits ? "The plan (one screen)" : `The plan · ${position}`,
    question: `Approve the plan: ${counts.approval} lines to approve${counts.action ? ` · ${counts.action} ${counts.action === 1 ? "thing" : "things"} only you can do` : ""}.`,
    body: [...at.top, ...rows, ...hold, ...at.footer],
    keys: state.editing
      ? ["ENTER save", "ESC stop editing"]
      : [unread > 0 ? "ENTER read on" : "ENTER approve", "SPACE skip a line", "E edit a line", "↑↓ move", "ESC later"]
  }
}

function countLines(payload: PlanPayload): { approval: number; action: number } {
  return {
    approval: payload.lines.filter((line) => line.requires === "approval").length,
    action: payload.lines.filter((line) => line.requires === "user_action").length
  }
}

function initialEdit(payload: PlanPayload, state: PlanState, line: PlanLine): string {
  const existing = state.edits[line.id]
  if (existing !== undefined) return existing
  if (line.kind === "conversion_names") return payload.decisions.conversionNames.join(", ")
  if (line.kind === "privacy_text") return payload.decisions.privacyText ?? ""
  return ""
}

/** ↑/↓ inside a line taller than the room: the next (or previous) rows of it; null when the cursor should move on. */
function scrollInLine(payload: PlanPayload, state: PlanState, ctx: OverlayContext | undefined, direction: 1 | -1): PlanState | null {
  if (!ctx) return null
  const at = layout(payload, state, ctx)
  if (!at.tall) return null
  const last = at.tall.height - at.room
  if (direction === 1 && at.tall.from < last) return { ...state, notice: null, lineScroll: Math.min(last, at.tall.from + at.room) }
  if (direction === -1 && at.tall.from > 0) return { ...state, notice: null, lineScroll: Math.max(0, at.tall.from - at.room) }
  return null
}

/**
 * ENTER while a line that needs the user was never on screen: show the next unread lines and say how many are
 * left. Null when every such line was shown (ENTER then approves).
 */
function readOn(payload: PlanPayload, state: PlanState, ctx: OverlayContext): PlanState | null {
  const first = unseenLines(payload, state)[0]
  if (!first) return null
  const moved: PlanState = { ...state, cursor: payload.lines.indexOf(first), lineScroll: state.readRows[first.id] ?? 0 }
  const notice = (left: number) =>
    left > 0
      ? `${left} more line${left === 1 ? "" : "s"} to read before you approve: ENTER shows the next, ↓ scrolls.`
      : "That is the whole plan. ENTER approves it as shown."
  // The notice takes rows from the list, so what is left is counted with the notice on screen.
  let next: PlanState = { ...moved, notice: notice(payload.lines.length) }
  for (let pass = 0; pass < 2; pass += 1) next = { ...moved, notice: notice(unseenLines(payload, observe(payload, next, ctx)).length) }
  return next
}

function handleKey(payload: PlanPayload, state: PlanState, key: Key, ctx: OverlayContext | undefined): KeyOutcome<"plan", PlanState> {
  const lines = payload.lines
  if (state.editing) {
    const editing = state.editing
    if (key.name === "enter") {
      return { state: { ...state, editing: null, notice: null, edits: { ...state.edits, [editing.lineId]: editing.buffer.trim() } } }
    }
    if (key.name === "escape") return { state: { ...state, editing: null } }
    return { state: { ...state, editing: { ...editing, buffer: editBuffer(editing.buffer, key, EDIT_MAX) } } }
  }
  const current = lines[state.cursor]
  switch (key.name) {
    case "up":
      return { state: scrollInLine(payload, state, ctx, -1) ?? { ...state, notice: null, lineScroll: 0, cursor: lines.length ? (state.cursor - 1 + lines.length) % lines.length : 0 } }
    case "down":
    case "tab":
      return { state: scrollInLine(payload, state, ctx, 1) ?? { ...state, notice: null, lineScroll: 0, cursor: lines.length ? (state.cursor + 1) % lines.length : 0 } }
    case "space": {
      if (!current || current.requires !== "approval") return { state }
      const skipped = state.skipped.includes(current.id) ? state.skipped.filter((id) => id !== current.id) : [...state.skipped, current.id]
      return { state: { ...state, skipped } }
    }
    case "char": {
      if (key.char.toLowerCase() !== "e" || !current) return { state }
      if (current.kind === "consent_mode") {
        const now = consentValue(payload, state)
        const next = now === CONSENT_VALUES[0] ? CONSENT_VALUES[1] : CONSENT_VALUES[0]
        return { state: { ...state, notice: null, edits: { ...state.edits, [current.id]: next } } }
      }
      if (!current.editable) return { state: { ...state, notice: "This line can't be edited; SPACE skips it." } }
      return { state: { ...state, notice: null, editing: { lineId: current.id, buffer: initialEdit(payload, state, current) } } }
    }
    case "enter": {
      const consent = consentLine(payload)
      if (consent && !consentValue(payload, state)) {
        return {
          state: { ...state, cursor: lines.indexOf(consent), lineScroll: 0, notice: "Choose the consent setting first: press E on it." }
        }
      }
      // Never approve a line the user was not shown (F11). Without a box size (a caller that draws nothing)
      // there is no screen to have missed a line on.
      const more = ctx ? readOn(payload, state, ctx) : null
      if (more) return { state: more }
      const approvalLines = lines.filter((line) => line.requires === "approval")
      const approved = approvalLines.filter((line) => !state.skipped.includes(line.id)).map((line) => line.id)
      const declined = approvalLines.filter((line) => state.skipped.includes(line.id)).map((line) => line.id)
      return { state, answer: { approved, declined, edits: { ...state.edits } } }
    }
    case "escape":
      return { state, answer: ASK_CANCELLED }
    default:
      return { state }
  }
}

/**
 * `ctx` is the box the screen BEFORE this key was drawn with: what that screen showed is `seen`. The screen after
 * the key is not marked here: it is drawn in a box measured for the new state (leaving the editor turns one
 * key-hint row into two below about 82 columns, so the box loses a row), and marking it with this box approved a
 * line that was never drawn (final verify F18). It is marked on the next key, which gets the box it was drawn in.
 */
function onKey(payload: PlanPayload, state: PlanState, key: Key, ctx?: OverlayContext): KeyOutcome<"plan", PlanState> {
  if (!ctx) return handleKey(payload, state, key, ctx)
  return handleKey(payload, observe(payload, state, ctx), key, ctx)
}

export const planOverlay: Overlay<"plan", PlanState> = {
  kind: "plan",
  init: () => ({ cursor: 0, skipped: [], edits: {}, editing: null, notice: null, seen: [], lineScroll: 0, readRows: {} }),
  render,
  onKey
}
