// The "In this pull request" column beyond the rehearsal's own cells (final verify F12: the column a reviewer
// reads before merging was "—" for 6 of 9 rows, "Checks passing" among them).
//
// Everything here comes from the wizard's own pre-merge evidence of THIS run (§3i.7's `in_pr` sources):
// - the static checks the wizard ran on the jobs (`ChecklistItem.checks`, tier S, stamped with this run's id):
//   conversions wired on the server (job 8), visits joined to accounts (job 9), the preview guard (job 7);
// - the plan's answers and lines (the consent choice, the 7-day check-in);
// - Infinite's own answers (the consent mode it holds for the site, the GA4 key events it marked);
// - the rehearsal's cells (written by `rehearsalCells`), which `checks_passing` and two rows are derived from.
// Nothing is read from an agent's claim: a job the wizard could not check is unknown, never "wired". A row with
// no pre-merge evidence is left out, so the report shows "—" with its reason.
import type { TagKeys } from "../wizard/contracts/bridge.js"
import type { ChecklistItem, ChecklistItemCheck, JobId } from "../wizard/contracts/jobs.js"
import { NULL_DISPLAY, type Cell, type FinishLineId, type ProvenanceSource, type Reason, type ReportColumnSnapshot, type ReportRowId } from "../wizard/contracts/report.js"
import type { WizardRunState } from "../wizard/contracts/state.js"
import { checksPassingCell } from "../wizard/report.js"

type InPrCells = Pick<ReportColumnSnapshot, "cells" | "finishLine">

function cell(state: Cell["state"], value: string | number | null, display: string, source: ProvenanceSource, at: string, runId: string, extra: { reason?: Reason; checkId?: string } = {}): Cell {
  return {
    value,
    display: value === null ? NULL_DISPLAY : display,
    state,
    provenance: { source, at, runId, ...(extra.checkId ? { checkId: extra.checkId } : {}) },
    ...(extra.reason ? { reason: extra.reason } : {})
  }
}

/** A job item by the wizard's own static checks of this run: all pass, one a problem, or not decided. */
function staticVerdict(item: ChecklistItem, runId: string): "pass" | "problem" | "unknown" {
  const checks = item.checks.filter((check: ChecklistItemCheck) => check.tier === "S")
  if (checks.some((check) => check.state === "problem" && check.runId === runId)) return "problem"
  if (checks.length > 0 && checks.every((check) => check.state === "pass" && check.runId === runId)) return "pass"
  return "unknown"
}

function verdicts(jobs: readonly ChecklistItem[], jobId: JobId, runId: string): Array<{ item: ChecklistItem; verdict: "pass" | "problem" | "unknown" }> {
  return jobs.filter((item) => item.jobId === jobId).map((item) => ({ item, verdict: staticVerdict(item, runId) }))
}

/** A conversion name is the user's own data: it is shown only when it is a plain short name. */
const PLAIN_NAME = /^[A-Za-z0-9_.-]{1,40}$/

export function consentWords(mode: "not_required" | "required"): string {
  return mode === "required" ? "waits for your banner's yes" : "starts with your site's own analytics, or on page load if it has none"
}

/**
 * The cells the jobs' static checks, the plan and Infinite's own answers give the column. `keys` is this step's
 * read of the connections (null = not read): the consent mode counts as recorded only when Infinite holds the
 * same value the plan chose.
 */
