// The reviewer's detached worktree (lane O4, §3g.4 step 1): a checkout of the PR head with ONLY committed
// files (so no `.env*`), outside the user's repo and outside $TMPDIR. It lives under `$HOME`
// (`~/Library/Caches/infinite-tag-review/<run>/worktrees/…`, §3f.7), which the Codex profile denies to every
// path but its own project root, and OUTSIDE the wizard's cache root (`~/Library/Caches/infinite-tag`): that one
// is a sensitive path every Claude agent is denied, so a Claude reviewer there could read nothing (review I1 P1-4).
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

import { WIZARD_REVIEW_WORKTREE_HOME_RELATIVE } from "../wizard/contracts/agents.js"

/** `<home>/Library/Caches/infinite-tag-review/<runKey>/worktrees`. */
export function defaultWorktreeRoot(runKey: string, home: string = homedir()): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runKey)) throw new Error("runKey must be a short id")
  return join(home, WIZARD_REVIEW_WORKTREE_HOME_RELATIVE, runKey, "worktrees")
}

/** A fresh directory name for one review of one head SHA. */
export function worktreeDirFor(root: string, sha: string): string {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("worktree SHA must be hex")
  return join(root, `review-${sha.slice(0, 12)}-${randomBytes(3).toString("hex")}`)
}
