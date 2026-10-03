// §3e.5 item states (lane O8). States are COMPUTED by the wizard from its own check results; the
// agent can only CLAIM. Every transition here is pure and returns the new item plus the note the
// `job.state` event carries.
//
//   pending ──claim done──▶ claimed ──S+B+T0 pass, diff in scope──▶ done_in_code
//      ▲                       │ a local check fails: budget left → pending (with the failure), spent → failed
//      └───────────────────────┘
//   done_in_code ──has T1/RH/PV──▶ waiting_deploy ──every live check passes with THIS run's id──▶ proven
//   done_in_code ──has P (jobs 8, 9, 10)──▶ waiting_real_event ──the first real event (passive)──▶ proven
//   claim not_needed ──the wizard's detector agrees──▶ not_needed, else ──▶ pending + the evidence
//   claim blocked ──▶ blocked(agent_blocked)
//
// Honesty: a check result counts ONLY when its `runId` equals this run's id (another run's receipt never
// proves, and a stored check from an older run never passes either), `undetermined` never counts as pass,
// and a claim never moves an item past `claimed`. A live reading of PRODUCTION (T1, PV) counts only when
// it was taken after the change could be live: after the item's claim, and after `liveSince` (the merge /
// deploy-ready time) when the caller knows it (review P2-2). A rehearsal (RH) reads the PR's preview, so
// the claim bounds it.
//
// Live checks before the deploy (review P2-1): an item whose path waits for a real event (job 10's click
// test) reaches `waiting_real_event` only once its live checks pass, and a failing rehearsal check sends
// an item back to `pending` with the failure (budget left) or to `failed` (budget spent), like a local one.
import { sanitizeUntrusted } from "../agents/sanitize.js"
import {
  ITEM_NOTE_MAX_CHARS,
  JOB_TABLE,
  type BlockedReason,
  type ChecklistItem,
  type ChecklistItemCheck,
  type CheckResult,
  type CheckTier,
  type Claim,
  type Evidence,
  type JobId,
  type JobItemState
} from "../wizard/contracts/jobs.js"

export const LOCAL_TIERS: readonly CheckTier[] = ["S", "B", "T0"]
export const LIVE_TIERS: readonly CheckTier[] = ["T1", "RH", "PV"]
export const PASSIVE_TIERS: readonly CheckTier[] = ["P"]
/** Readings of production: they must postdate the change. */
const PRODUCTION_TIERS: readonly CheckTier[] = ["T1", "PV"]

export interface ApplyOptions {
  budgetLeft: boolean
  /** The merge / deploy-ready time: a production reading (T1, PV) taken before it never counts. */
  liveSince?: string | null
}

export interface Transition {
  item: ChecklistItem
  /** What changed, for the `job.state` event; null when nothing changed. */
  changed: boolean
  by: "wizard" | "agent_claim"
  note?: string
}

const clone = (item: ChecklistItem): ChecklistItem => JSON.parse(JSON.stringify(item)) as ChecklistItem

/** §3x.2 The item's last wizard note, sanitized and capped like claim notes. */
export function withNote(item: ChecklistItem, note: string | undefined): ChecklistItem {
  if (note === undefined || note.trim() === "") return item
  item.note = sanitizeUntrusted(note, ITEM_NOTE_MAX_CHARS)
  return item
}

function donePathOf(item: ChecklistItem): readonly JobItemState[] {
  const spec = (JOB_TABLE as Record<string, { donePath: readonly JobItemState[] } | undefined>)[item.jobId]
  return spec?.donePath ?? ["done_in_code"]
}

function checksIn(item: ChecklistItem, tiers: readonly CheckTier[]): ChecklistItemCheck[] {
  return item.checks.filter((check) => tiers.includes(check.tier))
}

/** Every check passed IN THIS RUN (a stored pass from another run counts as not run). */
const allPass = (checks: readonly ChecklistItemCheck[], runId: string): boolean => checks.every((check) => check.state === "pass" && check.runId === runId)
const failingIn = (checks: readonly ChecklistItemCheck[], runId: string): ChecklistItemCheck[] => checks.filter((check) => check.state === "problem" && check.runId === runId)

function failureText(failing: readonly ChecklistItemCheck[]): string {
  return failing.map((check) => `${check.tier}:${check.id}${check.reason ? ` (${check.reason})` : ""}`).join("; ")
}

