// Pushing the PR branch (lane O4, §3g.1): `git push -u origin <branch>`, never `-f`, never the base, with
// `GIT_TERMINAL_PROMPT=0` and SSH in BatchMode (see run.ts). A refusal is reported verbatim and the wizard
// stops; it never takes a fork path.

export type PushFailureKind =
  /** An SSH key needs a passphrase (BatchMode refused to prompt): hand the TTY over and retry once. */
  | "ssh_passphrase"
  /** HTTPS credentials missing or rejected. */
  | "auth"
  /** No write access, or a ruleset / protected-branch refusal. */
  | "rejected"
  | "other"

export class GitPushError extends Error {
  constructor(
    readonly kind: PushFailureKind,
    readonly stderr: string
  ) {
    super(`git push failed (${kind})`)
    this.name = "GitPushError"
  }
}

export function classifyPushFailure(stderr: string): GitPushError {
  if (/Permission denied \(publickey|passphrase|Host key verification failed|BatchMode|sign_and_send_pubkey|agent refused/i.test(stderr)) {
    return new GitPushError("ssh_passphrase", stderr)
  }
  if (/terminal prompts disabled|could not read Username|Authentication failed|invalid username or password|403|401/i.test(stderr)) {
    return new GitPushError("auth", stderr)
  }
  if (/rejected|protected branch|ruleset|GH013|GH006|pre-receive hook declined|permission to .* denied|not allowed to push/i.test(stderr)) {
    return new GitPushError("rejected", stderr)
  }
  return new GitPushError("other", stderr)
}

/** The argv for a push, with GitLab's merge-request push options when given (§3g.2). */
export function pushArgv(branch: string, pushOptions: readonly string[] = []): string[] {
  const options = pushOptions.flatMap((option) => ["-o", option])
  return ["push", "-u", ...options, "origin", branch]
}

/** GitLab opens a draft MR from push options; `glab` is never needed (§3g.2). */
export function gitlabMergeRequestPushOptions(base: string, title: string): string[] {
  const safeTitle = title.replace(/[\r\n]+/g, " ").slice(0, 200)
  return ["merge_request.create", `merge_request.target=${base}`, "merge_request.draft", `merge_request.title=${safeTitle}`]
}
