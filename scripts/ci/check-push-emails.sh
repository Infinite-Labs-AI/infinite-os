#!/usr/bin/env bash
# check-push-emails.sh: the pre-push gate on commit METADATA. Refuses the push
# when any commit being pushed has an author or committer email outside the
# public allowlist (scripts/ci/public-email-allowlist.sh).
#
# Why this runs before the push and not only in CI: once a commit is pushed
# to a branch behind a pull request, GitHub keeps it under refs/pull/<n>/head
# for good. Squash-merging, force-pushing or deleting the branch does not
# remove it, and only GitHub Support can. CI check 6 in repo-tripwire.sh runs
# after that ref exists, so it can report a leak but never prevent one.
#
# Input is git's pre-push stdin, one line per ref being pushed:
#   <local ref> SP <local sha> SP <remote ref> SP <remote sha>
# Commits checked for each ref:
#   - remote tip known locally: remote_sha..local_sha
#   - new branch, or a remote tip never fetched: every commit reachable from
#     local_sha that is on no remote-tracking ref
#   - deletion (local sha all zeros): none, nothing is uploaded
set -euo pipefail

# shellcheck source=scripts/ci/public-email-allowlist.sh
. "$(dirname "${BASH_SOURCE[0]}")/public-email-allowlist.sh"

is_zero() { case "$1" in *[!0]*) return 1 ;; *) return 0 ;; esac; }

report=""
while read -r local_ref local_sha remote_ref remote_sha || [ -n "${local_ref:-}" ]; do
  [ -n "${local_sha:-}" ] || continue
  if is_zero "$local_sha"; then continue; fi

  if ! is_zero "${remote_sha:-0}" && git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
    set -- "$local_sha" "^$remote_sha"
  else
    set -- "$local_sha" --not --remotes
  fi

  # Same shape as repo-tripwire.sh check 6, over the pushed range only.
  bad_emails="$(git log --format='%ae%n%ce' "$@" | sort -u | grep -viE "$PUBLIC_EMAIL_ALLOWLIST_ERE" || true)"
  [ -n "$bad_emails" ] || continue

  offenders="$(git log --reverse --format='%h%x09%ae%x09%ce%x09%s' "$@" |
    BAD="$bad_emails" awk -F'\t' '
      BEGIN { n = split(ENVIRON["BAD"], b, "\n"); for (i = 1; i <= n; i++) bad[b[i]] = 1 }
      ($2 in bad) || ($3 in bad) { printf "    %s  author=%s  committer=%s  %s\n", $1, $2, $3, $4 }')"
  oldest_bad="$(printf '%s\n' "$offenders" | awk 'NR == 1 { print $1 }')"
  report="${report}  ${remote_ref} (from ${local_ref}):"$'\n'"${offenders}"$'\n'
  report="${report}    rewrite: git rebase --exec 'git commit --amend --no-edit --reset-author' ${oldest_bad}^"$'\n'
done

[ -n "$report" ] || exit 0

next_email="$(git var GIT_AUTHOR_IDENT 2>/dev/null | sed -n 's/.*<\(.*\)>.*/\1/p' || true)"
{
  echo "pre-push: REFUSED. These commits carry an email that must not reach the public repo:"
  printf '%s' "$report"
  echo ""
  echo "Allowed: *@infinite.fast, *@users.noreply.github.com, noreply@github.com"
  echo "(rule: scripts/ci/public-email-allowlist.sh)."
  echo "Nothing was sent. Once a commit is pushed to a PR branch, GitHub keeps it under"
  echo "refs/pull/<n>/head for good, and only GitHub Support can remove it."
  echo ""
  echo "Fix it, then push again:"
  echo "  1. git config user.email <id>+<login>@users.noreply.github.com"
  echo "     (your next commit would use: ${next_email:-unknown}; GIT_AUTHOR_EMAIL /"
  echo "     GIT_COMMITTER_EMAIL in the environment override the config)"
  echo "  2. Rewrite the listed commits. The 'rewrite:' line under each branch redoes every"
  echo "     commit from the oldest bad one up; if only the last commit is bad, this is enough:"
  echo "     git commit --amend --no-edit --reset-author"
} >&2
exit 1
