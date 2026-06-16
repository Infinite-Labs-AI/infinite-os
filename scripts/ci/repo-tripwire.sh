#!/usr/bin/env bash
# repo-tripwire.sh — security/IP tripwire for a repo that is about to go PUBLIC.
#
# Fails loudly if anything that must never be published shows up as a TRACKED
# file: secret-shaped files, paid-IP package paths, canary strings from private
# prompt IP (supplied via the IP_CANARIES env var), confidential local-only
# docs, or the owner's personal data.
#
# Run from anywhere inside the repo: bash scripts/ci/repo-tripwire.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

failures=0

fail() {
  echo "TRIPWIRE FAIL: $1" >&2
  failures=$((failures + 1))
}

# ---------------------------------------------------------------------------
# 1. Secret-shaped tracked files must not exist.
#    Intent: credential FILES (.env and .env.* variants such as
#    .env.production/.env.local — except the legitimate tracked
#    .env.example template — auth.json-named files, .growth-os/ state, key
#    material), not source files that merely mention "credential".
#    auth\.json is end-anchored to filenames so docs like oauth.json.md
#    don't trip, while a real oauth.json file still does.
# ---------------------------------------------------------------------------
secret_matches="$(git ls-files | grep -iE '(^|/)\.env(\..+)?$|[^/]*auth\.json$|(^|/)\.growth-os/|credential.*\.(json|ya?ml|pem|key)$|\.pem$' | grep -v '\.env\.example$' || true)"
if [[ -n "$secret_matches" ]]; then
  echo "$secret_matches" >&2
  fail "secret-shaped files are tracked by git (see list above)"
fi

# ---------------------------------------------------------------------------
# 2. Paid-IP paths must NEVER appear in this repo.
#    This repo is the public free plane; paid IP lives elsewhere.
# ---------------------------------------------------------------------------
paid_ip_matches="$(git ls-files -- packages/actions packages/licensing packages/metering)"
if [[ -n "$paid_ip_matches" ]]; then
  echo "$paid_ip_matches" >&2
  fail "paid-IP package paths are tracked in the public repo (see list above)"
fi

# ---------------------------------------------------------------------------
# 3. Canary strings: verbatim phrases from private/paid prompt IP must not
#    appear in any tracked file. The canaries come from the IP_CANARIES env
#    var (newline-separated, fixed-string matched via git grep -F) — in CI it
#    is fed from the IP_CANARIES Actions secret so the phrases themselves are
#    never published in this repo. Lines starting with # and blank lines are
#    skipped; the whole check is skipped when IP_CANARIES is unset/empty
#    (e.g. fork PRs, where secrets never arrive) — that skip stays exit 0
#    but emits a visible GitHub annotation so it can't no-op silently.
# ---------------------------------------------------------------------------
if [[ -n "${IP_CANARIES:-}" ]]; then
  canaries="$(printf '%s\n' "$IP_CANARIES" | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$' || true)"
  if [[ -n "$canaries" ]]; then
    canary_hits="$(git grep -F -f <(printf '%s\n' "$canaries") || true)"
    if [[ -n "$canary_hits" ]]; then
      echo "$canary_hits" >&2
      fail "canary strings from private IP found in tracked files (see list above)"
    fi
  fi
else
  echo "::warning::IP canary check skipped — IP_CANARIES secret not available (expected on fork PRs; configure the repo secret before paid IP exists)"
fi

# ---------------------------------------------------------------------------
# 4. Confidential local docs must stay untracked.
# ---------------------------------------------------------------------------
confidential_matches="$(git ls-files | grep -E 'docs/.*restructure|^AGENT_CONTEXT\.md|^\.claude/|^\.omc/' | grep -v '^docs/internal/' || true)"
if [[ -n "$confidential_matches" ]]; then
  echo "$confidential_matches" >&2
  fail "confidential local-only docs are tracked by git (see list above)"
fi

# ---------------------------------------------------------------------------
# 5. Personal data must never appear in tracked files: the owner's email,
#    local home paths, or live workspace ids (real ids are exactly 16 hex
#    chars, so fixtures like ws_1 / ws_test / ws_REDACTED won't match).
#    This script is excluded because it must name the patterns it hunts.
# ---------------------------------------------------------------------------
personal_hits="$(git grep -nE 'alchemistchaos@protonmail|/Users/chaosalchemist|ws_[0-9a-f]{16}' -- ':(exclude)scripts/ci/repo-tripwire.sh' || true)"
if [[ -n "$personal_hits" ]]; then
  echo "$personal_hits" >&2
  fail "personal data (owner email / home path / live workspace id) found in tracked files (see list above)"
fi

# ---------------------------------------------------------------------------
if [[ "$failures" -gt 0 ]]; then
  echo "" >&2
  echo "repo-tripwire: $failures check(s) FAILED — do not publish this tree." >&2
  exit 1
fi

# Internal engineering docs: tracked in the PRIVATE repo, but they must never
# exist in the public repo (the snapshot/mirror filter excludes docs/internal/).
# The public repo's CI sets PUBLIC_SURFACE=1 to turn this on.
if [ "${PUBLIC_SURFACE:-0}" = "1" ]; then
  matches="$(git ls-files | grep -E '^docs/internal/' || true)"
  if [ -n "$matches" ]; then echo "$matches" >&2; fail "internal docs tracked on the public surface"; fi

  # Private working-agreement / internal-planning files must never reach the
  # public snapshot. These ARE legitimately tracked in the private repo
  # (CLAUDE.md/AGENTS.md are agent working agreements; plans/ holds internal
  # planning docs), so this check is PUBLIC-MODE-ONLY — it must never fire in
  # private mode. On flip day the Phase-2 snapshot filter removes them before
  # the public push; this is the machine-enforced safety net that fails the
  # build if that filter is ever skipped or regresses. (CONTRIBUTING.md is a
  # legitimate public doc and is intentionally NOT in this list.)
  matches="$(git ls-files | grep -E '^CLAUDE\.md$|^AGENTS\.md$|^plans/' || true)"
  if [ -n "$matches" ]; then
    echo "$matches" >&2
    echo "::error::private working-agreement / internal-planning files would leak into the public snapshot (see list above): remove CLAUDE.md/AGENTS.md and any plans/* before publishing"
    fail "private working-agreement files tracked on the public surface"
  fi
fi
# Convention (both repos): plan/transcript/handoff docs live under docs/internal/,
# nowhere else tracked under docs/. (Root plans/ is a private-repo planning dir
# that is legitimately tracked here — it is gated PUBLIC-MODE-ONLY above, so the
# private repo's own CI, which runs private mode, stays green while the public
# snapshot still hard-fails on it.)
matches="$(git ls-files | grep -E '^docs/.*(plan|transcript|handoff|parity)[^/]*\.md$' | grep -v '^docs/internal/' || true)"
if [ -n "$matches" ]; then echo "$matches" >&2; fail "internal-style doc tracked outside docs/internal/"; fi

if [ "$failures" -gt 0 ]; then exit 1; fi

echo "repo-tripwire: all checks passed."
