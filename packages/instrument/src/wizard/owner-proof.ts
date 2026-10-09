import { measureWizardCommits, type OwnerBoundaryMeasurement } from "../jobs/owner-diff.js"
import type { WizardRunState } from "./contracts/state.js"

/** Recheck the current head for reports; never drop a failed/stale/legacy result into silence. */
export async function ownerBoundaryForState(root: string, appRoot: string, state: Readonly<WizardRunState> | null, headSha: string | null): Promise<OwnerBoundaryMeasurement> {
  const baseSha = state?.git?.baseSha ?? ""
  if (/^[a-f0-9]{40}$/.test(baseSha) && headSha && /^[a-f0-9]{40}$/.test(headSha)) {
    return measureWizardCommits({ root, appRoot, baseSha, headSha, wizardCommits: state?.wizardCommits, historyReason: state?.commitHistory?.unverifiedReason })
  }
  const previous = state?.ownerBoundary
  return { state: "not_checked", scope: "commit", baseSha, headSha: headSha ?? "", files: previous?.files ?? [], issues: previous?.issues ?? [],
    filesAvailable: previous?.filesAvailable ?? false,
    wizardCommits: [], measuredCommitCount: 0, fileScope: "branch_history",
    unverifiedReason: state?.commitHistory?.unverifiedReason ?? previous?.unverifiedReason ?? "the saved base or current branch head could not be read" }
}
