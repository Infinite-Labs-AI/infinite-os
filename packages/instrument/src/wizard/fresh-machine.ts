// §3d.6 / §3z.5 (B25): a fresh machine (a new clone, a teammate's laptop) has no `.infinite/wizard/state.json`.
// When the author has an OPEN wizard pull request in this repo, its body marker
// (`<!-- infinite-tag:pr v1 run=<runId> -->`) names the run, and the minimal run state is rebuilt from it:
// the run id, the pull request and its branch + base. The link step then asks the linked workspace for that
// run once (`runs.get`; a 404 halts with `--fresh`), and `before` switches to the branch and re-derives the
// base SHA (`merge-base`). A merged or closed PR is not resumed here: the run starts fresh.
import { findWizardPrs } from "../github/pr.js"
import { isGitHubAdapter } from "../hosts/github.js"
import type { GitHostAdapter } from "./contracts/git-host.js"
import type { WizardRunState } from "./contracts/state.js"

export interface RebuiltRun {
  runId: string
  prNumber: number
  branch: string
}

/**
 * Rebuilds `state` in place from the newest OPEN wizard PR, or returns null (not GitHub, no such PR, or the
 * host CLI cannot list PRs: a fresh run is the documented answer then, nothing is invented).
 */
export async function rebuildFromPrMarker(state: WizardRunState, host: GitHostAdapter): Promise<RebuiltRun | null> {
  if (!isGitHubAdapter(host)) return null
  let found: Awaited<ReturnType<typeof findWizardPrs>>
  try {
    found = await findWizardPrs(host.gh)
  } catch {
    return null
  }
  const open = found.filter((entry) => entry.pr.state === "OPEN" && entry.base !== null).sort((a, b) => b.pr.number - a.pr.number)[0]
  if (!open || open.base === null) return null
  state.runId = open.runId
  state.pr = {
    host: "github",
    number: open.pr.number,
    url: open.pr.url,
    nodeId: open.pr.nodeId,
    isDraft: open.pr.isDraft,
    round: 0,
    reviewedSha: null,
    handledThreadIds: [],
    mergeSha: null
  }
  // `baseSha: ""` = not known yet; `before` re-derives it once the branch is checked out.
  state.git = { base: open.base, baseSource: "default_branch", branch: open.branch, baseSha: "", headSha: null }
  return { runId: open.runId, prNumber: open.pr.number, branch: open.branch }
}
