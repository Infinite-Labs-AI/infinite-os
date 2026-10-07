import { ownerInformationOnly, reviewReliabilityWarning } from "../review/integrity.js"
import { loadPlanApprovals } from "../install/step-inputs.js"
import { buildScanner, runPublicIds } from "../review/context.js"
import { safeDisplayText } from "../review/display.js"
// §3x.6 The run facts THE verdict reads beyond the report's columns, gathered in ONE place for every caller (the
// rehearsal's PR body, the review's final comment, the merge card's in-PR report, `prove`'s PATCH and `done`):
// the run's checklist, the review's open findings (`openFindings`, the one definition) and the real visit's per-tool
// facts (`state.proof`, written by `prove`).
import { join } from "node:path"
import { reanchorOwnerLocations } from "../jobs/owner-locations.js"
import { hasRecordedPolicyEdits } from "../jobs/owner-boundary.js"
import { ownerBoundaryForState } from "./owner-proof.js"

import { openFindings, parseLedger, REVIEW_LEDGER_PATH } from "../review/ledger.js"
import { wizardOwnership } from "../review/ownership.js"
import type { WizardContext, WizardDeps } from "./contracts/deps.js"
import type { WizardGitOps } from "./contracts/git-host.js"
import type { VerdictFacts } from "./contracts/report.js"

export async function verdictFactsFor(ctx: WizardContext, deps: WizardDeps): Promise<VerdictFacts> {
  const reanchoredJobs = await reanchorOwnerLocations(ctx.root, ctx.state.get().jobs)
  // A read-only report can use corrected locations without rewriting saved policy/source files.
  const state = { ...ctx.state.get(), jobs: reanchoredJobs }
  const scanner = buildScanner(ctx, { ...deps, env: deps.env ?? {} }, await runPublicIds(ctx, deps))
  const display = (text: string) => safeDisplayText(scanner, text)
  const runId = state.runId ?? ctx.runId ?? ""
  const ledger = parseLedger(await deps.fs.readText(join(ctx.root, REVIEW_LEDGER_PATH)), runId)
  const base = state.git?.baseSha ?? null
  const git = deps.git as Partial<WizardGitOps>
  const showFile = typeof git.showFile === "function" ? git.showFile.bind(deps.git) : null
  // Whose code an open finding is on (a ledger written before §3x.3 recorded no label).
  const ownership = await wizardOwnership(deps, ctx.root, async (path) => {
    if (base === null || showFile === null) return null
    try {
      return (await showFile(base, path)) !== null
    } catch {
      return null
    }
  })
  // The receipt may outlive a retired job's entry in state. Read only its job/run metadata;
  // never open a policy file, inspect embedded policy text, or undo an earlier edit.
  const priorPolicyEdits = hasRecordedPolicyEdits(state.jobs) || ownership.recordedPolicyEdits?.(runId) === true
  const currentHead = typeof git.head === "function" ? await git.head().catch(() => null) : null
  const measured = await ownerBoundaryForState(ctx.root, ctx.appRoot, state, currentHead)
  const ownerBoundary = { ...measured, files: measured.files.map(display), issues: measured.issues.map(issue => ({ file: display(issue.file), reason: display(issue.reason) })),
    ...(measured.unverifiedReason ? { unverifiedReason: display(measured.unverifiedReason) } : {}) }  const reviewUnreliable = reviewReliabilityWarning(ledger.rounds.at(-1)?.review?.findings ?? ledger.findings ?? [])
  return {
    ...(reviewUnreliable ? { reviewUnreliable } : {}),
    tagNotInstalled: (await loadPlanApprovals(ctx, deps))?.ownerWiring?.canWire === false,
    ...(ownerBoundary ? { ownerBoundary } : {}),
    ...(priorPolicyEdits ? { priorPolicyEdits: true } : {}),
    ownerPolicyFindings: (ledger.findings ?? []).filter(finding => finding.action === "OWNER_INFO" && !reviewUnreliable && ownerInformationOnly(finding) && !(finding.path !== null && ownership.writtenByRun?.(finding.path, finding.line))).map(finding => display(`About the site owner’s consent/privacy: not ours to change. ${finding.path ?? "general"}: ${finding.body ?? "Recorded reviewer finding"}`)),
    jobs: state.jobs.map(job => {
      // These are report-only copies: source paths and executable text in state stay untouched.
      const boundary = job.ownerBoundary ? { ...job.ownerBoundary } : undefined
      let withheld = false
      if (boundary) {
        if (boundary.file) boundary.file = display(boundary.file)
        for (const field of ["guard", "wiring"] as const) {
          const snippet = boundary[field]
          if (snippet !== undefined && (scanner.redact(snippet).text !== snippet || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(snippet))) {
            delete boundary[field]
            withheld = true
          }
        }
      }
      const note = withheld
        ? `Copyable owner snippet withheld because it contains sensitive text or terminal controls. Review the named file locally.${job.note ? ` ${display(job.note)}` : ""}`
        : job.note ? display(job.note) : undefined
      return { ...job, title: display(job.title), allow: { files: job.allow.files.map(display), create: job.allow.create.map(display) },
        ...(boundary ? { ownerBoundary: boundary } : {}), ...(note ? { note } : {}) }
    }),
    openFindings: openFindings(ledger, state.jobs, ownership.classify, ownership.writtenByRun).map(finding => ({ ...finding, path: finding.path === null ? null : display(finding.path) })),
    tools: state.proof?.tools ?? null,
    installedUnknown: state.proof?.installedUnknown ?? null
  }
}
