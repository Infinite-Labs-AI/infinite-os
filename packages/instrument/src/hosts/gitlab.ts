// GitLab (§3g.2): no `glab`. The draft merge request is opened by git push options
// (`-o merge_request.create -o merge_request.target=<base> -o merge_request.draft`); if GitLab refuses them,
// the step pushes plainly and prints the link. Every other method is unsupported, and the review goes to
// `.infinite/wizard/REVIEW.md`.
import type { GitHostAdapter } from "../wizard/contracts/git-host.js"
import type { WizardGitOps } from "../git/index.js"
import { unsupportedAdapter } from "./other.js"

export function createGitLabAdapter(_git: Pick<WizardGitOps, "pushWithOptions">): GitHostAdapter {
  return {
    ...unsupportedAdapter("gitlab"),
    async createDraftPr() {
      // Merge-request push options run only at the measured, SHA-pinned shipping boundary.
      return { unsupported: true }
    }
  }
}
