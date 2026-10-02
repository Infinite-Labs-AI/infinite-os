// The prompt the WIZARD opens on the controlling terminal itself (`/dev/tty`), for nested-agent mode's
// user-only asks (§3d.7, R2-14): consent mode, conversion names, privacy text, the Meta relay, every line
// that changes an existing tag, teammate comments, uninstall pieces. The parent agent owns stdin and
// stdout; it never sees or answers these. With no controlling terminal this returns null and those asks
// stay unanswered (the run parks NEEDS_ANSWERS: "run npx infinite-tag --resume in your own terminal").
import { closeSync, createReadStream, createWriteStream, openSync } from "node:fs"
import { createInterface } from "node:readline"

import { ASK_CANCELLED, type AskAnswer, type AskKind, type AskPayloads, type PlanLine } from "./contracts/asks.js"
import type { TtyPrompter } from "./asks.js"
import { cleanEventText } from "./events.js"

const PROMPT_MAX = 300

export function openDevTtyPrompter(path = "/dev/tty"): TtyPrompter | null {
  let fd: number
  try {
    fd = openSync(path, "r+")
  } catch {
    return null
  }
  const input = createReadStream("", { fd, autoClose: false })
  const output = createWriteStream("", { fd, autoClose: false })
  const rl = createInterface({ input, output, terminal: false })
  const question = (text: string) => new Promise<string>((resolve) => rl.question(text, (answer) => resolve(answer.trim())))
  const say = (text: string) => output.write(`${cleanEventText(text, PROMPT_MAX)}\n`)
  const yes = (answer: string) => /^y(es)?$/i.test(answer)

  return {
    async planLine(line: PlanLine) {
      say(`infinite-tag needs your answer (your agent cannot give it): ${line.text}`)
      if (line.kind === "consent_mode") {
        const answer = await question("Consent for this site: [c] collect by default, [a] ask first (consent required), [enter] skip: ")
        if (/^c/i.test(answer)) return { approved: true, edit: "not_required" }
        if (/^a/i.test(answer)) return { approved: true, edit: "required" }
        return null
      }
      if (line.kind === "conversion_names") {
        const answer = await question("Conversion names, comma separated (enter to skip): ")
        return answer === "" ? null : { approved: true, edit: answer }
      }
      const answer = await question("Approve this line? [y/N] ")
      return answer === "" ? null : { approved: yes(answer) }
    },
    async ask<K extends AskKind>(kind: K, payload: AskPayloads[K]): Promise<AskAnswer<K>> {
      if (kind === "confirm") {
        const p = payload as AskPayloads["confirm"]
        const answer = await question(`${cleanEventText(p.question, PROMPT_MAX)} ${p.defaultYes ? "[Y/n]" : "[y/N]"} `)
        return (answer === "" ? p.defaultYes : yes(answer)) as AskAnswer<K>
      }
      if (kind === "single") {
        const p = payload as AskPayloads["single"]
        say(p.question)
        p.options.forEach((option, index) => say(`  ${index + 1}. ${option.label}`))
        const answer = await question("Pick a number (enter for the default): ")
        const index = Number.parseInt(answer, 10) - 1
        const value = answer === "" ? p.default : p.options[index]?.value
        return (value ?? ASK_CANCELLED) as AskAnswer<K>
      }
      if (kind === "teammate-comments") {
        const p = payload as AskPayloads["teammate-comments"]
        p.comments.forEach((comment, index) => say(`  ${index + 1}. ${comment.author} on ${comment.path}: ${comment.excerpt}`))
        const answer = await question("Act on which comments? Numbers, comma separated (enter for none): ")
        const picked = answer
          .split(",")
          .map((part) => Number.parseInt(part.trim(), 10) - 1)
          .filter((index) => index >= 0 && index < p.comments.length)
        return { actOn: picked.map((index) => p.comments[index]!.threadId) } as AskAnswer<K>
      }
      return ASK_CANCELLED as AskAnswer<K>
    },
    close() {
      rl.close()
      try {
        closeSync(fd)
      } catch {
        // Already closed.
      }
    }
  }
}
