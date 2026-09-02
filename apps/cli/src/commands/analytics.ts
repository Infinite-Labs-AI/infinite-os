/**
 * `infinite analytics [--check | --plan | --apply] [flags…]` — the desktop CLI's front door to
 * the analytics harness that `infinite-tag harness` also runs. Same runbook, same report;
 * this command only adds what the standalone tag cannot know:
 *
 *  - the workspace: `--workspace` wins, else the running Desktop's active workspace (via the
 *    existing bridge client), else the harness's own single-saved-artifacts discovery;
 *  - the saved public keys: the file `infinite setup` wrote to
 *    `~/.infinite/artifacts/<workspaceId>.json`, which the harness discovers by workspace id;
 *  - a verification backend: the cloud one when a cloud session token is available, else
 *    NoneBackend — and it SAYS which, because `verified` is only ever printed with a receipt.
 *
 * Cloud session honesty: this CLI talks to the Desktop bridge (localhost bearer), not to the
 * cloud API, so there is no ambient cloud session to reuse. The cloud backend is wired only
 * when `INFINITE_API_TOKEN` (a bearer for `POST /api/analytics/verify`) is present in the
 * environment; `INFINITE_API_ORIGIN` overrides the default origin.
 */
import type {
  HarnessArgs,
  HarnessDeps,
  HarnessIo,
  VerificationBackend
} from "infinite-tag";

import { resolveLiveBridge, type DesktopAppClient } from "../desktop-app-client.js";

export const ANALYTICS_USAGE = [
  "Usage: infinite analytics [--check | --plan | --apply | --verify-only] [flags]",
  "",
  "One runbook: adopt the analytics your site already has (incl. Tag Manager), install what is",
  "missing with your own keys, mark buttons and links as named conversions, verify each provider",
  "actually received an event, and report per provider. Same runbook as `npx infinite-tag harness`.",
  "",
  "  --check                 Inspect + report; writes nothing",
  "  --plan                  Write the plan, the proposed conversions and .infinite/REPORT.md; apply nothing",
  "  --apply (default)       plan → confirm → apply → verify",
  "  --verify-only           Read receipts back for an already-installed site (needs --url or a production host)",
  "  --workspace <id>        Defaults to the Desktop's active workspace, then the single saved artifacts file",
  "  --conversions <file>    Pre-approved conversions (the only non-interactive marking path)",
  "  --no-mark               Skip conversion marking",
  "  --providers, --adopt-existing/--no-adopt-existing, --server-lane, --url, --yes, --allow-dirty,",
  "  --json, --brief, --posthog-query-key, and the infinite-tag artifact flags are passed through.",
  "",
  "Verification reads receipts through the cloud when INFINITE_API_TOKEN is set (INFINITE_API_ORIGIN",
  "overrides the host); otherwise providers print 'installed, not verifiable' and the report says why."
].join("\n");

export const DEFAULT_INFINITE_API_ORIGIN = "https://api.ultima.inc";
export const NO_CLOUD_SESSION_NOTICE =
  "No cloud session in this CLI: receipts cannot be read back, so providers will print 'installed, not verifiable'. " +
  "Set INFINITE_API_TOKEN (a bearer for the Infinite API) to verify through the cloud.";

/** The slice of `infinite-tag` this command uses — injectable so tests never need the built package. */
export interface TagHarnessModule {
  parseHarnessArgs(argv: readonly string[]): HarnessArgs;
  conversionsArgumentError(args: HarnessArgs, interactive: boolean): string | null;
  infErrorLine(code: string, message: string): string;
  isInteractiveTerminal(env?: NodeJS.ProcessEnv): boolean;
  terminalIo(interactive: boolean): HarnessIo;
  runHarness(args: HarnessArgs, io: HarnessIo, deps?: HarnessDeps): Promise<{ exitCode: number; report: { failure: { code: string; message: string } | null } }>;
  NoneBackend: new () => VerificationBackend;
  InfiniteCloudBackend: new (options: { origin: string; token: string; engineProjectId: string; fetch?: typeof fetch }) => VerificationBackend;
  EXIT_ARGS: number;
  EXIT_FAILED: number;
  EXIT_OK: number;
}

export interface AnalyticsCommandEnv {
  INFINITE_API_TOKEN?: string;
  INFINITE_API_ORIGIN?: string;
  GROWTH_OS_HOME?: string;
  GROWTH_OS_CLI_NONINTERACTIVE?: string;
  HOME?: string;
  [key: string]: string | undefined;
}

