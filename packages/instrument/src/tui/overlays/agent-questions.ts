// `agent-questions` (§3d.3): the agent's questions, batched once per turn, asked one after the other. Every
// question, reason and option label is agent text, so all of it goes through the sanitiser.
import { ASK_CANCELLED } from "../../wizard/contracts/asks.js"
import { editBuffer, inputLine } from "./text.js"
import type { Overlay } from "./types.js"
import { OVERLAY_TEXT_CAPS, selectRow, windowAround } from "./types.js"

export interface AgentQuestionsState {
  index: number
  answers: Record<string, string>
  cursor: number
  buffer: string
}

const ANSWER_MAX = 500

export const agentQuestionsOverlay: Overlay<"agent-questions", AgentQuestionsState> = {
  kind: "agent-questions",
  init: () => ({ index: 0, answers: {}, cursor: 0, buffer: "" }),
  render(payload, state, ctx) {
    const s = ctx.styles
    const question = payload.questions[state.index]
    if (!question) return { heading: "Your agent asks", question: "", body: [], keys: [] }
    const body = [s.dim(`Why: ${ctx.sanitize(question.why, OVERLAY_TEXT_CAPS.question)}`), ""]
    if (question.options && question.options.length > 0) {
      const room = Math.max(1, ctx.maxBodyLines - body.length)
      const { start, end } = windowAround(question.options, state.cursor, room)
      for (let index = start; index < end; index++) {
        const option = question.options[index]
        if (option) body.push(selectRow(ctx.sanitize(option.label, OVERLAY_TEXT_CAPS.option), index === state.cursor, s))
      }
    } else {
      body.push(inputLine(state.buffer, ctx.width))
    }
    return {
      heading: `Your agent asks · question ${state.index + 1} of ${payload.questions.length}`,
      question: ctx.sanitize(question.question, OVERLAY_TEXT_CAPS.question),
      body,
      keys: question.options && question.options.length > 0 ? ["ENTER answer", "↑↓ move", "ESC later"] : ["ENTER answer", "ESC later"]
    }
  },
  onKey(payload, state, key) {
    const question = payload.questions[state.index]
    if (!question) return { state, answer: { answers: { ...state.answers } } }
    if (key.name === "escape") return { state, answer: ASK_CANCELLED }
    const options = question.options ?? []
    if (options.length > 0) {
      if (key.name === "up") return { state: { ...state, cursor: (state.cursor - 1 + options.length) % options.length } }
      if (key.name === "down" || key.name === "tab") return { state: { ...state, cursor: (state.cursor + 1) % options.length } }
    }
    if (key.name === "enter") {
      const value = options.length > 0 ? options[state.cursor]?.value : state.buffer.trim()
      if (value === undefined || value === "") return { state }
      const answers = { ...state.answers, [question.itemId]: value }
      if (state.index + 1 >= payload.questions.length) return { state: { ...state, answers }, answer: { answers } }
      return { state: { index: state.index + 1, answers, cursor: 0, buffer: "" } }
    }
    if (options.length === 0) return { state: { ...state, buffer: editBuffer(state.buffer, key, ANSWER_MAX) } }
    return { state }
  }
}