/** The earliest moment a production reading may come from (the claim, and the deploy when known). */
function productionFloor(item: ChecklistItem, liveSince: string | null | undefined): number | null {
  const bounds = [item.claim?.at, liveSince ?? undefined].filter((value): value is string => typeof value === "string").map((value) => Date.parse(value))
  if (bounds.some((value) => Number.isNaN(value))) return Number.POSITIVE_INFINITY
  return bounds.length === 0 ? null : Math.max(...bounds)
}

function evidenceText(evidence: readonly Evidence[]): string {
  if (evidence.length === 0) return "no evidence"
  return evidence
    .slice(0, 3)
    .map((entry) => ("url" in entry ? entry.url : `${entry.file}:${entry.line}`))
    .join(", ")
}

/**
 * Records an agent claim. A claim is input, never a result: `done` moves a `pending` item to `claimed`
 * and no further. `not_needed` is re-verified by the wizard's own detector (`reverify`).
 */
export function applyClaim(
  item: ChecklistItem,
  claim: Claim,
  reverify: (item: ChecklistItem) => { agrees: boolean; evidence: Evidence[] }
): Transition {
  if (item.owner !== "agent") return { item, changed: false, by: "agent_claim", note: "claim ignored: a code job is not the agent's" }
  if (item.state !== "pending" && item.state !== "claimed") {
    return { item, changed: false, by: "agent_claim", note: `claim ignored: the item is ${item.state}` }
  }
  const next = clone(item)
  next.claim = { status: claim.status, note: claim.note, at: claim.at }
  if (claim.status === "done") {
    next.state = "claimed"
    delete next.blockedReason
    return { item: next, changed: true, by: "agent_claim", note: "claimed done; the wizard will run its own checks" }
  }
  if (claim.status === "blocked") {
    next.state = "blocked"
    next.blockedReason = "agent_blocked"
    // §3x.2 The real reason is the agent's own (quoted, sanitized), never a generic "did not finish".
    withNote(next, claim.note.trim() === "" ? "the agent said it is blocked" : `the agent said it is blocked: ${claim.note}`)
    return { item: next, changed: true, by: "agent_claim", note: "the agent is blocked" }
  }
  const verdict = reverify(item)
  if (verdict.agrees) {
    next.state = "not_needed"
    delete next.blockedReason
    return { item: next, changed: true, by: "wizard", note: "not needed: the wizard's detector agrees" }
  }
  next.state = "pending"
  if (verdict.evidence.length > 0) next.trigger = { finding: next.trigger.finding, evidence: verdict.evidence }
  return { item: next, changed: true, by: "wizard", note: `agent said not needed; the wizard found ${evidenceText(verdict.evidence)}` }
}

/** The budget is spent (30 turns / 10 minutes, §3f.4) and the item's last wizard check failed: `failed`. */
export function failItem(item: ChecklistItem, note: string): Transition {
  const next = withNote(clone(item), note)
  next.state = "failed"
  delete next.blockedReason
  return { item: next, changed: item.state !== "failed", by: "wizard", note }
}

/** A question answered: a `blocked:needs_you` item goes back to the agent (`pending`). */
export function unblockItem(item: ChecklistItem, note: string): Transition {
  if (item.state !== "blocked") return { item, changed: false, by: "wizard" }
  const next = clone(item)
  next.state = "pending"
  delete next.blockedReason
  return { item: next, changed: true, by: "wizard", note }
}

/** Marks an item blocked with one of the §3e.5 reasons (the fence, the post-turn gate, usage, …). */
export function blockItem(item: ChecklistItem, reason: BlockedReason, note?: string): Transition {
  const next = withNote(clone(item), note)
  next.state = "blocked"
  next.blockedReason = reason
  return { item: next, changed: item.state !== "blocked" || item.blockedReason !== reason, by: "wizard", ...(note ? { note } : {}) }
}

/**
 * Merges this run's check results into an item and advances it as far as the results allow. A result
 * from another run (or with no run id) is ignored, so it can never pass a check.
 */
