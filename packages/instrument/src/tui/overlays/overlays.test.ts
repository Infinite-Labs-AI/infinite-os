import { describe, expect, it } from "vitest"

import { makeTestSanitizer } from "../../../test/wizard/fake-store.js"
import type { AskKind, AskPayloads, PlanLine } from "../../wizard/contracts/asks.js"
import { ASK_KINDS } from "../../wizard/contracts/asks.js"
import { makeStyles, stripAnsi } from "../ansi.js"
import { parseKeys, type Key } from "../keys.js"
import { OVERLAYS, answered } from "./index.js"
import type { OverlayContext } from "./types.js"

function ctx(sanitize = makeTestSanitizer()): OverlayContext {
  return { width: 80, maxBodyLines: 20, styles: makeStyles(false), sanitize, spinner: "⠋" }
}

/** Feed keys to an overlay; returns the answer (or undefined) and the final state. */
function drive<K extends AskKind>(kind: K, payload: AskPayloads[K], input: string): { answer: unknown; state: unknown; done: boolean } {
  const overlay = OVERLAYS[kind]
  let state = overlay.init(payload as never)
  for (const key of parseKeys(input)) {
    const outcome = overlay.onKey(payload as never, state as never, key as Key)
    state = outcome.state
    if (answered(outcome)) return { answer: outcome.answer, state, done: true }
  }
  return { answer: undefined, state, done: false }
}

const DOWN = "\x1b[B"
const UP = "\x1b[A"
const ENTER = "\r"
const ESC = "\x1b"

describe("overlays", () => {
  it("has one overlay per ask kind", () => {
    expect(Object.keys(OVERLAYS).sort()).toEqual([...ASK_KINDS].sort())
  })

  it("single: arrows move, ENTER chooses, ESC cancels; the default is highlighted, never auto-chosen", () => {
    const payload = { question: "Which?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" }], default: "b" }
    expect(drive("single", payload, ENTER).answer).toBe("b")
    expect(drive("single", payload, DOWN + ENTER).answer).toBe("c")
    expect(drive("single", payload, UP + UP + ENTER).answer).toBe("c")
    expect(drive("single", payload, ESC).answer).toBe("__cancelled__")
    expect(drive("single", payload, DOWN).done).toBe(false)
  })

  it("confirm: Y / N / ENTER default", () => {
    expect(drive("confirm", { question: "Try again?", defaultYes: true }, ENTER).answer).toBe(true)
    expect(drive("confirm", { question: "Try again?", defaultYes: false }, ENTER).answer).toBe(false)
    expect(drive("confirm", { question: "Try again?", defaultYes: false }, "y").answer).toBe(true)
    expect(drive("confirm", { question: "Try again?", defaultYes: true }, "\x1b[C" + ENTER).answer).toBe(false)
  })

  it("multi: SPACE ticks, ENTER returns the ticked values in option order", () => {
    const payload = { question: "Which?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" }] }
    expect(drive("multi", payload, DOWN + DOWN + " " + UP + UP + " " + ENTER).answer).toEqual(["a", "c"])
    expect(drive("multi", payload, ENTER).answer).toEqual([])
  })

  it("text: typing, backspace, maxLength", () => {
    expect(drive("text", { question: "Name?", maxLength: 5 }, "abcdefg" + ENTER).answer).toBe("abcde")
    expect(drive("text", { question: "Name?", maxLength: 10 }, "abc\x7f" + ENTER).answer).toBe("ab")
  })

  it("merge-ready: ENTER open, ESC later", () => {
    const payload = { prUrl: "https://github.com/acme/acme-store/pull/42", number: 42, summary: "Reviewed by Codex · rehearsal passed." }
    expect(drive("merge-ready", payload, ENTER).answer).toBe("open")
    expect(drive("merge-ready", payload, ESC).answer).toBe("later")
    expect(stripAnsi(OVERLAYS["merge-ready"].render(payload, {}, ctx()).question)).toContain("Pull request #42 is ready")
  })

  it("teammate comments start unticked (nothing acted on without the user's OK)", () => {
    const payload = {
      comments: [
        { threadId: "t1", author: "sam", path: "app/layout.tsx", line: 14, excerpt: "please keep gtag" },
        { threadId: "t2", author: "ana", path: "README.md", line: null, excerpt: "nit" }
      ]
    }
    expect(drive("teammate-comments", payload, ENTER).answer).toEqual({ actOn: [] })
    expect(drive("teammate-comments", payload, DOWN + " " + ENTER).answer).toEqual({ actOn: ["t2"] })
  })

  it("agent questions and teammate excerpts go through the sanitiser", () => {
    const sanitize = makeTestSanitizer()
    const questions = {
      questions: [{ itemId: "job8", question: "Which route? \x1b[2J‮evil", why: "two candidates \x1b[31m", options: [{ label: "app/api/signup \x1b[1m", value: "a" }] }]
    }
    const view = OVERLAYS["agent-questions"].render(questions, OVERLAYS["agent-questions"].init(questions), ctx(sanitize))
    const all = [view.question, ...view.body].join("\n")
    expect(all).not.toContain("\x1b[2J")
    expect(all).not.toContain("‮")
    expect(sanitize.calls.some((call) => call.includes("Which route?"))).toBe(true)
    expect(sanitize.calls.some((call) => call.includes("two candidates"))).toBe(true)
    expect(sanitize.calls.some((call) => call.includes("app/api/signup"))).toBe(true)

    const comments = { comments: [{ threadId: "t1", author: "mallory\x1b]0;x\x07", path: "a.ts", line: 1, excerpt: "\x1b[2Jwipe" }] }
    const commentView = OVERLAYS["teammate-comments"].render(comments, OVERLAYS["teammate-comments"].init(comments), ctx(sanitize))
    expect(commentView.body.join("\n")).not.toContain("\x1b[2J")
    expect(sanitize.calls.some((call) => call.includes("wipe"))).toBe(true)
  })

  it("agent questions: one after the other, options or text", () => {
    const payload = {
      questions: [
        { itemId: "job8", question: "Which route creates the user?", why: "two candidates", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] },
        { itemId: "job9", question: "What is the user id field?", why: "not found" }
      ]
    }
    expect(drive("agent-questions", payload, DOWN + ENTER + "userId" + ENTER).answer).toEqual({ answers: { job8: "b", job9: "userId" } })
    expect(drive("agent-questions", payload, ESC).answer).toBe("__cancelled__")
    // An empty text answer is not accepted.
    expect(drive("agent-questions", payload, ENTER + ENTER).done).toBe(false)
  })
})

