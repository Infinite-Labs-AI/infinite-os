// The prompt the WIZARD opens on the controlling terminal itself (`/dev/tty`), for nested-agent mode's
// user-only asks (§3d.7, R2-14): consent mode, conversion names, account writes, packages, API costs,
// the Meta relay, teammate comments, uninstall pieces. The parent agent owns stdin and
// stdout; it never sees or answers these. With no controlling terminal this returns null and those asks
// stay unanswered (the run parks NEEDS_ANSWERS: "run npx infinite-tag --resume in your own terminal").
//
// The terminal is opened only for the length of ONE exchange (a tty stream, so closing it never races a
// pending read): nothing typed into that terminal between prompts is swallowed, and closing the
// prompter with no prompt open leaves nothing behind. An unanswered prompt gives up after
// DEV_TTY_PROMPT_TIMEOUT_MS (the parent agent is waiting on the run).
import { closeSync, openSync } from "node:fs"
import { createInterface } from "node:readline"
import { ReadStream, WriteStream, isatty } from "node:tty"

import { ASK_CANCELLED, ASK_TIMEOUT, type AskAnswer, type AskKind, type AskPayloads, type PlanLine } from "./contracts/asks.js"
import type { TtyPrompter } from "./asks.js"
import { cleanEventText } from "./events.js"

const PROMPT_MAX = 300
/** How long one /dev/tty prompt waits for the user before it gives up (unanswered). */
export const DEV_TTY_PROMPT_TIMEOUT_MS = 10 * 60_000

interface Exchange {
  say(text: string): void
  /** The trimmed answer, or null when the prompt timed out, the terminal closed or the prompter was closed. */
  question(text: string): Promise<string | null>
}

export function openDevTtyPrompter(path = "/dev/tty", options: { timeoutMs?: number } = {}): TtyPrompter | null {
  // Is there a controlling terminal at all? The probe is closed at once; nothing stays open between prompts.
  let probe: number
  try {
    probe = openSync(path, "r+")
  } catch {
    return null
  }
  const usable = isatty(probe)
  closeSync(probe)
  if (!usable) return null
  const timeoutMs = options.timeoutMs ?? DEV_TTY_PROMPT_TIMEOUT_MS
  let closed = false
  let endActive: (() => void) | null = null

  /** Opens the terminal for one exchange and closes it after, whatever happens. */
  const exchange = async <T>(fn: (io: Exchange) => Promise<T>): Promise<T | null> => {
    if (closed) return null
    let readFd: number | null = null
    let writeFd: number | null = null
    try {
      readFd = openSync(path, "r")
      writeFd = openSync(path, "w")
    } catch {
      for (const fd of [readFd, writeFd]) if (fd !== null) closeSync(fd)
      return null
    }
    // tty streams own their fd and close it on destroy() without racing a pending read.
    const input = new ReadStream(readFd)
    const output = new WriteStream(writeFd)
    input.on("error", () => {})
    output.on("error", () => {})
    const rl = createInterface({ input, output, terminal: false })
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      rl.close()
      input.destroy()
      output.destroy()
    }
    endActive = end
    const io: Exchange = {
      say: (text) => {
        output.write(`${cleanEventText(text, PROMPT_MAX)}\n`)
      },
      question: (text) =>
        new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), timeoutMs)
          rl.once("close", () => {
            clearTimeout(timer)
            resolve(null)
          })
          rl.question(text, (answer) => {
            clearTimeout(timer)
            resolve(answer.trim())
          })
        })
    }
    try {
      return await fn(io)
    } finally {
      end()
      if (endActive === end) endActive = null
    }
  }
  const yes = (answer: string) => /^y(es)?$/i.test(answer)

  return {
    async showPlan(payload) {
      await exchange(async io => {
        io.say("The plan (repository work is included unless excluded):")
        for (const line of payload.lines) {
          io.say(`${payload.excluded?.includes(line.id) ? "Excluded: " : ""}${line.id}`)
          // Keep handoff lines intact: the normal prompt cap must not truncate code.
          for (const row of line.text.split("\n")) for (let offset = 0; offset < Math.max(1, row.length); offset += PROMPT_MAX) io.say(row.slice(offset, offset + PROMPT_MAX))
        }
      })
    },
    async planLine(line: PlanLine) {
      const reply = await exchange(async (io) => {
        io.say(`infinite-tag needs your answer (your agent cannot give it): ${line.text}`)
        if (line.kind === "consent_mode") {
          const answer = await io.question("Consent for this site: [c] collect by default, [a] ask first (consent required), [enter] skip: ")
          if (answer && /^c/i.test(answer)) return { approved: true, edit: "not_required" }
          if (answer && /^a/i.test(answer)) return { approved: true, edit: "required" }
          return null
        }
        if (line.kind === "conversion_names") {
          const answer = await io.question("Conversion names, comma separated (enter to skip): ")
          return answer ? { approved: true, edit: answer } : null
        }
        const answer = await io.question("Approve this line? [y/N] ")
        return answer ? { approved: yes(answer) } : null
      })
      return reply ?? null
    },
    async ask<K extends AskKind>(kind: K, payload: AskPayloads[K]): Promise<AskAnswer<K>> {
      const answer = await exchange(async (io): Promise<unknown> => {
        if (kind === "confirm") {
          const p = payload as AskPayloads["confirm"]
          const typed = await io.question(`${cleanEventText(p.question, PROMPT_MAX)} ${p.defaultYes ? "[Y/n]" : "[y/N]"} `)
          if (typed === null) return ASK_TIMEOUT
          return typed === "" ? p.defaultYes : yes(typed)
        }
        if (kind === "single") {
          const p = payload as AskPayloads["single"]
          io.say(p.question)
          p.options.forEach((option, index) => io.say(`  ${index + 1}. ${option.label}`))
          const typed = await io.question("Pick a number (enter for the default): ")
          if (typed === null) return ASK_TIMEOUT
          const index = Number.parseInt(typed, 10) - 1
          return (typed === "" ? p.default : p.options[index]?.value) ?? ASK_CANCELLED
        }
        if (kind === "teammate-comments") {
          const p = payload as AskPayloads["teammate-comments"]
          p.comments.forEach((comment, index) => io.say(`  ${index + 1}. ${comment.author} on ${comment.path}: ${comment.excerpt}`))
          const typed = await io.question("Act on which comments? Numbers, comma separated (enter for none): ")
          if (typed === null) return ASK_TIMEOUT
          const picked = typed
            .split(",")
            .map((part) => Number.parseInt(part.trim(), 10) - 1)
            .filter((index) => index >= 0 && index < p.comments.length)
          return { actOn: picked.map((index) => p.comments[index]!.threadId) }
        }
        return ASK_CANCELLED
      })
      return (answer ?? ASK_TIMEOUT) as AskAnswer<K>
    },
    close() {
      closed = true
      endActive?.()
    }
  }
}
