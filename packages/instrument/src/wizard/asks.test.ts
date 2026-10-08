import { describe, expect, it } from "vitest"

import { ASK_TIMEOUT, PLAN_LINE_KINDS, YES_POLICY, type AskKind, type AskPayloads, type PlanLine } from "./contracts/asks.js"
import type { WizardOptions } from "./contracts/deps.js"
import { defaultOptions } from "../../test/wizard/runtime-fakes.js"
import {
  YesPolicyViolation,
  approveUnderYes,
  createWizardAsks,
  parseAnswersFile,
  yesPlanAnswer,
  type AnswersFile,
  type TtyPrompter
} from "./asks.js"
import { WizardEventEmitter } from "./events.js"
import { WizardStore } from "./store.js"

const line = (id: string, kind: PlanLine["kind"], extra: Partial<PlanLine> = {}): PlanLine => ({
  id,
  kind,
  text: `${kind} line`,
  requires: kind === "user_action" ? "user_action" : "approval",
  editable: false,
  ...extra
})

const PLAN_LINES: PlanLine[] = [
  line("L1", "install_provider"),
  line("L2", "server_lane"),
  line("L3", "npm_install"),
  line("L4", "preview_guard_managed"),
  line("L5", "agent_budget"),
  line("L6", "improve_additive", { ownership: "managed" }),
  line("L7", "improve_additive", { ownership: "adopted" }),
  line("L8", "consent_mode", { editable: true }),
  line("L9", "conversion_names", { editable: true }),
  line("L10", "privacy_text"),
  line("L11", "remove_duplicate"),
  line("L12", "preview_guard_adopted"),
  line("L13", "autoconfig_off_adopted"),
  line("L14", "sensitive_pages"),
  line("L15", "posthog_defaults_bump_adopted"),
  line("L16", "capture_beside_adopted_pixel"),
  line("L17", "retire_fbc_writer"),
  line("L18", "meta_relay"),
  line("L19", "meta_goal"),
  line("L20", "user_action")
]

const PLAN: AskPayloads["plan"] = {
  lines: PLAN_LINES,
  decisions: { consentMode: null, conversionNames: [], privacyText: null, npmInstall: null }
}

function setup(options: Partial<WizardOptions>, answers: AnswersFile | null = null, ttyPrompter: TtyPrompter | null = null) {
  const store = new WizardStore({ displayId: "r-7f3c", tagVersion: "0.12.0" })
  const emitter = new WizardEventEmitter({ store })
  const asks = createWizardAsks({ store, emitter, options: defaultOptions(options), answers, ttyPrompter })
  return { store, asks }
}

const NEVER_LINES = ["L8", "L9", "L10", "L18"]

describe("--yes (§3d.4 YES_POLICY)", () => {
  it("approves exactly the yes-lines and leaves every never-line unanswered", async () => {
    const { store, asks } = setup({ yes: true })
    const answer = await asks.ask("plan", PLAN)
    expect(store.getSnapshot().pendingAsk).toBeNull()
    expect(answer).toEqual({ approved: ["L1", "L2", "L4", "L6", "L7", "L11", "L12", "L13", "L14", "L15", "L16", "L17"], declined: [], edits: {} })
    for (const id of NEVER_LINES) expect(JSON.stringify(answer)).not.toContain(`"${id}"`)
    expect(PLAN_LINE_KINDS.every((kind) => kind in YES_POLICY)).toBe(true)
  })

  it("a forced --yes approval of a human decision throws; repository improvements are included", () => {
    expect(() => approveUnderYes(line("x", "conversion_names"))).toThrow(YesPolicyViolation)
    expect(() => approveUnderYes(line("x", "privacy_text"))).toThrow(YesPolicyViolation)
    expect(approveUnderYes(line("x", "improve_additive", { ownership: "adopted" }))).toBe("x")
    expect(approveUnderYes(line("x", "improve_additive"))).toBe("x")
    expect(approveUnderYes(line("x", "install_provider"))).toBe("x")
  })

  it("the consent line is answered only by --consent-mode (the user's explicit flag), never by --yes alone", () => {
    expect(yesPlanAnswer(PLAN_LINES, null).approved).not.toContain("L8")
    const withFlag = yesPlanAnswer(PLAN_LINES, "required")
    expect(withFlag.approved).toContain("L8")
    expect(withFlag.edits).toEqual({ L8: "required" })
  })

  it("answers no other ask: the GA4 stream choice, teammate comments, agent questions, start-fresh and uninstall asks all close __timeout__ (one negative each)", async () => {
    const { store, asks } = setup({ yes: true, json: true })
    const cases: Array<[AskKind, unknown]> = [
      ["single", { question: "Which GA4 stream is this site?", options: [{ label: "web", value: "G-1" }, { label: "app", value: "G-2" }] }],
      ["teammate-comments", { comments: [{ threadId: "t1", author: "ana", path: "a.ts", line: 1, excerpt: "rename this" }] }],
      ["agent-questions", { questions: [{ itemId: "server_conversions:signup", question: "Is /api/signup the success path?", why: "two routes" }] }]
    ]
    for (const [kind, payload] of cases) {
      const answer = await asks.ask(kind, payload as never)
      expect(answer, kind).toBe(ASK_TIMEOUT)
      expect(store.getSnapshot().pendingAsk).toBeNull()
    }
    await expect(asks.askUserOnly("confirm", { question: "Start fresh?", defaultYes: true })).resolves.toBe(ASK_TIMEOUT)
    await expect(asks.askUserOnly("single", { question: "Remove the server-lane settings now?", options: [], default: "after_merge" })).resolves.toBe(ASK_TIMEOUT)
  })
})

