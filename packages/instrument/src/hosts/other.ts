// A host with no review API the wizard can use (§3g.2): GitLab without push options, Bitbucket, a self-hosted
// remote, or GitHub without a logged-in `gh`. The branch is pushed and a link printed; every PR and review
// method answers `{unsupported:true}`; the review is written to `.infinite/wizard/REVIEW.md`.
import type { GitHostAdapter, Unsupported } from "../wizard/contracts/git-host.js"
import type { GitHostKind } from "../wizard/contracts/state.js"

const UNSUPPORTED: Unsupported = { unsupported: true }

export function unsupportedAdapter(kind: GitHostKind): GitHostAdapter {
  const no = async (): Promise<Unsupported> => UNSUPPORTED
  return {
    kind,
    auth: async () => ({ ok: false, login: null }),
    repoFacts: no,
    findPr: no,
    createDraftPr: no,
    readPr: no,
    readThreads: no,
    postReview: no,
    reply: no,
    resolve: no,
    markReady: no,
    checks: no,
    comment: no,
    updateBranch: no,
    previewUrl: no,
    rules: no
  }
}

export function createOtherAdapter(): GitHostAdapter {
  return unsupportedAdapter("other")
}

export function isUnsupported(value: unknown): value is Unsupported {
  return typeof value === "object" && value !== null && (value as { unsupported?: unknown }).unsupported === true
}
