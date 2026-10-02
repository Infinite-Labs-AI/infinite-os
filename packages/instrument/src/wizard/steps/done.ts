// Step 12 `done` (§3d.1): "What happened". In this order:
// 1. PATCH `checkinOptIn` first: the 7-day check-in never depends on a later post or comment succeeding,
//    and its due date is the cloud read the "keeps being checked" finish-line cell needs;
// 2. build the before/after report from the run's three column snapshots and post it to Infinite (one
//    phase per column; the echo must be this run's);
// 3. PATCH `proven` (only after Infinite accepted the report, and only when the column proves it);
// 4. write the report where the outro and the exit line find it, then comment it on the PR (a comment
//    failure is reported, never fatal: everything else is already saved).
//
// Nothing here computes a cell: every cell was built by a column builder from typed sources; the report
// builder re-checks each one (§3i.3, §3i.7) before anything is posted.
import { normalizeRemote } from "../../bridge/repo-identity.js"
import { bridgeFailureOutcome } from "../../bridge/outcomes.js"
import { buildScanner, loadRunFacts } from "../../review/context.js"
import { safeText } from "../../review/post.js"
import { BRIDGE_BOUNDS } from "../contracts/bridge.js"
import { PR_MARKERS } from "../contracts/git-host.js"
import { createHash } from "node:crypto"
import { basename, join } from "node:path"

import { withFinishLineReadings } from "../report.js"

import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import { REPORT_COLUMN_IDS, REPORT_SCHEMA, SAMPLE_FLOOR_PAGE_VIEWS, type ReportColumnId, type ReportV2 } from "../contracts/report.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"
import { WIZARD_REPORT_PATHS } from "../run-state.js"
import { proofStateFrom } from "./prove.js"

/** Where the final report lands (inside the gitignored `.infinite/wizard/`). */
export { WIZARD_REPORT_PATHS }

/** The accepted default (BUILD-PLAN §1.4): the 7-day check-in is on; the plan has no line that turns it off. */
export const DEFAULT_CHECKIN_OPT_IN = true

export const REAL_VISIT_DISCLOSURE =
  "A real visit lands two bot-flagged document rows in your Infinite ledger (the page load and the server-lane probe)."
export const SAMPLE_FLOOR_NOTE = `Below ${SAMPLE_FLOOR_PAGE_VIEWS} page views a share is shown as raw counts.`

/**
 * The repo label the report shows: the normalised remote (no userinfo, query, fragment or `.git`;
 * `git@host:a/b` → `host/a/b`), else the folder name. Never the raw remote.
 */
export function repoLabelFromRemote(remote: string | null, root: string): string {
  // ONE normaliser (§3z.12 B9): lane O2's `normalizeRemote` (the link card's label).
  const label = (remote ? normalizeRemote(remote) : null) ?? basename(root)
  return label.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim()
}

function notesFor(ctx: WizardContext, report: Pick<ReportV2, "rows">): string[] {
  const notes: string[] = []
  const state = ctx.state.get()
  const hasSmallShare = report.rows.some((row) =>
    REPORT_COLUMN_IDS.some((column) => {
      const raw = row.cells[column].raw
      return raw !== undefined && raw.denominator < SAMPLE_FLOOR_PAGE_VIEWS
    })
  )
  if (hasSmallShare) notes.push(SAMPLE_FLOOR_NOTE)
  if (state.markers.prove.probePath || (state.markers.prove.infiniteEventIds?.length ?? 0) > 0) notes.push(REAL_VISIT_DISCLOSURE)
  // B22: the model and effort the agents ran with (a fallback to the user's default model is said plainly).
  const models = state.agent?.models
  if (state.agent?.worker && models?.worker) {
    const label = state.agent.worker === "codex" ? "Codex" : "Claude Code"
    notes.push(models.worker.fallback ? `${label} ran on your default model (the pinned model is not on your plan), effort ${models.worker.effort}.` : `${label} ran ${models.worker.model} at ${models.worker.effort} effort.`)
  }
  return notes
}

function shortDate(iso: string): string {
  const date = new Date(iso)
  return `${date.getUTCDate()} ${date.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`
}

async function writeReportFiles(ctx: WizardContext, deps: WizardDeps, payload: unknown, markdown: string): Promise<void> {
  await deps.fs.writeTextAtomic(join(ctx.root, WIZARD_REPORT_PATHS.json), `${JSON.stringify(payload, null, 2)}\n`, 0o600)
  await deps.fs.writeTextAtomic(join(ctx.root, WIZARD_REPORT_PATHS.markdown), `${markdown}\n`, 0o600)
}

