// The wizard's asks (§3d.3, §3d.4, §3d.7): one `ask(kind, payload)` every step uses, the `YES_POLICY`
// enforcement, `--answers <file>`, batching of agent questions, and the nested-agent rule that
// user-only asks stay human.
//
// The rules, in order of precedence:
// - NESTED mode (§3d.7, R2-14): an `--answers` file never satisfies a user-only item (consent mode,
//   conversion names, account writes, packages, API budgets, `meta_relay`, teammate
//   comments, uninstall pieces, "start fresh?"). Those are asked only through a prompt the wizard opens on
//   /dev/tty itself; with no controlling terminal they stay unanswered and the step parks NEEDS_ANSWERS.
//   Every other nested ask is answered from the answers file, or not at all (exit 3, resumable).
// - `--yes` (§3d.4, R2-15) answers NO ask except a `plan` line whose kind YES_POLICY marks yes. Every other
//   ask closes `__timeout__` at once (the step parks or blocks its jobs). `--yes` never approves a "never"
//   line: `approveUnderYes` throws if anything tries.
// - An `--answers` file (outside nested mode) answers what it names.
// - Otherwise the ask opens in the store and the UI answers it.
import { readFileSync } from "node:fs"
import { isContinuedWork } from "../install/plan-permission.js"

import {
  ASK_CANCELLED,
  ASK_KINDS,
  ASK_TIMEOUT,
  YES_ASK_POLICY,
  isNestedUserOnly,
  yesApproves,
  type AskAnswer,
  type AskAnswers,
  type AskKind,
  type AskPayloads,
  type PlanLine
} from "./contracts/asks.js"
import type { AskFn, WizardOptions } from "./contracts/deps.js"
import type { WizardEventEmitter } from "./events.js"
import type { WizardStore } from "./store.js"

// ---------------------------------------------------------------------------------------------
// `--answers <file>`
// ---------------------------------------------------------------------------------------------

export const ANSWERS_FILE_VERSION = 1 as const

/**
 * The `--answers` file. Plan line ids come from the plan screen (`ask.open` in --json mode prints them);
 * `consentMode` / `conversionNames` / `privacyText` / `npmInstall` answer the plan's decision lines by kind
 * (their ids are not known in advance). `asks` answers any other ask by kind, optionally only when its
 * question contains `match`.
 */
export interface AnswersFile {
  v: typeof ANSWERS_FILE_VERSION
  plan?: { approved?: string[]; declined?: string[]; edits?: Record<string, string> }
  consentMode?: "not_required" | "required"
  conversionNames?: string[]
  privacyText?: boolean
  npmInstall?: boolean
  asks?: Array<{ kind: AskKind; match?: string; answer: unknown }>
}

