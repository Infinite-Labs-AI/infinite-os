// What the `plan` and `install` steps share: loading the plan's inputs (the scan, the keys, what
// `before` measured, the seeded candidates) and the saved approvals.
//
// The run state schema (§3d.6) keeps the plan's hash, answers and per-line approvals, but not the
// candidates the plan was built from or an edited privacy paragraph, both of which `install` (and
// job 14) need to rebuild the SAME plan. They are kept beside the state, in the gitignored wizard dir.
import { join } from "node:path"

import type { WizardContext, WizardDeps } from "../wizard/contracts/deps.js"
import type { TagHosting, TagKeys } from "../wizard/contracts/bridge.js"
import type { ChecklistItem, PlanApprovals, PlanModel } from "../wizard/contracts/jobs.js"
import { WIZARD_PATHS, WIZARD_STATE_FILE_MODE } from "../wizard/contracts/state.js"

import { narrowKeysToChoices, readBeforeFacts, readKeysChoices } from "./before-facts.js"
import type { GuardDecision, WizardBeforeFacts } from "./plan-model.js"

export const PLAN_APPROVALS_RELATIVE_PATH = `${WIZARD_PATHS.dir}/plan-approvals.json`
const PLAN_APPROVALS_SCHEMA = "infinite-tag.plan-approvals.v1" as const

export interface SavedPlanApprovals {
  schema: typeof PLAN_APPROVALS_SCHEMA
  planHash: string
  /** `state.steps.before.at` of the `before` run whose candidates these are. */
  beforeAt: string | null
  /** The candidates `before` seeded, exactly as the plan saw them (state.jobs is replaced after the plan). */
  candidates: ChecklistItem[]
  approvals: PlanApprovals
  /** The approved privacy paragraph (job 14 inserts it verbatim), or null. */
  privacyText: string | null
  /**
   * The preview guard the plan decided (exempt production hosts + deny list), persisted so job 7 (the
   * agent's guard on an ADOPTED init) uses exactly the hosts the managed guard uses, never its own pick.
   */
  guard?: GuardDecision | null
  /**
   * The approved plan's lines and decisions (I1: the agent brief's plan data is rebuilt from them in a
   * fresh process; `briefPlanFrom(plan, approvals)`). Absent in files written before I1.
   */
  plan?: { hash: string; lines: PlanModel["lines"]; decisions: PlanModel["decisions"] } | null
}

export async function savePlanApprovals(ctx: WizardContext, deps: WizardDeps, saved: Omit<SavedPlanApprovals, "schema">): Promise<void> {
  await deps.fs.mkdirp(join(ctx.root, WIZARD_PATHS.dir), 0o700)
  const file: SavedPlanApprovals = { schema: PLAN_APPROVALS_SCHEMA, ...saved }
  await deps.fs.writeTextAtomic(join(ctx.root, PLAN_APPROVALS_RELATIVE_PATH), `${JSON.stringify(file, null, 2)}\n`, WIZARD_STATE_FILE_MODE)
}

export async function loadPlanApprovals(ctx: WizardContext, deps: WizardDeps): Promise<SavedPlanApprovals | null> {
  const text = await deps.fs.readText(join(ctx.root, PLAN_APPROVALS_RELATIVE_PATH))
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as SavedPlanApprovals
    return parsed.schema === PLAN_APPROVALS_SCHEMA ? parsed : null
  } catch {
    return null
  }
}

/** The keys without the bridge envelope. */
export function keysOnly(response: TagKeys): TagKeys {
  return { infinite: response.infinite, ga4: response.ga4, posthog: response.posthog, meta: response.meta, serverLane: response.serverLane }
}

function hostingOnly(response: TagHosting): TagHosting {
  return { provider: response.provider, vercel: response.vercel }
}

export interface PlanInputs {
  before: WizardBeforeFacts
  keys: TagKeys
  hosting: TagHosting
  /** False when `before`'s live facts were not available (measured values then show "—"). */
  liveFacts: boolean
}

/**
 * `before`'s facts for this run; without them (a fresh process after an old run), the keys and hosting
 * are re-read from the app and the static census re-run, with NO live facts (never invented).
 */
export async function loadPlanInputs(ctx: WizardContext, deps: WizardDeps): Promise<PlanInputs | { missingCapability: string }> {
  // The `keys` step's GA4 stream / Meta pixel choice narrows the connection's keys (P1-9).
  const choices = await readKeysChoices(deps.fs, ctx.root, ctx.runId)
  const saved = await readBeforeFacts(deps.fs, ctx.root, ctx.runId)
  if (saved) {
    const keys = narrowKeysToChoices(keysOnly(saved.keys), choices)
    return { before: { ...saved, keys }, keys, hosting: saved.hosting, liveFacts: saved.dryLive !== null && saved.dryLive !== undefined }
  }
  for (const capability of ["tag.keys.v1", "tag.hosting.v1"] as const) {
    if (!deps.bridge.has(capability)) return { missingCapability: capability }
  }
  const keys = narrowKeysToChoices(keysOnly(await deps.bridge.keys({ signal: ctx.signal })), choices)
  const hosting = hostingOnly(await deps.bridge.hosting(undefined, { signal: ctx.signal }))
  const census = await deps.checks.census(ctx.root, ctx.appRoot)
  return {
    before: { hosting, keys, census, dryLive: null, checks: [], observedProductionHost: null },
    keys,
    hosting,
    liveFacts: false
  }
}

/** A bridge error's code, duck-typed (O2's client throws errors carrying the §3a.2 `code`). */
export function bridgeErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null
  const direct = (error as { code?: unknown }).code
  if (typeof direct === "string") return direct
  const nested = (error as { error?: { code?: unknown } }).error?.code
  return typeof nested === "string" ? nested : null
}

/**
 * The candidates the plan is built from: the ones `before` seeded. After the plan, `state.jobs` holds
 * the approved items instead, so a re-run of the plan (or `install`) for the SAME `before` run reads
 * the saved originals; a new `before` run's candidates are in `state.jobs`.
 */
export async function planCandidates(ctx: WizardContext, deps: WizardDeps): Promise<ChecklistItem[]> {
  const saved = await loadPlanApprovals(ctx, deps)
  const beforeAt = ctx.state.get().steps.before?.at ?? null
  if (saved && saved.beforeAt === beforeAt) return saved.candidates
  return [...ctx.state.get().jobs]
}