async function runDone(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  const runId = ctx.state.get().runId
  if (!runId) return { kind: "skipped", reason: "No Infinite run was created, so there is no report to send." }

  // 1. The check-in first; its due date is the "keeps being checked" reading for the proven column.
  const optedIn = await deps.bridge.patchRun(runId, { checkinOptIn: DEFAULT_CHECKIN_OPT_IN })
  const due = optedIn.run.checkinDueAt
  const proven = ctx.state.get().report.proven_live
  if (proven) {
    const at = deps.clock.now().toISOString()
    const withCheckin = withFinishLineReadings(
      "proven_live",
      proven,
      "keeps_being_checked",
      [{ input: "run.checkin_due_at", state: due ? "pass" : "pending", display: due ? `7-day check-in on ${shortDate(due)}` : "7-day check-in after the deploy", at }],
      runId
    )
    ctx.state.update((draft) => {
      draft.report.proven_live = withCheckin
    })
    await ctx.state.save()
  }
  const state = ctx.state.get()

  const keys = deps.bridge.has("tag.keys.v1") ? await deps.bridge.keys() : null
  const site = {
    repoLabel: repoLabelFromRemote(await deps.git.remoteUrl(), ctx.root),
    productionHost: keys?.infinite.productionHosts[0] ?? null
  }
  const provenPending: ReportV2["columns"]["proven_live"]["pending"] = state.report.proven_live
    ? null
    : ctx.options.noProve
      ? "open_infinite"
      : "deploy"
  const draft = deps.report.build({
    runId,
    tagVersion: deps.tagVersion,
    site,
    columns: state.report,
    provenLivePending: provenPending,
    day7: null,
    notes: []
  })
  const report = deps.report.build({
    runId,
    tagVersion: deps.tagVersion,
    site,
    columns: state.report,
    provenLivePending: provenPending,
    day7: null,
    notes: notesFor(ctx, draft)
  })
  const payload = deps.report.payload(report)

  ctx.emit.emit("step.sub", { step: "done", text: "Sending the report to Infinite…", tone: "pending" })
  // §3z.8 (A14): the compact JSON report is at most 56,000 bytes; the tag checks before posting.
  const compactBytes = Buffer.byteLength(JSON.stringify(payload), "utf8")
  if (compactBytes > BRIDGE_BOUNDS.reportMaxBytes) {
    await writeReportFiles(ctx, deps, payload, deps.report.renderMarkdown(report))
    return {
      kind: "failed",
      code: "INF_WIZ_PROOF_INCOMPLETE",
      message: `The report is ${compactBytes} bytes, over Infinite's ${BRIDGE_BOUNDS.reportMaxBytes}-byte limit; it was not sent (it is in .infinite/wizard/report.md).`,
      next: "continue"
    }
  }
  const phases = REPORT_COLUMN_IDS.filter((column: ReportColumnId) => state.report[column] !== null)
  for (const phase of phases) {
    const stored = await deps.bridge.postReport(runId, phase, payload)
    if (stored.echo.schema !== REPORT_SCHEMA || stored.echo.runId !== runId) {
      return {
        kind: "failed",
        code: "INF_WIZ_PROOF_INCOMPLETE",
        message: `Infinite stored the ${phase} report under another run or schema (${stored.echo.runId}, ${stored.echo.schema}); it was not accepted as this run's.`,
        next: "continue"
      }
    }
    ctx.emit.emit("report", { phase, report: payload })
  }

  // 3. `proven` only once Infinite holds this run's report.
  if (state.report.proven_live && proofStateFrom(state.report.proven_live) === "proven") {
    await deps.bridge.patchRun(runId, { phase: "proven" })
  }

  // 4. The files, then the PR comment (last: a failure there loses nothing).
  const markdown = deps.report.renderMarkdown(report)
  await writeReportFiles(ctx, deps, payload, markdown)
  ctx.emit.emit("step.sub", { step: "done", text: "✓ Report sent", tone: "ok" })

  const prNumber = state.pr?.number ?? null
  if (prNumber !== null && deps.host.kind === "github") {
    try {
      // B29: every string the wizard posts goes through the §3g.5 secret scan (tokens, keys, env values).
      const facts = await loadRunFacts(deps)
      const scanner = buildScanner(ctx, deps, facts.connectionIds)
      const commented = await deps.host.comment(prNumber, `${safeText(scanner, markdown)}\n\n${PR_MARKERS.report(runId)}`)
      if (commented && typeof commented === "object" && "unsupported" in commented) {
        ctx.emit.emit("step.sub", { step: "done", text: "The report is in .infinite/wizard/report.md (this host has no comment API).", tone: "info" })
      }
    } catch (error) {
      ctx.emit.emit("step.sub", {
        step: "done",
        text: `Could not comment the report on the PR (${error instanceof Error ? error.message : String(error)}); it is in .infinite/wizard/report.md.`,
        tone: "warn"
      })
    }
  }
  return {
    kind: "ok",
    status: `Report in Site Settings · 7-day check-in ${due ? `on ${shortDate(due)}` : "after the deploy"}`
  }
}

export const step: WizardStep<"done"> = {
  id: "done",
  title: WIZARD_STEP_META.done.title,
  who: [...WIZARD_STEP_META.done.who],
  learn: WIZARD_STEP_META.done.learn,
  requiredCapabilities: [...WIZARD_STEP_META.done.requiredCapabilities],
  // F0's structural step test calls inputHash with an empty context, so a missing state hashes as nulls.
  inputHash: (ctx) => {
    const state = ctx.state?.get()
    const columns = REPORT_COLUMN_IDS.map((column) => state?.report[column]?.meta ?? null)
    return `sha256:${createHash("sha256").update(JSON.stringify(["done", state?.runId ?? null, columns])).digest("hex")}`
  },
  async run(ctx, deps) {
    try {
      return await runDone(ctx, deps)
    } catch (error) {
      // §3z.4: a bridge failure the step cannot carry on from is an outcome, never a crash.
      const outcome = bridgeFailureOutcome(error)
      if (outcome) return outcome
      throw error
    }
  }
}