const ANSWERS_FILE_KEYS = new Set(["v", "plan", "consentMode", "conversionNames", "privacyText", "npmInstall", "asks"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

/** Strict: an unknown key, a wrong type or another version is an error (a typo must never silently answer nothing). */
export function parseAnswersFile(text: string): AnswersFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`The answers file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed)) throw new Error("The answers file must be a JSON object.")
  for (const key of Object.keys(parsed)) {
    if (!ANSWERS_FILE_KEYS.has(key)) throw new Error(`The answers file has an unknown key ${JSON.stringify(key)}.`)
  }
  if (parsed.v !== ANSWERS_FILE_VERSION) throw new Error(`The answers file must carry "v": ${ANSWERS_FILE_VERSION}.`)
  const out: AnswersFile = { v: ANSWERS_FILE_VERSION }
  if (parsed.plan !== undefined) {
    const plan = parsed.plan
    if (!isRecord(plan)) throw new Error("answers.plan must be an object.")
    for (const key of Object.keys(plan)) {
      if (!["approved", "declined", "edits"].includes(key)) throw new Error(`answers.plan has an unknown key ${JSON.stringify(key)}.`)
    }
    if (plan.approved !== undefined && !isStringArray(plan.approved)) throw new Error("answers.plan.approved must be a list of line ids.")
    if (plan.declined !== undefined && !isStringArray(plan.declined)) throw new Error("answers.plan.declined must be a list of line ids.")
    if (plan.edits !== undefined && (!isRecord(plan.edits) || !Object.values(plan.edits).every((v) => typeof v === "string"))) {
      throw new Error("answers.plan.edits must map line ids to strings.")
    }
    out.plan = {
      ...(plan.approved ? { approved: plan.approved as string[] } : {}),
      ...(plan.declined ? { declined: plan.declined as string[] } : {}),
      ...(plan.edits ? { edits: plan.edits as Record<string, string> } : {})
    }
  }
  if (parsed.consentMode !== undefined) {
    if (parsed.consentMode !== "not_required" && parsed.consentMode !== "required") {
      throw new Error('answers.consentMode must be "not_required" or "required".')
    }
    out.consentMode = parsed.consentMode
  }
  if (parsed.conversionNames !== undefined) {
    if (!isStringArray(parsed.conversionNames)) throw new Error("answers.conversionNames must be a list of names.")
    out.conversionNames = parsed.conversionNames
  }
  for (const key of ["privacyText", "npmInstall"] as const) {
    if (parsed[key] !== undefined) {
      if (typeof parsed[key] !== "boolean") throw new Error(`answers.${key} must be true or false.`)
      out[key] = parsed[key] as boolean
    }
  }
  if (parsed.asks !== undefined) {
    if (!Array.isArray(parsed.asks)) throw new Error("answers.asks must be a list.")
    out.asks = parsed.asks.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`answers.asks[${index}] must be an object.`)
      for (const key of Object.keys(entry)) {
        if (!["kind", "match", "answer"].includes(key)) throw new Error(`answers.asks[${index}] has an unknown key ${JSON.stringify(key)}.`)
      }
      if (typeof entry.kind !== "string" || !(ASK_KINDS as readonly string[]).includes(entry.kind)) {
        throw new Error(`answers.asks[${index}].kind is not an ask kind.`)
      }
      if (entry.match !== undefined && typeof entry.match !== "string") throw new Error(`answers.asks[${index}].match must be a string.`)
      if (!("answer" in entry)) throw new Error(`answers.asks[${index}] has no answer.`)
      return { kind: entry.kind as AskKind, ...(entry.match !== undefined ? { match: entry.match as string } : {}), answer: entry.answer }
    })
  }
  return out
}

export function readAnswersFile(path: string): AnswersFile {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    throw new Error(`Cannot read the answers file ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseAnswersFile(text)
}

// ---------------------------------------------------------------------------------------------
// `--yes`
// ---------------------------------------------------------------------------------------------

export class YesPolicyViolation extends Error {
  constructor(line: Pick<PlanLine, "id" | "kind">) {
    super(`--yes cannot approve the plan line ${JSON.stringify(line.id)} (${line.kind}): only you can.`)
    this.name = "YesPolicyViolation"
  }
}

/** The one place `--yes` approves a line. Throws for every kind YES_POLICY marks "never". */
export function approveUnderYes(line: Pick<PlanLine, "id" | "kind" | "ownership">): string {
  if (!yesApproves(line)) throw new YesPolicyViolation(line)
  return line.id
}

/**
 * The plan answer `--yes` gives: every yes-line approved, nothing declined, every "never" line left
 * unanswered (the plan step blocks its jobs, or parks when the consent mode is missing). `--consent-mode`
 * is the user's own explicit answer to the consent line, not a `--yes` approval.
 */
export function yesPlanAnswer(lines: readonly PlanLine[], consentMode: WizardOptions["consentMode"]): AskAnswers["plan"] {
  const approved: string[] = []
  const edits: Record<string, string> = {}
  for (const line of lines) {
    if (line.kind === "consent_mode") {
      if (consentMode) {
        approved.push(line.id)
        edits[line.id] = consentMode
      }
      continue
    }
    if (line.requires !== "approval") continue
    if (yesApproves(line)) approved.push(approveUnderYes(line))
  }
  return { approved, declined: [], edits }
}

// ---------------------------------------------------------------------------------------------
// The prompter the wizard opens on /dev/tty itself (nested mode's user-only asks)
// ---------------------------------------------------------------------------------------------

/** A prompt the WIZARD opens on the controlling terminal (never the parent agent's stdin). */
export interface TtyPrompter {
  /** Shows the complete plan, including repository work and owner handoffs, before decision prompts. */
  showPlan(payload: AskPayloads["plan"]): Promise<void>
  /** Asks one plan line ("Approve: <text>? [y/N]"); consent and names lines take the typed value. */
  planLine(line: PlanLine): Promise<{ approved: boolean; edit?: string } | null>
  ask<K extends AskKind>(kind: K, payload: AskPayloads[K]): Promise<AskAnswer<K>>
  close(): void
}

// ---------------------------------------------------------------------------------------------
// The ask function
// ---------------------------------------------------------------------------------------------

export interface WizardAsksOptions {
  store: WizardStore
  emitter: WizardEventEmitter
  options: WizardOptions
  answers: AnswersFile | null
  /** Null when there is no controlling terminal (or not nested). */
  ttyPrompter: TtyPrompter | null
  signal?: AbortSignal
}

export interface WizardAsks {
  /** `ctx.ask` for every step. */
  ask: AskFn
  /**
   * For the asks that are ALWAYS the user's (uninstall pieces, "start fresh?"): never `--yes`, never an
   * answers file in nested mode.
   */
  askUserOnly: AskFn
  /** One `agent-questions` ask for a whole turn's questions (§3f.4). */
  askAgentQuestions(questions: AskPayloads["agent-questions"]["questions"]): Promise<AskAnswer<"agent-questions">>
}

function questionOf(payload: unknown): string {
  return isRecord(payload) && typeof payload.question === "string" ? payload.question : ""
}

function fileAnswer(answers: AnswersFile | null, kind: AskKind, payload: unknown): { found: boolean; answer: unknown } {
  const question = questionOf(payload)
  const entry = answers?.asks?.find((candidate) => candidate.kind === kind && (candidate.match === undefined || question.includes(candidate.match)))
  return entry ? { found: true, answer: entry.answer } : { found: false, answer: undefined }
}

/** The answers file's plan answer, with the decision keys mapped onto their lines. */
export function planAnswerFromFile(lines: readonly PlanLine[], answers: AnswersFile): AskAnswers["plan"] | null {
  const known = new Set(lines.map((line) => line.id))
  const approved = new Set((answers.plan?.approved ?? []).filter((id) => known.has(id)))
  const declined = new Set((answers.plan?.declined ?? []).filter((id) => known.has(id)))
  const edits: Record<string, string> = {}
  for (const [id, value] of Object.entries(answers.plan?.edits ?? {})) if (known.has(id)) edits[id] = value
  const byKind = (kind: PlanLine["kind"]) => lines.filter((line) => line.kind === kind)
  if (answers.consentMode) {
    for (const line of byKind("consent_mode")) {
      approved.add(line.id)
      declined.delete(line.id)
      edits[line.id] = answers.consentMode
    }
  }
  if (answers.conversionNames) {
    for (const line of byKind("conversion_names")) {
      approved.add(line.id)
      declined.delete(line.id)
      edits[line.id] = answers.conversionNames.join(",")
    }
  }
  for (const [key, kind] of [["privacyText", "privacy_text"], ["npmInstall", "npm_install"]] as const) {
    const value = answers[key]
    if (value === undefined) continue
    for (const line of byKind(kind)) {
      if (value) {
        approved.add(line.id)
        declined.delete(line.id)
      } else {
        declined.add(line.id)
        approved.delete(line.id)
      }
    }
  }
  // Shorthand values do not erase an explicit refusal in the same answer file.
  for (const id of answers.plan?.declined ?? []) {
    if (!known.has(id)) continue
    declined.add(id)
    approved.delete(id)
    delete edits[id]
  }
  if (approved.size === 0 && declined.size === 0 && Object.keys(edits).length === 0) return null
  return { approved: [...approved], declined: [...declined], edits }
}

/** Removes user-only approvals and edits; a refusal is always binding, including in nested mode. */
export function withoutUserOnlyLines(lines: readonly PlanLine[], answer: AskAnswers["plan"]): AskAnswers["plan"] {
  const userOnly = new Set(lines.filter((line) => isNestedUserOnly(line)).map((line) => line.id))
  const edits: Record<string, string> = {}
  for (const [id, value] of Object.entries(answer.edits)) if (!userOnly.has(id)) edits[id] = value
  return {
    approved: answer.approved.filter((id) => !userOnly.has(id)),
    declined: [...answer.declined],
    edits
  }
}

function mergePlanAnswers(base: AskAnswers["plan"], over: AskAnswers["plan"]): AskAnswers["plan"] {
  const approved = new Set(base.approved)
  const declined = new Set(base.declined)
  for (const id of over.approved) {
    approved.add(id)
    declined.delete(id)
  }
  for (const id of over.declined) {
    declined.add(id)
    approved.delete(id)
  }
  return { approved: [...approved], declined: [...declined], edits: { ...base.edits, ...over.edits } }
}

type AskOptions = NonNullable<Parameters<AskFn>[2]>

export function createWizardAsks(input: WizardAsksOptions): WizardAsks {
  const { store, emitter, options, answers, ttyPrompter, signal } = input
  let counter = 0
  const nextId = () => `ask_${(++counter).toString().padStart(3, "0")}`

  /** Records an ask that was answered without the UI (file, `--yes`, nested tty) so the event log shows it. */
  const announce = <K extends AskKind>(kind: K, payload: AskPayloads[K], answer: unknown): AskAnswer<K> => {
    const askId = nextId()
    emitter.emit("ask.open", { askId, kind, payload })
    emitter.emit("ask.closed", { askId, answer })
    return answer as AskAnswer<K>
  }

  /**
   * Opens the ask in the store. It closes on an answer, on its timeout (`__timeout__`), on the run's
   * signal or on the ASK's own signal (`__cancelled__`): a display-only ask (`link-code`) has no answer,
   * so the step that opened it closes it with that signal, and the next ask can open.
   */
  const openInStore = async <K extends AskKind>(kind: K, payload: AskPayloads[K], askOptions?: AskOptions): Promise<AskAnswer<K>> => {
    const own = askOptions?.signal
    if (signal?.aborted || own?.aborted) return announce(kind, payload, ASK_CANCELLED)
    const askId = nextId()
    const opened = store.openAsk(kind, payload, askId)
    emitter.emit("ask.open", { askId, kind, payload })
    let timer: ReturnType<typeof setTimeout> | null = null
    const onAbort = () => store.cancelAsk(askId)
    signal?.addEventListener("abort", onAbort, { once: true })
    own?.addEventListener("abort", onAbort, { once: true })
    const timeoutMs = askOptions?.timeoutMs
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => store.answerAsk(askId, ASK_TIMEOUT), timeoutMs)
    }
    try {
      const answer = await opened.answer
      emitter.emit("ask.closed", { askId, answer })
      return answer as AskAnswer<K>
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      own?.removeEventListener("abort", onAbort)
    }
  }

  const nestedPlan = async (payload: AskPayloads["plan"]): Promise<AskAnswer<"plan">> => {
    const fromFile = answers ? planAnswerFromFile(payload.lines, answers) : null
    let answer: AskAnswers["plan"] = fromFile ? withoutUserOnlyLines(payload.lines, fromFile) : { approved: [], declined: [], edits: {} }
    if (options.yes) answer = mergePlanAnswers(withoutUserOnlyLines(payload.lines, yesPlanAnswer(payload.lines, null)), answer)
    // The user-only lines: only through the wizard's own /dev/tty prompt, never the file.
    if (ttyPrompter) {
      await ttyPrompter.showPlan(payload)
      for (const line of payload.lines) {
        if (!isNestedUserOnly(line) || line.requires !== "approval") continue
        const reply = await ttyPrompter.planLine(line)
        if (!reply) continue
        answer = mergePlanAnswers(answer, {
          approved: reply.approved ? [line.id] : [],
          declined: reply.approved ? [] : [line.id],
          edits: reply.edit !== undefined ? { [line.id]: reply.edit } : {}
        })
      }
    }
    const anything = answer.approved.length + answer.declined.length + Object.keys(answer.edits).length > 0
    return announce("plan", payload, anything || payload.lines.some(isContinuedWork) ? answer : ASK_TIMEOUT)
  }

  const ask = (async <K extends AskKind>(kind: K, payload: AskPayloads[K], askOptions?: AskOptions): Promise<AskAnswer<K>> => {
    if (options.nested) {
      if (kind === "plan") return (await nestedPlan(payload as AskPayloads["plan"])) as AskAnswer<K>
      if (kind === "teammate-comments") return userOnly(kind, payload)
      if (kind === "link-code" || kind === "tty-handover") return openInStore(kind, payload, askOptions)
      const found = fileAnswer(answers, kind, payload)
      return announce(kind, payload, found.found ? found.answer : ASK_TIMEOUT)
    }
    if (options.yes) {
      if (kind === "plan") {
        const plan = payload as AskPayloads["plan"]
        let answer = yesPlanAnswer(plan.lines, options.consentMode)
        const fromFile = answers ? planAnswerFromFile(plan.lines, answers) : null
        if (fromFile) answer = mergePlanAnswers(answer, fromFile)
        return announce(kind, payload, answer)
      }
      if (YES_ASK_POLICY[kind] === "never") {
        const found = fileAnswer(answers, kind, payload)
        return announce(kind, payload, found.found ? found.answer : ASK_TIMEOUT)
      }
      return openInStore(kind, payload, askOptions)
    }
    if (answers) {
      if (kind === "plan") {
        const fromFile = planAnswerFromFile((payload as AskPayloads["plan"]).lines, answers)
        if (fromFile) return announce(kind, payload, fromFile)
      } else {
        const found = fileAnswer(answers, kind, payload)
        if (found.found) return announce(kind, payload, found.answer)
      }
    }
    if (kind === "plan" && options.consentMode) {
      const plan = payload as AskPayloads["plan"]
      if (plan.decisions.consentMode === null) {
        return openInStore(kind, { ...plan, decisions: { ...plan.decisions, consentMode: options.consentMode } } as AskPayloads[K], askOptions)
      }
    }
    return openInStore(kind, payload, askOptions)
  }) as AskFn

  /** Always the user's: never `--yes`, never an answers file in nested mode; the UI or the wizard's own tty. */
  const userOnly = async <K extends AskKind>(kind: K, payload: AskPayloads[K], askOptions?: AskOptions): Promise<AskAnswer<K>> => {
    if (options.nested) {
      if (!ttyPrompter) return announce(kind, payload, ASK_TIMEOUT)
      return announce(kind, payload, await ttyPrompter.ask(kind, payload))
    }
    if (options.yes && !options.json) {
      // An attended terminal: the user is there, so ask; --yes still answers nothing here.
      return openInStore(kind, payload, askOptions)
    }
    if (options.yes) return announce(kind, payload, ASK_TIMEOUT)
    if (answers) {
      const found = fileAnswer(answers, kind, payload)
      if (found.found) return announce(kind, payload, found.answer)
    }
    return openInStore(kind, payload, askOptions)
  }

  return {
    ask,
    askUserOnly: userOnly as AskFn,
    askAgentQuestions: (questions) => ask("agent-questions", { questions })
  }
}
