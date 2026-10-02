// `plan` (§3d.3): the one plan screen. It shows the user's four decisions (consent mode, conversion names,
// privacy text, the npm-install line) and every plan line. Lines that need approval start ticked (ENTER
// approves the plan as shown); SPACE skips a line ("that job is skipped"); E edits an editable line (the
// consent line flips between its two values, the others take text). ESC leaves it for later (the run parks).
//
// The consent mode is never assumed: when the plan has a consent line and no value was chosen, ENTER moves to
// it and asks for a choice instead of answering.
import { ASK_CANCELLED, type AskPayloads, type PlanLine } from "../../wizard/contracts/asks.js"
import type { Key } from "../keys.js"
import { editBuffer, inputLine } from "./text.js"
import type { KeyOutcome, Overlay, OverlayContext, OverlayView } from "./types.js"
import { OVERLAY_TEXT_CAPS, windowAround } from "./types.js"

export interface PlanState {
  cursor: number
  /** Per approval line: false = skipped. Absent = approved (the plan as shown). */
  skipped: string[]
  edits: Record<string, string>
  editing: { lineId: string; buffer: string } | null
  notice: string | null
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
    `· Consent: ${consent ? (CONSENT_LABEL[consent] ?? consent) : s.you("— choose it (E on the consent line)")}`,
    `· Conversions: ${conversions ? ctx.sanitize(conversions, OVERLAY_TEXT_CAPS.line) : "—"}`,
    `· Privacy: ${privacyShown}`,
    `· npm: ${npm}`
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
  if (edit !== undefined && line.kind !== "privacy_text") text += ctx.styles.info(` → ${ctx.sanitize(edit, OVERLAY_TEXT_CAPS.label)}`)
  return text
}

function render(payload: PlanPayload, state: PlanState, ctx: OverlayContext): OverlayView {
  const s = ctx.styles
  const decisions = decisionsView(payload, state, ctx)
  const footer: string[] = []
  if (state.editing) {
    const line = payload.lines.find((candidate) => candidate.id === state.editing?.lineId)
    footer.push("", s.bold(`Editing: ${line ? ctx.sanitize(line.text, OVERLAY_TEXT_CAPS.label) : ""}`), inputLine(state.editing.buffer, ctx.width))
  }
  if (state.notice) footer.push("", s.you(state.notice))
  const room = Math.max(1, ctx.maxBodyLines - decisions.length - 2 - footer.length)
  const { start, end } = windowAround(payload.lines, state.cursor, room)
  const rows = payload.lines.slice(start, end).map((line, offset) => {
    const index = start + offset
    const pointer = index === state.cursor ? s.accent("▸") : " "
    const body = `${pointer} ${lineMark(line, state, ctx)} ${lineText(line, state, ctx)}`
    return index === state.cursor ? s.bold(body) : body
  })
  const counts = countLines(payload)
  return {
    heading: "The plan (one screen)",
    question: `Approve the plan: ${counts.approval} lines to approve${counts.action ? ` · ${counts.action} ${counts.action === 1 ? "thing" : "things"} only you can do` : ""}.`,
    body: [...decisions, "", s.bold("The plan"), ...rows, ...footer],
    keys: state.editing
      ? ["ENTER save", "ESC stop editing"]
      : ["ENTER approve", "SPACE skip a line", "E edit a line", "↑↓ move", "ESC later"]
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

function onKey(payload: PlanPayload, state: PlanState, key: Key): KeyOutcome<"plan", PlanState> {
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
      return { state: { ...state, notice: null, cursor: lines.length ? (state.cursor - 1 + lines.length) % lines.length : 0 } }
    case "down":
    case "tab":
      return { state: { ...state, notice: null, cursor: lines.length ? (state.cursor + 1) % lines.length : 0 } }
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
          state: { ...state, cursor: lines.indexOf(consent), notice: "Choose the consent setting first: press E on it." }
        }
      }
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

export const planOverlay: Overlay<"plan", PlanState> = {
  kind: "plan",
  init: () => ({ cursor: 0, skipped: [], edits: {}, editing: null, notice: null }),
  render,
  onKey
}
