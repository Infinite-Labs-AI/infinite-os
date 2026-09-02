/**
 * `infinite analytics [--check | --plan | --apply] [flags…]` — the desktop CLI's front door to
 * the analytics harness that `infinite-tag harness` also runs. Same runbook, same report;
 * this command only adds what the standalone tag cannot know:
 *
 *  - the workspace: `--workspace` wins, else the running Desktop's active workspace (via the
 *    existing bridge client), else the harness's own single-saved-artifacts discovery;
 *  - the saved public keys: the file `infinite setup` wrote to
 *    `~/.infinite/artifacts/<workspaceId>.json`, which the harness discovers by workspace id;
 *  - a verification backend: the running Desktop, which reads the receipts back on this CLI's
 *    behalf — and it SAYS which backend answered, because `verified` is only ever printed with
 *    a receipt.
 *
 * NO TOKENS. This CLI holds no cloud session by design (the companion train): it POSTs to the
 * Desktop's loopback bridge verb `analytics.verify.v1`, and the Desktop — which holds the session
 * and knows the active workspace — makes the cloud call itself. The founder never handles a
 * bearer. Selection order:
 *
 *   1. DesktopBridgeBackend — the Desktop is running and advertises `analytics.verify.v1`.
 *   2. InfiniteCloudBackend — ADVANCED escape hatch, only with an explicit `--api-token-env`
 *      (CI / a machine with no Desktop). `INFINITE_API_ORIGIN` overrides the origin.
 *   3. NoneBackend — nothing can read receipts back, and the report says exactly that.
 *
 * A token in the environment is NEVER used implicitly: an unnoticed stale `INFINITE_API_TOKEN`
 * silently verifying against another account is worse than an honest "not verifiable".
 */
import type {
  HarnessArgs,
  HarnessDeps,
  HarnessIo,
  VerificationBackend
} from "infinite-tag";

import {
  resolveLiveBridge,
  type DesktopAppClient,
  type DesktopBridgeDescriptor
} from "../desktop-app-client.js";

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
  "Verification runs through Infinite Desktop: the app reads the receipts back with its own session,",
  "so no API token is ever needed here. With the app closed (or too old to carry the verify verb),",
  "providers print 'installed, not verifiable' and the report says why.",
  "",
  "  --api-token-env [NAME]  ADVANCED. No Desktop (CI, a server): read a bearer for the Infinite API",
  "                          from NAME (default INFINITE_API_TOKEN) and verify against the cloud",
  "                          directly. INFINITE_API_ORIGIN overrides the host. The Desktop wins",
  "                          whenever it is running — a token is never used implicitly.",
  "",
  "Everything but --help and the read-only --check needs Infinite Desktop signed in with an active",
  "subscription (the standalone `npx infinite-tag harness` does not)."
].join("\n");

export const DEFAULT_INFINITE_API_ORIGIN = "https://api.ultima.inc";
export const DEFAULT_API_TOKEN_ENV_VAR = "INFINITE_API_TOKEN";
export const ANALYTICS_VERIFY_CAPABILITY = "analytics.verify.v1";
/** Every "nothing can read the receipts" line starts here, then names the ONE thing to change. */
export const NOT_VERIFIABLE_PREFIX =
  "Receipts cannot be read back, so providers will print 'installed, not verifiable'.";
export const NO_CLOUD_SESSION_NOTICE = `${NOT_VERIFIABLE_PREFIX} Open the Infinite app and re-run to verify.`;
export const DESKTOP_TOO_OLD_NOTICE = `${NOT_VERIFIABLE_PREFIX} This Infinite app cannot verify from the CLI yet — update it and re-run.`;
export const BRIDGE_BACKEND_NOTICE =
  "Verifying through Infinite Desktop — the app reads the receipts back with its own session; no token needed.";

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
  DesktopBridgeBackend: new (options: { bridgeUrl: string; token: string; fetch?: typeof fetch }) => VerificationBackend;
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

/** The live bridge: the descriptor carries the loopback url + LOCAL bearer + capability list. */
export type ResolvedBridge = {
  client: Pick<DesktopAppClient, "status">;
  descriptor?: Pick<DesktopBridgeDescriptor, "url" | "token" | "capabilities">;
};

export interface AnalyticsCommandDeps {
  loadTag?: () => Promise<TagHarnessModule>;
  /** Test seam over the Desktop bridge; returns null when Desktop is not running. */
  resolveBridge?: (env: AnalyticsCommandEnv) => ResolvedBridge | null;
  io?: HarnessIo;
  fetch?: typeof fetch;
}

async function defaultLoadTag(): Promise<TagHarnessModule> {
  return (await import("infinite-tag")) as unknown as TagHarnessModule;
}

function defaultResolveBridge(env: AnalyticsCommandEnv): ResolvedBridge | null {
  try {
    return resolveLiveBridge(env as Parameters<typeof resolveLiveBridge>[0]);
  } catch {
    return null;
  }
}

