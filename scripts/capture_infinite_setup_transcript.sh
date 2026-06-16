#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OUTPUT_PATH="${1:-$REPO_ROOT/docs/infinite-setup-fresh-clone-transcript.md}"
KEEP_TEMP="${KEEP_TEMP:-0}"

TMP_WORKSPACE="$(mktemp -d /tmp/infinite-transcript-workspace-XXXXXX)"
TMP_HOME="$(mktemp -d /tmp/infinite-transcript-home-XXXXXX)"

cleanup() {
  if [[ "$KEEP_TEMP" == "1" ]]; then
    printf 'Kept temp workspace: %s\n' "$TMP_WORKSPACE" >&2
    printf 'Kept temp home: %s\n' "$TMP_HOME" >&2
    return
  fi
  rm -rf "$TMP_WORKSPACE" "$TMP_HOME"
}
trap cleanup EXIT

mkdir -p "$(dirname "$OUTPUT_PATH")"

rsync -a \
  --delete \
  --exclude .git \
  --exclude .growth-os \
  --exclude node_modules \
  --exclude dist \
  --exclude '*.tsbuildinfo' \
  "$REPO_ROOT/" \
  "$TMP_WORKSPACE/"

mkdir -p "$TMP_HOME/.claude"
cat > "$TMP_HOME/.claude/.credentials.json" <<'JSON'
{"claudeAiOauth":{"accessToken":"claude-transcript-access","refreshToken":"claude-transcript-refresh","expiresAt":"2999-01-01T00:00:00.000Z"}}
JSON

run_cmd() {
  local title="$1"
  shift
  {
    printf '## %s\n\n' "$title"
    printf '```bash\n'
    printf '%q ' "$@"
    printf '\n```\n\n'
    printf '```text\n'
    "$@"
    printf '\n```\n\n'
  } >> "$OUTPUT_PATH"
}

cat > "$OUTPUT_PATH" <<EOF
# Infinite Fresh-Clone Transcript

Generated on: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

Reference workspace: $REPO_ROOT
Clone-like workspace: $TMP_WORKSPACE
Synthetic HOME: $TMP_HOME

Notes:
- Bootstrap uses the real machine HOME indirectly via \`./infinite help\` so pnpm can install/build.
- The captured onboarding commands run with an isolated synthetic HOME so user-level Infinite OS state is clean.
- The clone-like workspace excludes \`.git\`, \`.growth-os\`, \`node_modules\`, \`dist\`, and \`*.tsbuildinfo\`.

EOF

# Build/bootstrap once in the clone-like workspace. Do not isolate HOME here; pnpm relies on the real user setup.
run_cmd "Bootstrap CLI" bash -lc "cd '$TMP_WORKSPACE' && ./infinite help"

# Capture onboarding-state commands with isolated HOME.
run_cmd "Status Before Init" bash -lc "cd '$TMP_WORKSPACE' && HOME='$TMP_HOME' node apps/cli/dist/index.js setup status --json"
run_cmd "Init Workspace" bash -lc "cd '$TMP_WORKSPACE' && HOME='$TMP_HOME' node apps/cli/dist/index.js init"
run_cmd "Model Setup" bash -lc "cd '$TMP_WORKSPACE' && HOME='$TMP_HOME' node apps/cli/dist/index.js setup model claude claude-sonnet-4-5 --auth reuse"
run_cmd "Status After Model Setup" bash -lc "cd '$TMP_WORKSPACE' && HOME='$TMP_HOME' node apps/cli/dist/index.js setup status --json"

printf 'Wrote transcript to %s\n' "$OUTPUT_PATH"