export function preMergeCells(state: Pick<WizardRunState, "jobs" | "plan">, input: { at: string; runId: string; keys?: TagKeys | null }): InPrCells {
  const { at, runId } = input
  const cells: Partial<Record<ReportRowId, Cell>> = {}
  const finishLine: Partial<Record<FinishLineId, Cell>> = {}

  // 6 conversions_server_side + the "Conversions sent from the server" row: job 8's static checks.
  const conversions = verdicts(state.jobs, "server_conversions", runId)
  if (conversions.length > 0) {
    const wired = conversions.filter((entry) => entry.verdict === "pass")
    const problems = conversions.filter((entry) => entry.verdict === "problem").length
    const names = wired.map((entry) => entry.item.id.slice(entry.item.id.indexOf(":") + 1))
    const named = names.length > 0 && names.length <= 6 && names.every((name) => PLAIN_NAME.test(name)) ? ` (${names.join(", ")})` : ""
    const extra = { checkId: "outcome_declared" }
    if (problems > 0) {
      const display = `${wired.length} of ${conversions.length} wired in code`
      finishLine.conversions_server_side = cell("problem", "problem", display, "wizard_check", at, runId, extra)
      cells.server_conversions = cell("problem", wired.length, display, "wizard_check", at, runId, extra)
    } else if (wired.length === conversions.length) {
      finishLine.conversions_server_side = cell("pass", "pass", `${wired.length} wired in code`, "wizard_check", at, runId, extra)
      cells.server_conversions = cell("pass", wired.length, `${wired.length} wired${named}`, "wizard_check", at, runId, extra)
    } else {
      finishLine.conversions_server_side = cell("undetermined", null, NULL_DISPLAY, "wizard_check", at, runId, { ...extra, reason: "not_exercised" })
      cells.server_conversions =
        wired.length > 0
          ? cell("undetermined", wired.length, `${wired.length} of ${conversions.length} wired in code`, "wizard_check", at, runId, extra)
          : cell("undetermined", null, NULL_DISPLAY, "wizard_check", at, runId, { ...extra, reason: "not_exercised" })
    }
  }

  // 7 identity_joined: job 9, checked by the review agent (identify on sign-in, reset on sign-out).
  const identity = verdicts(state.jobs, "identify_reset", runId)
  if (identity.length > 0) {
    const extra = { checkId: "jobs_review" }
    finishLine.identity_joined = identity.some((entry) => entry.verdict === "problem")
      ? cell("problem", "problem", "identify or reset is missing in code", "wizard_check", at, runId, extra)
      : identity.every((entry) => entry.verdict === "pass")
        ? cell("pass", "pass", "identify on sign-in, reset on sign-out", "wizard_check", at, runId, extra)
        : cell("undetermined", null, NULL_DISPLAY, "wizard_check", at, runId, { ...extra, reason: "not_exercised" })
  }

  // 9 consent_recorded + the "Consent setting" row: the plan's answer, and what Infinite holds for the site.
  const chosen = state.plan?.answers.consentMode ?? null
  if (chosen) {
    const held = input.keys?.infinite.consentMode ?? null
    const consent =
      held === chosen
        ? cell("info", chosen, `${consentWords(chosen)} (recorded in Infinite)`, "cloud_read", at, runId)
        : held === null
          ? cell("info", chosen, `${consentWords(chosen)} (set by this run; not read back from Infinite)`, "plan_answer", at, runId)
          : cell("problem", held, `this run set "${consentWords(chosen)}"; Infinite has "${consentWords(held)}"`, "cloud_read", at, runId, { reason: "test_error" })
    finishLine.consent_recorded = consent
    cells.consent_setting = consent
  }

  // 14 keeps_being_checked: the plan's 7-day check-in line (on by default; the plan shows it).
  if (state.plan?.lines.some((line) => line.id === "checkin")) {
    finishLine.keeps_being_checked = cell("pass", "pass", "7-day check-in is on", "plan_answer", at, runId)
  }
  return { cells, finishLine }
}

/**
 * The cells derived from the column's other cells, written last: the "Page views from preview links" row (the
 * rehearsal's load of the preview's own URL, and job 7's static guard check) and `checks_passing`, counted over
 * all 14 finish-line cells the column holds.
 */
export function derivedInPrCells(column: InPrCells, state: Pick<WizardRunState, "jobs">, input: { at: string; runId: string }): InPrCells {
  const { at, runId } = input
  const cells: Partial<Record<ReportRowId, Cell>> = {}
  const silent = column.finishLine.previews_silent
  const guards = verdicts(state.jobs, "preview_guard", runId)
  const guardAdded = guards.length > 0 && guards.every((entry) => entry.verdict === "pass")
  const extra = { checkId: "preview_self_silent" }
  if (silent?.state === "pass") {
    cells.preview_share = cell("pass", "silent", guardAdded ? "guard added · the preview link sent nothing" : "the preview link sent nothing", "desktop_test", at, runId, extra)
  } else if (silent?.state === "problem") {
    cells.preview_share = cell("problem", "sends data", "the preview link sends data", "desktop_test", at, runId, extra)
  } else if (guardAdded) {
    cells.preview_share = cell("info", "guard added", "guard added (the preview link was not loaded)", "wizard_check", at, runId, { checkId: "jobs_review" })
  } else if (silent?.reason) {
    cells.preview_share = cell("undetermined", null, NULL_DISPLAY, "desktop_test", at, runId, { ...extra, reason: silent.reason })
  }
  cells.checks_passing = checksPassingCell(column.finishLine, runId, at)
  return { cells, finishLine: {} }
}

/**
 * The GA4 key events Infinite marked for this run's click-tested conversions (`ga4-key-events` response): the
 * row and finish-line 11 (`info` by §3i.7: marked now, received later). `already` is the count an earlier
 * response of this run recorded (the review step marks only the new names).
 */
export function ga4KeyEventCells(marked: number, already: number, input: { at: string; runId: string }): InPrCells {
  const total = marked + already
  if (total <= 0) return { cells: {}, finishLine: {} }
  const { at, runId } = input
  return {
    cells: { ga4_key_events: cell("info", total, `${total} marked as key event${total === 1 ? "" : "s"} (click test passed)`, "cloud_read", at, runId) },
    finishLine: { ga4_key_events_received: cell("info", "info", "marked in GA4; received later", "cloud_read", at, runId) }
  }
}