describe("plan overlay", () => {
  const lines: PlanLine[] = [
    { id: "install_provider:infinite", kind: "install_provider", text: "Install the Infinite pixel", requires: "approval", editable: false },
    { id: "consent_mode", kind: "consent_mode", text: "Consent setting", requires: "approval", editable: true },
    { id: "conversion_names", kind: "conversion_names", text: "Conversion names", requires: "approval", editable: true },
    { id: "remove_duplicate:ga4_gtag", kind: "remove_duplicate", text: "Remove the hand-written gtag (GTM fires the same ID)", requires: "approval", editable: false, measured: { value: "2 page views per visit", window: "dry load" } },
    { id: "user_action:connect_ga4", kind: "user_action", text: "Connect GA4 in Infinite", requires: "user_action", editable: false }
  ]
  const payload = (consentMode: "not_required" | "required" | null): AskPayloads["plan"] => ({
    lines,
    decisions: { consentMode, conversionNames: ["start_trial", "signup"], privacyText: "a\nb", npmInstall: "npm install @vercel/functions" }
  })

  it("ENTER approves every approval line as shown", () => {
    expect(drive("plan", payload("not_required"), ENTER).answer).toEqual({
      approved: ["install_provider:infinite", "consent_mode", "conversion_names", "remove_duplicate:ga4_gtag"],
      declined: [],
      edits: {}
    })
  })

  it("SPACE skips a line (its job is skipped); user_action lines cannot be toggled", () => {
    const answer = drive("plan", payload("not_required"), DOWN + DOWN + DOWN + " " + DOWN + " " + ENTER).answer as { approved: string[]; declined: string[] }
    expect(answer.declined).toEqual(["remove_duplicate:ga4_gtag"])
    expect(answer.approved).not.toContain("remove_duplicate:ga4_gtag")
    expect(answer.approved).not.toContain("user_action:connect_ga4")
  })

  it("never assumes the consent mode: ENTER with no choice moves to it instead of answering (negative)", () => {
    const first = drive("plan", payload(null), ENTER)
    expect(first.done).toBe(false)
    expect((first.state as { notice: string }).notice).toMatch(/consent/i)
    const chosen = drive("plan", payload(null), ENTER + "e" + ENTER)
    expect(chosen.answer).toMatchObject({ edits: { consent_mode: "not_required" } })
    const flipped = drive("plan", payload(null), ENTER + "e" + "e" + ENTER)
    expect(flipped.answer).toMatchObject({ edits: { consent_mode: "required" } })
  })

  it("E edits a text line (conversion names)", () => {
    const answer = drive("plan", payload("not_required"), DOWN + DOWN + "e" + "\x7f".repeat(40) + "purchase, lead" + ENTER + ENTER).answer
    expect(answer).toMatchObject({ edits: { conversion_names: "purchase, lead" } })
  })

  it("renders decisions, measured values and the line marks", () => {
    const view = OVERLAYS.plan.render(payload(null), OVERLAYS.plan.init(payload(null)), ctx())
    // A plan line wider than the box wraps under its text, so the words are compared across rows.
    const text = stripAnsi([view.question, ...view.body].join("\n")).replace(/\n {6}/g, " ")
    expect(text).toContain("Consent: — choose it")
    expect(text).toContain("Conversions: start_trial · signup")
    expect(text).toContain("(2 page views per visit · dry load)")
    expect(text).toContain(" →  Connect GA4 in Infinite")
    expect(text).toContain("4 lines to approve · 1 thing only you can do")
  })
})
