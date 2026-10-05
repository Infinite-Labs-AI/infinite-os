# Local CLI model selection

In an `infinite` or `infinite local` Ink session, enter `/model` to choose the model for your next
message. Use the arrow keys and Enter to choose a model, choose effort when offered,
and confirm **Save and use**. Escape goes back; Escape on the model list or Cancel
closes without saving. Ctrl-C closes the picker without quitting the session.

The choice persists in `GROWTH_OS_HOME/terminal-model.yml` (normally
`~/.growth-os/terminal-model.yml`) with mode 0600. Local CLI chats using that home
share the choice. Desktop chat, memory review, and compaction keep using their
existing defaults. A chat snapshots the selection when its turn starts.

The resolution order is an explicit per-turn model, the complete
`GROWTH_OS_MODEL_PROVIDER` / `GROWTH_OS_MODEL_NAME` environment pair, the terminal
file, then the shared `config.yml` default. When environment variables override a
saved choice, the result says so.

In Desktop-backed `infinite`, the picker lists exactly the models advertised by
Desktop, grouped by provider. Both Codex and the Desktop's existing Claude Code
provider are available when connected and selectable. A disconnected provider
says **connect in the app**. **Use Desktop default** clears the terminal file;
`/model default` also clears it if an older Desktop cannot open the picker.

Desktop readiness is unchanged: a not-ready app cannot start or run a terminal
session. With a saved choice, each turn negotiates `turn.model.v1` and sends an
explicit provider/model/optional effort. Older apps or unsupported choices produce
a clear error before sending. With no choice the request has its original shape.
Environment and shared model defaults are never substituted into this opt-in field.

In `infinite local`, the local catalog is used. A terminal-picked Claude model runs
through the user's installed, signed-in Claude Code CLI and subscription. Readiness
checks the binary and `claude auth status --json`; sign-in guidance is
`claude auth login`. A restricted, headless process receives `--model` and optional
`--effort`, with a temporary private MCP config. Its MCP server exposes only the
controller's tools and calls the same execution and recording code used by Codex.
Operator proposals still require confirmation, and tool calls cannot continue past
that gate. The shared-config Claude client, memory review, and compaction retain
their existing paths.

`Default` sends no effort field or CLI flag. Local environment-pair precedence
continues to apply; only an effective terminal-file Claude choice activates the
new local CLI client.

Outside the picker:

```sh
infinite local model list
infinite local model status
infinite local model use codex gpt-5.5
```

`model list` prints supported IDs. `model status` shows the effective terminal model,
its effort and source, and the shared app default on separate lines. `model use`
continues to change the **shared default** for setup compatibility; it does not
replace an existing terminal choice. Bare `model` without the Ink session prints
guidance and never waits for input. Bare `infinite` delegates chat to Desktop while keeping terminal model choices separate from the app selection.

## Verification

The focused source-check configurations below resolve workspace dependencies from
source, so a fresh worktree needs no full workspace build. The Ink renderer's local
bundle must already be available to run its interaction tests.

```sh
pnpm exec tsc -p tests/model-picker.tsconfig.json --pretty false
pnpm exec vitest run --config tests/model-picker.vitest.config.ts \
  packages/config/test/terminal-model.test.ts packages/config/test/config.test.ts \
  packages/llm-controller/test/terminal-model.test.ts packages/llm-controller/test/native-tools.test.ts \
  packages/llm-controller/test/codex-tool-wire.test.ts \
  apps/cli/src/terminal-model-picker.test.ts apps/cli/src/terminal-model-runtime.test.ts \
  apps/cli/src/claude-cli-model-client.test.ts apps/cli/src/desktop/model-selection.test.ts \
  apps/cli/src/desktop-app-client.test.ts apps/cli/src/desktop/desktop-interactive.test.ts \
  apps/cli/src/tui/ink/interactive-session.model.test.ts \
  apps/cli/src/tui/ink/interactive-session.connect.test.ts \
  apps/cli/src/tui/keys/keymap.test.ts
pnpm exec vitest run --config tests/model-picker.vitest.config.ts \
  apps/cli/src/index.test.ts -t 'model|Codex device|codex login'
```

`tests/fixtures/model-picker-session.mts` opens the real Ink session with synthetic
provider readiness for PTY capture. Set `MODEL_PICKER_FIXTURE=1`, use a fresh
throwaway `GROWTH_OS_HOME` and `HOME`, and set
`TSX_TSCONFIG_PATH=tests/model-picker.tsconfig.json`. It sends no model or database
requests. Capture list, effort, confirm, and result at 80, 100, and 140 columns.

For Desktop-mode PTY captures, set `MODEL_PICKER_MODE=desktop` and point
`MODEL_PICKER_CATALOG` at fixture status options exported from Desktop's catalog.
The fixture never sends a model turn. This keeps its model list derived from the
Desktop source rather than another maintained catalog.
