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
  const proof = state.ownerBoundary
  const currentHead = proof?.state === "checked" && proof.scope === "commit" && typeof git.head === "function" ? await git.head().catch(() => null) : null
  const ownerBoundary = proof?.scope === "commit" && proof.baseSha === base && proof.headSha === currentHead && proof.issues.length === 0 ? proof : undefined
  return {
    tagNotInstalled: (await loadPlanApprovals(ctx, deps))?.ownerWiring?.canWire === false,
    ...(ownerBoundary ? { ownerBoundary } : {}),
    ...(priorPolicyEdits ? { priorPolicyEdits: true } : {}),
    ownerPolicyFindings: (ledger.findings ?? []).filter(finding => finding.action === "OWNER_INFO" && !(finding.path !== null && ownership.writtenByRun?.(finding.path, finding.line))).map(finding => display(`About the site owner’s consent/privacy: not ours to change. ${finding.path ?? "general"}: ${finding.body ?? "Recorded reviewer finding"}`)),
    jobs: state.jobs.map(job => ({ ...job, title: display(job.title), ...(job.note ? { note: display(job.note) } : {}) })),
    openFindings: openFindings(ledger, state.jobs, ownership.classify, ownership.writtenByRun).map(finding => ({ ...finding, path: finding.path === null ? null : display(finding.path) })),
    tools: state.proof?.tools ?? null,
    installedUnknown: state.proof?.installedUnknown ?? null
  }
}
