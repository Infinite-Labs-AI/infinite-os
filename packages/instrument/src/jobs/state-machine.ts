// §3e.5 item states (lane O8). States are COMPUTED by the wizard from its own check results; the
// agent can only CLAIM. Every transition here is pure and returns the new item plus the note the
// `job.state` event carries.
//
//   pending ──claim done──▶ claimed ──S+B+T0 pass (one that proves the change among them), diff in scope──▶ done_in_code
//      ▲                       │ a local check fails: budget left → pending (with the failure), spent → failed
//      └───────────────────────┘
//   claimed ──no local check failed, and the review agent answered (`applyReview`)──▶ done_in_code
//      (a "pass" on every question PROVES the change; "fail" / "cant_tell" / "not_run" keep the edits with the
//      reviewer's words: a review answer never reverts an edit)
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
import { CONSENT_LEFT_FOR_YOU } from "./owner-boundary.js"
import { CAPTURE_WAITING } from "../install/consent-handoff.js"
import { checkWords, heldByBanner, NOT_MEASURED_BEHIND_BANNER } from "./check-words.js"
import { sanitizeUntrusted } from "../agents/sanitize.js"
import { redactDisplayText } from "../review/display.js"
import { createScanner, type Scanner } from "../review/scan.js"
import {
  ITEM_NOTE_MAX_CHARS,
  CLAIM_LIMITS,
  JOB_TABLE,
  checkProvesChange,
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
  /** The run's known environment literals and public IDs, in addition to provider secret shapes. */
  scanner?: Scanner
  /** Prove has finished: failure/unknown must no longer be described as waiting for deployment. */
  afterDeploy?: boolean
  awaitingVisit?: boolean
  budgetLeft: boolean
  /** The merge / deploy-ready time: a production reading (T1, PV) taken before it never counts. */
  liveSince?: string | null
  /**
   * LF4 close round 2 (P1-1): the item is checked on the tree with NO claim (the agent's turns ended): only a check that
   * proves its change is in the code may tick it, never a recorded diff.
   */
  claimless?: boolean
}

export interface Transition {
  item: ChecklistItem
  /** What changed, for the `job.state` event; null when nothing changed. */
  changed: boolean
  by: "wizard" | "agent_claim"
  note?: string
}

const clone = (item: ChecklistItem): ChecklistItem => JSON.parse(JSON.stringify(item)) as ChecklistItem

const DEFAULT_SCANNER = createScanner({ literals: [], allowedIds: [] })

/** Redact before controls/limits can split a credential; persisted notes retain their original syntax. */
function storedNote(note: string, scanner: Scanner, max = ITEM_NOTE_MAX_CHARS): string {
  return sanitizeUntrusted(redactDisplayText(scanner, note), max)
}

