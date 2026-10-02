// Step 12 `done` (§3d.1): "What happened". Build the before/after report from the run's three column
// snapshots, post it to Infinite (one phase per column), comment it on the PR, PATCH the run (`proven`,
// `checkinOptIn`), and leave the report where the outro and the exit line can find it.
//
// Nothing here computes a cell: every cell was built by a column builder from typed sources; the report
// builder re-checks each one (§3i.3, §3i.7) before anything is posted.
import { createHash } from "node:crypto"
import { basename, join } from "node:path"

import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import { REPORT_COLUMN_IDS, REPORT_SCHEMA, SAMPLE_FLOOR_PAGE_VIEWS, type ReportColumnId, type ReportV2 } from "../contracts/report.js"
import { WIZARD_PATHS } from "../contracts/state.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"
import { proofStateFrom } from "./prove.js"

/** Where the final report lands (inside the gitignored `.infinite/wizard/`). */
export const WIZARD_REPORT_PATHS = {
  json: `${WIZARD_PATHS.dir}/report.json`,
  markdown: `${WIZARD_PATHS.dir}/report.md`
} as const

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
  if (!remote) return basename(root)
  let text = remote.trim()
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(text)
  if (scp) text = `${scp[1]}/${scp[2]}`
  else {
    try {
      const url = new URL(text)
      text = `${url.hostname}${url.pathname}`
    } catch {
      text = text.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]*@/, "")
    }
  }
  text = text.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "")
  const slash = text.indexOf("/")
  return slash > 0 ? `${text.slice(0, slash).toLowerCase()}${text.slice(slash)}` : text.toLowerCase()
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
  return notes
}

function shortDate(iso: string): string {
  const date = new Date(iso)
  return `${date.getUTCDate()} ${date.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`
}

async function runDone(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  const state = ctx.state.get()
  const runId = state.runId
  if (!runId) return { kind: "skipped", reason: "No Infinite run was created, so there is no report to send." }

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

  const markdown = deps.report.renderMarkdown(report)
  await deps.fs.writeTextAtomic(join(ctx.root, WIZARD_REPORT_PATHS.json), `${JSON.stringify(payload, null, 2)}\n`, 0o600)
  await deps.fs.writeTextAtomic(join(ctx.root, WIZARD_REPORT_PATHS.markdown), `${markdown}\n`, 0o600)

  const prNumber = state.pr?.number ?? null
  if (prNumber !== null && deps.host.kind === "github") {
    const commented = await deps.host.comment(prNumber, `${markdown}\n\n<!-- infinite-tag:report v1 run=${runId} -->`)
    if (commented && typeof commented === "object" && "unsupported" in commented) {
      ctx.emit.emit("step.sub", { step: "done", text: "The report is in .infinite/wizard/report.md (this host has no comment API).", tone: "info" })
    }
  }

  const proven = state.report.proven_live ? proofStateFrom(state.report.proven_live) === "proven" : false
  const run = await deps.bridge.patchRun(runId, { checkinOptIn: DEFAULT_CHECKIN_OPT_IN, ...(proven ? { phase: "proven" } : {}) })
  const due = run.run.checkinDueAt
  ctx.emit.emit("step.sub", { step: "done", text: "✓ Report sent", tone: "ok" })
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
  inputHash: (ctx) => {
    const state = ctx.state.get()
    const columns = REPORT_COLUMN_IDS.map((column) => state.report[column]?.meta ?? null)
    return `sha256:${createHash("sha256").update(JSON.stringify(["done", state.runId, columns])).digest("hex")}`
  },
  run: runDone
}
