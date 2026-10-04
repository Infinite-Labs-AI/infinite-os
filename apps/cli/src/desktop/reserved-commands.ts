/**
 * Reserved local-command interception (design §6.6, round 5).
 *
 * The companion CLI routes unknown top-level text to Desktop as a
 * natural-language turn. The typed engine commands move UNDER `infinite local`
 * (namespace, don't delete) — so a bare `infinite sources` must be intercepted
 * with exact guidance BEFORE the unknown-text→chat fallthrough, or the word
 * "sources" would silently become a chat turn.
 *
 * The set enumerates every deterministic engine command surfaced at top level
 * by `runCommand` in `apps/cli/src/index.ts` today (aliases included: `up` =
 * start, `tools` = mcp). Deliberately NOT reserved:
 *   - `help` / `version` — always product-allowed (§6.6 routing step 2).
 *   - `app`             — the product's Desktop command, not an engine command.
 *   - `update`          — product-level `update` means DESKTOP updating and is
 *                         handled before reserved interception (§6.6 step 2);
 *                         the git/local-stack updater lives at
 *                         `infinite local update`.
 *   - `local`           — the explicit namespace itself.
 *   - `contacts`        — the product's bridge-backed contacts-sync command,
 *                         intercepted in `runCli` before reserved interception
 *                         (not an engine command; `infinite local contacts`
 *                         would be wrong guidance).
 *   - `analytics`       — the analytics harness (`infinite analytics`), a
 *                         product command that runs locally against the
 *                         current repo; intercepted in `runCli` the same way.
 */
export const RESERVED_LOCAL_COMMANDS: ReadonlySet<string> = new Set([
  "init",
  "setup",
  "start",
  "up",
  "stop",
  "migrate",
  "logs",
  "status",
  "connect",
  "health",
  "sources",
  "schema",
  "schedules",
  "sync",
  "sync-runs",
  "views",
  "metrics",
  "mcp",
  "tools",
  "recipes",
  "recipe",
  "auth",
  "codex",
  "model",
  "project",
  "meta",
  "explain",
  "saved-report",
  "call"
]);

/**
 * Guidance for a bare top-level invocation of a reserved engine command, or
 * null when the word is not reserved (and may therefore become a turn). The
 * caller's remaining argv rides along so it is clear what was intercepted.
 */
export function reservedCommandNotice(
  command: string,
  rest: readonly string[] = []
): string | null {
  return RESERVED_LOCAL_COMMANDS.has(command)
    ? `"${[command, ...rest].join(" ")}" is not a Terminal product command. ` +
        "Open Infinite Desktop at infinite://onboarding and press ⌘L. " +
        "App and Terminal use the same account, workspace, and agent."
    : null;
}
