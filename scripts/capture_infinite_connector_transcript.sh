#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OUTPUT_PATH="${1:-$REPO_ROOT/docs/infinite-setup-connector-transcript.md}"
KEEP_TEMP="${KEEP_TEMP:-0}"

TMP_WORKSPACE="$(mktemp -d /tmp/infinite-connector-workspace-XXXXXX)"
TMP_HOME="$(mktemp -d /tmp/infinite-connector-home-XXXXXX)"
TMP_SERVER_DIR="$(mktemp -d /tmp/infinite-connector-server-XXXXXX)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ "$KEEP_TEMP" == "1" ]]; then
    printf 'Kept temp workspace: %s\n' "$TMP_WORKSPACE" >&2
    printf 'Kept temp home: %s\n' "$TMP_HOME" >&2
    printf 'Kept temp server dir: %s\n' "$TMP_SERVER_DIR" >&2
    return
  fi
  rm -rf "$TMP_WORKSPACE" "$TMP_HOME" "$TMP_SERVER_DIR"
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
{"claudeAiOauth":{"accessToken":"claude-connector-access","refreshToken":"claude-connector-refresh","expiresAt":"2999-01-01T00:00:00.000Z"}}
JSON

cat > "$TMP_SERVER_DIR/mock_connector_server.mjs" <<'EOF'
import http from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const stateDir = process.env.MOCK_CONNECTOR_STATE_DIR;
const portFile = process.env.MOCK_CONNECTOR_PORT_FILE;
mkdirSync(stateDir, { recursive: true });

const state = {
  sources: []
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  const body = raw ? JSON.parse(raw) : {};

  const respond = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  if (req.method === 'GET' && url.pathname === '/sources') {
    return respond(200, { ok: true, data: { sources: state.sources } });
  }

  if (req.method === 'POST' && url.pathname === '/sources/connect') {
    const provider = String(body.provider ?? 'unknown');
    const connectionName = String(body.connectionName ?? provider);
    const source = {
      id: `src_${provider}`,
      provider,
      connectionName,
      status: 'connected'
    };
    state.sources = [source];
    return respond(200, { ok: true, data: { source } });
  }

  return respond(404, { ok: false, error: { code: 'not_found' } });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') {
    process.exit(1);
  }
  writeFileSync(portFile, String(address.port));
});
EOF

PORT_FILE="$TMP_SERVER_DIR/port"
MOCK_CONNECTOR_STATE_DIR="$TMP_SERVER_DIR/state" \
MOCK_CONNECTOR_PORT_FILE="$PORT_FILE" \
node "$TMP_SERVER_DIR/mock_connector_server.mjs" >"$TMP_SERVER_DIR/server.log" 2>&1 &
SERVER_PID="$!"

for _ in $(seq 1 50); do
  if [[ -f "$PORT_FILE" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -f "$PORT_FILE" ]]; then
  printf 'mock connector server failed to start\n' >&2
  exit 1
fi

MOCK_PORT="$(cat "$PORT_FILE")"
MOCK_API_URL="http://127.0.0.1:$MOCK_PORT"

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
# Infinite Connector Transcript

Generated on: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

Reference workspace: $REPO_ROOT
Clone-like workspace: $TMP_WORKSPACE
Synthetic HOME: $TMP_HOME
Mock API: $MOCK_API_URL

Notes:
- Bootstrap uses the real machine HOME indirectly via \`./infinite help\` so pnpm can install/build.
- The onboarding commands run with an isolated synthetic HOME.
- Connector calls are routed to a mock local app API so the transcript captures real CLI connector behavior without mutating a live runtime.
- Connector commands also override \`DATABASE_URL\` to an unreachable local address so readiness uses the mock API instead of any ambient local Postgres.

EOF

run_cmd "Bootstrap CLI" bash -lc "cd '$TMP_WORKSPACE' && ./infinite help"
run_cmd "Init Workspace" bash -lc "cd '$TMP_WORKSPACE' && HOME='$TMP_HOME' node apps/cli/dist/index.js init"
run_cmd "Model Setup" bash -lc "cd '$TMP_WORKSPACE' && HOME='$TMP_HOME' node apps/cli/dist/index.js setup model claude claude-sonnet-4-5 --auth reuse"
run_cmd "Connector Options Before Connect" bash -lc "cd '$TMP_WORKSPACE' && HOME='$TMP_HOME' GROWTH_OS_API_URL='$MOCK_API_URL' DATABASE_URL='postgres://growth:password@127.0.0.1:1/growth' node apps/cli/dist/index.js setup connectors"
run_cmd "Configure PostHog Connector" bash -lc "cd '$TMP_WORKSPACE' && export POSTHOG_PERSONAL_API_KEY='<redacted-fixture>' && HOME='$TMP_HOME' GROWTH_OS_API_URL='$MOCK_API_URL' DATABASE_URL='postgres://growth:password@127.0.0.1:1/growth' node apps/cli/dist/index.js setup connectors posthog --connection-name 'Product Analytics' --project-id 42 --personal-api-key \"\$POSTHOG_PERSONAL_API_KEY\" --api-host https://posthog.test"
run_cmd "Connector Options After Connect" bash -lc "cd '$TMP_WORKSPACE' && HOME='$TMP_HOME' GROWTH_OS_API_URL='$MOCK_API_URL' DATABASE_URL='postgres://growth:password@127.0.0.1:1/growth' node apps/cli/dist/index.js setup connectors"

printf 'Wrote transcript to %s\n' "$OUTPUT_PATH"
