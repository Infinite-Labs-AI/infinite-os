import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { reverseTextEdits } from "../server-lane/text-edits.js"
import type { WizardDeps } from "../wizard/contracts/deps.js"
import type { ChecklistItem, WizardEditRecord } from "../wizard/contracts/jobs.js"
import type { ManagedTextEdit } from "../types.js"
import { checkWords } from "./check-words.js"

export interface AttributedEdit {
  edit: WizardEditRecord
  itemIds: string[]
  textEditItems: string[][]
  /** The jobs step's round the edit was made in: an owner verified in an earlier round never vouches for it. */
  generation?: number
}

export const VERIFIED_JOB_STATES = ["done_in_code", "waiting_deploy", "waiting_real_event", "proven"] as const
export function jobVerified(item: Pick<ChecklistItem, "state">): boolean {
  return (VERIFIED_JOB_STATES as readonly string[]).includes(item.state)
}
export const editHash = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`

/**
 * Hard-rule checks that cannot read a value the site sets in an environment variable (PostHog's own documented setup, a
 * GA4 id from `process.env`, `fbq('init', PIXEL_ID)`, a CSP nonce): "undetermined" from one of them says nothing is
 * wrong, only that the code cannot show it. A job whose only open checks are these keeps its edits for the review agent
 * (analysis P2-10), never a put-back. `adopted_init_guarded` returns `info` for the same reason.
 */
export const REVIEW_ON_UNDETERMINED: ReadonlySet<string> = new Set(["ga4_id_applied", "posthog_improve_applied", "meta_autoconfig_off", "csp_hosts", "adopted_init_guarded"])

const LOCAL_CHECK_TIERS = ["S", "B", "T0"]

/**
 * A claimed job the wizard could not verify but whose edits stay for the review agent (never put back): no local check
 * found a problem, and every one it could not decide is a hard rule that cannot read environment values; or the job has
 * no local check at all, so only the review agent can decide it.
 */
export function heldForReview(item: Pick<ChecklistItem, "owner" | "state" | "checks" | "claim">): boolean {
  if (item.owner !== "agent" || item.state !== "claimed" || item.claim?.status !== "done") return false
  const local = item.checks.filter((check) => LOCAL_CHECK_TIERS.includes(check.tier))
  if (local.some((check) => check.state === "problem")) return false
  if (local.length === 0) return true
  const open = local.filter((check) => check.state !== "pass")
  return open.length > 0 && open.every((check) => (check.state === "undetermined" || check.state === "info") && REVIEW_ON_UNDETERMINED.has(check.id))
}

export interface SettlementOptions {
  /** The round each owner was last verified in (`AttributedEdit.generation`): only a verification on a tree that held the edit counts. */
  verifiedAt?: ReadonlyMap<string, number>
}

export interface SettlementPlan {
  files: Map<string, string | null>
  kept: AttributedEdit[]
  /** Verified jobs whose own hunk could not be replayed even with every earlier hunk of its file kept (put back). */
  dependent: Set<string>
  /** Jobs with at least one hunk put back. */
  undone: Set<string>
  /**
   * Unverified jobs whose lines stay because a verified job owns the same block (`shared_lines`) or needs them for its
   * own hunk to apply (`needed_by`): unverified job id → the verified jobs and files. Listed for the review agent.
   */
  keptWith: Map<string, { with: Set<string>; files: Set<string>; why: "shared_lines" | "needed_by" }>
}

/**
 * Replays exact recorded hunks (never searching for similar text). A block is KEPT when ANY of its owners was verified on
 * a tree that held it (founder decision: never revert verified work); only a block no verified job owns is put back. A
 * verified hunk that needs an earlier, unverified hunk of the same file (it edits that hunk's lines) keeps that hunk too,
 * instead of being put back with it.
 */
export function settlementPlan(entries: readonly AttributedEdit[], current: ReadonlyMap<string, string | null>, verified: ReadonlySet<string>, options: SettlementOptions = {}): SettlementPlan {
  const bases = new Map(current)
  for (const { edit } of [...entries].reverse()) {
    const text = bases.get(edit.file)
    if (text === undefined || text === null || editHash(text) !== edit.afterHash) throw new Error(`The recorded edit to ${edit.file} no longer matches; refusing to stage it.`)
    const before = reverseTextEdits(text, edit.textEdits)
    if (edit.beforeHash !== null && editHash(before) !== edit.beforeHash) throw new Error(`The original edit to ${edit.file} no longer matches; refusing to stage it.`)
    bases.set(edit.file, edit.beforeHash === null ? null : before)
  }
  const vouches = (id: string, entry: AttributedEdit) => {
    if (!verified.has(id)) return false
    const at = options.verifiedAt?.get(id)
    return entry.generation === undefined || at === undefined || at >= entry.generation
  }
  const denied = new Set<string>()
  /** `<entry>:<hunk>` of unverified hunks kept because a verified hunk of the same file needs them, and who needs them. */
  const rescued = new Map<string, Set<string>>()
  for (;;) {
    const files = new Map(bases)
    const maps = new Map([...bases].map(([file, text]) => [file, Array.from({ length: (text ?? "").length + 1 }, (_, i) => i)]))
    const kept: AttributedEdit[] = []
    const undone = new Set<string>()
    const keptWith: SettlementPlan["keptWith"] = new Map()
    /** This pass's put-back hunks, per file, for a later verified hunk that turns out to need them. */
    const putBack = new Map<string, string[]>()
    let retry = false
    const note = (ids: readonly string[], by: Iterable<string>, file: string, why: "shared_lines" | "needed_by") => {
      for (const id of ids) {
        if (verified.has(id)) continue
        const entry = keptWith.get(id) ?? { with: new Set<string>(), files: new Set<string>(), why }
        for (const other of by) if (other !== id) entry.with.add(other)
        entry.files.add(file)
        if (why === "needed_by") entry.why = why
        keptWith.set(id, entry)
      }
    }
    for (const [entryIndex, entry] of entries.entries()) {
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
        const key = `${entryIndex}:${index}`
        const vouching = ids.filter((id) => vouches(id, entry) && !denied.has(id))
        const needs = rescued.get(key)
        let keep = vouching.length > 0 || needs !== undefined
        const start = hunk.offset + originalShift, end = start + hunk.removed.length
        const from = map[start]!, to = map[end]!
        const exact = from >= 0 && to >= 0 && to - from === hunk.removed.length &&
          text.slice(from, to) === hunk.removed && map.slice(start, end + 1).every((at, i) => at === from + i)
        if (keep && !exact) {
          // It edits lines an earlier, unverified hunk of this file wrote: keep those (once) rather than lose this one.
          const earlier = (putBack.get(edit.file) ?? []).filter((candidate) => !rescued.has(candidate))
          const by = vouching.length > 0 ? vouching : [...(needs ?? [])]
          if (earlier.length > 0) for (const candidate of earlier) rescued.set(candidate, new Set(by))
          else ids.forEach((id) => denied.add(id))
          retry = true
          keep = false
        }
        if (keep) {
          if (vouching.length > 0) note(ids, vouching, edit.file, "shared_lines")
          if (needs) note(ids, needs, edit.file, "needed_by")
          textEdits.push({ ...hunk, offset: from - keptShift })
          owners.push(ids)
          text = text.slice(0, from) + hunk.inserted + text.slice(to)
          const delta = hunk.inserted.length - hunk.removed.length
          map = [...map.slice(0, start), ...Array.from({ length: hunk.inserted.length + 1 }, (_, i) => from + i), ...map.slice(end + 1).map(at => at < 0 ? at : at + delta)]
          keptShift += delta
        } else {
          ids.forEach(id => undone.add(id))
          putBack.set(edit.file, [...(putBack.get(edit.file) ?? []), key])
          // Interior offsets belong to removed agent text. They cannot establish a later edit's identity.
          const replacement = hunk.inserted.length === 0 ? [to] : [from, ...Array(Math.max(0, hunk.inserted.length - 1)).fill(-1), to]
          map = [...map.slice(0, start), ...replacement, ...map.slice(end + 1)]
        }
        originalShift += hunk.inserted.length - hunk.removed.length
      }
      maps.set(edit.file, map)
      files.set(edit.file, !beforeExists && textEdits.length === 0 ? null : text)
      if (textEdits.length) kept.push({ edit: { ...edit, beforeHash: beforeExists ? editHash(beforeText) : null, afterHash: editHash(text), textEdits }, itemIds: [...new Set(owners.flat())], textEditItems: owners, ...(entry.generation !== undefined ? { generation: entry.generation } : {}) })
    }
    if (!retry) {
      // A job with a hunk put back AND a hunk kept is still "undone" for its note; one whose every hunk stayed is not.
      return { files, kept, dependent: denied, undone, keptWith }
    }
  }
}

/**
 * For the review agent (Builder A's post-jobs review) and the pull request: every unverified job whose lines stay in the
 * tree, one plain line each: "<title>": shared with "<verified job>", not verified on its own (in <files>).
 */
export function keptForReviewLines(items: readonly ChecklistItem[]): string[] {
  const title = (id: string) => items.find((item) => item.id === id)?.title ?? id
  return items.flatMap((item) => item.keptForReview
    ? [`${keptWithLine(item.title, item.keptForReview.with.map(title), item.keptForReview.why)} (${item.keptForReview.files.join(", ")})`]
    : [])
}

/** The plain line the review agent (and the pull request) reads for an unverified job whose lines stayed. */
export function keptWithLine(title: string, withTitles: readonly string[], why: "shared_lines" | "needed_by"): string {
  const others = withTitles.length > 0 ? withTitles.map((other) => `"${other}"`).join(" and ") : "a verified job"
  return why === "needed_by"
    ? `"${title}": not verified on its own; its lines stay because ${others} builds on them`
    : `"${title}": shared with ${others}, not verified on its own`
}

export async function settleAgentEdits(deps: Pick<WizardDeps, "fs">, root: string, entries: readonly AttributedEdit[], verified: ReadonlySet<string>, options: SettlementOptions = {}) {
  const current = new Map(await Promise.all([...new Set(entries.map(entry => entry.edit.file))].map(async file => [file, await deps.fs.readText(join(root, file))] as const)))
  const plan = settlementPlan(entries, current, verified, options)
  for (const [file, text] of plan.files) {
    if (text === current.get(file)) continue
    const absolute = join(root, file)
    if (text === null) {
      if (!deps.fs.removeFile || !await deps.fs.removeFile(absolute, editHash(current.get(file)!))) throw new Error(`Could not remove the unverified agent file ${file}.`)
    } else await deps.fs.writeTextAtomic(absolute, text, await stat(absolute).then(info => info.mode & 0o777).catch(() => 0o644))
  }
  return { ...plan, before: current }
}

/** Writes back the files a settlement changed, exactly as they stood before it (the wizard undoing its own put-back). */
export async function unsettle(deps: Pick<WizardDeps, "fs">, root: string, plan: { files: ReadonlyMap<string, string | null>; before: ReadonlyMap<string, string | null> }): Promise<void> {
  for (const [file, text] of plan.before) {
    if (plan.files.get(file) === text || text === null) continue
    const absolute = join(root, file)
    await deps.fs.writeTextAtomic(absolute, text, await stat(absolute).then(info => info.mode & 0o777).catch(() => 0o644))
  }
}

/**
 * A terminal state retains the actual checks and the agent's note for every report. A job held for the review agent
 * (`heldForReview`) keeps its state and edits. Item 8: the reason is plain words, never a check id or state code.
 */
export function notDoneItem(item: ChecklistItem): ChecklistItem {
  if (item.owner !== "agent" || jobVerified(item) || item.state === "not_needed" || item.state === "left_for_you" || heldForReview(item)) return item
  const local = item.checks.filter(check => check.state !== "pass" && LOCAL_CHECK_TIERS.includes(check.tier))
  const problem = local.find(check => check.state === "problem")
  const undecided = local.find(check => check.state === "undetermined" || check.state === "info")
  const reason = item.claim?.status === "blocked" ? `the agent said it was blocked: ${item.claim.note}`
    : !item.claim && !item.edits?.length ? `the agent did not do it${item.note ? ` — ${item.note}` : ""}`
    : problem ? `the wizard's check of the code found a problem: ${checkWords([problem])}`
    : undecided ? `the wizard could not decide it from the code: ${checkWords([undecided])}`
      : item.note ?? "the wizard could not verify it (no check it ran shows this change in the code)"
  return { ...item, state: "left_for_you", note: reason, edits: [] }
}


export function notDoneJobs(items: readonly ChecklistItem[]): ChecklistItem[] {
  return items.filter(item => item.owner === "agent" && !jobVerified(item) && item.state !== "not_needed" && !item.ownerBoundary && !heldForReview(item))
}
export function notDoneDescription(item: ChecklistItem): string {
  return `${item.title} — ${notDoneItem(item).note ?? "the agent did not do it"}`
}