/** §3x.2 The item's last wizard note, redacted, sanitized and capped like claim notes. */
export function withNote(item: ChecklistItem, note: string | undefined, scanner: Scanner = DEFAULT_SCANNER): ChecklistItem {
  if (note === undefined || note.trim() === "") return item
  item.note = storedNote(note, scanner)
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
  return checkWords(failing)
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
  reverify: (item: ChecklistItem) => { agrees: boolean; evidence: Evidence[] },
  scanner: Scanner = DEFAULT_SCANNER
): Transition {
  if (item.jobId === "privacy_paragraph") return leaveForOwner(item, "Left for you: privacy policies and terms belong to the site owner.")
  if (item.owner !== "agent") return { item, changed: false, by: "agent_claim", note: "claim ignored: a code job is not the agent's" }
  if (item.state !== "pending" && item.state !== "claimed") {
    return { item, changed: false, by: "agent_claim", note: `claim ignored: the item is ${item.state}` }
  }
  const next = clone(item)
  const claimNote = storedNote(claim.note, scanner, CLAIM_LIMITS.noteMaxChars)
  next.claim = { status: claim.status, note: claimNote, at: claim.at }
  if (claim.status === "done") {
    next.state = "claimed"
    delete next.blockedReason
    return { item: next, changed: true, by: "agent_claim", note: "claimed done; the wizard will run its own checks" }
  }
  if (claim.status === "blocked") {
    next.state = "blocked"
    next.blockedReason = "agent_blocked"
    // §3x.2 The real reason is the agent's own (quoted, sanitized), never a generic "did not finish".
    withNote(next, claimNote.trim() === "" ? "the agent said it is blocked" : `the agent said it is blocked: ${claimNote}`, scanner)
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
  return { item: next, changed: true, by: "wizard", note: storedNote(`agent said not needed; the wizard found ${evidenceText(verdict.evidence)}`, scanner) }
}

/** The budget is spent (30 turns / 10 minutes, §3f.4) and the item's last wizard check failed: `failed`. */
export function failItem(item: ChecklistItem, note: string, scanner: Scanner = DEFAULT_SCANNER): Transition {
  note = storedNote(note, scanner)
  const next = withNote(clone(item), note, scanner)
  next.state = "failed"
  delete next.blockedReason
  return { item: next, changed: item.state !== "failed", by: "wizard", note }
}

/** A question answered: a `blocked:needs_you` item goes back to the agent (`pending`). */
export function unblockItem(item: ChecklistItem, note: string, scanner: Scanner = DEFAULT_SCANNER): Transition {
  note = storedNote(note, scanner)
  if (item.state !== "blocked") return { item, changed: false, by: "wizard" }
  const next = clone(item)
  next.state = "pending"
  delete next.blockedReason
  return { item: next, changed: true, by: "wizard", note }
}

/** Marks an item blocked with one of the §3e.5 reasons (the fence, the post-turn gate, usage, …). */
export function leaveForOwner(item: ChecklistItem, note = CONSENT_LEFT_FOR_YOU, ownerBoundary?: ChecklistItem["ownerBoundary"], scanner: Scanner = DEFAULT_SCANNER): Transition {
  note = storedNote(note, scanner)
  const next = withNote(clone(item), note, scanner)
  next.state = "left_for_you"
  if (ownerBoundary) next.ownerBoundary = ownerBoundary
  next.checks = []
  delete next.blockedReason
  return { item: next, changed: item.state !== "left_for_you", by: "wizard", note }
}

export function blockItem(item: ChecklistItem, reason: BlockedReason, note?: string, scanner: Scanner = DEFAULT_SCANNER): Transition {
  if (reason === "consent_touched") return leaveForOwner(item, "Put back: an edit reached code that handles consent.", { kind: "restored_unit" })
  note = note === undefined ? undefined : storedNote(note, scanner)
  const next = withNote(clone(item), note, scanner)
  next.state = "blocked"
  next.blockedReason = reason
  return { item: next, changed: item.state !== "blocked" || item.blockedReason !== reason, by: "wizard", ...(note ? { note } : {}) }
}

/**
 * Merges this run's check results into an item and advances it as far as the results allow. A result
 * from another run (or with no run id) is ignored, so it can never pass a check.
 */
export function applyResults(item: ChecklistItem, results: readonly CheckResult[], runId: string, options: ApplyOptions): Transition {
  const scanner = options.scanner ?? DEFAULT_SCANNER
  if (item.jobId === "privacy_paragraph") return leaveForOwner(item, "Left for you: privacy policies and terms belong to the site owner.")
  if (item.state === "left_for_you") return { item, changed: false, by: "wizard" }
  const next = clone(item)
  let merged = false
  const floor = productionFloor(item, options.liveSince)
  for (const check of next.checks) {
    const result = results.find((candidate) => candidate.checkId === check.id && candidate.tier === check.tier && candidate.runId === runId)
    if (!result) continue
    if (PRODUCTION_TIERS.includes(check.tier) || check.tier === "RH") {
      // A reading from before the change existed (e.g. `before`'s own T1 checks) never counts for it.
      const taken = Date.parse(result.at)
      const bound = check.tier === "RH" && !options.afterDeploy ? productionFloor(item, null) : floor
      if (bound === null || Number.isNaN(taken) || taken < bound) continue
    }
    check.state = result.state
    check.at = result.at
    check.runId = runId
    if (result.reason !== undefined) check.reason = redactDisplayText(scanner, result.reason)
    else delete check.reason
    merged = true
  }
  const advanced = advance(next, runId, options)
  if (options.afterDeploy) {
    const live = checksIn(advanced.item, LIVE_TIERS)
    const failed = failingIn(live, runId)
    const undecided = live.filter((check) => check.state !== "pass" || check.runId !== runId)
    if (failed.length > 0) {
      advanced.item.state = "failed"
      advanced.note = `Failed after the deploy: ${checkWords(failed)}`
    } else if (options.awaitingVisit && undecided.some(check => check.tier === "PV")) {
      advanced.item.state = inCode(advanced.item, runId) ? "done_in_code" : "claimed"
      const pendingChecks = undecided.filter(check => check.tier === "PV")
      const pending = checkWords(pendingChecks)
      const notMeasured = undecided.filter(check => check.tier !== "PV" && !pendingChecks.some(pv => pv.id === check.id))
      advanced.note = `Waiting for the Infinite app's results: ${pending}${notMeasured.length > 0 ? `. Not checked after the deploy: ${checkWords(notMeasured)}` : ""}`
    } else if (undecided.length > 0 || advanced.item.state === "waiting_deploy") {
      advanced.item.state = advanced.item.state !== "claimed" && inCode(advanced.item, runId) ? "done_in_code" : "claimed"
      // The site's own banner kept the proof visit silent: said as not measured, with the reason, never as a failure.
      const behindBanner = undecided.length > 0 && undecided.every(check => check.runId === runId && heldByBanner(check))
      advanced.note = behindBanner ? NOT_MEASURED_BEHIND_BANNER : undecided.length > 0 ? `Not checked after the deploy: ${checkWords(undecided)}` : `Checked, but not tied to this deploy: ${checkWords(live)}`
    } else if (advanced.item.state === "proven") delete advanced.item.note
    if (advanced.note) withNote(advanced.item, advanced.note, scanner)
  }
  // §3x.2 A check that sent the item back (or failed it) is its note.
  if (advanced.note && (advanced.item.state === "pending" || advanced.item.state === "failed")) withNote(advanced.item, advanced.note, scanner)
  if (advanced.item.consentActivation === "waiting_banner_signal" && ["done_in_code", "waiting_deploy", "proven"].includes(advanced.item.state)) {
    advanced.item.state = "done_in_code"
    advanced.note = CAPTURE_WAITING
    withNote(advanced.item, CAPTURE_WAITING, scanner)
  }
  return { item: advanced.item, changed: merged || advanced.item.state !== item.state, by: "wizard", ...(advanced.note ? { note: storedNote(advanced.note, scanner) } : {}) }
}

/**
 * The item's change is in the code as the wizard knows it this run: every local check passed, or (a job the review agent
 * decides) the review answered and no local check found a problem. Whatever the review said, its edits are kept.
 */
function inCode(item: ChecklistItem, runId: string): boolean {
  const local = checksIn(item, LOCAL_TIERS)
  if (local.length > 0 && allPass(local, runId)) return true
  return item.review !== undefined && item.review.runId === runId && failingIn(local, runId).length === 0
}

function sendBack(item: ChecklistItem, failing: readonly ChecklistItemCheck[], options: ApplyOptions): string {
  item.state = options.budgetLeft ? "pending" : "failed"
  return options.budgetLeft ? `check failed: ${failureText(failing)}` : `check failed and the budget is spent: ${failureText(failing)}`
}

/** RH alone proves preview behavior, never deployment. A rehearsal-only job needs a
 * new measurement after the known deploy; T1/PV results already carry production bounds. */
function hasProductionProof(item: ChecklistItem, runId: string, options: ApplyOptions): boolean {
  const live = checksIn(item, LIVE_TIERS)
  if (live.some((check) => PRODUCTION_TIERS.includes(check.tier) && check.state === "pass" && check.runId === runId)) return true
  if (!options.afterDeploy || !options.liveSince) return false
  const floor = productionFloor(item, options.liveSince)
  return floor !== null && live.some((check) => check.tier === "RH" && check.state === "pass" && check.runId === runId && Date.parse(check.at ?? "") >= floor)
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
      // LF4 close round 2 (P1-1): only a check whose pass PROVES the job's change is in the code may tick it
      // (`checkProvesChange`); a check that also passes with nothing of the job in the code (no click-fired standard event,
      // the mirror's event ids, the build) may only fail it. With no proving check the wizard has nothing to verify in
      // code but the recorded, in-scope diff of a CLAIMED item; an item checked with no claim is never ticked by a diff.
      const proving = local.filter((check) => checkProvesChange(item.jobId, check.tier, check.id))
      // The review agent's answers on this job, this run (`applyReview`). A pass on every question proves the change; any
      // other answer still KEEPS the edits (said in the note), since a review answer never reverts anything.
      const reviewed = item.review !== undefined && item.review.runId === runId
      const reviewProves = reviewed && item.review!.state === "pass"
      const verified =
        (local.length > 0 && allPass(local, runId) && (proving.length > 0 || reviewProves || (!options.claimless && (item.edits?.length ?? 0) > 0))) ||
        (reviewed && local.every((check) => check.state !== "problem" || check.runId !== runId))
      if (verified) item.state = "done_in_code"
      else {
        // LF4-P1-2: a claimed item the wizard cannot verify in code (e.g. no recorded edit) whose rehearsal check
        // FAILED is not left "claimed" (read as "in the code but not checked"): that check's reason sends it back.
        const rehearsalFailing = failingIn(checksIn(item, ["RH"]), runId)
        if (rehearsalFailing.length > 0) {
          note = sendBack(item, rehearsalFailing, options)
          break
        }
        // No local check means no "done in code" claim. An edited, claimed job can instead
        // advance on its actual rehearsal (or all its live checks for a T1-only job).
        const rehearsal = checksIn(item, ["RH"])
        const live = checksIn(item, LIVE_TIERS)
        if (local.length === 0 && !options.claimless && (item.edits?.length ?? 0) > 0 && path.includes("waiting_deploy") &&
          ((rehearsal.length > 0 && allPass(rehearsal, runId)) || (live.length > 0 && allPass(live, runId)))) {
          item.state = "waiting_deploy"
        }
      }
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
          if (proof.length > 0 && allPass(proof, runId)) item.state = hasProductionProof(item, runId, options) ? "proven" : "waiting_deploy"
        }
      } else {
        const live = checksIn(item, LIVE_TIERS)
        if (live.length > 0 && allPass(live, runId) && hasProductionProof(item, runId, options)) item.state = "proven"
      }
    } else if (item.state === "waiting_real_event") {
      const passive = checksIn(item, PASSIVE_TIERS)
      if (passive.length > 0 && allPass(passive, runId)) item.state = "proven"
    }
    if (item.state === before) break
  }
  return note ? { item, note } : { item }
}