/**
 * The Desktop's active workspace, or null when Desktop is not running / not ready.
 *
 * WHICH id this is: the bridge's `/v1/status` is built by the Cmd+L brain service
 * (1bu-1 `apps/desktop/src/main/brain/agent/cmdl-brain-service.ts`, `status()`), whose
 * `workspace.id` is `authority.snapshot.engineProjectId` — the ENGINE project id the desktop
 * links (`proj_…`), the same id `infinite setup` keys `~/.infinite/artifacts/<id>.json` by and
 * the same id every cloud route resolves through `linkedWorkspace(engineProjectId)`. It is NOT
 * the cloud workspace UUID. That is why it is passed straight through as the harness's
 * `--workspace` and as `engineProjectId` in the cloud verify body.
 */
export async function activeWorkspaceFromDesktop(bridge: ResolvedBridge | null): Promise<string | null> {
  if (!bridge) return null;
  try {
    const status = await bridge.client.status();
    const id = status.workspace?.id;
    return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
  } catch {
    return null;
  }
}

/**
 * `--api-token-env [NAME]` is a CLI-only flag: the harness parser would reject it, so it is
 * removed from argv here. Bare, it means the default `INFINITE_API_TOKEN`; a following token that
 * is not itself a flag names a different variable. The VALUE never appears on the command line —
 * a token in shell history is exactly what this design avoids.
 */
export function extractApiTokenEnvFlag(args: readonly string[]): {
  rest: string[];
  envVar: string | null;
} {
  const rest: string[] = [];
  let envVar: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--api-token-env") {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        envVar = next;
        index += 1;
      } else {
        envVar = DEFAULT_API_TOKEN_ENV_VAR;
      }
      continue;
    }
    if (token.startsWith("--api-token-env=")) {
      envVar = token.slice("--api-token-env=".length) || DEFAULT_API_TOKEN_ENV_VAR;
      continue;
    }
    rest.push(token);
  }
  return { rest, envVar };
}

/** Trim trailing "/" without a regex: the value is user-supplied, and `/\/+$/` on a long run of
 *  slashes is a polynomial-backtracking hazard (CodeQL js/polynomial-redos). A scan is cheaper. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export interface ChooseBackendInput {
  tag: TagHarnessModule;
  env: AnalyticsCommandEnv;
  /** The live bridge, or null when Desktop is not running. */
  bridge: ResolvedBridge | null;
  /** The env var named by `--api-token-env`, or null when the flag was not passed. */
  apiTokenEnvVar: string | null;
  workspaceId: string | undefined;
  fetchImpl?: typeof fetch;
}

/**
 * Which backend reads the receipts back — and the one line that tells the founder which, because
 * a report may only print `verified` next to a receipt someone actually produced.
 *
 * The Desktop wins whenever it can serve the verb. The cloud backend is reachable ONLY through the
 * explicit `--api-token-env` escape hatch: a token sitting in the environment must never silently
 * verify a run (it can belong to another account, or be long expired).
 */
export function chooseBackend(input: ChooseBackendInput): {
  backend: VerificationBackend;
  notice: string | null;
} {
  const { tag, env, bridge, apiTokenEnvVar, workspaceId, fetchImpl } = input;
  const descriptor = bridge?.descriptor;
  if (descriptor?.capabilities?.includes(ANALYTICS_VERIFY_CAPABILITY)) {
    return {
      backend: new tag.DesktopBridgeBackend({
        bridgeUrl: descriptor.url,
        token: descriptor.token,
        fetch: fetchImpl
      }),
      notice: BRIDGE_BACKEND_NOTICE
    };
  }

  if (apiTokenEnvVar) {
    const token = env[apiTokenEnvVar]?.trim();
    if (token && workspaceId) {
      const origin = stripTrailingSlashes(env.INFINITE_API_ORIGIN?.trim() || DEFAULT_INFINITE_API_ORIGIN);
      return {
        backend: new tag.InfiniteCloudBackend({ origin, token, engineProjectId: workspaceId, fetch: fetchImpl }),
        notice: `Verifying through the cloud at ${origin} for workspace ${workspaceId}.`
      };
    }
    return {
      backend: new tag.NoneBackend(),
      notice: token
        ? `${NOT_VERIFIABLE_PREFIX} ${apiTokenEnvVar} is set but no workspace id was resolved — pass --workspace.`
        : `${NOT_VERIFIABLE_PREFIX} --api-token-env named ${apiTokenEnvVar}, which is empty.`
    };
  }

  return {
    backend: new tag.NoneBackend(),
    // Desktop running but too old to carry the verb is a DIFFERENT fix from Desktop not running.
    notice: bridge ? DESKTOP_TOO_OLD_NOTICE : NO_CLOUD_SESSION_NOTICE
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

  // `--api-token-env` is ours, not the harness's — strip it before the harness parser sees it.
  const { rest: harnessArgs, envVar: apiTokenEnvVar } = extractApiTokenEnvFlag(args);

  let parsed: HarnessArgs;
  try {
    parsed = tag.parseHarnessArgs(harnessArgs);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(ANALYTICS_USAGE.split("\n")[0]);
    return tag.EXIT_ARGS;
  }

  // ONE bridge resolution for the whole run: it names the workspace AND carries the verify verb.
  const bridge = (deps.resolveBridge ?? defaultResolveBridge)(env);
  if (parsed.workspaceId === undefined) {
    const fromDesktop = await activeWorkspaceFromDesktop(bridge);
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

  const { backend, notice } = chooseBackend({
    tag,
    env,
    bridge,
    apiTokenEnvVar,
    workspaceId: parsed.workspaceId,
    fetchImpl: deps.fetch
  });
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