export interface AnalyticsCommandDeps {
  loadTag?: () => Promise<TagHarnessModule>;
  /** Test seam over the Desktop bridge; returns null when Desktop is not running. */
  resolveBridge?: (env: AnalyticsCommandEnv) => { client: Pick<DesktopAppClient, "status"> } | null;
  io?: HarnessIo;
  fetch?: typeof fetch;
}

async function defaultLoadTag(): Promise<TagHarnessModule> {
  return (await import("infinite-tag")) as unknown as TagHarnessModule;
}

function defaultResolveBridge(env: AnalyticsCommandEnv): { client: Pick<DesktopAppClient, "status"> } | null {
  try {
    return resolveLiveBridge(env as Parameters<typeof resolveLiveBridge>[0]);
  } catch {
    return null;
  }
}

/** The Desktop's active workspace id, or null when Desktop is not running / not ready. */
export async function activeWorkspaceFromDesktop(
  env: AnalyticsCommandEnv,
  resolveBridge: NonNullable<AnalyticsCommandDeps["resolveBridge"]>
): Promise<string | null> {
  const bridge = resolveBridge(env);
  if (!bridge) return null;
  try {
    const status = await bridge.client.status();
    const id = status.workspace?.id;
    return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
  } catch {
    return null;
  }
}

export function chooseBackend(
  tag: TagHarnessModule,
  env: AnalyticsCommandEnv,
  workspaceId: string | undefined,
  fetchImpl?: typeof fetch
): { backend: VerificationBackend; notice: string | null } {
  const token = env.INFINITE_API_TOKEN?.trim();
  if (token && workspaceId) {
    const origin = (env.INFINITE_API_ORIGIN?.trim() || DEFAULT_INFINITE_API_ORIGIN).replace(/\/+$/, "");
    return {
      backend: new tag.InfiniteCloudBackend({ origin, token, engineProjectId: workspaceId, fetch: fetchImpl }),
      notice: `Verifying through the cloud at ${origin} for workspace ${workspaceId}.`
    };
  }
  return {
    backend: new tag.NoneBackend(),
    notice: token && !workspaceId
      ? `${NO_CLOUD_SESSION_NOTICE} (INFINITE_API_TOKEN is set but no workspace id was resolved — pass --workspace.)`
      : NO_CLOUD_SESSION_NOTICE
  };
}

export async function runAnalyticsCommand(
  args: readonly string[],
  env: AnalyticsCommandEnv,
  deps: AnalyticsCommandDeps = {}
): Promise<number> {
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    (deps.io?.out ?? ((line: string) => process.stdout.write(`${line}\n`)))(ANALYTICS_USAGE);
    return 0;
  }
  const tag = await (deps.loadTag ?? defaultLoadTag)();
  const interactive = deps.io?.interactive ?? tag.isInteractiveTerminal(env as NodeJS.ProcessEnv);
  const io = deps.io ?? tag.terminalIo(interactive);

  let parsed: HarnessArgs;
  try {
    parsed = tag.parseHarnessArgs(args);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(ANALYTICS_USAGE.split("\n")[0]);
    return tag.EXIT_ARGS;
  }

  if (parsed.workspaceId === undefined) {
    const fromDesktop = await activeWorkspaceFromDesktop(env, deps.resolveBridge ?? defaultResolveBridge);
    if (fromDesktop) {
      parsed = { ...parsed, workspaceId: fromDesktop };
      io.err(`Workspace ${fromDesktop} (Desktop's active workspace).`);
    }
  }

  const argumentError = tag.conversionsArgumentError(parsed, io.interactive);
  if (argumentError) {
    io.err(tag.infErrorLine("INF_ARGS_CONVERSIONS_REQUIRED", argumentError));
    return tag.EXIT_ARGS;
  }

  const { backend, notice } = chooseBackend(tag, env, parsed.workspaceId, deps.fetch);
  if (notice) io.err(notice);

  try {
    const result = await tag.runHarness(parsed, io, { backends: [backend], fetch: deps.fetch });
    if (result.report.failure) {
      io.err(tag.infErrorLine(result.report.failure.code, result.report.failure.message));
    }
    return result.exitCode === 0 ? tag.EXIT_OK : tag.EXIT_FAILED;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return tag.EXIT_FAILED;
  }
}
