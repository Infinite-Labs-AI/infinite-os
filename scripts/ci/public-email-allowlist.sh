# shellcheck shell=bash
# The ONE public commit-email allowlist for this repo. Sourced, never run, by:
#   - scripts/ci/repo-tripwire.sh      check 6: CI audit of all history (PUBLIC_SURFACE=1)
#   - scripts/ci/check-push-emails.sh  the .githooks/pre-push gate on the commits being pushed
# An author or committer email is allowed only if it matches this ERE with
# `grep -iE`: an @infinite.fast address, a GitHub user noreply address, or the
# synthetic noreply@github.com that GitHub stamps on web and squash merges.
# Change the rule here only; both gates read it.
PUBLIC_EMAIL_ALLOWLIST_ERE='(@infinite\.fast|@users\.noreply\.github\.com|^noreply@github\.com)$'
