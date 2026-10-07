// §3x.6 The run facts THE verdict reads beyond the report's columns, gathered in ONE place for every caller (the
// rehearsal's PR body, the review's final comment, the merge card's in-PR report, `prove`'s PATCH and `done`):
// the run's checklist, the review's open findings (`openFindings`, the one definition) and the real visit's per-tool
// facts (`state.proof`, written by `prove`).
import { join } from "node:path"
import { hasRecordedPolicyEdits } from "../jobs/owner-boundary.js"

import { openFindings, parseLedger, REVIEW_LEDGER_PATH } from "../review/ledger.js"
import { wizardOwnership } from "../review/ownership.js"
import type { WizardContext, WizardDeps } from "./contracts/deps.js"
import type { WizardGitOps } from "./contracts/git-host.js"
import type { VerdictFacts } from "./contracts/report.js"

export async function verdictFactsFor(ctx: WizardContext, deps: WizardDeps): Promise<VerdictFacts> {
  const state = ctx.state.get()
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
  return {
    ...(priorPolicyEdits ? { priorPolicyEdits: true } : {}),
    jobs: state.jobs,
    openFindings: openFindings(ledger, state.jobs, ownership.classify),
    tools: state.proof?.tools ?? null,
    installedUnknown: state.proof?.installedUnknown ?? null
  }
}