/** What a job's note says for each review answer (plain words, never a check id). */
export const REVIEW_WORDS = {
  pass: "Checked by the review agent.",
  fail: "Needs your look",
  cant_tell: "The review could not tell",
  not_run: "Not checked by a review agent"
} as const

/** The note a review answer leaves on a job (the reviewer's finding or why, after the plain words). */
export function reviewNote(review: Pick<ChecklistItem["review"] & {}, "state" | "reason">): string {
  if (review.state === "pass") return REVIEW_WORDS.pass
  return review.reason ? `${REVIEW_WORDS[review.state]}: ${review.reason}` : `${REVIEW_WORDS[review.state]}.`
}

/**
 * The review agent's verdict on a job (`wizard/steps/jobs-review.ts`). The verdict is stored on the item, and an item
 * whose local checks found no problem this run is DONE IN CODE, whatever the answer: "pass" proves it ("checked by the
 * review agent"), "fail" keeps it as "needs your look", "cant_tell" and "not_run" keep it with why. A review answer never
 * sends an edit back and never reverts it; only the one fix round (the caller's) hands a failing answer to the agent.
 * An item in any other state (pending, failed, blocked, left for you) keeps its state and only records the answers.
 */
export function applyReview(item: ChecklistItem, review: NonNullable<ChecklistItem["review"]>, options: Omit<ApplyOptions, "budgetLeft"> = {}): Transition {
  const scanner = options.scanner ?? DEFAULT_SCANNER
  const next = clone(item)
  next.review = { ...review, ...(review.reason !== undefined ? { reason: storedNote(review.reason, scanner) } : {}) }
  if (!["claimed", "done_in_code", "waiting_deploy", "waiting_real_event", "proven"].includes(item.state)) {
    return { item: next, changed: true, by: "wizard" }
  }
  const advanced = next.state === "claimed" ? advance(next, review.runId, { ...options, budgetLeft: false }) : { item: next }
  const note = reviewNote(review)
  withNote(advanced.item, note, scanner)
  return { item: advanced.item, changed: true, by: "wizard", note: storedNote(note, scanner) }
}

/**
 * `proven (= merged)`: items whose done path ends at `proven` but which have no live or passive check
 * (job 16's comments) are proven by the merge itself.
 */
export function markMerged(item: ChecklistItem): Transition {
  if (item.jobId === "privacy_paragraph") return leaveForOwner(item, "Left for you: privacy policies and terms belong to the site owner.")
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
