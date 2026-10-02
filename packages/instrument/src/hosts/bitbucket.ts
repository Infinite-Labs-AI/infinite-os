// Bitbucket (§3g.2): push the branch and print the "new pull request" link. Nothing else is supported.
import type { GitHostAdapter } from "../wizard/contracts/git-host.js"
import { unsupportedAdapter } from "./other.js"

export function createBitbucketAdapter(): GitHostAdapter {
  return unsupportedAdapter("bitbucket")
}

/** `https://bitbucket.org/<workspace>/<repo>/pull-requests/new?source=<branch>`. */
export function bitbucketNewPrUrl(workspace: string, repo: string, branch: string): string {
  return `https://bitbucket.org/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pull-requests/new?source=${encodeURIComponent(branch)}`
}