describe("explicit cost and account approvals", () => {
  const lines = ["agent_budget", "npm_install", "account_settings"].map(kind => line(kind, kind as PlanLine["kind"]))
  const payload: AskPayloads["plan"] = { ...PLAN, lines }

  it("--yes leaves API spend, package installs and account changes unanswered", async () => {
    const { asks } = setup({ yes: true })
    await expect(asks.ask("plan", payload)).resolves.toEqual({ approved: [], declined: [], edits: {} })
    for (const item of lines) expect(() => approveUnderYes(item)).toThrow(YesPolicyViolation)
  })

  it("nested --yes and an answers file cannot opt into those actions without the user's own tty", async () => {
    const { asks } = setup({ yes: true, nested: true }, { v: 1, plan: { approved: lines.map(item => item.id) } })
    await expect(asks.ask("plan", payload)).resolves.toBe(ASK_TIMEOUT)
  })
})

describe("--answers <file>", () => {
  it("is strict: an unknown key, a wrong version or a wrong type is an error (negative)", () => {
    expect(() => parseAnswersFile(JSON.stringify({ v: 1, consent: "required" }))).toThrow(/unknown key/)
    expect(() => parseAnswersFile(JSON.stringify({ v: 2 }))).toThrow(/"v": 1/)
    expect(() => parseAnswersFile(JSON.stringify({ v: 1, consentMode: "maybe" }))).toThrow(/consentMode/)
    expect(() => parseAnswersFile("{")).toThrow(/not valid JSON/)
  })
})

describe("nested mode (§3d.7): user-only asks stay human", () => {
  const nestedAnswers: AnswersFile = {
    v: 1,
    plan: { approved: ["L1", "L11", "L18"] },
    consentMode: "required",
    conversionNames: ["signup"],
    privacyText: true
  }

  it("an answers file carrying consentMode / conversion names / privacy / changes to existing tags is IGNORED for those lines", async () => {
    const { asks } = setup({ nested: true, json: true }, nestedAnswers)
    const answer = (await asks.ask("plan", PLAN)) as { approved: string[]; declined: string[]; edits: Record<string, string> }
    expect(answer.approved).toEqual(["L1", "L11"])
    expect(answer.edits).toEqual({})
    for (const id of ["L8", "L9", "L10", "L18"]) expect(answer.approved).not.toContain(id)
  })

  it("teammate comments never come from the file; every other ask is answered from it or not at all", async () => {
    const file: AnswersFile = { v: 1, asks: [{ kind: "teammate-comments", answer: { actOn: ["t1"] } }, { kind: "merge-ready", answer: "later" }] }
    const { asks } = setup({ nested: true, json: true }, file)
    await expect(asks.ask("teammate-comments", { comments: [] })).resolves.toBe(ASK_TIMEOUT)
    await expect(asks.ask("merge-ready", { prUrl: "u", number: 1, summary: "s" })).resolves.toBe("later")
    await expect(asks.ask("single", { question: "Which stream?", options: [] })).resolves.toBe(ASK_TIMEOUT)
  })
})

it("explicit file refusals beat shorthand consent and package answers", async () => {
  const { asks } = setup({ yes: true }, { v: 1, plan: { declined: ["L8", "L3"] }, consentMode: "not_required", npmInstall: true })
  const answer = await asks.ask("plan", PLAN)
  expect(answer).toMatchObject({ declined: ["L8", "L3"] })
  expect((answer as { approved: string[] }).approved).not.toContain("L8")
  expect((answer as { approved: string[] }).approved).not.toContain("L3")
})