export function applyResults(item: ChecklistItem, results: readonly CheckResult[], runId: string, options: ApplyOptions): Transition {
  const next = clone(item)
  let merged = false
  const floor = productionFloor(item, options.liveSince)
  for (const check of next.checks) {
    const result = results.find((candidate) => candidate.checkId === check.id && candidate.tier === check.tier && candidate.runId === runId)
    if (!result) continue
    if (PRODUCTION_TIERS.includes(check.tier) || check.tier === "RH") {
      // A reading from before the change existed (e.g. `before`'s own T1 checks) never counts for it.
      const taken = Date.parse(result.at)
      const bound = check.tier === "RH" ? productionFloor(item, null) : floor
      if (bound === null || Number.isNaN(taken) || taken < bound) continue
    }
    check.state = result.state
    check.at = result.at
    check.runId = runId
    if (result.reason !== undefined) check.reason = result.reason
    else delete check.reason
    merged = true
  }
  const advanced = advance(next, runId, options)
  // §3x.2 A check that sent the item back (or failed it) is its note.
  if (advanced.note && (advanced.item.state === "pending" || advanced.item.state === "failed")) withNote(advanced.item, advanced.note)
  return { item: advanced.item, changed: merged || advanced.item.state !== item.state, by: "wizard", ...(advanced.note ? { note: advanced.note } : {}) }
}

function sendBack(item: ChecklistItem, failing: readonly ChecklistItemCheck[], options: ApplyOptions): string {
  item.state = options.budgetLeft ? "pending" : "failed"
  return options.budgetLeft ? `check failed: ${failureText(failing)}` : `check failed and the budget is spent: ${failureText(failing)}`
}

function advance(item: ChecklistItem, runId: string, options: ApplyOptions): { item: ChecklistItem; note?: string } {
  let note: string | undefined
  const path = donePathOf(item)
  for (let guard = 0; guard < 5; guard += 1) {
    const before = item.state
    if (item.state === "claimed") {
      const local = checksIn(item, LOCAL_TIERS)
      const failing = failingIn(local, runId)
      if (failing.length > 0) {
        note = sendBack(item, failing, options)
        break
      }
      // With no local check the wizard has nothing to verify in code but the recorded, in-scope diff.
      const verified = local.length > 0 ? allPass(local, runId) : (item.edits?.length ?? 0) > 0
      if (verified) item.state = "done_in_code"
    } else if (item.state === "done_in_code" || item.state === "waiting_deploy") {
      const rehearsalFailing = failingIn(checksIn(item, ["RH"]), runId)
      if (rehearsalFailing.length > 0) {
        note = sendBack(item, rehearsalFailing, options)
        break
      }
      if (item.state === "done_in_code") {
        const after = path[path.indexOf("done_in_code") + 1]
        const live = checksIn(item, LIVE_TIERS)
        if (after === "waiting_deploy") item.state = after
        else if (after === "waiting_real_event") {
          // e.g. job 10: the click test must have passed before the item waits for a real conversion.
          if (allPass(live, runId)) item.state = after
        } else if (after === "proven") {
          const proof = checksIn(item, [...LIVE_TIERS, ...PASSIVE_TIERS])
          if (proof.length > 0 && allPass(proof, runId)) item.state = "proven"
        }
      } else {
        const live = checksIn(item, LIVE_TIERS)
        if (live.length > 0 && allPass(live, runId)) item.state = "proven"
      }
    } else if (item.state === "waiting_real_event") {
      const passive = checksIn(item, PASSIVE_TIERS)
      if (passive.length > 0 && allPass(passive, runId)) item.state = "proven"
    }
    if (item.state === before) break
  }
  return note ? { item, note } : { item }
}

/**
 * `proven (= merged)`: items whose done path ends at `proven` but which have no live or passive check
 * (job 14's privacy paragraph, job 16's comments) are proven by the merge itself.
 */
export function markMerged(item: ChecklistItem): Transition {
  if (item.state !== "done_in_code") return { item, changed: false, by: "wizard" }
  const path = donePathOf(item)
  if (path[path.length - 1] !== "proven" || checksIn(item, [...LIVE_TIERS, ...PASSIVE_TIERS]).length > 0) {
    return { item, changed: false, by: "wizard" }
  }
  const next = clone(item)
  next.state = "proven"
  return { item: next, changed: true, by: "wizard", note: "merged" }
}

/** The job ids whose done path waits for a real event (jobs 8, 9, 10). */
export function waitsForRealEvent(jobId: JobId): boolean {
  return JOB_TABLE[jobId].donePath.includes("waiting_real_event")
}
