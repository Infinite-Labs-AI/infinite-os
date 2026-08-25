import { INFINITE_DOWNLOAD_URL } from "./desktop/onboarding.js";

/**
 * Help text is SPLIT (design §6.6, round 5):
 *
 * - `productHelpText()` — the advertised product surface: natural-language
 *   turns proxied through the Infinite Desktop app, `infinite app`, and a
 *   pointer at `infinite local` for the self-host lane. No local-stack detail.
 * - `localHelpText()` — the full open-source engine surface, hosted under
 *   `infinite local` (namespace, don't delete).
 *
 * Copy accuracy (design invariant 8): orchestration runs locally, but BYO
 * prompts run on the user's OWN Codex/Anthropic account — never claim
 * "thinking never leaves your machine". The repo is MIT open source.
 */

export function productHelpText(): string {
  return [
    "infinite — your Infinite growth agent, in the terminal",
    "",
    "Usage:",
    "  infinite                       Start an interactive agent session",
    '  infinite "message"             Ask one question and print the answer',
    "  infinite app                   Desktop bridge status and one-shot messages",
    "  infinite help                  Show this help",
    "  infinite version               Print the Infinite OS version and commit",
    "  infinite update                How to update (the agent ships with Infinite Desktop)",
    "",
    "Getting started:",
    "  Turns run through the Infinite Desktop app on this Mac — it must be",
    "  running and signed in. Without it, `infinite` walks you through launch",
    "  and sign-in.",
    `  New here? Download Infinite Desktop at ${INFINITE_DOWNLOAD_URL}`,
    "",
    "Self-host / local engine:",
    "  infinite local <command>       Run the open-source local engine directly",
    "                                 (setup, connect, sources, sync, ...)",
    "  infinite local help            Full local engine command list",
    "",
    "Orchestration runs locally; prompts run on your own Codex or Anthropic",
    "account, with your own credentials. Infinite OS is MIT open source."
  ].join("\n");
}

/**
 * Product-level `infinite update` (§6.6): the product agent ships WITH the
 * Infinite Desktop app and updates with it — never the git/local-stack
 * updater, which lives at `infinite local update`.
 */
export function productUpdateText(): string {
  return [
    "The infinite agent ships with the Infinite Desktop app and updates with it.",
    "Open Infinite Desktop to pick up the latest version — it keeps itself up to",
    `date automatically. New install? Download it at ${INFINITE_DOWNLOAD_URL}`,
    "",
    "Self-hosting the open-source engine? Run `infinite local update` to pull the",
    "latest code and restart the local stack."
  ].join("\n");
}

export function localHelpText(): string {
  return [
    "infinite <command>",
    "",
    "Common:",
    "  infinite                       Start an interactive agent session",
    "  infinite \"message\"             Ask one question and print the answer",
    "  infinite local                 Force the local engine (skips the cloud brain)",
    "  infinite local <command>       Run any command against the local engine",
    "  version                        Print the Infinite OS version and commit",
    "  setup                          Configure project, runtime, model, and analytics",
    "  setup status                   Show what is ready and what is blocked",
    "",
    "Connect data:",
    "  setup connectors               Show connector status and guided setup options",
    "  connect <provider>             Connect or reconnect a provider interactively",
    "  connect <provider> [name] <json_credential_payload>",
    "  sources                         List connected sources",
    "  setup resume <run_id>          Resume a paused browser or OAuth setup handoff",
    "  setup resume --all             Resume every paused provider, one at a time",
    "  setup reset [tool]             Clear stuck setup runs so a fresh run can start",
    "  Providers: ga4, posthog, x, meta, stripe, shopify",
    "",
    "Sync data:",
    "  sync                           Pick a source and time window interactively",
    "  sync <provider|source_id> [window]",
    "  sync all [window]              Sync every connected source",
    "  sync-runs                      List recent sync runs",
    "  Windows: incremental, 30_days, 3_months, 6_months, 12_months, all_time",
    "",
    "Inspect:",
    "  health                         Check app health",
    "  schema | views                 List queryable views",
    "  metrics                        List metric definitions",
    "  explain <metric>               Explain authority and provenance",
    "  recipes                        List guided operator recipes",
    "",
    "Runtime:",
    "  start [--no-wait]              Start the stack and wait until the app server is ready",
    "  update                         Pull the latest code on this branch and restart the stack",
    "  stop                           Stop the Infinite OS Docker stack",
    "  status                         Show Docker stack status",
    "  logs [service]                 Show Docker logs",
    "  migrate                        Run database migrations",
    "  init                           Create .growth-os config files",
    "",
    "Model/auth:",
    "  codex login                    Sign in to Codex (browser); --force re-auths an existing session",
    "  codex import                   Import existing Codex CLI credentials (~/.codex)",
    "  auth login codex               Alias for `codex login`",
    "  auth import codex              Alias for `codex import`",
    "  auth login claude --mode <reuse|setup-token|growth-os-oauth>",
    "  auth status [codex|claude]      Show model auth status without printing tokens",
    "  model list                     List supported login-backed model providers",
    "  model use <codex|claude> <model>",
    "  model status                   Show selected user-level model",
    "  setup query                    Show whether the LLM query runtime is ready",
    "  setup runtime                  Configure local Docker, external Postgres, or Supabase runtime",
    "",
    "Schedules:",
    "  schedules                      List source schedules",
    "",
    "Meta Ads (operator-only writes; creates land PAUSED):",
    "  meta <campaign|adset|ad|creative> list --source-id <id> [-l 10]",
    "  meta <campaign|adset|ad|creative> get <id> --source-id <id>",
    "  meta campaign create --source-id <id> --name <s> --objective <OUTCOME_*> [--daily-budget <cents>]",
    "  meta adset create <campaign_id> --source-id <id> --name <s> --optimization-goal <enum> --billing-event <enum>",
    "  meta creative create --source-id <id> --name <s> --page-id <id> [--link-url <url>] [--body <s>]",
    "  meta ad create <adset_id> --source-id <id> --name <s> --creative-id <id>",
    "  meta <campaign|adset|ad> activate <id> --source-id <id>   (separate, typed-confirm; spends money)",
    "  meta <campaign|adset|ad> pause <id> --source-id <id>",
    "  meta <campaign|adset> budget <id> --source-id <id> --daily-budget <cents>   (change an existing daily budget; no status change)",
    "  Budgets/bids are integer cents in the ad-account currency. Use --yes to skip the confirm.",
    "",
    "Reports:",
    "  saved-report create <name> [json_tool_plan]",
    "  saved-report run <report_id>",
    "  saved-report export <report_id> [format]",
    "",
    "Examples:",
    "  infinite local connect x",
    "  infinite local connect meta",
    "  infinite local sync meta 30_days",
    "  infinite local sync all incremental"
  ].join("\n");
}
