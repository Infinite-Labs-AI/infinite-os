import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { reverseTextEdits } from "../server-lane/text-edits.js"
import type { WizardDeps } from "../wizard/contracts/deps.js"
import type { ChecklistItem, WizardEditRecord } from "../wizard/contracts/jobs.js"
import type { ManagedTextEdit } from "../types.js"

export interface AttributedEdit {
  edit: WizardEditRecord
  itemIds: string[]
  textEditItems: string[][]
}

export const VERIFIED_JOB_STATES = ["done_in_code", "waiting_deploy", "waiting_real_event", "proven"] as const
export function jobVerified(item: Pick<ChecklistItem, "state">): boolean {
  return (VERIFIED_JOB_STATES as readonly string[]).includes(item.state)
}
export const editHash = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`

/** Replays exact recorded hunks, never searching similar text or keeping an unchecked co-owner's hunk. */
export function settlementPlan(entries: readonly AttributedEdit[], current: ReadonlyMap<string, string | null>, verified: ReadonlySet<string>): {
  files: Map<string, string | null>; kept: AttributedEdit[]; dependent: Set<string>; undone: Set<string>
} {
  const bases = new Map(current)
  for (const { edit } of [...entries].reverse()) {
    const text = bases.get(edit.file)
    if (text === undefined || text === null || editHash(text) !== edit.afterHash) throw new Error(`The recorded edit to ${edit.file} no longer matches; refusing to stage it.`)
    const before = reverseTextEdits(text, edit.textEdits)
    if (edit.beforeHash !== null && editHash(before) !== edit.beforeHash) throw new Error(`The original edit to ${edit.file} no longer matches; refusing to stage it.`)
    bases.set(edit.file, edit.beforeHash === null ? null : before)
  }
  const denied = new Set<string>()
  for (;;) {
    const files = new Map(bases)
    const maps = new Map([...bases].map(([file, text]) => [file, Array.from({ length: (text ?? "").length + 1 }, (_, i) => i)]))
    const kept: AttributedEdit[] = []
    const undone = new Set<string>()
    let retry = false
    for (const entry of entries) {
      const { edit } = entry
      let text = files.get(edit.file) ?? ""
      let map = maps.get(edit.file)!
      const beforeText = text
      const beforeExists = files.get(edit.file) !== null
      const textEdits: ManagedTextEdit[] = []
      const owners: string[][] = []
      let originalShift = 0, keptShift = 0
      for (const [index, hunk] of edit.textEdits.entries()) {
        const ids = entry.textEditItems[index] ?? entry.itemIds
        let keep = ids.length > 0 && ids.every(id => verified.has(id) && !denied.has(id))
        const start = hunk.offset + originalShift, end = start + hunk.removed.length
        const from = map[start]!, to = map[end]!
        const exact = from >= 0 && to >= 0 && to - from === hunk.removed.length &&
          text.slice(from, to) === hunk.removed && map.slice(start, end + 1).every((at, i) => at === from + i)
        if (keep && !exact) {
          ids.forEach(id => denied.add(id))
          retry = true
          keep = false
        }
        if (keep) {
          textEdits.push({ ...hunk, offset: from - keptShift })
          owners.push(ids)
          text = text.slice(0, from) + hunk.inserted + text.slice(to)
          const delta = hunk.inserted.length - hunk.removed.length
          map = [...map.slice(0, start), ...Array.from({ length: hunk.inserted.length + 1 }, (_, i) => from + i), ...map.slice(end + 1).map(at => at < 0 ? at : at + delta)]
          keptShift += delta
        } else {
          ids.forEach(id => undone.add(id))
          // Interior offsets belong to removed agent text. They cannot establish a later edit's identity.
          const replacement = hunk.inserted.length === 0 ? [to] : [from, ...Array(Math.max(0, hunk.inserted.length - 1)).fill(-1), to]
          map = [...map.slice(0, start), ...replacement, ...map.slice(end + 1)]
        }
        originalShift += hunk.inserted.length - hunk.removed.length
      }
      maps.set(edit.file, map)
      files.set(edit.file, !beforeExists && textEdits.length === 0 ? null : text)
      if (textEdits.length) kept.push({ edit: { ...edit, beforeHash: beforeExists ? editHash(beforeText) : null, afterHash: editHash(text), textEdits }, itemIds: [...new Set(owners.flat())], textEditItems: owners })
    }
    if (!retry) return { files, kept, dependent: denied, undone }
  }
}

export async function settleAgentEdits(deps: Pick<WizardDeps, "fs">, root: string, entries: readonly AttributedEdit[], verified: ReadonlySet<string>) {
  const current = new Map(await Promise.all([...new Set(entries.map(entry => entry.edit.file))].map(async file => [file, await deps.fs.readText(join(root, file))] as const)))
  const plan = settlementPlan(entries, current, verified)
  for (const [file, text] of plan.files) {
    if (text === current.get(file)) continue
    const absolute = join(root, file)
    if (text === null) {
      if (!deps.fs.removeFile || !await deps.fs.removeFile(absolute, editHash(current.get(file)!))) throw new Error(`Could not remove the unverified agent file ${file}.`)
    } else await deps.fs.writeTextAtomic(absolute, text, await stat(absolute).then(info => info.mode & 0o777).catch(() => 0o644))
  }
  return plan
}

/** A terminal state retains the actual checks and the agent's note for every report. */
export function notDoneItem(item: ChecklistItem): ChecklistItem {
  if (item.owner !== "agent" || jobVerified(item) || item.state === "not_needed" || item.state === "left_for_you") return item
  const check = item.checks.find(check => check.state !== "pass" && ["S", "B", "T0"].includes(check.tier))
  const reason = item.claim?.status === "blocked" ? `the agent said it was blocked: ${item.claim.note}`
    : !item.claim && !item.edits?.length ? `the agent did not do it${item.note ? ` — ${item.note}` : ""}`
    : item.note ?? (check ? `the wizard could not verify it (${check.id}: ${check.state}${check.reason ? ` — ${check.reason}` : ""})`
      : "the wizard could not verify it (no completed check proves this change)")
  return { ...item, state: "left_for_you", note: reason, edits: [] }
}


export function notDoneJobs(items: readonly ChecklistItem[]): ChecklistItem[] {
  return items.filter(item => item.owner === "agent" && !jobVerified(item) && item.state !== "not_needed" && !item.ownerBoundary)
}
export function notDoneDescription(item: ChecklistItem): string {
  return `${item.title} — ${notDoneItem(item).note ?? "the agent did not do it"}`
}
