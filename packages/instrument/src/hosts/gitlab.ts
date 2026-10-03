// GitLab (§3g.2): no `glab`. The draft merge request is opened by git push options
// (`-o merge_request.create -o merge_request.target=<base> -o merge_request.draft`); if GitLab refuses them,
// the step pushes plainly and prints the link. Every other method is unsupported, and the review goes to
// `.infinite/wizard/REVIEW.md`.
import type { GitHostAdapter } from "../wizard/contracts/git-host.js"
import { gitlabMergeRequestPushOptions } from "../git/push.js"
import type { WizardGitOps } from "../git/index.js"
import { unsupportedAdapter } from "./other.js"

export function createGitLabAdapter(git: Pick<WizardGitOps, "pushWithOptions">): GitHostAdapter {
  return {
    ...unsupportedAdapter("gitlab"),
    async createDraftPr(input) {
      await git.pushWithOptions(input.head, gitlabMergeRequestPushOptions(input.base, input.title))
      return { unsupported: true }
    }
  }
}
