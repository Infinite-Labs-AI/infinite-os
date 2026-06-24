#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { stdin as input, stderr as errorOutput, stdout as output } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  CredentialDecryptError,
  decryptCredentialPayload,
  generateEncryptionKey
} from "@infinite-os/core";
import {
  consumeAssistantStreamSurface,
  createInteractiveProgressReporter,
  type InteractiveProgressReporter
} from "./formatting/live-activity.js";
import { createCliRenderer, shouldUseInteractiveRenderer } from "./formatting/renderer.js";
import {
  promptChecklist,
  promptChoice,
  promptProviderMatrix,
  promptText,
  promptUrl,
  promptYesNo,
  shouldUseInteractivePrompts,
  type ProviderInstallState,
  type ProviderInventoryRow,
  type SetupProviderId
} from "./setup-prompts.js";
import { readReleaseGa4OAuthClient, type EmbeddedGa4OAuthClient } from "./ga4-oauth-client.js";
import { prepareGa4ConnectConfig } from "./ga4-connect-config.js";
import { renderInfiniteAppChrome } from "./tui/app/app-chrome.js";
import { displayWidth } from "./tui/lib/display-width.js";
import { buildToolTrailLine, compactPreview } from "./tui/lib/text.js";
import { canUseInkProgressReporter } from "./tui/ink/progress-reporter.js";
import {
  completeInteractiveInput,
  completeSlashCommands,
  runInkInteractiveSession,
  type CompletionSuggestion,
  type InkInteractiveSelectionPrompt
} from "./tui/ink/interactive-session.js";
import { runInfiniteWelcome } from "./tui/ink/infinite-welcome.js";
import { appendPersistentInputHistory, loadPersistentInputHistory } from "./tui/ink/input-history.js";
import { resolveCliRenderSurface, usesTranscriptRenderSurface } from "./tui/runtime/render-surface.js";
import { resolveTheme, type Theme } from "./tui/theme.js";
import type { Msg } from "./tui/types.js";
import { mirrorMachineHomeEnv } from "./mirror-machine-home-env.js";
import { createActionHandlers } from "@infinite-os/analytical-engine";
import {
  loadInfiniteOsConfig,
  resolveDaemonEndpoint,
  invalidateResolvedDaemonEndpoint,
  probeDaemonIdentity,
  NoActiveProjectError,
  parseDotEnv,
  parseSimpleYaml,
  readActiveProjectId,
  writeActiveProjectId,
  clearActiveProjectId,
  readDefaultProjectId,
  writeDefaultProjectId,
  clearDefaultProjectId,
  readMigrationNoticeShown,
  markMigrationNoticeShown,
  type InfiniteOsConfig,
  infiniteOsAuthPath,
  infiniteOsHome,
  infiniteOsWorkspaceId,
  infiniteOsUserConfigPath,
  readInfiniteOsAuthState,
  readInfiniteOsAuthSummary,
  readInfiniteOsModelSelection,
  writeInfiniteOsAuthRecord,
  writeInfiniteOsModelSelection,
  type InfiniteOsAuthRecord,
  type InfiniteOsModelProvider
} from "@infinite-os/config";
import {
  createInfiniteOsDb,
  createProject,
  findProject,
  listProjects,
  runMigrations,
  type InfiniteOsDb,
  type ProjectRow
} from "@infinite-os/db";
import {
  createDbBackedConnectedXIdentityLookup,
  createCuratedMemoryManager,
  createConfiguredModelClient,
  createLlmController,
  createModelBackedMemoryReviewer,
  createSourceAwareQueryAdvisor,
  createSessionStore,
  filterCuratedMemoryCandidates,
  type ChatProgressEvent,
  type ChatProgressMode,
  type ChatSessionStore,
  type InfiniteOsModelClient
} from "@infinite-os/llm-controller";
import {
  createOperatorSessionMemory,
  createFileSessionMemoryStore,
  createSessionContext,
  createInfiniteOsRegistry,
  listRecipes,
  loadSetupModule as loadRuntimeSetupModule,
  renderProgressBar,
  runtimeBoot,
  runRecipe,
  type ActionEnvelope,
  type OperatorSessionMemory,
  type SessionContext,
  type RecipeId,
  type SessionMemoryStore,
  type SessionMemoryState
} from "@infinite-os/runtime";

export const cliBoot = runtimeBoot;
export { formatInteractiveProgress } from "./formatting/progress.js";
export { createCliRenderer, renderAssistantResponsePanel, renderStatusFooter } from "./formatting/renderer.js";
export { renderInfiniteAppChrome, shouldUseInfiniteAppChrome } from "./tui/app/app-chrome.js";
export { resolveTheme } from "./tui/theme.js";
export { resolveCliRenderSurface, usesTranscriptRenderSurface } from "./tui/runtime/render-surface.js";
export { createInfiniteTranscriptRuntime } from "./tui/runtime/transcript-runtime.js";
export { inkTranscriptRowCount, renderInkTranscriptToString } from "./tui/ink/transcript-app.js";
export {
  appendInputHistory,
  applyCompletionSuggestion,
  applyComposerEdit,
  composerCursorLayout,
  composerNativeCursorPosition,
  completeInteractiveInput,
  completeSlashCommands,
  navigateInputHistory,
  renderInkInteractiveSessionToString
} from "./tui/ink/interactive-session.js";
export {
  appendPersistentInputHistory,
  inputHistoryPath,
  loadPersistentInputHistory,
  parsePersistentInputHistory
} from "./tui/ink/input-history.js";
export { LongRunToolCharmTicker } from "./tui/app/long-run-tool-charms.js";
export { renderInfiniteTranscript } from "./tui/app/transcript-renderer.js";
export { InfiniteTurnController, getTurnState, resetTurnState, turnController } from "./tui/app/turn-controller.js";
export type { ChatProgressEvent, ChatProgressMode } from "@infinite-os/llm-controller";

export interface CliEnv {
  GROWTH_OS_API_URL?: string;
  GROWTH_OS_OPERATOR_TOKEN?: string;
  GROWTH_OS_READ_TOKEN?: string;
  GROWTH_OS_WORKSPACE_ID?: string;
  GROWTH_OS_WORKSPACE_ROOT?: string;
  GROWTH_OS_ENCRYPTION_KEY?: string;
  DATABASE_URL?: string;
  GROWTH_OS_DOCKER_BIN?: string;
  GROWTH_OS_CODEX_BIN?: string;
  GROWTH_OS_CLAUDE_BIN?: string;
  GROWTH_OS_COMPOSE_PROJECT?: string;
  GROWTH_OS_CODE_VERSION?: string;
  GROWTH_OS_START_TIMEOUT_MS?: string;
  GROWTH_OS_START_POLL_INTERVAL_MS?: string;
  /** Short per-probe cap on the interactive readiness path (default 8s) — keeps a
   * missing/zombie daemon from hanging startup (design §3/§7). */
  GROWTH_OS_READINESS_PROBE_TIMEOUT_MS?: string;
  GROWTH_OS_SYNC_WAIT_TIMEOUT_MS?: string;
  GROWTH_OS_SYNC_POLL_INTERVAL_MS?: string;
  GROWTH_OS_CLI_DRY_RUN?: string;
  GROWTH_OS_CLI_NONINTERACTIVE?: string;
  GROWTH_OS_HOME?: string;
  GROWTH_OS_CODEX_AUTH_BASE_URL?: string;
  GROWTH_OS_CODEX_TOKEN_URL?: string;
  GROWTH_OS_CODEX_AUTH_TIMEOUT_MS?: string;
  GROWTH_OS_CODEX_AUTH_POLL_MS?: string;
  GROWTH_OS_CODEX_AUTH_SILENT?: string;
  GROWTH_OS_CLAUDE_REFRESH_URL?: string;
  GROWTH_OS_AUTH_BROWSER_BIN?: string;
  GROWTH_OS_GA4_OAUTH_CLIENT_ID?: string;
  GROWTH_OS_GA4_OAUTH_CLIENT_SECRET?: string;
  GROWTH_OS_GA4_OAUTH_REDIRECT_URI?: string;
  INFINITE_RENDER_SURFACE?: string;
  INFINITE_PLAIN_OUTPUT?: string;
  INFINITE_CLI_SKIN?: string;
  INFINITE_SKIN?: string;
  INFINITE_SKIN_DIR?: string;
  INFINITE_SKIN_FILE?: string;
  INFINITE_THEME?: string;
  INFINITE_TUI_CHROME?: string;
  CODEX_HOME?: string;
  OPENAI_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  ANTHROPIC_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  HOME?: string;
  PWD?: string;
  /** Set by SSH; used as a hint that the loopback OAuth redirect lands on THIS box (#7). */
  SSH_CONNECTION?: string;
  SSH_TTY?: string;
}

interface CliOutputStream {
  columns?: number;
  isTTY?: boolean;
}

interface CliInputStream {
  isTTY?: boolean;
}

interface CliProgressStream extends CliOutputStream {
  write(chunk: string): boolean;
}

interface CliProgressReporterOptions {
  promptPlaceholder?: string;
  status?: readonly string[] | (() => readonly string[]);
  theme?: Theme;
}

interface ApiOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  operator?: boolean;
  config?: InfiniteOsConfig;
  omitWorkspace?: boolean;
  // Explicit workspace header, bypassing the env-derived pin. Used by
  // cross-workspace readiness to scope `/sources` per project without a pin.
  workspaceId?: string;
  // Per-request abort cap (ms). The INTERACTIVE readiness path passes a short cap so
  // a missing/zombie daemon fails fast (~30-60s budget across the readiness probes)
  // instead of blocking on a foreign server that accepts the TCP connection but never
  // answers — the original 5-minute startup hang (design §1/§7). Omitted = no cap.
  timeoutMs?: number;
}

interface InteractiveChatState {
  // Immutable UI conversation id (`cli_<uuid>`), set once at session start and
  // only re-pointed by `/new` and `/resume`. The runtime derives the
  // per-workspace controller session id (`${conversationId}:${workspaceId}`)
  // from THIS, never from `sessionId` — deriving from the round-tripped
  // `sessionId` would compound the `:<ws>` suffix every turn.
  conversationId: string;
  // Last controller session id returned by a turn — display/`status` only.
  // Never fed back into `conversationId`.
  sessionId?: string;
}

interface RunSlashCommandOptions {
  onProgress?: (event: ChatProgressEvent) => void;
  progressStream?: CliProgressStream;
}

interface RunCommandOptions {
  onProgress?: (event: ChatProgressEvent) => void;
  syncPollIntervalMs?: number;
  syncWaitTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Confirm/typed-confirm seams for `infinite meta <object> <action>` writes.
  // Production never sets this; tests inject deterministic gates.
  meta?: MetaCommandOptions;
}

type SetupPreflightAction = "continue" | "status" | "exit";
type SetupWizardMode = "quick" | "full" | "reuse" | "exit";
type ProductSurface = "web" | "mobile";
type PostHogResumeHostChoice = "eu" | "us" | "custom";

interface SetupInterview {
  projectName: string;
  productDescription?: string;
  websiteUrl?: string;
  productSurface: ProductSurface;
  providerInventory: ProviderInventoryRow[];
}

interface RunSetupInterviewOptions {
  prompt?: boolean;
  defaultProjectName?: string;
  promptProjectName?: (question: string, defaultValue?: string) => Promise<string>;
  promptWebsiteUrl?: (question: string, defaultValue?: string) => Promise<string>;
  promptProviderInventory?: (rows: ProviderInventoryRow[]) => Promise<ProviderInventoryRow[]>;
  onWarning?: (message: string) => void;
}

// Claude-Code OAuth completions are no longer supported (Anthropic ToS — no
// first-party broker to route OAuth-bearer chat through). Steer users to an API key.
const CLAUDE_OAUTH_UNSUPPORTED_REASON =
  "Claude via OAuth (Claude Code setup-token/reuse credentials) is no longer supported. Set `ANTHROPIC_API_KEY` to use Claude, or run `codex login` to use Codex.";

export interface SetupReadiness {
  ok: boolean;
  workspaceRoot: string;
  runtimeConfig: "missing" | "configured";
  runtimeServices: "unknown" | "down" | "ready";
  database: "unknown" | "missing" | "migrated";
  model: "missing" | "selected";
  auth: "missing" | "ready";
  connectors: "none" | "connected";
  llmQuery: "blocked" | "ready";
  blockingReasons: string[];
  modelSelection?: {
    provider?: InfiniteOsModelProvider;
    model?: string;
  };
  authProvider?: {
    provider: InfiniteOsModelProvider;
    source?: string;
    reason: string;
  };
  activeSetupRun?: SetupRunSummary | null;
  connectedSourceCount?: number;
}

interface SetupRunSummary {
  id: string;
  tool?: string;
  provider?: string;
  status?: string;
  updatedAt?: string;
  interview?: {
    projectName?: string;
    productDescription?: string;
    websiteUrl?: string;
    productSurface?: string;
  } | null;
  selectedProviders?: string[];
  recommendedProviders?: string[];
  providers?: Record<string, SetupRunProviderSummary>;
  pendingHandoff?: {
    kind?: string;
    url?: string;
    lastUrl?: string;
    instructions?: string;
  } | null;
  site?: {
    id?: string;
    url?: string;
    repoPath?: string;
    appDir?: string;
    framework?: string;
    businessType?: string;
  } | null;
}

interface SetupRunProviderSummary {
  phases?: Record<string, { status?: string; detail?: string }>;
  verification?: {
    installStatus?: string;
    queryabilityStatus?: string;
    lastCheckedAt?: string;
  } | null;
}

interface SetupOnboardingProviderSummary {
  provider: SetupProviderId;
  selected: boolean;
  recommended: boolean;
  status: "completed" | "paused_handoff" | "failed" | "not_selected" | "deferred";
  runId?: string;
  detail?: string;
  /** Human rationale for a deferred provider (#13), surfaced from the recommendation. */
  deferralReason?: string;
  /** Drives the enable-path copy: "reenable" → re-tick & re-run; "future" → not in this version. */
  deferralKind?: "reenable" | "future";
  handoff?: {
    url?: string;
    lastUrl?: string;
    instructions?: string;
  };
}

interface SetupOnboardingResult {
  ok: boolean;
  section: "connectors";
  workflow: "onboarding";
  interview: SetupInterview;
  selectedProviders: SetupProviderId[];
  recommendedProviders: SetupProviderId[];
  completed: SetupProviderId[];
  paused: SetupProviderId[];
  failed: SetupProviderId[];
  providers: SetupOnboardingProviderSummary[];
  resolvedPublicArtifacts?: {
    ga4?: Record<string, unknown>;
    posthog?: Record<string, unknown>;
    x?: Record<string, unknown>;
  };
  /** Complete `npx infinite-tag install …` command for the founder's website repo; null when nothing installable was captured. */
  installCommand?: string | null;
  /** Same-machine handoff file with the saved PUBLIC keys (~/.infinite/artifacts/<workspaceId>.json); null when not written. */
  installArtifactsPath?: string | null;
  /**
   * Every provider in the workspace still paused on a browser handoff (#11), derived from
   * the workspace-wide activeRuns (NOT the scoped interview), deduped per provider. Lets
   * the render + `next` surface all outstanding providers, not just the first/scoped one.
   */
  outstanding?: Array<{ provider: SetupProviderId; runId: string; instructions?: string; url?: string }>;
  next?: string;
}

type SetupCliResult = Record<string, unknown> | SetupOnboardingResult;

interface SetupResumeRunInput {
  runId: string;
  env: CliEnv;
  workspaceId: string;
  jsonMode?: boolean;
  posthogPersonalApiKey?: string;
  posthogApiHost?: string;
}

interface SetupResumePostHogSecrets {
  personalApiKey?: string;
  apiHost?: string;
}

interface SetupWizardOptions {
  runSetupOnboarding?: (input: { interview: SetupInterview; env: CliEnv; workspaceId: string }) => Promise<SetupOnboardingResult>;
  resumeSetupRun?: (input: SetupResumeRunInput) => Promise<SetupOnboardingResult>;
  activeSetupRun?: SetupRunSummary | null;
  runSetupRuntimeSection?: (args: string[], env: CliEnv) => Promise<Record<string, unknown>>;
  jsonMode?: boolean;
}

// These mirror the exported types in @infinite-os/setup (provider-guidance.ts / live.ts).
// The setup module is loaded at runtime (not statically imported), so we restate the seam
// types structurally here. Keep them in sync with the setup package.
type GuidanceStep = "quick_connect" | "byo" | "tos" | "api_key" | "signup" | "billing";
type Ga4OauthWaitDecision = "retry" | "byo" | "manual" | "quit";
interface Ga4OauthWaitInteraction {
  onWaitStarted?(input: { authorizationUrl?: string; sessionId: string }): void;
  waitForDecision?(): Promise<Ga4OauthWaitDecision | null>;
  cancelWait?(): void;
  onTimeout?(input: { error?: string | null; sessionId: string }): Promise<Ga4OauthWaitDecision | null>;
  onFailed?(input: { error?: string | null; sessionId: string }): Promise<Ga4OauthWaitDecision | null>;
}
type ProviderHandoffGate = (
  provider: SetupProviderId,
  context: { index: number; total: number; url?: string; signal?: AbortSignal }
) => Promise<void>;

interface SetupModuleApi {
  runLiveSetupOnboarding(input: {
    db: InfiniteOsDb;
    workspaceId: string;
    repoRoot?: string;
    interview: SetupInterview;
    actions: {
      execute(id: string, input: unknown, ctx: SessionContext): Promise<ActionEnvelope>;
    };
    prompt: {
      ask(question: string, choices?: string[]): Promise<string>;
      note(message: string): void;
    };
    ga4OauthBootstrap?: {
      prepareConfig(): Promise<{ clientId: string; clientSecret: string; redirectUri?: string } | null>;
      start(input: { clientId: string; clientSecret: string; redirectUri?: string }): Promise<Record<string, unknown>>;
      status(sessionId: string): Promise<Record<string, unknown>>;
      exchange(sessionId: string): Promise<Record<string, unknown>>;
    };
    /** Cancellable GA4 OAuth wait interaction (#7); omitted on non-interactive/--json/headless. */
    ga4OauthInteraction?: Ga4OauthWaitInteraction;
    /** Sequencing gate between paused provider hand-offs (#8); omitted on non-interactive. */
    awaitProviderHandoff?: ProviderHandoffGate;
    /** Per-provider "Now connecting <Provider> (N of M)…" boundary callback (#8). */
    onProviderStart?: (input: { provider: SetupProviderId; index: number; total: number }) => void;
    log?: (event: { phase: string; status: string; detail?: string }) => void;
  }): Promise<{
    selectedProviders: SetupProviderId[];
    recommendedProviders: SetupProviderId[];
    /** Per-provider recommendation truth (#13): carries deferral status + rationale + reasonCode. */
    recommendations: Array<{ provider: SetupProviderId; status: "recommended" | "deferred" | "not_applicable"; reasonCode: string; rationale: string }>;
    completed: SetupProviderId[];
    paused: SetupProviderId[];
    failed: SetupProviderId[];
    runs: Partial<Record<SetupProviderId, { phases: Record<string, { status: string; detail: string; data?: Record<string, unknown>; handoff?: { url?: string; instructions: string } }>; providerState?: { browser?: { profileRef?: string } } }>>;
    activeRuns: Array<{ id: string; provider?: string; status?: string; pendingHandoff?: { url?: string; lastUrl?: string; instructions?: string } | null }>;
    resolvedPublicArtifacts: {
      ga4: Record<string, unknown>;
      posthog: Record<string, unknown>;
      x: Record<string, unknown>;
    };
    installCommand: string | null;
    installArtifactsPath: string | null;
  }>;
  resumeLiveSetupOnboarding(input: {
    db: InfiniteOsDb;
    workspaceId: string;
    runId: string;
    resumeSecrets?: {
      posthog?: {
        apiHost?: string;
        personalApiKey?: string;
      };
    };
    actions: {
      execute(id: string, input: unknown, ctx: SessionContext): Promise<ActionEnvelope>;
    };
    prompt: {
      ask(question: string, choices?: string[]): Promise<string>;
      note(message: string): void;
    };
    ga4OauthBootstrap?: {
      prepareConfig(): Promise<{ clientId: string; clientSecret: string; redirectUri?: string } | null>;
      start(input: { clientId: string; clientSecret: string; redirectUri?: string }): Promise<Record<string, unknown>>;
      status(sessionId: string): Promise<Record<string, unknown>>;
      exchange(sessionId: string): Promise<Record<string, unknown>>;
    };
    /** Cancellable GA4 OAuth wait interaction (#7); omitted on non-interactive/--json/headless. */
    ga4OauthInteraction?: Ga4OauthWaitInteraction;
    /** Sequencing gate between paused provider hand-offs (#8); omitted on non-interactive. */
    awaitProviderHandoff?: ProviderHandoffGate;
    /** Per-provider "Now connecting <Provider> (N of M)…" boundary callback (#8). */
    onProviderStart?: (input: { provider: SetupProviderId; index: number; total: number }) => void;
    log?: (event: { phase: string; status: string; detail?: string }) => void;
  }): Promise<{
    interview?: SetupInterview;
    selectedProviders: SetupProviderId[];
    recommendedProviders: SetupProviderId[];
    /** Per-provider recommendation truth (#13): carries deferral status + rationale + reasonCode. */
    recommendations: Array<{ provider: SetupProviderId; status: "recommended" | "deferred" | "not_applicable"; reasonCode: string; rationale: string }>;
    completed: SetupProviderId[];
    paused: SetupProviderId[];
    failed: SetupProviderId[];
    runs: Partial<Record<SetupProviderId, { phases: Record<string, { status: string; detail: string; data?: Record<string, unknown>; handoff?: { url?: string; instructions: string } }>; providerState?: { browser?: { profileRef?: string } } }>>;
    activeRuns: Array<{ id: string; provider?: string; status?: string; pendingHandoff?: { url?: string; lastUrl?: string; instructions?: string } | null }>;
    resolvedPublicArtifacts: {
      ga4: Record<string, unknown>;
      posthog: Record<string, unknown>;
      x: Record<string, unknown>;
    };
    installCommand: string | null;
    installArtifactsPath: string | null;
  }>;
  /** Pure-string per-provider guidance template; reused by the CLI just-in-time (#8 Part 2). */
  providerGuidance(
    provider: SetupProviderId,
    step: GuidanceStep,
    ctx?: { authorizationUrl?: string; runId?: string; remoteLoopbackHint?: boolean },
    hasAccount?: boolean
  ): string;
  readSetupInterviewFromRun(
    db: InfiniteOsDb,
    workspaceId: string,
    runId: string
  ): Promise<SetupInterview | null>;
  abandonActiveSetupRuns(
    db: InfiniteOsDb,
    workspaceId: string,
    tool?: string
  ): Promise<Array<{ id: string; tool: string }>>;
  installGa4Tag(input: {
    measurementId: string;
    repoRoot: string;
    workspaceId: string;
    confirm?: (summary: {
      framework: string;
      appRoot: string;
      packageManager: string;
      files: string[];
    }) => Promise<boolean>;
  }): Promise<{
    result: { status: string; detail: string; data?: Record<string, unknown>; caveats?: string[] };
    verification?: { installStatus: string; queryabilityStatus?: string };
  }>;
  /**
   * Provider-neutral combined install (#9): plans + applies every captured tag in ONE
   * pass so the managed analytics module is rewritten once. Mirrors {@link installGa4Tag}
   * but takes the full artifacts map; the confirm summary names which providers will be
   * written. Restated structurally here because the setup module is loaded at runtime.
   */
  installProviderTags(input: {
    artifacts: SetupWorkspaceInstallArtifacts;
    repoRoot: string;
    workspaceId: string;
    confirm?: (summary: {
      framework: string;
      appRoot: string;
      packageManager: string;
      files: string[];
      providers: SetupProviderId[];
    }) => Promise<boolean>;
  }): Promise<{
    result: { status: string; detail: string; data?: Record<string, unknown>; caveats?: string[] };
    verification?: { installStatus: string; queryabilityStatus?: string };
  }>;
  /** Workspace-wide active/paused setup runs (#11 outstanding + `setup resume --all`). */
  listActiveSetupRuns(
    db: InfiniteOsDb,
    workspaceId: string
  ): Promise<Array<{ id: string; provider?: string; status?: string; pendingHandoff?: { url?: string; lastUrl?: string; instructions?: string } | null }>>;
  /** Tested public bootstrap-snippet builders re-exported from infinite-tag (#9 manual fallback). */
  buildPostHogBootstrapSnippet(projectKey: string, apiHost: string): string;
  buildXBootstrapSnippet(pixelId: string, eventTagIds: string[]): string;
  wrapHtmlSnippet(source: string): string;
}

/**
 * Structural restatement of @infinite-os/setup's `WorkspaceInstallArtifacts` (= infinite-tag).
 * The CLI builds this map from `resolvedPublicArtifacts` to drive the combined install.
 */
interface SetupWorkspaceInstallArtifacts {
  ga4?: { measurementId: string };
  posthog?: { projectKey: string; apiHost: string };
  x?: { pixelId: string; eventTagIds: string[] };
}

async function loadSetupModule(): Promise<SetupModuleApi> {
  return loadRuntimeSetupModule(import.meta.url) as Promise<SetupModuleApi>;
}

interface SetupFilesSummary {
  projectConfigPath: string;
  runtimeEnvPath: string;
  userConfigPath: string;
  userAuthPath: string;
}

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CLAUDE_CODE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // gitleaks:allow — Claude Code public OAuth client id
const DEFAULT_CODEX_AUTH_BASE_URL = "https://auth.openai.com";
const DEFAULT_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_CLAUDE_REFRESH_URLS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token"
];
const MODEL_PROVIDER_CATALOG: Record<
  InfiniteOsModelProvider,
  { models: string[]; defaultModel: string }
> = {
  codex: {
    models: ["gpt-5.4"],
    defaultModel: "gpt-5.4"
  },
  claude: {
    models: [
      "claude-sonnet-4-6",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-4-5",
      "claude-haiku-4-5-20251001"
    ],
    defaultModel: "claude-sonnet-4-6"
  }
};
const SETUP_INTERVIEW_PROVIDERS = ["ga4", "posthog", "x"] as const satisfies readonly SetupProviderId[];
const DEFAULT_SETUP_INTERVIEW_PROVIDERS = ["ga4", "posthog"] as const satisfies readonly SetupProviderId[];
const DEFAULT_SETUP_INTERVIEW_PROVIDER_SET = new Set<SetupProviderId>(DEFAULT_SETUP_INTERVIEW_PROVIDERS);
const SETUP_OPTIONS_WITH_VALUES = new Set([
  "--provider",
  "--model",
  "--auth",
  "--mode",
  "--backfill-window",
  "--backfill",
  "--backfill-range",
  "--project-name",
  "--product-description",
  "--website-url",
  "--product-surface",
  "--providers",
  "--ga4-installed",
  "--posthog-installed",
  "--x-installed"
]);
const INTERACTIVE_COMMAND_COMPLETIONS: readonly CompletionSuggestion[] = [
  { value: "/connect", description: "Connect a data source (guided wizard)" },
  { value: "/help", description: "Show CLI help" },
  { value: "/memory", description: "Review or update session memory" },
  { value: "/sessions", description: "List model-backed chat sessions" },
  { value: "/resume", description: "Resume a chat session" },
  { value: "/new", description: "Start a new chat session" },
  { value: "/compact", description: "Compact the active chat session" },
  { value: "/confirm", description: "Confirm a pending operator action" },
  { value: "/call", description: "Call a typed action directly" },
  { value: "/setup", description: "Configure Infinite" },
  { value: "/status", description: "Show Docker stack status" },
  { value: "/sources", description: "List connected sources" },
  { value: "/schema", description: "List queryable schema" },
  { value: "/views", description: "List queryable views" },
  { value: "/metrics", description: "List metric definitions" },
  { value: "/sync", description: "Sync a source, provider, or all (wizard when no target)" },
  { value: "/sync-runs", description: "List recent sync runs" },
  { value: "/recipes", description: "List guided recipes" },
  { value: "/explain", description: "Explain a metric" },
  { value: "/mcp", description: "List app-hosted MCP tools" },
  { value: "/tools", description: "List app-hosted MCP tools" },
  { value: "/auth", description: "Manage model auth" },
  { value: "/codex", description: "Sign in to Codex (login, import, status)" },
  { value: "/model", description: "Manage model selection" },
  { value: "/project", description: "Create, list, or switch projects" },
  { value: "/exit", description: "Exit the interactive shell" },
  { value: "/quit", description: "Exit the interactive shell" }
];

// ── Home inventory (every-launch startup screen) ──────────────────────────────
// A SHORT, friendly curated list of what the OS can DO — verb-phrases, NOT raw
// action ids. Hand-curated on purpose (the action registry is large and its ids
// are internal); keep it to the handful that read well as "here's what I can do".
const HOME_INVENTORY_TOOLS: readonly { label: string }[] = [
  { label: "connect" },
  { label: "sync" },
  { label: "generate ads" },
  { label: "insights" },
  { label: "outreach" },
  { label: "query" }
];

// The curated subset of slash commands shown on the home screen — the most useful
// front doors, drawn from INTERACTIVE_COMMAND_COMPLETIONS (the same registry the
// Tab-completer uses). Kept short so the Commands row stays one line on a normal
// terminal; the full set is still discoverable via `/help` and Tab.
const HOME_INVENTORY_COMMAND_VALUES: readonly string[] = [
  "/connect",
  "/sync",
  "/help",
  "/memory",
  "/sessions",
  "/exit"
];

// Friendly short labels for the Connected row, keyed by the connector `provider`.
// Falls back to a title-cased provider id for anything not listed here.
const HOME_INVENTORY_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  google_analytics_4: "GA4",
  posthog: "PostHog",
  stripe: "Stripe",
  x: "X",
  shopify: "Shopify",
  meta_ads: "Facebook"
};

export function homeInventoryProviderLabel(provider: string): string {
  return (
    HOME_INVENTORY_PROVIDER_LABELS[provider] ??
    provider
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

// The curated command subset, resolved from the registry so a renamed/removed
// command can't drift out of sync. Skips any value missing from the registry.
export function homeInventoryCommands(): readonly { value: string }[] {
  const known = new Set(INTERACTIVE_COMMAND_COMPLETIONS.map((entry) => entry.value));
  return HOME_INVENTORY_COMMAND_VALUES.filter((value) => known.has(value)).map((value) => ({ value }));
}

// Best-effort, BOUNDED fetch of the connected sources for the home screen. Uses
// the app-API `/sources` path (pin-tolerant — `apiRequest` omits the workspace
// header on a no-pin session) with a SHORT abort cap so a missing/zombie daemon
// fails fast. Returns `undefined` (NOT an empty array) on ANY failure so the home
// screen renders the inventory WITHOUT a misleading "nothing connected" line — it
// shows a muted "daemon not reachable" note instead. NEVER throws, never hangs.
async function fetchHomeInventoryConnections(
  env: CliEnv
): Promise<readonly { label: string; degraded?: boolean }[] | undefined> {
  // Reuse the readiness probe cap (default 1.5s) so the prompt is never delayed.
  const timeoutMs = readinessProbeTimeoutMs(env);
  try {
    const payload = await apiRequest("/sources", env, { timeoutMs });
    const connections = configuredConnectionsFromPayload(payload);
    // De-dupe by provider (a workspace can have multiple connections per provider)
    // and prefer "connected" over "degraded" for the tick.
    const byProvider = new Map<string, boolean>();
    for (const connection of connections) {
      const degraded = connection.status === "degraded";
      const existing = byProvider.get(connection.provider);
      byProvider.set(connection.provider, existing === false ? false : degraded);
    }
    return [...byProvider.entries()].map(([provider, degraded]) => ({
      label: homeInventoryProviderLabel(provider),
      degraded
    }));
  } catch {
    // Daemon unreachable / no pin resolvable / timeout → omit the live line.
    return undefined;
  }
}

export function completeInteractiveInputForCli(value: string, env: CliEnv): readonly CompletionSuggestion[] {
  const workspaceRoot = workspaceRootFor(env);

  return completeInteractiveInput(value, INTERACTIVE_COMMAND_COMPLETIONS, {
    cwd: workspaceRoot,
    env: env as NodeJS.ProcessEnv,
    // `@name` completion reads the in-memory project-list cache (loaded at session
    // start, refreshed on `project new`) — the completion hook is synchronous.
    projects: projectListCache
  });
}

type SetupAuthMode = "login" | "import" | "reuse" | "setup-token" | "none";
type RuntimeSetupMode = "local_docker" | "external_postgres" | "supabase";
type SetupSectionId = "runtime" | "model" | "project" | "connectors" | "query" | "status";

interface ConnectorFieldDefinition {
  flag: string;
  aliases?: string[];
  label: string;
  key: string;
  required: boolean;
  secret?: boolean;
}

export interface ConnectorSetupDefinition {
  provider: "google_analytics_4" | "posthog" | "stripe" | "x" | "shopify" | "meta_ads";
  label: string;
  description: string;
  docsUrl: string;
  credentialKind: string;
  defaultConnectionName: string;
  fields: ConnectorFieldDefinition[];
  oauth?: boolean;
}

const DEFAULT_PROJECT_DATABASE_URL = "postgres://growth_os:growth_os_dev@localhost:5432/growth_os";
const SETUP_SECTIONS: ReadonlyArray<{
  id: SetupSectionId;
  title: string;
}> = [
  { id: "runtime", title: "Runtime and storage" },
  { id: "model", title: "Model and auth for LLM querying" },
  { id: "project", title: "Your first project" },
  { id: "connectors", title: "Data connectors" },
  { id: "query", title: "Query readiness" },
  { id: "status", title: "Review and start" }
];
const CONNECTOR_SETUP_REGISTRY: ReadonlyArray<ConnectorSetupDefinition> = [
  {
    provider: "google_analytics_4",
    label: "Google Analytics 4",
    description: "Web analytics",
    docsUrl: "https://developers.google.com/analytics/devguides/reporting/data/v1",
    credentialKind: "oauth_access_token",
    defaultConnectionName: "Google Analytics 4",
    oauth: true,
    fields: [
      { flag: "--client-id", label: "Google OAuth client ID", key: "clientId", required: true },
      { flag: "--property-id", label: "GA4 property ID", key: "propertyId", required: false }
    ]
  },
  {
    provider: "posthog",
    label: "PostHog",
    description: "Product analytics",
    docsUrl: "https://posthog.com/docs/api",
    credentialKind: "personal_api_key",
    defaultConnectionName: "PostHog",
    fields: [
      { flag: "--project-id", label: "PostHog project ID", key: "projectId", required: true },
      { flag: "--personal-api-key", label: "PostHog personal API key", key: "personalApiKey", required: true, secret: true },
      { flag: "--api-host", aliases: ["--posthog-api-host"], label: "PostHog API host", key: "apiHost", required: false }
    ]
  },
  {
    provider: "stripe",
    label: "Stripe",
    description: "Billing and revenue",
    docsUrl: "https://docs.stripe.com/api",
    credentialKind: "api_key",
    defaultConnectionName: "Stripe",
    fields: [
      { flag: "--secret-key", label: "Stripe secret key", key: "secretKey", required: true, secret: true },
      { flag: "--api-base-url", label: "Stripe API base URL", key: "apiBaseUrl", required: false }
    ]
  },
  {
    provider: "x",
    label: "X",
    description: "Social/public content metrics",
    docsUrl: "https://developer.x.com/en/docs/x-api",
    credentialKind: "bearer_token",
    defaultConnectionName: "X Public Metrics",
    fields: [
      { flag: "--bearer-token", label: "X bearer token", key: "bearerToken", required: true, secret: true },
      { flag: "--username", label: "X username", key: "username", required: true },
      { flag: "--api-base-url", label: "X API base URL", key: "apiBaseUrl", required: false }
    ]
  },
  {
    provider: "shopify",
    label: "Shopify",
    description: "Store orders and catalog",
    docsUrl: "https://shopify.dev/docs/api/admin-graphql/latest",
    credentialKind: "admin_api_access_token",
    defaultConnectionName: "Shopify",
    fields: [
      { flag: "--store-domain", label: "Shopify store domain", key: "storeDomain", required: true },
      { flag: "--admin-access-token", label: "Shopify Admin API access token", key: "adminAccessToken", required: true, secret: true },
      { flag: "--api-version", label: "Shopify Admin API version", key: "apiVersion", required: false }
    ]
  },
  {
    provider: "meta_ads",
    label: "Meta Ads",
    description: "Campaign performance insights",
    docsUrl: "https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/insights",
    credentialKind: "marketing_api_access_token",
    defaultConnectionName: "Meta Ads",
    fields: [
      { flag: "--ad-account-id", label: "Meta ad account ID", key: "adAccountId", required: true },
      { flag: "--access-token", label: "Meta access token", key: "accessToken", required: true, secret: true },
      { flag: "--api-version", label: "Meta Graph API version", key: "apiVersion", required: false },
      { flag: "--meta-ads-cli-command", label: "Meta Ads CLI command", key: "cliCommand", required: false },
      {
        flag: "--mcp-stdio-command",
        aliases: ["--mcp-command"],
        label: "MCP stdio command",
        key: "mcpCommand",
        required: false
      },
      { flag: "--mcp-tool-name", label: "MCP stdio tool name", key: "mcpToolName", required: false }
    ]
  }
];

const META_ADS_BACKFILL_WARNING =
  "Meta Ads backfills can take time, especially for large accounts or long history windows.";
const META_ADS_BACKFILL_OPTIONS = [
  { value: "7_days", label: "7 days", refreshWindowDays: 7 },
  { value: "14_days", label: "14 days", refreshWindowDays: 14 },
  { value: "30_days", label: "30 days", refreshWindowDays: 30 },
  { value: "3_months", label: "3 months", refreshWindowDays: 90 },
  { value: "6_months", label: "6 months", refreshWindowDays: 180 },
  { value: "12_months", label: "12 months", refreshWindowDays: 365 },
  { value: "all_time", label: "all time", refreshWindowDays: undefined }
] as const;
type MetaAdsBackfillOption = (typeof META_ADS_BACKFILL_OPTIONS)[number];
const DEFAULT_META_ADS_BACKFILL_OPTION = META_ADS_BACKFILL_OPTIONS[2];

export interface CliAgentRuntime {
  chat(input: {
    message: string;
    sessionId?: string;
    progressMode?: ChatProgressMode;
    onProgress?: (event: ChatProgressEvent) => void;
  }): Promise<unknown>;
  listSessions(): Promise<unknown>;
  resumeSession(sessionId: string): Promise<unknown>;
  compactSession(sessionId: string, summaryText?: string): Promise<unknown>;
  confirmAction(confirmationId: string): Promise<unknown>;
  listMemory(sessionId: string): Promise<unknown>;
  addMemory(sessionId: string, scope: string, fact: string): Promise<unknown>;
  deleteMemory(sessionId: string, memoryId: string): Promise<unknown>;
  close?(): Promise<void>;
}

type CliAgentRuntimeSource = CliAgentRuntime | (() => CliAgentRuntime);

// Module-scoped memo so `infinite project use` can re-scope the live TUI runtime.
// The interactive session builds this lazily; `resetAgentRuntime` closes + nulls it
// so the next `localAgentRuntime()` rebuilds against the newly-active project (the
// runtime binds `workspaceId` at construction).
let activeAgentRuntime: CliAgentRuntime | undefined;

export function ensureActiveAgentRuntime(factory: () => CliAgentRuntime): CliAgentRuntime {
  activeAgentRuntime ??= factory();
  return activeAgentRuntime;
}

export function resetAgentRuntime(): void {
  activeAgentRuntime?.close?.();
  activeAgentRuntime = undefined;
}

// The active project's display name, cached for the interactive session so the
// per-answer label (`Infinite — <project>`) renders without a query every turn.
// `state.json` persists only the immutable project id — the single source of
// truth for names is the `workspaces` table — so we resolve the name once at
// session start and refresh it in-process whenever the active project changes.
let activeProjectLabel: string | undefined;

async function refreshActiveProjectLabel(env: CliEnv): Promise<void> {
  try {
    // Honor the in-process env pin first (the session pin loaded from the
    // persisted default, or set by `--project`/CI), falling back to the legacy
    // `activeProjectId` — same precedence as `infiniteOsWorkspaceId`, so the label
    // tracks the project that queries actually scope to. (PR4 re-points this at
    // the resolved `@name` pin.)
    const id = env.GROWTH_OS_WORKSPACE_ID?.trim() || readActiveProjectId(env as NodeJS.ProcessEnv);
    if (!id) {
      activeProjectLabel = undefined;
      return;
    }
    const { databaseUrl } = loadInfiniteOsConfig({
      workspaceRoot: workspaceRootFor(env),
      env: env as NodeJS.ProcessEnv
    });
    const db = createInfiniteOsDb(databaseUrl);
    try {
      const project = await findProject(db, id);
      activeProjectLabel = project?.name;
    } finally {
      await db.close();
    }
  } catch {
    // Best-effort: if the DB is unreachable the label degrades to the bare
    // brand name rather than blocking or crashing the session.
  }
}

// Session-start pin policy (PR3): **no default on load** unless the operator set
// one. Precedence, highest first:
//   1. An already-set in-process env pin (`GROWTH_OS_WORKSPACE_ID` from CI /
//      `--project` / a prior `@name` switch) — honored, never overwritten.
//   2. The persisted `defaultProjectId` — loaded into the env pin if set.
//   3. Otherwise no pin (the legacy `activeProjectId` is **not** auto-promoted).
// Also emits a one-time migration notice when a legacy `activeProjectId` exists
// but no default has been set, then latches it so it never repeats. Returns the
// notice line (or undefined) so the caller decides where to render it.
export function applySessionDefaultPin(env: CliEnv): string | undefined {
  const explicitPin = env.GROWTH_OS_WORKSPACE_ID?.trim();
  const defaultProjectId = readDefaultProjectId(env as NodeJS.ProcessEnv);
  if (!explicitPin && defaultProjectId) {
    // Mutate the in-process env so infiniteOsWorkspaceId()'s higher-precedence env
    // branch wins for this session (session-only, never persisted).
    env.GROWTH_OS_WORKSPACE_ID = defaultProjectId;
  }
  // One-time migration notice: a legacy active pointer exists, but the operator
  // hasn't set a default — guide them to the new model exactly once.
  const legacyActive = readActiveProjectId(env as NodeJS.ProcessEnv);
  if (legacyActive && !defaultProjectId && !readMigrationNoticeShown(env as NodeJS.ProcessEnv)) {
    try {
      markMigrationNoticeShown(env as NodeJS.ProcessEnv);
    } catch {
      // If the latch can't be written we still show the notice this once.
    }
    return "No default project is set. Set one with `/project default set <name>`, or scope a question inline with `@name`.";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// `@name` project pin (PR4)
// ---------------------------------------------------------------------------

// Signal a command (currently `/project use`) attaches to its result so the
// `onSubmitLine` wrapper — which holds the *original* session `env` — applies the
// session pin (env mutation + `resetAgentRuntime`). `projectCommand` runs with a
// COPY of the env, so it cannot apply the pin itself; it only resolves+validates
// the project and asks the wrapper to switch. A string key (not a Symbol) so it
// survives the structural-equality checks in tests.
const PROJECT_PIN_CHANGE = "__projectPinChange";

export function readProjectPinChange(result: unknown): { id: string; name: string } | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }
  const change = (result as Record<string, unknown>)[PROJECT_PIN_CHANGE];
  if (
    typeof change === "object" && change !== null &&
    typeof (change as { id?: unknown }).id === "string" &&
    typeof (change as { name?: unknown }).name === "string"
  ) {
    return { id: (change as { id: string }).id, name: (change as { name: string }).name };
  }
  return undefined;
}

// In-memory project list ({id,name}[]) used by the `@name` resolver and Tab
// completion. This is a SEPARATE cache from the single-string `activeProjectLabel`
// above: the resolver and the (synchronous) completion hook both need the whole
// list, so we load it once at session start and refresh it in-process on
// `project new`. It is never persisted — it is a read cache of the `workspaces`
// table for this session only.
let projectListCache: ReadonlyArray<{ id: string; name: string }> = [];

export function getProjectListCache(): ReadonlyArray<{ id: string; name: string }> {
  return projectListCache;
}

// Test/seed hook so unit tests can populate the cache without a DB.
export function setProjectListCacheForTest(projects: ReadonlyArray<{ id: string; name: string }>): void {
  projectListCache = projects.map((p) => ({ id: p.id, name: p.name }));
}

async function loadProjectListCache(env: CliEnv): Promise<void> {
  try {
    const { databaseUrl } = loadInfiniteOsConfig({
      workspaceRoot: workspaceRootFor(env),
      env: env as NodeJS.ProcessEnv
    });
    const db = createInfiniteOsDb(databaseUrl);
    try {
      const rows = await listProjects(db);
      projectListCache = rows.map((row) => ({ id: row.id, name: row.name }));
    } finally {
      await db.close();
    }
  } catch {
    // Best-effort: a DB-down session keeps the last-known (possibly empty) cache
    // rather than crashing the interactive shell.
  }
}

// Normalize a project name / `@token` for case-insensitive matching: lowercase
// and strip everything that isn't a letter or digit (so `Acme Co` matches
// `@acmeco`, AND natural-question punctuation glued onto a mention — `@rtk?`,
// `@rtk.`, `@rtk,` — doesn't break the match, since `@(\S+)` captures the
// trailing char when there's no space after the mention).
export function normalizeProjectSlug(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// First `@<token>` anywhere in the line (the token runs to the next whitespace).
const AT_MENTION_RE = /(^|\s)@(\S+)/;

export interface ResolvedProjectPin {
  // The line with the matched `@token` removed (and whitespace tidied). Empty
  // string means the message was a bare `@name` switch.
  remainder: string;
  // The matched project, when the token resolved to exactly one.
  project?: { id: string; name: string };
  // "switched" — token matched exactly one project; "ambiguous" — token matched
  // MORE THAN ONE distinct project (slug collision → picker); "unknown" — token
  // present but no match; "none" — no `@token` in the line.
  status: "switched" | "ambiguous" | "unknown" | "none";
  // The raw token (without the `@`) when status is "unknown" or "ambiguous".
  token?: string;
  // The colliding projects (distinct by id) when status is "ambiguous" — offered
  // to the picker so the operator disambiguates the slug collision.
  candidates?: ReadonlyArray<{ id: string; name: string }>;
}

// Apply a session pin: mutate the ORIGINAL session `env` (the one
// `localAgentRuntime` closes over and `applySessionDefaultPin` already mutates),
// reset the live runtime so the next turn rebinds against the new workspace, and
// update the cached label so the per-answer title re-stamps. Session-only — never
// `writeActiveProjectId` (that would persist the pin past restart).
export function applySessionPin(env: CliEnv, project: { id: string; name: string }): void {
  env.GROWTH_OS_WORKSPACE_ID = project.id;
  activeProjectLabel = project.name;
  resetAgentRuntime();
}

// Resolve an `@name` switch against the in-memory project list. Pure: it does NOT
// mutate env or reset the runtime — the caller (the `onSubmitLine` wrapper, which
// holds the original session `env`) applies the pin. Case-insensitive, matching a
// normalized slug or the raw id.
export function resolveProjectPin(line: string): ResolvedProjectPin {
  const match = AT_MENTION_RE.exec(line);
  if (!match) {
    return { remainder: line, status: "none" };
  }
  const token = match[2] ?? "";
  const normalized = normalizeProjectSlug(token);
  // ALL projects the token matches (normalized slug OR raw id), de-duped by id.
  // Two distinct projects can normalize to the same `@`-slug (e.g. two "Default
  // workspace" → `@Defaultworkspace`); returning the FIRST match would silently
  // pin an arbitrary one. We surface the collision instead.
  const byId = new Map<string, { id: string; name: string }>();
  for (const candidate of projectListCache) {
    if (normalizeProjectSlug(candidate.name) === normalized || candidate.id === token) {
      if (!byId.has(candidate.id)) {
        byId.set(candidate.id, { id: candidate.id, name: candidate.name });
      }
    }
  }
  const matches = [...byId.values()];
  // Strip the matched token (collapse the surrounding whitespace it leaves).
  const remainder = `${line.slice(0, match.index)}${line.slice(match.index + match[0].length)}`
    .replace(/\s{2,}/g, " ")
    .trim();
  if (matches.length === 0) {
    return { remainder, status: "unknown", token };
  }
  if (matches.length > 1) {
    // Slug collision → ambiguous → picker (the colliding projects only).
    return { remainder, status: "ambiguous", token, candidates: matches };
  }
  const project = matches[0]!;
  return { remainder, project: { id: project.id, name: project.name }, status: "switched" };
}

// All `@<token>` mentions anywhere in the line (global form of AT_MENTION_RE).
const AT_MENTION_RE_GLOBAL = /(^|\s)@(\S+)/g;

// The distinct projects a line mentions via `@token`. Resolves every `@token`
// (case-insensitive slug / id) against the cache and de-dupes by project id —
// `@a @b` yields two, `@a @a` (or one matched + repeats) yields one. Used by the
// PR5 picker trigger for "multiple distinct `@a @b`" (offer {a,b}). Distinct from
// `resolveProjectPin`, which only inspects the FIRST mention.
export function resolveDistinctProjectMentions(line: string): Array<{ id: string; name: string }> {
  const seen = new Set<string>();
  const projects: Array<{ id: string; name: string }> = [];
  for (const match of line.matchAll(AT_MENTION_RE_GLOBAL)) {
    const token = match[2] ?? "";
    const normalized = normalizeProjectSlug(token);
    const project = projectListCache.find(
      (candidate) => normalizeProjectSlug(candidate.name) === normalized || candidate.id === token
    );
    if (project && !seen.has(project.id)) {
      seen.add(project.id);
      projects.push({ id: project.id, name: project.name });
    }
  }
  return projects;
}

export interface PreTurnProjectSelection {
  options: ReadonlyArray<{ id: string; name: string }>;
  originalLine: string;
}

// Recognize a small allow-list of auth commands typed WITHOUT a leading slash in
// the TUI (e.g. `codex login`), so the command we suggest in error messages is
// literally typeable. Matched against the WHOLE line + only known flags, so it
// can never swallow a normal chat message — `codex login is broken` has trailing
// tokens and falls through to chat. An optional leading `infinite` is tolerated.
export function bareInfiniteCommand(line: string): { command: string; args: string[] } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("/")) {
    return null;
  }
  let tokens = trimmed.split(/\s+/);
  if (tokens[0] === "infinite") {
    tokens = tokens.slice(1);
  }
  if (tokens.length < 2 || tokens[0] !== "codex") {
    return null;
  }
  const sub = tokens[1];
  if (sub !== "login" && sub !== "import" && sub !== "status") {
    return null;
  }
  const flags = tokens.slice(2);
  const allowed = sub === "login" ? ["--force", "--reauth"] : [];
  if (!flags.every((flag) => allowed.includes(flag))) {
    return null;
  }
  return { command: "codex", args: tokens.slice(1) };
}

// PR5 pre-turn gate. Decide whether a line must route to the project picker
// BEFORE building the runtime (a pin-less session fail-closes at runtime
// construction). Returns the picker options + the original line to answer once a
// project is picked, or `undefined` to let the line flow to the PR4 resolver /
// dispatch. Pure: reads the in-process env pin + project-list cache only.
//
// IMPORTANT (legacy/pin-less consistency — the PR3 minor): this keys the no-pin
// decision off the REAL session pin (`env.GROWTH_OS_WORKSPACE_ID`) and the
// persisted `defaultProjectId` — NOT the legacy `activeProjectId`. So a legacy
// install (state.json has `activeProjectId` but no default, and
// `applySessionDefaultPin` never auto-promotes it) is genuinely pin-less here and
// reaches the picker, instead of silently inheriting the legacy pointer via
// `infiniteOsWorkspaceId`'s fallback. (We deliberately do NOT change that fallback:
// the non-interactive CLI commands — `sources`, the stale-pointer guard — still
// depend on it; gating on the env pin here is the surgical fix.)
export function decidePreTurnProjectSelection(env: CliEnv, line: string): PreTurnProjectSelection | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  // Bare auth commands (e.g. `codex login`) dispatch as commands, not chat — they
  // never need a project pin, so bypass the picker just like slash commands do.
  if (bareInfiniteCommand(trimmed)) {
    return undefined;
  }

  // (a) Multiple distinct `@a @b` → disambiguate to one via the picker of {a,b}.
  // A turn answers for ONE project; offer only the mentioned ones.
  const mentions = resolveDistinctProjectMentions(trimmed);
  if (mentions.length >= 2) {
    // Strip ALL `@` mentions from the question so the picker's re-submit
    // `@<pick> <question>` resolves to a SINGLE switch and flows to dispatch.
    // Returning `trimmed` (with `@a @b` intact) would re-trigger this branch on
    // the re-submit and loop the picker forever.
    const bareQuestion = trimmed.replace(AT_MENTION_RE_GLOBAL, " ").replace(/\s{2,}/g, " ").trim();
    return { options: mentions, originalLine: bareQuestion };
  }

  const pin = resolveProjectPin(trimmed);

  // (a2) Slug collision: a single `@token` that matches MORE THAN ONE distinct
  // project resolves as ambiguous. Like `@unknown`, never silently pin an
  // arbitrary one — route to the picker offering ONLY the colliding projects.
  // The picker re-submits `@<id>` for colliding options (see
  // `buildProjectSelectionPrompt`), which resolves uniquely and won't re-loop.
  if (pin.status === "ambiguous" && pin.candidates && pin.candidates.length > 0) {
    return { options: pin.candidates, originalLine: pin.remainder };
  }

  // (b) `@unknown` → never a silent fallback; offer the full list to pick from.
  if (pin.status === "unknown" && projectListCache.length > 0) {
    // Re-pose the remainder (token stripped) so the pick answers the real question.
    return { options: projectListCache, originalLine: pin.remainder };
  }

  // (c) No pin + no resolvable `@` + no default → first message in a pin-less
  // session. Slash commands (`/help`, `/project …`, `/setup`) don't need a
  // workspace pin, so they bypass the gate. Only fire when there's ≥1 project to
  // pick — otherwise let the line flow to the runtime, which fail-closes with the
  // `project new` guidance.
  if (pin.status === "none" && !trimmed.startsWith("/")) {
    const hasSessionPin = Boolean(env.GROWTH_OS_WORKSPACE_ID?.trim());
    const hasDefault = Boolean(readDefaultProjectId(env as NodeJS.ProcessEnv));
    if (!hasSessionPin && !hasDefault && projectListCache.length > 0) {
      return { options: projectListCache, originalLine: trimmed };
    }
  }

  return undefined;
}

export function helpText(): string {
  return [
    "infinite <command>",
    "",
    "Common:",
    "  infinite                       Start an interactive agent session",
    "  infinite \"message\"             Ask one question and print the answer",
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
    "  Budgets/bids are integer cents in the ad-account currency. Use --yes to skip the confirm.",
    "",
    "Reports:",
    "  saved-report create <name> [json_tool_plan]",
    "  saved-report run <report_id>",
    "  saved-report export <report_id> [format]",
    "",
    "Examples:",
    "  infinite connect x",
    "  infinite connect meta",
    "  infinite sync meta 30_days",
    "  infinite sync all incremental"
  ].join("\n");
}

// Commands tolerated when the DB is down (spec §12 OQ) — `--project` resolution is
// skipped for these so `infinite --project X status` still works with no live DB.
const PROJECT_FLAG_DB_DOWN_EXEMPT = new Set(["status", "logs"]);

interface ResolveProjectFlagOptions {
  createDb?: (databaseUrl: string) => Pick<InfiniteOsDb, "one" | "close">;
  databaseUrl?: string;
}

export async function resolveProjectFlag(
  args: string[],
  env: CliEnv,
  options: ResolveProjectFlagOptions = {}
): Promise<{ args: string[]; command: string | undefined }> {
  const stripped: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project") {
      value = args[i + 1];
      i += 1; // consume the value token
      continue;
    }
    if (arg.startsWith("--project=")) {
      value = arg.slice("--project=".length);
      continue;
    }
    stripped.push(arg);
  }
  const command = stripped[0];
  if (value === undefined) {
    return { args: stripped, command };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("--project requires a project name or id");
  }
  // DB-down-tolerant commands skip resolution (the app/DB may be unavailable).
  if (command && PROJECT_FLAG_DB_DOWN_EXEMPT.has(command)) {
    return { args: stripped, command };
  }
  const databaseUrl =
    options.databaseUrl ??
    loadInfiniteOsConfig({ workspaceRoot: workspaceRootFor(env), env: env as NodeJS.ProcessEnv }).databaseUrl;
  const createDb = options.createDb ?? createInfiniteOsDb;
  const db = createDb(databaseUrl);
  let match: { id: string } | null;
  try {
    match = await findProject(db, trimmed);
  } finally {
    await db.close();
  }
  if (!match) {
    throw new Error(`Unknown project: ${trimmed}`);
  }
  // Mutate the in-process env so infiniteOsWorkspaceId()'s higher-precedence env
  // branch wins for this invocation.
  env.GROWTH_OS_WORKSPACE_ID = match.id;
  return { args: stripped, command };
}

export async function runCli(
  args = process.argv.slice(2),
  env: CliEnv = process.env
): Promise<void> {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  if (normalizedArgs.length === 0) {
    // No command → interactive session. The session blocks until the user
    // exits, so emit the (bounded, ≤once/24h) update notice to stderr first;
    // it never delays the prompt the user is about to see.
    maybeNotifyUpdateAvailable(env);
    await interactiveSession(env);
    return;
  }

  const { args: dispatchArgs } = await resolveProjectFlag(normalizedArgs, env);
  if (dispatchArgs.length === 0) {
    maybeNotifyUpdateAvailable(env);
    await interactiveSession(env);
    return;
  }

  const [command, ...rest] = dispatchArgs;
  const progress = createLazyCliProgressReporter(process.stderr, env, {
    promptPlaceholder: "Running request."
  });
  let result: unknown;
  try {
    result = await runCliInput(command, rest, env, undefined, (event) => progress.progress(event));
  } finally {
    progress.stop();
  }
  if ((command === "setup" || command === "meta") && hasFlag(rest, "--json")) {
    // `--json` returns the raw `{ok,...}` envelope. `runCli` only honors `--json`
    // for `setup` and `meta`; other commands ignore the flag and render normally.
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (typeof result === "string") {
    output.write(`${result}\n`);
  } else {
    output.write(`${renderCliResultForStream(result, output, env)}\n`);
  }
  if (command === "setup" && !hasFlag(rest, "--json")) {
    await maybeLaunchInfiniteAfterSetup(result, env);
  }
  // The update notice runs LAST and only ever touches stderr, so it never
  // delays or corrupts the command's stdout (e.g. `--json`/piped output). It's
  // suppressed for `update` (redundant) and any `--json` invocation.
  maybeNotifyUpdateAvailable(env, { command, args: rest });
}

function createLazyCliProgressReporter(
  stream: CliProgressStream,
  env: CliEnv,
  options: CliProgressReporterOptions = {}
): InteractiveProgressReporter {
  let reporter: InteractiveProgressReporter | undefined;

  return {
    progress(event) {
      reporter ??= createCliProgressReporter(stream, env, options);
      reporter.progress(event);
    },
    stop() {
      reporter?.stop();
    }
  };
}

function createCliProgressReporter(
  stream: CliProgressStream,
  env: CliEnv,
  options: CliProgressReporterOptions = {}
): InteractiveProgressReporter {
  const theme = options.theme ?? resolveTheme(env as NodeJS.ProcessEnv);
  const renderSurface = resolveCliRenderSurface(stream, env as NodeJS.ProcessEnv);
  return createInteractiveProgressReporter(stream, {
    animate: renderSurface === "plain" ? false : undefined,
    renderSurface: renderSurface === "ink"
      ? "ink"
      : usesTranscriptRenderSurface(renderSurface)
        ? "transcript"
        : "raw",
    theme,
    transcript: {
      prompt: { placeholder: options.promptPlaceholder ?? "Thinking, reasoning, or running tools." },
      status: options.status,
      theme
    }
  });
}

export function shouldUseInkInteractiveSession(
  inputStream: CliInputStream = input,
  stream: CliProgressStream = output,
  env: CliEnv = process.env
): boolean {
  return Boolean(
    env.GROWTH_OS_CLI_NONINTERACTIVE !== "1" &&
    inputStream.isTTY &&
    stream.isTTY &&
    resolveCliRenderSurface(stream, env as NodeJS.ProcessEnv) === "ink" &&
    canUseInkProgressReporter(stream)
  );
}

export async function runCliInput(
  command: string,
  args: string[],
  env: CliEnv,
  agentRuntime?: CliAgentRuntimeSource,
  onProgress?: (event: ChatProgressEvent) => void
): Promise<unknown> {
  try {
    return await runCommand(command, args, env, { onProgress });
  } catch (error) {
    if (!isUnknownCommandError(error, command)) {
      throw error;
    }
    return chatRequest([command, ...args].join(" "), env, undefined, agentRuntime, onProgress);
  }
}

function isUnknownCommandError(error: unknown, command: string): boolean {
  return error instanceof Error && error.message === `Unknown Infinite OS CLI command: ${command}`;
}

const ACTIVE_PROJECT_EXEMPT_COMMANDS = new Set([
  "help", "--help", "-h", "version", "--version", "-v", "init", "setup",
  "start", "up", "update", "stop", "migrate", "logs", "status", "health", "auth",
  "codex", "model", "recipes", "project"
]);

export async function runCommand(
  command: string,
  args: string[],
  env: CliEnv,
  options: RunCommandOptions = {}
): Promise<unknown> {
  if (!ACTIVE_PROJECT_EXEMPT_COMMANDS.has(command)) {
    await requireActiveProject(env);
  }
  if (command === "help" || command === "--help" || command === "-h") {
    return helpText();
  }
  if (command === "version" || command === "--version" || command === "-v") {
    return versionText(env);
  }
  if (command === "init") {
    return initWorkspace(env);
  }
  if (command === "setup") {
    return setupWorkspace(args, env);
  }
  if (command === "start" || command === "up") {
    return runStartStack(args, env);
  }
  if (command === "update") {
    return runUpdateCommand(args, env);
  }
  if (command === "stop") {
    return runComposeCommand(["stop"], env);
  }
  if (command === "migrate") {
    return runComposeCommand(["run", "--rm", "migrate"], env);
  }
  if (command === "logs") {
    return runComposeCommand(["logs", ...args], env);
  }
  if (command === "status") {
    return runComposeCommand(["ps"], env);
  }
  if (command === "connect") {
    const [provider, ...nameParts] = args;
    if (!provider) {
      throw new Error("connect requires a provider");
    }
    if (provider === "oauth") {
      return connectorOAuthCommand(nameParts, env);
    }
    if (provider === "oauth-status") {
      return connectorOAuthStatusCommand(nameParts, env);
    }
    if (provider === "oauth-exchange") {
      return connectorOAuthExchangeCommand(nameParts, env);
    }
    const hasJson = nameParts.some((part) => part.trim().startsWith("{"));
    const definition = connectorSetupDefinition(provider);
    if (!hasJson && definition && shouldUseInteractivePrompts()) {
      return connectProviderPicker(definition, env);
    }
    const credentialJsonStart = nameParts.findIndex((part) => part.trim().startsWith("{"));
    const connectionNameParts = credentialJsonStart === -1 ? nameParts : nameParts.slice(0, credentialJsonStart);
    const credentialParts = credentialJsonStart === -1 ? [] : nameParts.slice(credentialJsonStart);
    if (!credentialParts.length) {
      throw new Error("connect requires a JSON credential payload; product setup does not use fixture credentials");
    }
    const credentialPayload = credentialParts.length ? parseJsonInput(credentialParts.join(" ")) : undefined;
    const connectionName = stripBackfillFlags(connectionNameParts).join(" ") || provider;
    const response = await apiRequest("/sources/connect", env, {
      method: "POST",
      operator: true,
      body: {
        provider,
        connectionName,
        credentialPayload,
        credentialKind: credentialKindForProvider(provider)
      }
    });
    if (provider === "meta_ads" && !hasFlag(connectionNameParts, "--no-backfill")) {
      const backfill = await queueMetaAdsBackfillForConnect(
        response,
        metaAdsBackfillBody(connectionNameParts, { allowPositional: false }),
        env
      );
      return isRecord(response) ? { ...response, backfill } : { ok: true, result: response, backfill };
    }
    return response;
  }
  if (command === "health") {
    return apiRequest("/health", env);
  }
  if (command === "sources") {
    return apiRequest("/sources", env);
  }
  if (command === "schema") {
    return apiRequest("/schema", env);
  }
  if (command === "schedules") {
    return apiRequest("/source-schedules", env);
  }
  if (command === "sync") {
    return runSyncCommand(args, env, options);
  }
  if (command === "sync-runs") {
    return apiRequest("/sync/runs", env);
  }
  if (command === "views") {
    return apiRequest("/queryable/views", env);
  }
  if (command === "metrics") {
    return apiRequest("/metrics", env);
  }
  if (command === "mcp" || command === "tools") {
    return apiRequest("/mcp/tools", env);
  }
  if (command === "recipes") {
    return { recipes: listRecipes() };
  }
  if (command === "recipe") {
    const [recipeId, ...inputParts] = args;
    if (!recipeId) {
      throw new Error("recipe requires a recipe id");
    }
    return runCliRecipe(recipeId as RecipeId, parseJsonInput(inputParts.join(" ")), env);
  }
  if (command === "auth") {
    return authCommand(args, env);
  }
  if (command === "codex") {
    return codexCommand(args, env);
  }
  if (command === "model") {
    return modelCommand(args, env);
  }
  if (command === "project") {
    return projectCommand(args, env);
  }
  if (command === "meta") {
    return metaCommand(args, env, options.meta);
  }
  if (command === "explain") {
    return apiRequest("/tools/call", env, {
      method: "POST",
      body: {
        actionId: "explain_answer",
        input: { metric: args[0] ?? "recognized_revenue" }
      }
    });
  }
  if (command === "saved-report") {
    return savedReportCommand(args, env);
  }
  if (command === "call") {
    const [actionId, ...inputParts] = args;
    if (!actionId) {
      throw new Error("call requires an action id");
    }
    return apiRequest("/tools/call", env, {
      method: "POST",
      operator: true,
      body: {
        actionId,
        input: parseJsonInput(inputParts.join(" "))
      }
    });
  }

  throw new Error(`Unknown Infinite OS CLI command: ${command}`);
}

function initWorkspace(env: CliEnv): Record<string, unknown> {
  const root = workspaceRootFor(env);
  const growthDir = join(root, ".growth-os");
  mkdirSync(growthDir, { recursive: true });
  const configPath = join(growthDir, "config.yml");
  const envPath = join(growthDir, ".env");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, "runtime_mode: local\napp_host: 127.0.0.1\napp_port: 3000\n");
  }
  if (!existsSync(envPath)) {
    // NOTE: `init` writes only the PROJECT .env (it never mirrors to the machine-home rendezvous the
    // desktop daemon reads), so it is not the credential-orphaning path that `setup` is. The DB-probe
    // guard lives on writeRuntimeSetupFiles (the only mirror writer); adding it here would also turn
    // `init` — used pervasively as lightweight test scaffolding — into a DB-dependent operation.
    writeFileSync(
      envPath,
      [
        `DATABASE_URL=${DEFAULT_PROJECT_DATABASE_URL}`,
        `GROWTH_OS_ENCRYPTION_KEY=${generateEncryptionKey()}`,
        "GROWTH_OS_READ_TOKEN=dev-read-token",
        "GROWTH_OS_OPERATOR_TOKEN=dev-operator-token",
        ""
      ].join("\n")
    );
  }
  return { ok: true, growthDir, configPath, envPath };
}

async function setupWorkspace(args: string[], env: CliEnv): Promise<SetupCliResult> {
  return runSetupWizard(args.filter((arg) => arg !== "--json"), env, {
    jsonMode: hasFlag(args, "--json")
  });
}

interface SetupProjectStepOptions {
  prompt?: boolean;
  interview?: SetupInterview;
  // Test seams: the project step builds the DB directly (the app server may not be
  // up at first-run — spec §8), so injecting these keeps the step testable without
  // a live Postgres.
  createDb?: (databaseUrl: string) => InfiniteOsDb;
  promptName?: (question: string) => Promise<string | undefined>;
}

interface SetupProjectContext {
  projectName?: string;
}

export async function runSetupInterview(
  args: string[],
  options: RunSetupInterviewOptions = {}
): Promise<SetupInterview | undefined> {
  const warn = options.onWarning ?? ((message: string) => errorOutput.write(`${message}\n`));
  const flagProjectName = (optionValue(args, "--project-name") ?? "").trim();
  const flagProductDescription = normalizeOptionalInterviewText(optionValue(args, "--product-description"));
  const rawProductSurface = normalizeOptionalInterviewText(optionValue(args, "--product-surface"));
  const defaultProjectName = options.defaultProjectName?.trim() ?? "";
  const flagWebsiteUrl = optionValue(args, "--website-url") ?? "";
  const providerSelectionInput = optionValue(args, "--providers");
  const selectedProvidersFromFlags = providerSelectionInput
    ? parseSetupProviderSelection(providerSelectionInput)
    : [...DEFAULT_SETUP_INTERVIEW_PROVIDERS];
  const providerInventoryFromFlags = buildSetupInterviewRowsFromFlags(args, selectedProvidersFromFlags);
  const hasInterviewFlags =
    flagProjectName.length > 0 ||
    Boolean(flagProductDescription) ||
    Boolean(rawProductSurface) ||
    flagWebsiteUrl.length > 0 ||
    providerSelectionInput !== undefined ||
    providerInventoryFromFlags.some((row, index) => {
      const defaultRow = defaultSetupInterviewRows()[index];
      return row.hasAccount !== defaultRow.hasAccount || row.installState !== defaultRow.installState;
    });

  if (!options.prompt && !hasInterviewFlags) {
    return undefined;
  }

  let projectName = flagProjectName || (options.prompt ? "" : defaultProjectName);
  if (options.prompt && !flagProjectName) {
    const promptProjectName =
      options.promptProjectName ??
      ((question: string, defaultValue = "") => promptText(question, defaultValue));
    projectName = (await promptProjectName(setupProjectNamePrompt())).trim();
  }

  if (flagProductDescription) {
    warn(
      "Warning: --product-description is deprecated. Setup no longer prompts from it, but the value will be preserved for compatibility."
    );
  }

  const productSurface = normalizeDeprecatedInterviewSurface(rawProductSurface, warn);
  let websiteUrl = flagWebsiteUrl;
  if (options.prompt) {
    const promptWebsiteUrl =
      options.promptWebsiteUrl ??
      ((question: string, defaultValue = "") => promptUrl(question, defaultValue));
    websiteUrl = (await promptWebsiteUrl("What's your URL?", websiteUrl)).trim();
  }

  let providerInventory = providerInventoryFromFlags;
  if (options.prompt) {
    const promptProviderInventory = options.promptProviderInventory ?? ((rows: ProviderInventoryRow[]) => promptProviderMatrix(rows));
    providerInventory = await promptProviderInventory(providerInventory);
  }

  return {
    projectName,
    productDescription: flagProductDescription,
    websiteUrl: normalizeInterviewWebsiteUrl(websiteUrl, productSurface),
    productSurface,
    providerInventory: normalizeInterviewProviderInventory(providerInventory)
  };
}

function defaultSetupInterviewRows(
  selectedProviders: readonly SetupProviderId[] = DEFAULT_SETUP_INTERVIEW_PROVIDERS
): ProviderInventoryRow[] {
  const selected = new Set<SetupProviderId>(selectedProviders);
  return SETUP_INTERVIEW_PROVIDERS.map((provider) => ({
    provider,
    hasAccount: false,
    installState: "unknown",
    selected: selected.has(provider),
    recommended: provider !== "x"
  }));
}

function buildSetupInterviewRowsFromFlags(
  args: string[],
  selectedProviders: readonly SetupProviderId[]
): ProviderInventoryRow[] {
  return defaultSetupInterviewRows(selectedProviders).map((row) => ({
    ...row,
    hasAccount: inferInterviewHasAccount(
      hasFlag(args, `--${row.provider}-account`) || row.hasAccount,
      parseInstallStateInput(optionValue(args, `--${row.provider}-installed`))
    ),
    installState: parseInstallStateInput(optionValue(args, `--${row.provider}-installed`)) ?? row.installState
  }));
}

function normalizeInterviewProviderInventory(rows: ProviderInventoryRow[]): ProviderInventoryRow[] {
  const merged = new Map<SetupProviderId, ProviderInventoryRow>();
  for (const row of defaultSetupInterviewRows()) {
    merged.set(row.provider, row);
  }
  for (const row of rows) {
    if (!isSetupProviderId(row.provider)) {
      continue;
    }
    const current = merged.get(row.provider);
    merged.set(row.provider, {
      provider: row.provider,
      hasAccount: inferInterviewHasAccount(row.hasAccount, row.installState),
      installState: row.installState,
      selected: row.selected,
      recommended: row.recommended ?? current?.recommended ?? row.provider !== "x"
    });
  }
  return SETUP_INTERVIEW_PROVIDERS.map((provider) => merged.get(provider) ?? {
    provider,
    hasAccount: false,
    installState: "unknown",
    selected: DEFAULT_SETUP_INTERVIEW_PROVIDER_SET.has(provider),
    recommended: provider !== "x"
  });
}

function normalizeDeprecatedInterviewSurface(
  value: string | undefined,
  warn: (message: string) => void
): ProductSurface {
  if (!value) {
    return "web";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "web") {
    warn("Warning: --product-surface is deprecated. Setup now defaults to web, so this flag can be removed.");
    return "web";
  }

  warn(`Warning: --product-surface is deprecated; received "${value}". Infinite setup currently supports web onboarding only, so it will continue using web.`);
  return "web";
}

function normalizeInterviewWebsiteUrl(value: string, productSurface: ProductSurface): string | undefined {
  if (productSurface !== "web") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const candidate = normalizeInterviewUrlCandidate(trimmed);
  const parsed = new URL(candidate);
  const protocol = parsed.protocol === "http:" && isLocalInterviewHost(parsed.hostname) ? "http:" : "https:";
  const hostname = stripInterviewWwwPrefix(parsed.hostname);
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ""}${path}${parsed.search}`;
}

function parseSetupProviderSelection(value: string | undefined): SetupProviderId[] {
  if (!value) {
    return [...DEFAULT_SETUP_INTERVIEW_PROVIDERS];
  }
  const selected: SetupProviderId[] = [];
  for (const part of value.split(",")) {
    const normalized = part.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (!isSetupProviderId(normalized)) {
      throw new Error(`Unsupported setup provider: ${part.trim()}`);
    }
    if (!selected.includes(normalized)) {
      selected.push(normalized);
    }
  }
  return selected.length ? selected : [...DEFAULT_SETUP_INTERVIEW_PROVIDERS];
}

function parseInstallStateInput(value: string | undefined): ProviderInstallState | undefined {
  const normalized = value?.trim().toLowerCase().replace(/-/gu, "_");
  if (!normalized) {
    return undefined;
  }
  if (normalized === "installed" || normalized === "not_installed" || normalized === "unknown") {
    return normalized;
  }
  throw new Error("setup install state must be installed, not_installed, or unknown");
}

function isSetupProviderId(value: string): value is SetupProviderId {
  return (SETUP_INTERVIEW_PROVIDERS as readonly string[]).includes(value);
}

function normalizeInterviewUrlCandidate(value: string): string {
  let normalized = value.trim();
  while (/^https?:\/\/https?:\/\//iu.test(normalized)) {
    normalized = normalized.replace(/^https?:\/\//iu, "");
  }
  return normalized.includes("://") ? normalized : `https://${normalized}`;
}

function stripInterviewWwwPrefix(hostname: string): string {
  if (hostname.startsWith("www.")) {
    return hostname.slice(4);
  }
  return hostname;
}

function isLocalInterviewHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".test")
  ) {
    return true;
  }
  return isPrivateDevelopmentIp(normalized);
}

function isPrivateDevelopmentIp(hostname: string): boolean {
  const version = isIP(hostname);
  if (version === 4) {
    const octets = hostname.split(".").map((part) => Number(part));
    const [a = 0, b = 0] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (version === 6) {
    return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:");
  }
  return false;
}

function normalizeOptionalInterviewText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePostHogApiHost(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalInterviewText(value);
  if (!trimmed) {
    return undefined;
  }
  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    const hostname = url.hostname.toLowerCase();
    if (hostname === "eu.posthog.com" || hostname === "eu.i.posthog.com") {
      return "https://eu.posthog.com";
    }
    if (hostname === "us.posthog.com" || hostname === "us.i.posthog.com" || hostname === "app.posthog.com") {
      return "https://us.posthog.com";
    }
    return url.origin.replace(/\/$/, "");
  } catch {
    if (/^[a-z][a-z\d+\-.]*:\/?\/?$/i.test(withProtocol)) {
      return undefined;
    }
    return withProtocol.replace(/\/+$/, "");
  }
}

function inferInterviewHasAccount(hasAccount: boolean, installState: ProviderInstallState | undefined): boolean {
  return installState === "installed" ? true : hasAccount;
}

function setupProjectNamePrompt(): string {
  return "What's your project name?";
}

export async function setupProjectStep(
  args: string[],
  env: CliEnv,
  options: SetupProjectStepOptions = {}
): Promise<Record<string, unknown>> {
  const existing = readActiveProjectId(env as NodeJS.ProcessEnv);
  let name = (optionValue(args, "--project-name") ?? options.interview?.projectName ?? "").trim();
  if (!name && options.prompt && !options.interview) {
    const promptName = options.promptName ?? ((question: string) => promptFreeformValue(question));
    name = ((await promptName(setupProjectNamePrompt())) ?? "").trim();
  }
  if (!name && existing) {
    return {
      ok: true,
      section: "project",
      status: "exists",
      activeProjectId: existing,
      name: existing,
      ...(options.interview ? { interview: options.interview } : {}),
      next: "Run `infinite project list` to see all projects."
    };
  }
  if (!name) {
    return {
      ok: false,
      section: "project",
      status: "skipped",
      skipped: true,
      ...(options.interview ? { interview: options.interview } : {}),
      next: "Run `infinite project new <name>` to create your first project."
    };
  }
  const createDb = options.createDb ?? createInfiniteOsDb;
  const databaseUrl = options.createDb
    ? ""
    : loadInfiniteOsConfig({ workspaceRoot: workspaceRootFor(env), env: env as NodeJS.ProcessEnv }).databaseUrl;
  const db = createDb(databaseUrl);
  try {
    const activeProject = existing ? await findProject(db, existing) : null;
    if (existing && (existing === name || activeProject?.name === name)) {
      return {
        ok: true,
        section: "project",
        status: "exists",
        activeProjectId: existing,
        name: activeProject?.name ?? name,
        ...(options.interview ? { interview: { ...options.interview, projectName: activeProject?.name ?? name } } : {}),
        next: "Run `infinite project list` to see all projects."
      };
    }

    const existingProject = await findProject(db, name);
    if (existingProject) {
      writeActiveProjectId(existingProject.id, env as NodeJS.ProcessEnv);
      return {
        ok: true,
        section: "project",
        status: "selected",
        activeProjectId: existingProject.id,
        name: existingProject.name,
        ...(options.interview ? { interview: { ...options.interview, projectName: existingProject.name } } : {}),
        next: "Run `infinite project list` to see all projects."
      };
    }

    const project = await createProject(db, name);
    writeActiveProjectId(project.id, env as NodeJS.ProcessEnv);
    return {
      ok: true,
      section: "project",
      status: "created",
      activeProjectId: project.id,
      name: project.name,
      ...(options.interview ? { interview: { ...options.interview, projectName: project.name } } : {}),
      next: "Run `infinite project list` to see all projects."
    };
  } finally {
    await db.close();
  }
}

export async function runSetupWizard(
  args: string[],
  env: CliEnv,
  options: SetupWizardOptions = {}
): Promise<SetupCliResult> {
  const section = setupSectionFromArgs(args);
  if (section) {
    const sectionArgs = args.slice(1);
    return runSetupSection(section, sectionArgs, env);
  }
  if (args[0] === "reset") {
    return runSetupReset(args.slice(1), env);
  }
  if (args[0] === "resume") {
    const workspaceId = await requireActiveProject(env);
    // #11 `setup resume --all`: resume every outstanding paused provider one at a time.
    // Inserted BEFORE the "requires a run id" throw so the no-positional `--all` path works.
    if (hasFlag(args, "--all")) {
      return runLocalSetupResumeAll({
        env,
        workspaceId,
        jsonMode: options.jsonMode,
        resumeSetupRun: options.resumeSetupRun ?? runLocalSetupResume
      });
    }
    const runId = args.slice(1).find((arg) => !arg.startsWith("--"));
    if (!runId) {
      throw new Error("setup resume requires a run id");
    }
    const posthogResumeSecrets = await resolveSetupResumePostHogResumeSecrets(
      args,
      env,
      workspaceId
    );
    return (options.resumeSetupRun ?? runLocalSetupResume)({
      runId,
      env,
      workspaceId,
      jsonMode: options.jsonMode,
      ...(posthogResumeSecrets?.personalApiKey ? { posthogPersonalApiKey: posthogResumeSecrets.personalApiKey } : {}),
      ...(posthogResumeSecrets?.apiHost ? { posthogApiHost: posthogResumeSecrets.apiHost } : {})
    });
  }
  const initialSelection = readInfiniteOsModelSelection(env as NodeJS.ProcessEnv);
  const existingInstall = detectExistingInfiniteInstall(env);
  const setupPositionals = setupPositionalArgs(args);
  const providerInput = optionValue(args, "--provider") ?? setupPositionals[0];
  const authInput = optionValue(args, "--auth") ?? optionValue(args, "--mode");
  const parsedProvider = providerFromSetupInput(providerInput);
  const parsedAuthMode = authModeFromSetupInput(authInput);
  const prompt = shouldPromptForSetup(args);
  if (!prompt && !hasSetupFlags(args) && env.GROWTH_OS_CLI_NONINTERACTIVE === "1") {
    return setupNeedsInputResult();
  }
  const projectContext = await resolveSetupProjectContext(args, env, { prompt });
  const interview = await runSetupInterview(args, {
    prompt,
    defaultProjectName: projectContext.projectName
  });
  const setupMode = await resolveSetupWizardMode(args, env, existingInstall);
  if (setupMode === "exit") {
    return {
      ok: false,
      section: "wizard",
      status: "skipped",
      existingInstall,
      next: "Run `infinite setup` when you are ready to continue."
    };
  }
  const runtimeResult =
    shouldReuseExistingRuntimeSetup(args, env)
      ? buildExistingRuntimeSetupResult(env)
      : await (options.runSetupRuntimeSection ?? setupRuntimeSection)(deriveRuntimeSetupArgs(args), env);
  const reusedModelResult = shouldReuseExistingModelSetup(args, env)
    ? buildExistingModelSetupResult(env)
    : null;
  const modelResult = reusedModelResult ?? (prompt
    ? await runModelSetup(env, {
        provider: parsedProvider,
        model: optionValue(args, "--model") ?? setupPositionals[1],
        authMode: parsedAuthMode,
        initialProvider: initialSelection.provider
      })
    : await applyExplicitModelSelection(
        parsedProvider ?? initialSelection.provider ?? "codex",
        optionValue(args, "--model") ?? setupPositionals[1] ?? initialSelection.model,
        parsedAuthMode,
        env
      ));
  const projectResult = await setupProjectStep(args, env, { prompt: false, interview });
  const connectorsResult = await runSetupOnboardingStep(interview, env, {
    runSetupOnboarding: options.runSetupOnboarding,
    jsonMode: options.jsonMode
  });
  const queryResult = await setupQueryReadiness(env);
  const statusResult = await setupStatus(env);
  const next =
    !runtimeResult.ok && typeof runtimeResult.next === "string"
      ? runtimeResult.next
      : queryResult.ok
        ? "Run `infinite`, then type your question."
        : isSetupOnboardingResult(connectorsResult) && connectorsResult.next
          ? connectorsResult.next
          : "Run `infinite setup status` to review blockers.";
  return {
    ok:
      Boolean(runtimeResult.ok) &&
      Boolean(modelResult.ok) &&
      Boolean(queryResult.ok),
    section: "wizard",
    existingInstall,
    setupMode,
    runtime: isRecord(runtimeResult.runtime) ? runtimeResult.runtime : runtimeResult,
    model: modelResult,
    auth: isRecord(modelResult.auth) ? modelResult.auth : {},
    ...(interview ? { interview } : {}),
    sections: [
      {
        id: "project",
        title: setupSectionTitle("project"),
        result: projectResult
      },
      {
        id: "connectors",
        title: setupSectionTitle("connectors"),
        result: connectorsResult
      },
      {
        id: "runtime",
        title: setupSectionTitle("runtime"),
        result: runtimeResult
      },
      {
        id: "model",
        title: setupSectionTitle("model"),
        result: modelResult
      },
      {
        id: "query",
        title: setupSectionTitle("query"),
        result: queryResult
      },
      {
        id: "status",
        title: setupSectionTitle("status"),
        result: statusResult
      }
    ],
    next
  };
}

async function runSetupOnboardingStep(
  interview: SetupInterview | undefined,
  env: CliEnv,
  options: Pick<SetupWizardOptions, "runSetupOnboarding" | "jsonMode"> = {}
): Promise<SetupCliResult> {
  if (!interview) {
    return {
      ok: false,
      section: "connectors",
      status: "skipped",
      skipped: true,
      next: "Run `infinite setup` with the onboarding interview to configure analytics providers."
    };
  }
  let workspaceId: string;
  try {
    workspaceId = await requireActiveProject(env);
  } catch (error) {
    if (error instanceof NoActiveProjectError || error instanceof StaleActiveProjectError) {
      return {
        ok: false,
        section: "connectors",
        status: "skipped",
        skipped: true,
        next: "Create or select a project before running analytics onboarding."
      };
    }
    throw error;
  }
  return (options.runSetupOnboarding ?? runLocalSetupOnboarding)({
    interview,
    env,
    workspaceId,
    jsonMode: options.jsonMode
  });
}

/** The single interactivity predicate honored everywhere for setup TTY interaction. */
function isSetupInteractive(env: CliEnv, jsonMode?: boolean): boolean {
  return input.isTTY === true && !jsonMode && env.GROWTH_OS_CLI_NONINTERACTIVE !== "1";
}

const SETUP_PROVIDER_LABEL: Record<SetupProviderId, string> = {
  ga4: "Google Analytics",
  posthog: "PostHog",
  x: "X"
};

/**
 * Reads exactly one keypress from a raw-mode stdin. ALWAYS restores raw mode and removes the
 * listener — on a keypress, or when `cancel()` is called (e.g. the poll completed first). This
 * is the same raw-mode hazard promptSecretValue handles. Resolves `{ ctrlC }` on a key, or
 * `{ cancelled: true }` when cancelled.
 */
function waitForAnyKeypress(): {
  promise: Promise<{ key: string; ctrlC: boolean; cancelled?: boolean }>;
  cancel: () => void;
} {
  const stdin = process.stdin;
  let settled = false;
  let onKeypress: (str: string, key: { name?: string; ctrl?: boolean; sequence?: string } | undefined) => void = () => {};
  const teardown = () => {
    stdin.removeListener("keypress", onKeypress);
    try {
      stdin.setRawMode?.(false);
    } catch {
      // best-effort restore
    }
    stdin.pause();
  };
  let cancel = () => {
    settled = true;
    teardown();
  };
  const promise = new Promise<{ key: string; ctrlC: boolean; cancelled?: boolean }>((resolveKey) => {
    onKeypress = (_str, key) => {
      if (settled) {
        return;
      }
      settled = true;
      teardown();
      resolveKey({
        key: key?.name ?? key?.sequence ?? "",
        ctrlC: key?.ctrl === true && key?.name === "c"
      });
    };
    cancel = () => {
      if (settled) {
        return;
      }
      settled = true;
      teardown();
      resolveKey({ key: "", ctrlC: false, cancelled: true });
    };
    try {
      emitKeypressEvents(stdin);
    } catch {
      // best-effort — onKeypress still fires from a raw stdin on the real interactive path
    }
    try {
      stdin.setRawMode?.(true);
    } catch {
      // non-raw stdin (shouldn't happen on the interactive path) — onKeypress still fires
    }
    stdin.resume();
    stdin.on("keypress", onKeypress);
  });
  return { promise, cancel };
}

/**
 * Builds the CLI-owned interaction/gate seams shared by #7 (cancellable GA4 wait) and #8
 * (sequencing). Returns `{}` (no wiring) on non-interactive / --json / headless runs so the
 * setup module keeps today's print-URL + poll + resumable-pause behavior and NEVER blocks on
 * a keypress. `dispose()` tears down any armed keypress listener / raw mode in the caller's
 * finally — a hard guarantee that raw mode is always restored.
 */
export function createSetupInteractionWiring(args: {
  env: CliEnv;
  jsonMode?: boolean;
  setup: SetupModuleApi;
}): {
  ga4OauthInteraction?: Ga4OauthWaitInteraction;
  awaitProviderHandoff?: ProviderHandoffGate;
  onProviderStart?: (input: { provider: SetupProviderId; index: number; total: number }) => void;
  dispose(): void;
} {
  if (!isSetupInteractive(args.env, args.jsonMode)) {
    // Non-interactive: no menus, no keypress — preserve today's behavior exactly.
    return { dispose() {} };
  }

  let disposed = false;
  let activeCancel: (() => void) | null = null;
  let lastAuthorizationUrl: string | undefined;
  let ctrlCArmed = false;

  const writeLine = (message: string) => {
    errorOutput.write(`${message}\n`);
  };

  const showOptionsMenu = async (header: string): Promise<Ga4OauthWaitDecision> => {
    for (;;) {
      writeLine(header);
      const choices = [
        "Keep waiting / retry the browser sign-in",
        "Show the link again",
        "Use your own Google Cloud app",
        "Skip OAuth — install the GA4 tag manually",
        "Quit setup (resume later)"
      ];
      const selected = await promptChoice("How do you want to continue connecting Google Analytics?", choices, 0, {
        io: { input, output: errorOutput }
      });
      if (selected === 1) {
        // Show the link again, then re-open the menu without ending the wait.
        writeLine(args.setup.providerGuidance("ga4", "quick_connect", { authorizationUrl: lastAuthorizationUrl }));
        continue;
      }
      if (selected === 2) return "byo";
      if (selected === 3) return "manual";
      if (selected === 4) return "quit";
      return "retry";
    }
  };

  const ga4OauthInteraction: Ga4OauthWaitInteraction = {
    onWaitStarted({ authorizationUrl }) {
      lastAuthorizationUrl = authorizationUrl;
      writeLine(
        "Waiting for Google… press any key for options (retry · show link · use your own app · manual tag · quit)."
      );
    },
    async waitForDecision() {
      if (disposed) {
        return null;
      }
      const press = waitForAnyKeypress();
      activeCancel = press.cancel;
      const { ctrlC, cancelled } = await press.promise;
      activeCancel = null;
      if (disposed || cancelled) {
        // The poll completed first (cancel) — never block; let the caller use its outcome.
        return null;
      }
      if (ctrlC) {
        if (ctrlCArmed) {
          // Second Ctrl-C: hard-exit cleanly.
          process.exit(130);
        }
        ctrlCArmed = true;
      }
      const decision = await showOptionsMenu(
        ctrlC ? "Paused. Choose how to continue (press Ctrl-C again to force-quit)." : "Paused."
      );
      ctrlCArmed = false;
      return decision;
    },
    cancelWait() {
      // Tear down the armed keypress wait NOW (the poll reached a terminal state). activeCancel()
      // removes the 'keypress' listener, restores raw mode (setRawMode(false)), pauses stdin, AND
      // resolves the pending waitForDecision to a cancelled outcome so it can never fire while the
      // options menu / next prompt owns stdin. Idempotent (cancel() is a no-op once settled) and
      // exception-safe so a teardown hiccup never masks the poll outcome.
      try {
        activeCancel?.();
      } catch {
        // best-effort restore — never throw out of teardown.
      } finally {
        activeCancel = null;
      }
    },
    async onTimeout({ error }) {
      const header = error
        ? `We didn't hear back from Google in a few minutes. Google reported: ${error}`
        : "We didn't hear back from Google in a few minutes.";
      return showOptionsMenu(header);
    },
    async onFailed({ error }) {
      const header = error ? `Google sign-in didn't complete: ${error}` : "Google sign-in didn't complete.";
      return showOptionsMenu(header);
    }
  };

  const awaitProviderHandoff: ProviderHandoffGate = async (provider) => {
    // One browser at a time: block until the founder acks (Enter) before the next opens.
    await promptText(
      `Press Enter once ${SETUP_PROVIDER_LABEL[provider]} is connected, or to skip and continue…`,
      "",
      { io: { input, output: errorOutput } }
    );
  };

  const onProviderStart = (info: { provider: SetupProviderId; index: number; total: number }) => {
    writeLine(`\nNow connecting ${SETUP_PROVIDER_LABEL[info.provider]} (${info.index} of ${info.total})…`);
  };

  return {
    ga4OauthInteraction,
    awaitProviderHandoff,
    onProviderStart,
    dispose() {
      disposed = true;
      // If a keypress listener is still armed (poll resolved first), cancel it — this removes
      // the listener AND restores raw mode, so raw mode is ALWAYS torn down even if the poll
      // won the race against a pending keypress.
      activeCancel?.();
      activeCancel = null;
    }
  };
}

async function runLocalSetupOnboarding(input: {
  interview: SetupInterview;
  env: CliEnv;
  workspaceId: string;
  jsonMode?: boolean;
}): Promise<SetupOnboardingResult> {
  const setup = await loadSetupModule();
  const workspaceRoot = workspaceRootFor(input.env);
  const config = loadInfiniteOsConfig({ workspaceRoot, env: input.env as NodeJS.ProcessEnv });
  if (!process.env.GROWTH_OS_ENCRYPTION_KEY && config.encryptionKey) {
    process.env.GROWTH_OS_ENCRYPTION_KEY = config.encryptionKey;
  }
  const db = createInfiniteOsDb(config.databaseUrl);
  const actions = createLocalSetupActionRunner(db);
  const prompt = createLocalSetupPrompter({ interactive: isSetupInteractive(input.env, input.jsonMode) });
  const ga4OauthBootstrap = createLocalGa4OauthBootstrap({
    env: input.env,
    config,
    jsonMode: input.jsonMode,
    guidance: (step, ctx) => setup.providerGuidance("ga4", step, ctx)
  });
  const interaction = createSetupInteractionWiring({ env: input.env, jsonMode: input.jsonMode, setup });

  try {
    const result = await setup.runLiveSetupOnboarding({
      db,
      workspaceId: input.workspaceId,
      interview: input.interview,
      actions,
      prompt,
      ga4OauthBootstrap,
      ga4OauthInteraction: interaction.ga4OauthInteraction,
      awaitProviderHandoff: interaction.awaitProviderHandoff,
      onProviderStart: interaction.onProviderStart
    });
    // Once each provider is connected + synced, offer to install its tag into the founder's
    // site repo — the path is prompted explicitly (never cwd / Infinite's own repo) and the
    // founder confirms before any file is written. One combined apply across all providers.
    await offerProviderTagInstall({ setup, result, env: input.env, workspaceId: input.workspaceId, jsonMode: input.jsonMode });
    return buildSetupOnboardingResult(input.interview, result);
  } finally {
    interaction.dispose();
    await db.close();
  }
}

/** Provider display order for the post-run install offer (GA4 → PostHog → X). */
const TAG_INSTALL_PROVIDER_ORDER: SetupProviderId[] = ["ga4", "posthog", "x"];

/** The "<Provider> is connected — add the <noun> to your site" line, per provider. */
const TAG_INSTALL_CONNECTED_LINES: Record<SetupProviderId, string> = {
  ga4: "GA4 is connected. To start collecting data, add the GA4 tag to your site.",
  posthog: "PostHog is connected. To start capturing product events, add the PostHog snippet to your site.",
  x: "X is connected. To start tracking conversions, add the X pixel to your site."
};

/** Mixed-case display names so a single end-state view never reads both "PostHog" and "POSTHOG". */
const TAG_INSTALL_NOUNS: Record<SetupProviderId, string> = {
  ga4: "GA4 tag",
  posthog: "PostHog snippet",
  x: "X pixel"
};

/** What the founder still needs from each provider before its artifact exists. */
interface ProviderInstallArtifact {
  provider: SetupProviderId;
  artifacts: SetupWorkspaceInstallArtifacts;
}

/**
 * Builds the per-provider {@link SetupWorkspaceInstallArtifacts} slices for the install
 * offer: a completed provider is included only when its required PUBLIC id was captured.
 * Mirrors install-command.ts / artifacts-file.ts rules (PostHog needs a project key, X
 * event tags need a pixel id, apiHost defaults when null). Returned in provider order.
 */
function collectInstallableProviderArtifacts(
  completed: string[],
  resolved: SetupOnboardingResult["resolvedPublicArtifacts"] | undefined
): ProviderInstallArtifact[] {
  const completedSet = new Set(completed);
  const out: ProviderInstallArtifact[] = [];
  for (const provider of TAG_INSTALL_PROVIDER_ORDER) {
    if (!completedSet.has(provider)) {
      continue;
    }
    if (provider === "ga4") {
      const measurementId = stringValue(resolved?.ga4?.measurementId);
      if (measurementId) {
        out.push({ provider, artifacts: { ga4: { measurementId } } });
      }
    } else if (provider === "posthog") {
      const projectKey = stringValue(resolved?.posthog?.projectKey);
      if (projectKey) {
        const apiHost = stringValue(resolved?.posthog?.apiHost) ?? "https://us.i.posthog.com";
        out.push({ provider, artifacts: { posthog: { projectKey, apiHost } } });
      }
    } else if (provider === "x") {
      const pixelId = stringValue(resolved?.x?.pixelId);
      if (pixelId) {
        const rawTags = resolved?.x?.eventTagIds;
        const eventTagIds = [
          ...new Set(
            Object.values((rawTags && typeof rawTags === "object" ? rawTags : {}) as Record<string, unknown>)
              .map((id) => stringValue(id))
              .filter((id): id is string => Boolean(id))
          )
        ];
        out.push({ provider, artifacts: { x: { pixelId, eventTagIds } } });
      }
    }
  }
  return out;
}

async function offerProviderTagInstall(args: {
  setup: SetupModuleApi;
  result: { completed: SetupProviderId[]; resolvedPublicArtifacts: SetupOnboardingResult["resolvedPublicArtifacts"] };
  env: CliEnv;
  workspaceId: string;
  jsonMode?: boolean;
}): Promise<void> {
  // Route the install's prompts + progress to stderr so they never corrupt the stdout
  // payload of `infinite setup --json` (and conventionally, interactive UI belongs there).
  await runTagInstallOffer({
    completed: args.result.completed,
    resolvedPublicArtifacts: args.result.resolvedPublicArtifacts,
    workspaceId: args.workspaceId,
    io: {
      isInteractive: input.isTTY === true && !args.jsonMode && args.env.GROWTH_OS_CLI_NONINTERACTIVE !== "1",
      write: (message) => {
        errorOutput.write(message);
      },
      promptText: (question) => promptText(question, "", { io: { input, output: errorOutput } }),
      promptYesNo: (question, defaultValue) =>
        promptYesNo(question, defaultValue, { io: { input, output: errorOutput } }),
      installProviderTags: args.setup.installProviderTags,
      buildPostHogBootstrapSnippet: args.setup.buildPostHogBootstrapSnippet,
      buildXBootstrapSnippet: args.setup.buildXBootstrapSnippet,
      wrapHtmlSnippet: args.setup.wrapHtmlSnippet
    }
  });
}

export interface TagInstallIo {
  isInteractive: boolean;
  write: (message: string) => void;
  promptText: (question: string) => Promise<string>;
  promptYesNo: (question: string, defaultValue: boolean) => Promise<boolean>;
  installProviderTags: SetupModuleApi["installProviderTags"];
  /** Tested instrument snippet builders, injected so the manual fallback never drifts. */
  buildPostHogBootstrapSnippet: SetupModuleApi["buildPostHogBootstrapSnippet"];
  buildXBootstrapSnippet: SetupModuleApi["buildXBootstrapSnippet"];
  wrapHtmlSnippet: SetupModuleApi["wrapHtmlSnippet"];
}

/**
 * Per-provider tag-install offer after a completed run (#9). Pure over its {@link
 * TagInstallIo} seam so it is unit-testable: for every completed provider with a captured
 * artifact (GA4 + PostHog + X), print one connected line, recommend `npx infinite-tag
 * install`, then offer to apply ALL of them into the founder's repo in ONE combined pass.
 * On skip / decline / error, print the manual snippet for EVERY not-written provider so
 * nothing is silently dropped.
 */
export async function runTagInstallOffer(args: {
  completed: string[];
  resolvedPublicArtifacts: SetupOnboardingResult["resolvedPublicArtifacts"] | undefined;
  workspaceId: string;
  io: TagInstallIo;
}): Promise<void> {
  const { io } = args;
  const installable = collectInstallableProviderArtifacts(args.completed, args.resolvedPublicArtifacts);
  if (installable.length === 0) {
    return;
  }
  if (!io.isInteractive) {
    // Non-interactive (piped / CI / --json consumers): never write to a repo we cannot
    // confirm. The public ids ride out in the JSON result + the combined install command.
    return;
  }

  const printManualForProviders = (providers: ProviderInstallArtifact[]): void => {
    for (const entry of providers) {
      printProviderManualSnippet(io, entry);
    }
  };

  try {
    const connectedLines = installable.map((entry) => TAG_INSTALL_CONNECTED_LINES[entry.provider]);
    io.write(
      `\n${connectedLines.join("\n")}\n` +
        "Recommended — run this inside your site's code repo (it finds your captured tags automatically):\n\n" +
        "  npx infinite-tag install\n"
    );
    const repoAnswer = (
      await io.promptText(
        "Or enter your website repo path and Infinite will add it for you now (press Enter to skip and use the command above)"
      )
    ).trim();
    if (!repoAnswer) {
      printManualForProviders(installable);
      return;
    }

    const repoRoot = resolve(expandHomePath(repoAnswer));
    const combinedArtifacts: SetupWorkspaceInstallArtifacts = {};
    for (const entry of installable) {
      Object.assign(combinedArtifacts, entry.artifacts);
    }
    let outcome: Awaited<ReturnType<SetupModuleApi["installProviderTags"]>>;
    try {
      outcome = await io.installProviderTags({
        artifacts: combinedArtifacts,
        repoRoot,
        workspaceId: args.workspaceId,
        confirm: async (summary) => {
          const count = summary.files.length;
          const nounList = describeInstallNouns(
            (summary.providers.length > 0 ? summary.providers : installable.map((entry) => entry.provider))
          );
          io.write(
            `\nInfinite will install the ${nounList} into your ${summary.framework} app (updates ${count} file${count === 1 ? "" : "s"} plus an Infinite install manifest):\n`
          );
          for (const file of summary.files) {
            io.write(`  - ${file}\n`);
          }
          return io.promptYesNo("Apply these changes?", true);
        }
      });
    } catch (error) {
      io.write(
        `\nCould not install your analytics tags automatically: ${error instanceof Error ? error.message : String(error)}\n`
      );
      printManualForProviders(installable);
      return;
    }

    io.write(`\n${outcome.result.detail}\n`);
    if (outcome.result.status !== "ok") {
      // skipped / needs_human / blocked → the combined apply wrote nothing for ANY provider
      // (one managed module, one apply), so hand the founder the snippet for EVERY provider
      // so nothing is silently dropped.
      printManualForProviders(installable);
    }
  } catch {
    // A prompt rejection (e.g. readline close on Ctrl+C / EOF / stream error) must
    // never propagate out and fail the enclosing setup run. The providers are already
    // connected; the founder can add each tag manually at any time.
    printManualForProviders(installable);
  }
}

/** "GA4 tag", "GA4 tag and PostHog snippet", "GA4 tag, PostHog snippet, and X pixel". */
function describeInstallNouns(providers: SetupProviderId[]): string {
  const nouns = providers.map((provider) => TAG_INSTALL_NOUNS[provider]);
  if (nouns.length === 0) {
    return "analytics tags";
  }
  if (nouns.length === 1) {
    return nouns[0]!;
  }
  if (nouns.length === 2) {
    return `${nouns[0]} and ${nouns[1]}`;
  }
  return `${nouns.slice(0, -1).join(", ")}, and ${nouns[nouns.length - 1]}`;
}

function printProviderManualSnippet(io: TagInstallIo, entry: ProviderInstallArtifact): void {
  if (entry.provider === "ga4" && entry.artifacts.ga4) {
    printGa4ManualTag(io.write, entry.artifacts.ga4.measurementId);
  } else if (entry.provider === "posthog" && entry.artifacts.posthog) {
    printPostHogManualSnippet(io, entry.artifacts.posthog.projectKey, entry.artifacts.posthog.apiHost);
  } else if (entry.provider === "x" && entry.artifacts.x) {
    printXManualPixel(io, entry.artifacts.x.pixelId, entry.artifacts.x.eventTagIds);
  }
}

export function expandHomePath(raw: string): string {
  if (raw === "~") {
    return homedir();
  }
  if (raw.startsWith("~/")) {
    return `${homedir()}/${raw.slice(2)}`;
  }
  return raw;
}

/** Inverse of expandHomePath for display: shorten paths under the home dir to `~/…`. */
function contractHomePath(raw: string): string {
  const home = homedir();
  if (raw === home) {
    return "~";
  }
  return raw.startsWith(`${home}/`) ? `~${raw.slice(home.length)}` : raw;
}

function printGa4ManualTag(write: (message: string) => void, measurementId: string): void {
  write(
    [
      "",
      `Add this Google Analytics tag to the <head> of every page (Measurement ID ${measurementId}):`,
      "",
      "  <!-- Google tag (gtag.js) -->",
      `  <script async src="https://www.googletagmanager.com/gtag/js?id=${measurementId}"></script>`,
      "  <script>",
      "    window.dataLayer = window.dataLayer || [];",
      "    function gtag(){dataLayer.push(arguments);}",
      "    gtag('js', new Date());",
      `    gtag('config', '${measurementId}');`,
      "  </script>",
      ""
    ].join("\n")
  );
}

function printPostHogManualSnippet(io: TagInstallIo, projectKey: string, apiHost: string): void {
  io.write(
    [
      "",
      `Add this PostHog snippet to the <head> of every page (project key ${projectKey}, host ${apiHost}):`,
      "",
      ...io.wrapHtmlSnippet(io.buildPostHogBootstrapSnippet(projectKey, apiHost)).split("\n").map((line) => `  ${line}`),
      ""
    ].join("\n")
  );
}

function printXManualPixel(io: TagInstallIo, pixelId: string, eventTagIds: string[]): void {
  io.write(
    [
      "",
      `Add this X pixel to the <head> of every page (pixel id ${pixelId}):`,
      "",
      ...io.wrapHtmlSnippet(io.buildXBootstrapSnippet(pixelId, eventTagIds)).split("\n").map((line) => `  ${line}`),
      ""
    ].join("\n")
  );
}

async function runSetupReset(args: string[], env: CliEnv): Promise<Record<string, unknown>> {
  const tool = args.find((arg) => !arg.startsWith("--"));
  let workspaceId: string;
  try {
    workspaceId = await requireActiveProject(env);
  } catch (error) {
    if (error instanceof NoActiveProjectError || error instanceof StaleActiveProjectError) {
      return {
        ok: false,
        section: "reset",
        cleared: [],
        error: "No active project, so there are no setup runs to reset.",
        next: "Run `infinite project list` then `infinite project use <name>` first."
      };
    }
    throw error;
  }
  const config = loadOptionalInfiniteOsConfig(env);
  if (!config?.databaseUrl) {
    return {
      ok: false,
      section: "reset",
      cleared: [],
      error: "Runtime database is not configured, so setup runs cannot be reset.",
      next: "Run `infinite setup runtime` first."
    };
  }
  const setup = await loadSetupModule();
  const db = createInfiniteOsDb(config.databaseUrl);
  try {
    const cleared = await setup.abandonActiveSetupRuns(db, workspaceId, tool);
    return {
      ok: true,
      section: "reset",
      ...(tool ? { tool } : {}),
      cleared,
      next: cleared.length > 0
        ? "Run `infinite setup` to start a fresh setup run."
        : "No active setup runs were blocking. Run `infinite setup status` to review setup."
    };
  } finally {
    await db.close();
  }
}

async function runLocalSetupResume(input: {
  runId: string;
  env: CliEnv;
  workspaceId: string;
  jsonMode?: boolean;
  posthogPersonalApiKey?: string;
  posthogApiHost?: string;
}): Promise<SetupOnboardingResult> {
  const setup = await loadSetupModule();
  const workspaceRoot = workspaceRootFor(input.env);
  const config = loadInfiniteOsConfig({ workspaceRoot, env: input.env as NodeJS.ProcessEnv });
  if (!process.env.GROWTH_OS_ENCRYPTION_KEY && config.encryptionKey) {
    process.env.GROWTH_OS_ENCRYPTION_KEY = config.encryptionKey;
  }
  const db = createInfiniteOsDb(config.databaseUrl);
  const actions = createLocalSetupActionRunner(db);
  const prompt = createLocalSetupPrompter({ interactive: isSetupInteractive(input.env, input.jsonMode) });
  const ga4OauthBootstrap = createLocalGa4OauthBootstrap({
    env: input.env,
    config,
    jsonMode: input.jsonMode,
    guidance: (step, ctx) => setup.providerGuidance("ga4", step, ctx)
  });
  const interaction = createSetupInteractionWiring({ env: input.env, jsonMode: input.jsonMode, setup });

  try {
    let result: Awaited<ReturnType<SetupModuleApi["resumeLiveSetupOnboarding"]>>;
    try {
      result = await setup.resumeLiveSetupOnboarding({
        db,
        workspaceId: input.workspaceId,
        runId: input.runId,
        ...((input.posthogPersonalApiKey || input.posthogApiHost)
          ? {
              resumeSecrets: {
                posthog: {
                  ...(input.posthogApiHost ? { apiHost: input.posthogApiHost } : {}),
                  ...(input.posthogPersonalApiKey ? { personalApiKey: input.posthogPersonalApiKey } : {})
                }
              }
            }
          : {}),
        actions,
        prompt,
        ga4OauthBootstrap,
        ga4OauthInteraction: interaction.ga4OauthInteraction,
        awaitProviderHandoff: interaction.awaitProviderHandoff,
        onProviderStart: interaction.onProviderStart
      });
    } catch (error) {
      throw await enrichSetupResumeError(error, input.runId, input.env, config);
    }
    if (!result.interview) {
      throw new Error(`setup run ${input.runId} did not return onboarding state`);
    }
    // A resumed run can be the one that finally connects a provider — offer the tag install here too.
    await offerProviderTagInstall({ setup, result, env: input.env, workspaceId: input.workspaceId, jsonMode: input.jsonMode });
    return buildSetupOnboardingResult(result.interview, result);
  } finally {
    interaction.dispose();
    await db.close();
  }
}

/** Re-derives `next` (#11 ladder) from the final outstanding set after a `--all` pass. */
function nextFromOutstanding(
  outstanding: NonNullable<SetupOnboardingResult["outstanding"]>,
  failedCount: number
): string {
  if (outstanding.length >= 2) {
    const labels = outstanding.map((entry) => formatSetupProviderLabel(entry.provider)).join(", ");
    return `${outstanding.length} providers are still paused (${labels}) — finish each handoff, then resume from the "Still paused" list above (or run \`infinite setup resume --all\`).`;
  }
  if (outstanding.length === 1) {
    const only = outstanding[0]!;
    return `Run \`infinite setup resume ${only.runId}\` after completing the ${formatSetupProviderLabel(only.provider)} handoff.`;
  }
  if (failedCount > 0) {
    return "Run `infinite setup status` to review failed providers.";
  }
  return "Run `infinite setup query` or `infinite` to continue.";
}

/**
 * #11 `infinite setup resume --all`: resume every outstanding paused provider SEQUENTIALLY
 * (in updated_at order via listActiveSetupRuns), reusing #8's one-at-a-time hand-off gate per
 * iteration. Continue-on-error so one provider's browser failure cannot strand the others.
 * After the pass, the combined end-state's `outstanding`/`next`/`ok` are recomputed from the
 * FINAL activeRuns so a provider that re-paused mid-loop is still surfaced.
 */
async function runLocalSetupResumeAll(input: {
  env: CliEnv;
  workspaceId: string;
  jsonMode?: boolean;
  resumeSetupRun: (input: SetupResumeRunInput) => Promise<SetupOnboardingResult>;
}): Promise<SetupCliResult> {
  const setup = await loadSetupModule();
  const workspaceRoot = workspaceRootFor(input.env);
  const config = loadInfiniteOsConfig({ workspaceRoot, env: input.env as NodeJS.ProcessEnv });
  if (!process.env.GROWTH_OS_ENCRYPTION_KEY && config.encryptionKey) {
    process.env.GROWTH_OS_ENCRYPTION_KEY = config.encryptionKey;
  }

  // Guard against an older loaded setup build that predates listActiveSetupRuns on the seam.
  if (typeof setup.listActiveSetupRuns !== "function") {
    return {
      ok: false,
      section: "connectors",
      workflow: "onboarding",
      status: "unsupported",
      next: "This setup build does not support `resume --all`. Resume each run with `infinite setup resume <run_id>` (see `infinite setup status`)."
    };
  }

  const listOutstanding = async (): Promise<Array<{ id: string; provider?: string }>> => {
    const db = createInfiniteOsDb(config.databaseUrl);
    try {
      const runs = await setup.listActiveSetupRuns(db, input.workspaceId);
      // Oldest-first so the founder is walked through handoffs in the order they paused.
      return runs.filter((run) => run.status === "paused_handoff").reverse();
    } finally {
      await db.close();
    }
  };

  const initialOutstanding = await listOutstanding();
  if (initialOutstanding.length === 0) {
    return {
      ok: true,
      section: "connectors",
      workflow: "onboarding",
      status: "no_outstanding",
      next: "No setup runs are paused. Run `infinite setup status` to review setup."
    };
  }

  let lastResult: SetupOnboardingResult | null = null;
  const failures: Array<{ runId: string; error: string }> = [];
  for (const run of initialOutstanding) {
    try {
      lastResult = await input.resumeSetupRun({
        runId: run.id,
        env: input.env,
        workspaceId: input.workspaceId,
        jsonMode: input.jsonMode
      });
    } catch (error) {
      failures.push({ runId: run.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Recompute the end-state from the FINAL activeRuns (a provider may have re-paused).
  const finalRuns = await listOutstanding();
  const outstanding = finalRuns.flatMap((run) =>
    typeof run.provider === "string" && isSetupProviderId(run.provider)
      ? [{ provider: run.provider, runId: run.id }]
      : []
  );
  if (lastResult) {
    const failedCount = lastResult.failed.length;
    return {
      ...lastResult,
      outstanding,
      ok: outstanding.length === 0 && failedCount === 0 && failures.length === 0,
      next: nextFromOutstanding(outstanding, failedCount)
    };
  }
  // Every resume threw — there is no onboarding result to combine. Surface the failures.
  return {
    ok: false,
    section: "connectors",
    workflow: "onboarding",
    status: "resume_all_failed",
    failures,
    outstanding,
    next:
      outstanding.length > 0
        ? nextFromOutstanding(outstanding, 0)
        : "Run `infinite setup status` to review setup."
  };
}

async function enrichSetupResumeError(
  error: unknown,
  runId: string,
  env: CliEnv,
  config: InfiniteOsConfig
): Promise<Error> {
  const original = error instanceof Error ? error : new Error(String(error));
  if (!original.message.includes("is not resumable")) {
    return original;
  }

  const activeRun = await readActiveSetupRunSummary(env, config).catch(() => null);
  if (!activeRun || !isResumableSetupRunSummary(activeRun) || activeRun.id === runId) {
    return original;
  }

  const truncatedHint = activeRun.id.startsWith(runId) ? " The run id looks truncated." : "";
  return new Error(
    `${original.message}.${truncatedHint} Active resumable setup run: ${activeRun.id}. Run: ${setupResumeCommand(activeRun)}`
  );
}

function createLocalSetupActionRunner(
  db: InfiniteOsDb
): { execute(id: string, input: unknown, ctx: SessionContext): Promise<ActionEnvelope> } {
  const registry = createInfiniteOsRegistry(createActionHandlers(db));
  return {
    execute(id, payload, ctx) {
      return registry.execute(id, payload, ctx);
    }
  };
}

/**
 * The setup module's only founder-facing seam: every confirmation/note/ask in
 * packages/setup flows through this injected prompter. Gating on `interactive`
 * (not raw jsonMode) keeps `--json` stdout pure AND fixes piped/non-TTY runs where
 * readline would otherwise write the prompt to stdout:
 *   - note(): interactive → stderr (mirrors createSetupInteractionWiring.writeLine);
 *     non-interactive/json → no-op (advisory copy; the JSON carries the structured truth).
 *   - ask(): interactive → prompt on stderr (never stdout); non-interactive/json →
 *     return the headless default immediately WITHOUT opening readline. The default is
 *     load-bearing (PostHog paste-key treats "" as skip; the GA4 selector resolves
 *     unknown→entries[0]), so a no-op ask yields the same outcome the run already expects.
 */
export function createLocalSetupPrompter(opts: {
  interactive: boolean;
}): { ask(question: string, choices?: string[]): Promise<string>; note(message: string): void } {
  return {
    async ask(question, choices) {
      if (!opts.interactive) {
        return choices && choices.length > 0 ? (choices[0] ?? "") : "";
      }
      if (choices && choices.length > 0) {
        const selected = await promptChoice(question, choices, 0, { io: { input, output: errorOutput } });
        return choices[selected] ?? choices[0] ?? "";
      }
      return promptText(question, "", { io: { input, output: errorOutput } });
    },
    note(message) {
      if (opts.interactive) {
        errorOutput.write(`${message}\n`);
      }
    }
  };
}

export function createLocalGa4OauthBootstrap(options: {
  env: CliEnv;
  config: InfiniteOsConfig;
  /** True for `infinite setup --json`: never prompt or write picker UI to stdout. */
  jsonMode?: boolean;
  /** Injectable for tests/isolation; defaults to reading the release file. */
  readReleaseConfig?: () => EmbeddedGa4OAuthClient | null;
  /**
   * Renders the GA4 guidance block (provider-guidance.ts) at the open site (#8 Part 2),
   * carrying #7's "paste this link" line. Injectable for tests; defaults to the local
   * template so the bootstrap works without the loaded setup module.
   */
  guidance?: (step: GuidanceStep, ctx: { authorizationUrl?: string; remoteLoopbackHint?: boolean }) => string;
}): NonNullable<Parameters<SetupModuleApi["runLiveSetupOnboarding"]>[0]["ga4OauthBootstrap"]> {
  // The redirect URI is built from the resolved daemon base URL (descriptor-first
  // discovery, design §3) — no longer a hardcoded port. Resolved lazily inside the
  // async hooks since resolveApiBaseUrlOnce is async.
  const resolveDefaultRedirectUri = async (): Promise<string> =>
    `${await resolveApiBaseUrlOnce(options.env, options.config)}/oauth/callback/google_analytics_4`;
  return {
    async prepareConfig() {
      const defaultRedirectUri = await resolveDefaultRedirectUri();
      return prepareGa4ConnectConfig({
        env: options.env,
        interactive:
          input.isTTY === true && !options.jsonMode && options.env.GROWTH_OS_CLI_NONINTERACTIVE !== "1",
        defaultRedirectUri,
        readReleaseConfig: options.readReleaseConfig ?? readReleaseGa4OAuthClient,
        io: {
          write: (message) => {
            output.write(message);
          },
          promptText: (question, fallback) => promptFreeformValue(question, fallback),
          promptSecret: (question, fallback) => promptSecretValue(question, fallback),
          promptChoice: (question, choices, defaultIndex) =>
            promptChoice(question, choices, defaultIndex)
        }
      });
    },
    async start(input) {
      const session = (await apiRequest("/oauth/sessions", options.env, {
        method: "POST",
        operator: true,
        body: {
          provider: "google_analytics_4",
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          redirectUri: input.redirectUri
        }
      })) as Record<string, unknown>;
      // Open the consent page in the founder's browser, then setup polls for completion and
      // continues automatically. #7: ALWAYS surface the copy-pasteable URL (even when the
      // browser reports opened:true) so an SSH/remote/wrong-account/closed-tab founder is never
      // stuck. --json keeps stdout clean (the URL is on the returned session).
      const authorizationUrl =
        typeof session.authorizationUrl === "string" ? session.authorizationUrl : "";
      if (authorizationUrl && !options.jsonMode) {
        const launch = openBrowserForAuth(authorizationUrl, options.env);
        const remoteLoopbackHint =
          isRemoteSession(options.env) &&
          isLoopbackRedirect(stringValue(session.redirectUri) ?? (await resolveDefaultRedirectUri()));
        const renderGuidance =
          options.guidance ??
          ((step: GuidanceStep, ctx: { authorizationUrl?: string; remoteLoopbackHint?: boolean }) =>
            localGa4Guidance(step, ctx));
        const block = renderGuidance("quick_connect", { authorizationUrl, remoteLoopbackHint });
        output.write(
          (launch.opened
            ? "Opened Google in your browser. Finish signing in there.\n"
            : "") + block + "\n"
        );
      }
      return session;
    },
    async status(sessionId) {
      return apiRequest(`/oauth/sessions/${encodeURIComponent(sessionId)}`, options.env, {
        operator: true
      }) as Promise<Record<string, unknown>>;
    },
    async exchange(sessionId) {
      return apiRequest(`/oauth/sessions/${encodeURIComponent(sessionId)}/exchange`, options.env, {
        method: "POST",
        operator: true,
        body: {}
      }) as Promise<Record<string, unknown>>;
    }
  };
}

/** A deferred recommendation's reasonCode → which enable-path copy the founder should read. */
function deferralKindFromReasonCode(reasonCode: string): "reenable" | "future" {
  // Friction the founder can clear (billing/explicit) → re-tick & re-run; scope/surface
  // limits → tracked for a future release.
  return reasonCode === "developer_billing_friction" || reasonCode === "explicit_founder_request"
    ? "reenable"
    : "future";
}

/**
 * Derives EVERY still-paused provider in the workspace from the workspace-wide activeRuns
 * (#11), deduped per provider keeping the most-recent (first) id — mirrors
 * confirmations.ts:71-77. Independent of the scoped interview, so a 2nd/3rd paused
 * provider is never dropped on resume.
 */
function deriveOutstanding(
  activeRuns: Awaited<ReturnType<SetupModuleApi["runLiveSetupOnboarding"]>>["activeRuns"]
): NonNullable<SetupOnboardingResult["outstanding"]> {
  const seen = new Set<SetupProviderId>();
  const outstanding: NonNullable<SetupOnboardingResult["outstanding"]> = [];
  for (const run of activeRuns) {
    if (run.status !== "paused_handoff" || typeof run.provider !== "string" || !isSetupProviderId(run.provider)) {
      continue;
    }
    if (seen.has(run.provider)) {
      continue;
    }
    seen.add(run.provider);
    outstanding.push({
      provider: run.provider,
      runId: run.id,
      ...(run.pendingHandoff?.instructions ? { instructions: run.pendingHandoff.instructions } : {}),
      ...(run.pendingHandoff?.url ? { url: run.pendingHandoff.url } : {})
    });
  }
  return outstanding;
}

export function buildSetupOnboardingResult(
  interview: SetupInterview,
  result: Awaited<ReturnType<SetupModuleApi["runLiveSetupOnboarding"]>>
): SetupOnboardingResult {
  const activeRunsByProvider = new Map(
    result.activeRuns.flatMap((run) =>
      typeof run.provider === "string" && isSetupProviderId(run.provider)
        ? [[run.provider, run] as const]
        : []
    )
  );
  const completed = new Set(result.completed);
  const paused = new Set(result.paused);
  const failed = new Set(result.failed);
  const recByProvider = new Map(
    (result.recommendations ?? []).map((rec) => [rec.provider, rec] as const)
  );
  const providers: SetupOnboardingProviderSummary[] = interview.providerInventory.map((row) => {
    const activeRun = activeRunsByProvider.get(row.provider);
    const summary = result.runs[row.provider];
    const handoff = activeRun?.pendingHandoff ?? firstProviderHandoff(summary);
    const recommendation = recByProvider.get(row.provider);
    // #13 status ladder: a row that connected/paused/failed renders its run status; a row
    // that was ticked-but-dropped (deferred/not_applicable recommendation, or selected yet
    // never reached a run) renders "deferred" WITH its rationale + enable path; only a row
    // that was genuinely never ticked AND not deferred falls to "not_selected".
    const isDeferredRecommendation =
      recommendation?.status === "deferred" || recommendation?.status === "not_applicable";
    let status: SetupOnboardingProviderSummary["status"];
    if (completed.has(row.provider)) {
      status = "completed";
    } else if (paused.has(row.provider)) {
      status = "paused_handoff";
    } else if (failed.has(row.provider)) {
      status = "failed";
    } else if (row.selected || isDeferredRecommendation) {
      status = "deferred";
    } else {
      status = "not_selected";
    }
    const deferral =
      status === "deferred" && recommendation
        ? {
            deferralReason: recommendation.rationale,
            deferralKind: deferralKindFromReasonCode(recommendation.reasonCode)
          }
        : {};
    return {
      provider: row.provider,
      selected: row.selected,
      recommended: row.recommended,
      status,
      runId: activeRun?.id,
      detail: firstProviderDetail(summary),
      ...deferral,
      handoff: handoff
        ? {
            url: handoff.url,
            instructions: handoff.instructions
          }
        : undefined
    };
  });

  const outstanding = deriveOutstanding(result.activeRuns);
  // #14 none-selected / all-deferred: nothing was even attempted (equivalent to empty
  // selectedProviders) → an honest no-data-source verdict, not a false success.
  const noDataSource =
    result.completed.length === 0 && result.paused.length === 0 && result.failed.length === 0;

  // SINGLE next/ok precedence ladder (#11/#13/#14 never collide; #13 renders inline):
  //   (1) noDataSource → pick-a-source; (2) outstanding ≥1 → resume; (3) failed>0 → review;
  //   (4) otherwise → continue. deferred providers add NO `next` (rendered per-row).
  let ok: boolean;
  let next: string;
  if (noDataSource) {
    ok = false;
    next = "Run `infinite setup` and select a data source (GA4 or PostHog) — nothing was configured yet.";
  } else if (outstanding.length >= 2) {
    ok = false;
    const labels = outstanding.map((entry) => formatSetupProviderLabel(entry.provider)).join(", ");
    next = `${outstanding.length} providers are still paused (${labels}) — finish each handoff, then resume from the "Still paused" list above (or run \`infinite setup resume --all\`).`;
  } else if (outstanding.length === 1) {
    ok = false;
    const only = outstanding[0]!;
    next = `Run \`infinite setup resume ${only.runId}\` after completing the ${formatSetupProviderLabel(only.provider)} handoff.`;
  } else if (result.failed.length > 0) {
    ok = false;
    next = "Run `infinite setup status` to review failed providers.";
  } else {
    ok = true;
    next = "Run `infinite setup query` or `infinite` to continue.";
  }

  return {
    ok,
    section: "connectors",
    workflow: "onboarding",
    interview,
    selectedProviders: result.selectedProviders,
    recommendedProviders: result.recommendedProviders,
    completed: result.completed,
    paused: result.paused,
    failed: result.failed,
    providers,
    resolvedPublicArtifacts: result.resolvedPublicArtifacts,
    installCommand: result.installCommand ?? null,
    installArtifactsPath: result.installArtifactsPath ?? null,
    outstanding,
    next
  };
}

function firstProviderDetail(
  summary: Awaited<ReturnType<SetupModuleApi["runLiveSetupOnboarding"]>>["runs"][SetupProviderId] | undefined
): string | undefined {
  if (!summary) {
    return undefined;
  }
  for (const phase of Object.values(summary.phases)) {
    if (phase.status !== "skipped" && phase.detail) {
      return phase.detail;
    }
  }
  return undefined;
}

function firstProviderHandoff(
  summary: Awaited<ReturnType<SetupModuleApi["runLiveSetupOnboarding"]>>["runs"][SetupProviderId] | undefined
): { url?: string; lastUrl?: string; instructions?: string } | undefined {
  if (!summary) {
    return undefined;
  }
  for (const phase of Object.values(summary.phases)) {
    if (phase.handoff?.instructions) {
      const lastUrl = setupHandoffLastUrl(phase.data);
      return {
        url: phase.handoff.url,
        lastUrl,
        instructions: phase.handoff.instructions
      };
    }
  }
  return undefined;
}

function setupHandoffLastUrl(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.lastKnownUrl === "string") {
    return value.lastKnownUrl;
  }
  if (typeof value.lastUrl === "string") {
    return value.lastUrl;
  }
  const resume = isRecord(value.resume) ? value.resume : null;
  if (resume && typeof resume.lastKnownUrl === "string") {
    return resume.lastKnownUrl;
  }
  if (resume && typeof resume.lastUrl === "string") {
    return resume.lastUrl;
  }
  return undefined;
}

function detectExistingInfiniteInstall(env: CliEnv): boolean {
  const workspaceRoot = workspaceRootFor(env);
  const growthDir = join(workspaceRoot, ".growth-os");
  const hasProjectRuntime = existsSync(join(growthDir, "config.yml")) || existsSync(join(growthDir, ".env"));
  const hasUserModel = Boolean(readInfiniteOsModelSelection(env as NodeJS.ProcessEnv).provider);
  const hasUserAuth = readInfiniteOsAuthSummary(env as NodeJS.ProcessEnv).hasInfiniteOsAuth;
  return hasProjectRuntime || hasUserModel || hasUserAuth;
}

async function resolveSetupProjectContext(
  args: string[],
  env: CliEnv,
  _options: { prompt: boolean }
): Promise<SetupProjectContext> {
  const existingProjectId = readActiveProjectId(env as NodeJS.ProcessEnv);
  if (existingProjectId) {
    const existingProject = await resolveSetupProjectRecord(existingProjectId, env);
    return {
      projectName: existingProject?.name ?? existingProjectId
    };
  }

  const explicitProjectName = (optionValue(args, "--project-name") ?? "").trim();
  if (explicitProjectName) {
    return {
      projectName: explicitProjectName
    };
  }

  return {};
}

async function resolveSetupProjectRecord(idOrName: string, env: CliEnv): Promise<ProjectRow | null> {
  const config = loadOptionalInfiniteOsConfig(env);
  if (!config?.databaseUrl) {
    return null;
  }
  const db = createInfiniteOsDb(config.databaseUrl);
  try {
    return await findProject(db, idOrName);
  } catch {
    return null;
  } finally {
    await db.close();
  }
}

async function resolveSetupWizardMode(
  args: string[],
  _env: CliEnv,
  existingInstall: boolean
): Promise<SetupWizardMode> {
  if (hasFlag(args, "--quick")) {
    return "quick";
  }
  if (hasFlag(args, "--full")) {
    return "full";
  }
  if (hasFlag(args, "--reconfigure")) {
    return "full";
  }
  if (existingInstall) {
    return "reuse";
  }
  return "full";
}

function shouldPromptForSetup(args: string[]): boolean {
  return input.isTTY === true && !hasSetupFlags(args);
}

function setupSectionFromArgs(args: string[]): SetupSectionId | null {
  const first = args[0];
  if (first === "runtime") return "runtime";
  if (first === "model" || first === "auth") return "model";
  if (first === "connectors" || first === "connector") return "connectors";
  if (first === "query" || first === "readiness") return "query";
  if (first === "status") return "status";
  return null;
}

function setupSectionTitle(section: SetupSectionId): string {
  return SETUP_SECTIONS.find((entry) => entry.id === section)?.title ?? section;
}

async function runSetupSection(
  section: SetupSectionId,
  args: string[],
  env: CliEnv
): Promise<Record<string, unknown>> {
  if (section === "runtime") {
    return setupRuntimeSection(args, env);
  }
  if (section === "model") {
    return setupModelSection(args, env);
  }
  if (section === "connectors") {
    return setupConnectors(args, env);
  }
  if (section === "query") {
    return setupQueryReadiness(env);
  }
  return setupStatus(env);
}

function deriveRuntimeSetupArgs(args: string[]): string[] {
  const explicitMode = optionValue(args, "--runtime-mode");
  const explicitDatabaseUrl = optionValue(args, "--runtime-database-url");
  const sectionArgs: string[] = [];
  if (explicitMode) {
    sectionArgs.push("--mode", explicitMode);
  } else if (!hasSetupFlags(args) && input.isTTY === true) {
    // Let runtime prompt for its mode during full interactive setup.
  } else {
    sectionArgs.push("--mode", "local_docker");
  }
  if (explicitDatabaseUrl) {
    sectionArgs.push("--database-url", explicitDatabaseUrl);
  }
  if (hasFlag(args, "--no-start")) {
    sectionArgs.push("--no-start");
  }
  return sectionArgs;
}

function hasExplicitRuntimeSetupInput(args: string[]): boolean {
  return Boolean(
    optionValue(args, "--runtime-mode") ||
    optionValue(args, "--runtime-database-url") ||
    hasFlag(args, "--reconfigure") ||
    hasFlag(args, "--full")
  );
}

function shouldReuseExistingRuntimeSetup(args: string[], env: CliEnv): boolean {
  return currentRuntimeSummary(env) !== null && !hasExplicitRuntimeSetupInput(args);
}

function buildExistingRuntimeSetupResult(env: CliEnv): Record<string, unknown> {
  const current = currentRuntimeSummary(env);
  if (!current) {
    throw new Error("Cannot reuse runtime setup without an existing runtime configuration.");
  }
  const files = setupFilesSummary(env);
  return {
    ok: true,
    section: "runtime",
    reused: true,
    runtime: {
      mode: current.mode,
      configPath: files.projectConfigPath,
      envPath: files.runtimeEnvPath,
      databaseUrl: current.databaseLabel ?? "configured",
      start: { ok: true, skipped: true, reason: "existing_setup" },
      migrations: { ok: true, skipped: true, mode: "existing_setup" }
    },
    next: "Run `infinite setup runtime --reconfigure` to change runtime settings."
  };
}

function hasExplicitModelSetupInput(args: string[]): boolean {
  const positionals = setupPositionalArgs(args);
  return Boolean(
    optionValue(args, "--provider") ||
    optionValue(args, "--model") ||
    optionValue(args, "--auth") ||
    optionValue(args, "--mode") ||
    positionals[0] ||
    positionals[1] ||
    hasFlag(args, "--reconfigure") ||
    hasFlag(args, "--full")
  );
}

function shouldReuseExistingModelSetup(args: string[], env: CliEnv): boolean {
  const current = currentModelSummary(env);
  return Boolean(current && current.authReady && !hasExplicitModelSetupInput(args));
}

function buildExistingModelSetupResult(env: CliEnv): Record<string, unknown> {
  const current = currentModelSummary(env);
  if (!current || !current.authReady) {
    throw new Error("Cannot reuse model setup without an authenticated existing model selection.");
  }
  return {
    ok: true,
    reused: true,
    provider: current.provider,
    model: current.model,
    path: infiniteOsUserConfigPath(env as NodeJS.ProcessEnv),
    auth: {
      ok: true,
      provider: current.provider,
      ready: true,
      source: current.authSource ?? null,
      mode: current.authMode ?? "current",
      reused: true
    }
  };
}

function setupFilesSummary(env: CliEnv): SetupFilesSummary {
  const workspaceRoot = workspaceRootFor(env);
  return {
    projectConfigPath: join(workspaceRoot, ".growth-os", "config.yml"),
    runtimeEnvPath: join(workspaceRoot, ".growth-os", ".env"),
    userConfigPath: infiniteOsUserConfigPath(env as NodeJS.ProcessEnv),
    userAuthPath: infiniteOsAuthPath(env as NodeJS.ProcessEnv)
  };
}

function nextSetupCommand(readiness: SetupReadiness): string {
  if (readiness.llmQuery === "ready") {
    return "infinite";
  }
  if (readiness.activeSetupRun && isResumableSetupRunSummary(readiness.activeSetupRun)) {
    return setupResumeCommand(readiness.activeSetupRun);
  }
  if (readiness.blockingReasons.some((reason) => reason.startsWith("runtime_config_incomplete") || reason.startsWith("database_missing"))) {
    return "infinite setup runtime";
  }
  if (readiness.blockingReasons.some((reason) => reason.startsWith("model_missing") || reason.startsWith("model_auth_incomplete"))) {
    return "infinite setup model";
  }
  if (readiness.blockingReasons.some((reason) => reason.startsWith("connectors_missing"))) {
    return "infinite setup connectors";
  }
  return "infinite setup status";
}

function setupResumeCommand(run: Pick<SetupRunSummary, "id">): string {
  return `infinite setup resume ${run.id}`;
}

function isResumableSetupRunSummary(run: Pick<SetupRunSummary, "status">): boolean {
  return run.status === "paused_handoff";
}

function hasSetupFlags(args: string[]): boolean {
  return args.some((arg) => arg.startsWith("--"));
}

async function promptSetupOptions(options: {
  provider?: InfiniteOsModelProvider;
  model?: string;
  authMode?: SetupAuthMode;
  initialProvider?: InfiniteOsModelProvider;
  env?: CliEnv;
}): Promise<{ provider: InfiniteOsModelProvider; model: string; authMode: SetupAuthMode }> {
  const rl = createInterface({ input, output });
  try {
    if (options.env) {
      output.write(`${renderDetectedModelAuthStatus(options.env)}\n`);
    }
    const providerDefault = options.provider ?? options.initialProvider ?? "codex";
    const provider = await promptProvider(rl, providerDefault);
    const modelDefault = normalizeModelChoice(provider, options.model) ?? MODEL_PROVIDER_CATALOG[provider].defaultModel;
    const model = await promptModel(rl, provider, modelDefault);
    const authDefault = options.authMode ?? defaultSetupAuthMode(provider);
    const authMode = await promptSetupAuthMode(rl, provider, authDefault);
    return { provider, model, authMode };
  } finally {
    rl.close();
  }
}

async function promptProvider(
  rl: ReturnType<typeof createInterface>,
  fallback: InfiniteOsModelProvider
): Promise<InfiniteOsModelProvider> {
  void rl;
  const options = ["codex", "claude"];
  const defaultIndex = options.indexOf(fallback);
  const selected = await promptChoice("Select provider:", options, defaultIndex === -1 ? 0 : defaultIndex, {
    description: "Choose how Infinite connects to the LLM query runtime."
  });
  return options[selected] as InfiniteOsModelProvider;
}

async function promptSetupAuthMode(
  rl: ReturnType<typeof createInterface>,
  provider: InfiniteOsModelProvider,
  fallback: SetupAuthMode
): Promise<SetupAuthMode> {
  void rl;
  const choices = provider === "codex" ? ["login", "import", "none"] : ["reuse", "setup-token", "none"];
  const defaultIndex = Math.max(0, choices.indexOf(fallback));
  const selected = await promptChoice("Select auth mode:", choices, defaultIndex, {
    description:
      provider === "codex"
        ? "Login opens the Infinite OS Codex device flow. Import reuses Codex CLI credentials."
        : "Reuse links Claude Code credentials. setup-token runs the Claude Code auth flow."
  });
  return choices[selected] as SetupAuthMode;
}

async function promptModel(
  rl: ReturnType<typeof createInterface>,
  provider: InfiniteOsModelProvider,
  fallback: string
): Promise<string> {
  const supported = MODEL_PROVIDER_CATALOG[provider].models;
  void rl;
  const defaultIndex = Math.max(0, supported.indexOf(fallback));
  const selected = await promptChoice("Select default model:", supported, defaultIndex, {
    description: "Use the arrows to choose the model Infinite should use for GTM queries."
  });
  return supported[selected] as string;
}

async function promptValue(
  rl: ReturnType<typeof createInterface>,
  question: string,
  fallback: string
): Promise<string> {
  const value = (await rl.question(question)).trim();
  return value || fallback;
}

async function resolveRuntimeSetupMode(args: string[], env: CliEnv): Promise<RuntimeSetupMode | null> {
  const explicit = runtimeModeFromInput(optionValue(args, "--mode") ?? firstPositionalArg(args));
  if (explicit) {
    return explicit;
  }
  const current = currentRuntimeSummary(env);
  if (current && input.isTTY === true && env.GROWTH_OS_CLI_NONINTERACTIVE !== "1") {
    output.write(`Current runtime target: ${current.modeLabel}\n`);
    if (current.databaseLabel) {
      output.write(`Current database: ${current.databaseLabel}\n`);
    }
    const choice = await promptChoice(
      "Runtime configuration",
      ["Keep current", "Reconfigure"],
      0,
      {
        description: "Choose whether to keep the current runtime settings or change them."
      }
    );
    if (choice === 0) {
      return current.mode;
    }
  }
  if (env.GROWTH_OS_CLI_NONINTERACTIVE === "1" || input.isTTY !== true) {
    return null;
  }
  const choices: RuntimeSetupMode[] = ["local_docker", "external_postgres", "supabase"];
  const selected = await promptChoice("Select runtime mode:", choices, 0, {
    description: "Choose where Infinite stores and queries its GTM data."
  });
  return choices[selected] ?? null;
}

async function resolveRuntimeDatabaseUrl(
  mode: Exclude<RuntimeSetupMode, "local_docker">,
  args: string[],
  env: CliEnv
): Promise<string | null> {
  const explicit = optionValue(args, "--database-url");
  if (explicit) {
    return explicit;
  }
  if (env.GROWTH_OS_CLI_NONINTERACTIVE === "1" || input.isTTY !== true) {
    return null;
  }
  const rl = createInterface({ input, output });
  try {
    const label = mode === "supabase" ? "Supabase Postgres URL" : "External Postgres URL";
    const answer = (await rl.question(`${label}: `)).trim();
    return answer || null;
  } finally {
    rl.close();
  }
}

function runtimeModeFromInput(value: string | undefined): RuntimeSetupMode | null {
  if (value === "local_docker" || value === "external_postgres" || value === "supabase") {
    return value;
  }
  return null;
}

function firstPositionalArg(args: string[]): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith("--")) {
      return arg;
    }
  }
  return undefined;
}

async function runModelSetup(
  env: CliEnv,
  options: {
    provider?: InfiniteOsModelProvider;
    model?: string;
    authMode?: SetupAuthMode;
    initialProvider?: InfiniteOsModelProvider;
  } = {}
): Promise<Record<string, unknown> & { auth: Record<string, unknown> }> {
  const current = currentModelSummary(env);
  if (current && input.isTTY === true && env.GROWTH_OS_CLI_NONINTERACTIVE !== "1") {
    output.write(`Current provider: ${current.provider}\n`);
    output.write(`Current model: ${current.model}\n`);
    if (current.authSource) {
      output.write(`Current auth source: ${current.authSource}\n`);
    }
    const choice = await promptChoice(
      "Model and auth configuration",
      ["Keep current", "Reconfigure"],
      1,
      {
        description: "Choose whether to keep the current provider/model/auth or step through the selection flow."
      }
    );
    if (choice === 0) {
      return {
        ok: true,
        provider: current.provider,
        model: current.model,
        path: infiniteOsUserConfigPath(env as NodeJS.ProcessEnv),
        auth: {
          ok: Boolean(current.authReady),
          provider: current.provider,
          ready: Boolean(current.authReady),
          source: current.authSource ?? null,
          mode: current.authMode ?? "current",
          reused: true
        }
      };
    }
  }
  const answers = await promptSetupOptions({
    ...options,
    env
  });
  return applyExplicitModelSelection(answers.provider, answers.model, answers.authMode, env);
}

function currentRuntimeSummary(env: CliEnv): { mode: RuntimeSetupMode; modeLabel: string; databaseLabel?: string } | null {
  const workspaceRoot = workspaceRootFor(env);
  const configPath = join(workspaceRoot, ".growth-os", "config.yml");
  if (!existsSync(configPath)) {
    return null;
  }
  const values = parseSimpleYaml(readFileSync(configPath, "utf8"));
  const mode = runtimeModeFromInput(values.runtime_target) ?? "local_docker";
  return {
    mode,
    modeLabel: mode,
    databaseLabel:
      mode === "local_docker"
        ? "local Postgres"
        : mode === "supabase"
          ? "Supabase Postgres"
          : "external Postgres"
  };
}

function currentModelSummary(env: CliEnv): {
  provider: InfiniteOsModelProvider;
  model: string;
  authSource?: string;
  authMode?: string;
  authReady?: boolean;
} | null {
  const selection = readInfiniteOsModelSelection(env as NodeJS.ProcessEnv);
  if (!selection.provider || !selection.model) {
    return null;
  }
  const record = readInfiniteOsAuthState(env as NodeJS.ProcessEnv).providers[selection.provider];
  return {
    provider: selection.provider,
    model: selection.model,
    authSource: record?.source,
    authMode: record?.authMode,
    authReady: record ? !isExpired(record.expiresAt) || Boolean(record.refreshToken) : false
  };
}

// Returns true ONLY when the database already holds a credential that `key` cannot decrypt — a
// proven key mismatch. Never rejects: connection/query/missing-table errors resolve to false so an
// unreachable or fresh DB is treated as "nothing to protect".
async function probeForCredentialKeyMismatch(
  db: Pick<InfiniteOsDb, "one">,
  key: string
): Promise<boolean> {
  let payload: string | null = null;
  try {
    const fromCreds = await db.one<{ encrypted_payload: string | null }>(
      "select encrypted_payload from connection_credentials where encrypted_payload is not null order by created_at limit 1"
    );
    payload = fromCreds?.encrypted_payload ?? null;
    if (!payload) {
      const fromTokens = await db.one<{ encrypted_payload: string | null }>(
        "select encrypted_payload from oauth_tokens where encrypted_payload is not null order by created_at limit 1"
      );
      payload = fromTokens?.encrypted_payload ?? null;
    }
  } catch {
    return false; // tables don't exist yet (fresh DB) or the query failed — not a proven mismatch
  }
  if (!payload) return false; // empty DB — safe to set any key
  try {
    decryptCredentialPayload(payload, key);
    return false; // decrypts cleanly → the key matches the DB's credentials
  } catch (err) {
    return err instanceof CredentialDecryptError; // true only on a genuine decrypt mismatch
  }
}

/**
 * Guard against silently re-keying a database that already holds connector credentials.
 *
 * The CLI resolves `GROWTH_OS_ENCRYPTION_KEY` from env → project `.env` → machine-home `.env` →
 * `generateEncryptionKey()`. None of those know which key the *target database's* stored credentials
 * were actually encrypted with. Resolving a fresh/different key for a DB that already has credentials
 * makes every one of them undecryptable (syncs fail), and — because the setup flow mirrors the key
 * into `~/.growth-os/.env` — the desktop daemon inherits the wrong key too.
 *
 * So before persisting/mirroring a key, probe the target DB: if it already contains a credential the
 * resolved key cannot decrypt, REFUSE rather than orphan it. Conservative by design — any uncertainty
 * (non-postgres URL, unreachable DB, absent tables, empty DB, timeout) is treated as "nothing to
 * protect" and does NOT block setup. Only a PROVEN decrypt mismatch throws.
 */
export async function assertEncryptionKeyMatchesDatabase(opts: {
  databaseUrl: string;
  encryptionKey: string;
  createDb?: (databaseUrl: string) => Pick<InfiniteOsDb, "one" | "close">;
}): Promise<void> {
  // Only a real Postgres database can hold pre-existing credentials we'd orphan.
  if (!/^postgres(ql)?:\/\//i.test(opts.databaseUrl)) return;
  const makeDb = opts.createDb ?? createInfiniteOsDb;
  let db: Pick<InfiniteOsDb, "one" | "close">;
  try {
    db = makeDb(opts.databaseUrl);
  } catch {
    return; // couldn't even construct a client — nothing to validate
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const mismatch = await Promise.race([
      probeForCredentialKeyMismatch(db, opts.encryptionKey),
      // Never let an unreachable DB hang setup; on timeout assume "nothing proven" → don't block.
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 4000);
      })
    ]);
    if (mismatch) {
      throw new Error(
        "Refusing to write a new GROWTH_OS_ENCRYPTION_KEY: the target database already contains " +
          "connector credentials encrypted with a DIFFERENT key, and the resolved key cannot decrypt " +
          "them. Proceeding would orphan every stored credential (syncs would fail silently). Set " +
          "GROWTH_OS_ENCRYPTION_KEY to the key that originally encrypted them — the value in the " +
          ".growth-os/.env used when the sources were connected — or reconnect the sources to " +
          "re-encrypt them under the new key."
      );
    }
  } finally {
    if (timer) clearTimeout(timer);
    // Best-effort cleanup. If the DB was unreachable the probe left an in-flight connection, and
    // pool.close() would then block until the OS TCP timeout (~75-120s) — so cap the wait. The
    // cleanup timer is unref'd so it can never itself keep the process alive.
    await Promise.race([
      Promise.resolve(db.close()).catch(() => {}),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 2000).unref?.();
      })
    ]);
  }
}

async function writeRuntimeSetupFiles(options: {
  workspaceRoot: string;
  databaseUrl: string;
  mode: RuntimeSetupMode;
  env: CliEnv;
}): Promise<{ configPath: string; envPath: string; databaseUrlRedacted: string }> {
  const growthDir = join(options.workspaceRoot, ".growth-os");
  mkdirSync(growthDir, { recursive: true });
  const envPath = join(growthDir, ".env");
  const configPath = join(growthDir, "config.yml");
  const existingEnv = existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf8")) : {};
  // Read machine-home .env as a secondary fallback for key generation. When a
  // project-local .env doesn't exist yet (first setup on a fresh workspace) but
  // the machine home already has keys from a previous project, we reuse them
  // instead of generating new ones that would conflict with the mirror guard.
  const machineHomeEnvPath = join(infiniteOsHome(options.env as NodeJS.ProcessEnv), ".env");
  const machineHomeEnv = existsSync(machineHomeEnvPath)
    ? parseDotEnv(readFileSync(machineHomeEnvPath, "utf8"))
    : {};
  const deploymentEnv = {
    DATABASE_URL: options.databaseUrl,
    GROWTH_OS_ENCRYPTION_KEY:
      options.env.GROWTH_OS_ENCRYPTION_KEY ??
      existingEnv.GROWTH_OS_ENCRYPTION_KEY ??
      machineHomeEnv.GROWTH_OS_ENCRYPTION_KEY ??
      generateEncryptionKey(),
    GROWTH_OS_READ_TOKEN:
      options.env.GROWTH_OS_READ_TOKEN ??
      existingEnv.GROWTH_OS_READ_TOKEN ??
      machineHomeEnv.GROWTH_OS_READ_TOKEN ??
      "dev-read-token",
    GROWTH_OS_OPERATOR_TOKEN:
      options.env.GROWTH_OS_OPERATOR_TOKEN ??
      existingEnv.GROWTH_OS_OPERATOR_TOKEN ??
      machineHomeEnv.GROWTH_OS_OPERATOR_TOKEN ??
      "dev-operator-token"
  };
  // Before persisting the key into the project .env AND mirroring it into ~/.growth-os/.env (which
  // the desktop daemon reads), refuse if it can't decrypt credentials the target DB already holds —
  // otherwise we'd silently orphan them. Skipped in dry-run (no real DB to probe).
  if (options.env.GROWTH_OS_CLI_DRY_RUN !== "1") {
    await assertEncryptionKeyMatchesDatabase({
      databaseUrl: deploymentEnv.DATABASE_URL,
      encryptionKey: deploymentEnv.GROWTH_OS_ENCRYPTION_KEY
    });
  }
  writeFileSync(
    envPath,
    [
      `DATABASE_URL=${deploymentEnv.DATABASE_URL}`,
      `GROWTH_OS_ENCRYPTION_KEY=${deploymentEnv.GROWTH_OS_ENCRYPTION_KEY}`,
      `GROWTH_OS_READ_TOKEN=${deploymentEnv.GROWTH_OS_READ_TOKEN}`,
      `GROWTH_OS_OPERATOR_TOKEN=${deploymentEnv.GROWTH_OS_OPERATOR_TOKEN}`,
      ""
    ].join("\n")
  );
  // Mirror the 4 runtime secrets to the machine-home rendezvous so the desktop
  // picks them up regardless of which workspace the CLI was initialised in.
  mirrorMachineHomeEnv(growthDir, deploymentEnv, options.env as NodeJS.ProcessEnv);
  writeFileSync(
    configPath,
    [
      "runtime_mode: local",
      "app_host: 127.0.0.1",
      "app_port: 3000",
      `runtime_target: ${options.mode}`,
      ""
    ].join("\n")
  );
  return {
    configPath,
    envPath,
    databaseUrlRedacted: redactDatabaseUrl(options.databaseUrl)
  };
}

async function runRuntimeMigrations(databaseUrl: string, env: CliEnv): Promise<Record<string, unknown>> {
  if (env.GROWTH_OS_CLI_DRY_RUN === "1") {
    return {
      ok: true,
      dryRun: true,
      databaseUrl: redactDatabaseUrl(databaseUrl)
    };
  }
  const applied = await runMigrations(databaseUrl);
  return {
    ok: true,
    applied,
    alreadyUpToDate: applied.length === 0,
    databaseUrl: redactDatabaseUrl(databaseUrl)
  };
}

function redactDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) {
      url.password = "[redacted]";
    }
    return url.toString();
  } catch {
    return value.replace(/:(.*?)@/, ":[redacted]@");
  }
}

async function setupAuth(
  provider: InfiniteOsModelProvider,
  authMode: SetupAuthMode,
  env: CliEnv
): Promise<Record<string, unknown>> {
  if (provider === "codex") {
    if (authMode === "import") {
      return authCommand(["import", "codex"], env);
    }
    if (authMode === "login") {
      return authCommand(["login", "codex"], env);
    }
    throw new Error("codex setup auth must be login, import, or none");
  }
  if (authMode === "login" || authMode === "reuse") {
    return authCommand(["login", "claude", "--mode", "reuse"], env);
  }
  if (authMode === "setup-token") {
    return authCommand(["login", "claude", "--mode", "setup-token"], env);
  }
  throw new Error("claude setup auth must be reuse, setup-token, or none");
}

function defaultSetupAuthMode(provider: InfiniteOsModelProvider): SetupAuthMode {
  return provider === "codex" ? "login" : "reuse";
}

function isSetupAuthModeForProvider(provider: InfiniteOsModelProvider, mode: SetupAuthMode): boolean {
  if (mode === "none") {
    return true;
  }
  if (provider === "codex") {
    return mode === "login" || mode === "import";
  }
  return mode === "login" || mode === "reuse" || mode === "setup-token";
}

function providerFromInput(value: string | undefined): InfiniteOsModelProvider | undefined {
  if (value === "codex" || value === "claude") {
    return value;
  }
  return undefined;
}

function providerFromSetupInput(value: string | undefined): InfiniteOsModelProvider | undefined {
  const provider = providerFromInput(value);
  if (value && !provider) {
    throw new Error("setup provider must be codex or claude");
  }
  return provider;
}

function normalizeModelChoice(
  provider: InfiniteOsModelProvider,
  model: string | undefined
): string | undefined {
  if (!model) {
    return undefined;
  }
  return MODEL_PROVIDER_CATALOG[provider].models.find((candidate) => candidate === model);
}

function setupAuthModeFromInput(value: string | undefined): SetupAuthMode | undefined {
  if (
    value === "login" ||
    value === "import" ||
    value === "reuse" ||
    value === "setup-token" ||
    value === "none"
  ) {
    return value;
  }
  return undefined;
}

function authModeFromSetupInput(value: string | undefined): SetupAuthMode | undefined {
  const mode = setupAuthModeFromInput(value);
  if (value && !mode) {
    throw new Error("setup auth must be login, import, reuse, setup-token, or none");
  }
  return mode;
}

function setupPositionalArgs(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (SETUP_OPTIONS_WITH_VALUES.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    values.push(arg);
  }
  return values;
}

function setupNeedsInputResult(): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: "growth_os_setup_requires_input",
      message: "Run setup in a terminal, or pass provider/auth flags.",
      examples: [
        "infinite setup",
        "infinite setup --provider codex --auth login",
        "infinite setup --provider claude --auth reuse"
      ]
    }
  };
}

function modelSetupNeedsInputResult(): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: "growth_os_model_setup_requires_input",
      message: "Run model setup in a terminal, or pass provider/model/auth explicitly.",
      examples: [
        "infinite setup model",
        "infinite model use codex gpt-5.4 --auth login",
        "infinite model use claude claude-sonnet-4-5 --auth reuse"
      ]
    }
  };
}

function runtimeSetupNeedsInputResult(): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: "growth_os_runtime_setup_requires_input",
      message: "Choose a runtime mode, and provide a database URL for external Postgres or Supabase.",
      examples: [
        "infinite setup runtime --mode local_docker",
        "infinite setup runtime --mode external_postgres --database-url postgres://user:pass@host:5432/db",
        "infinite setup runtime --mode supabase --database-url postgres://user:pass@host:5432/db"
      ]
    }
  };
}

async function setupModelSection(args: string[], env: CliEnv): Promise<Record<string, unknown>> {
  if (!args.length) {
    return modelCommand(["use"], env);
  }
  const [provider, model, ...rest] = args;
  if (provider === "use") {
    return modelCommand(["use", ...rest], env);
  }
  if (provider === "status") {
    return modelCommand(["status"], env);
  }
  return modelCommand(["use", provider, model, ...rest].filter((part): part is string => Boolean(part)), env);
}

async function setupRuntimeSection(args: string[], env: CliEnv): Promise<Record<string, unknown>> {
  const mode = await resolveRuntimeSetupMode(args, env);
  if (!mode) {
    return runtimeSetupNeedsInputResult();
  }
  const databaseUrl =
    mode === "local_docker"
      ? DEFAULT_PROJECT_DATABASE_URL
      : await resolveRuntimeDatabaseUrl(mode, args, env);
  if (!databaseUrl) {
    return runtimeSetupNeedsInputResult();
  }

  const workspaceRoot = workspaceRootFor(env);
  const files = await writeRuntimeSetupFiles({
    workspaceRoot,
    databaseUrl,
    mode,
    env
  });

  if (mode === "local_docker") {
    let start: Record<string, unknown>;
    if (hasFlag(args, "--no-start")) {
      start = { ok: true, skipped: true };
    } else {
      try {
        start = runComposeCommand(["up", "-d"], env);
      } catch (error) {
        const failure = localRuntimeComposeFailureResult(error, {
          action: "setup",
          mode,
          configPath: files.configPath,
          envPath: files.envPath,
          databaseUrl: files.databaseUrlRedacted
        });
        if (failure) {
          return failure;
        }
        throw error;
      }
    }
    return {
      ok: true,
      section: "runtime",
      runtime: {
        mode,
        configPath: files.configPath,
        envPath: files.envPath,
        databaseUrl: files.databaseUrlRedacted,
        migrations: { ok: true, skipped: true, mode: "compose_managed" },
        start
      },
      next: "Run `infinite setup model` to choose Codex or Claude."
    };
  }

  const migrations = await runRuntimeMigrations(databaseUrl, env);
  return {
    ok: true,
    section: "runtime",
    runtime: {
      mode,
      configPath: files.configPath,
      envPath: files.envPath,
      databaseUrl: files.databaseUrlRedacted,
      start: { ok: true, skipped: true, reason: "external_runtime" },
      migrations
    },
    next: "Run `infinite setup model` to choose Codex or Claude."
  };
}

function optionValueAny(args: string[], ...flags: string[]): string | undefined {
  for (const flag of flags) {
    const value = optionValue(args, flag);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readLocalSecretFileValue(pathValue: string, secretLabel: string): string {
  const trimmedPath = pathValue.trim();
  if (!trimmedPath) {
    throw new Error(`${secretLabel} file path is empty.`);
  }
  if (trimmedPath.startsWith("file:") || /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmedPath)) {
    throw new Error(`${secretLabel} file must be a local filesystem path.`);
  }
  const resolvedPath = resolve(trimmedPath);
  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      throw new Error(`${secretLabel} file not found: ${resolvedPath}`);
    }
    throw error;
  }
  const secretValue = raw.trim();
  if (!secretValue) {
    throw new Error(`${secretLabel} file is empty: ${resolvedPath}`);
  }
  return secretValue;
}

async function setupStatus(env: CliEnv): Promise<Record<string, unknown>> {
  const readiness = await readSetupReadiness(env);
  const files = setupFilesSummary(env);
  const nextCommand = nextSetupCommand(readiness);
  return {
    ok: readiness.ok,
    section: "status",
    setupReadiness: readiness,
    files,
    nextCommand,
    next: readiness.ok
      ? "Run `infinite`, then type your question."
      : readiness.activeSetupRun && isResumableSetupRunSummary(readiness.activeSetupRun)
        ? `Run \`${setupResumeCommand(readiness.activeSetupRun)}\` to resume the active setup run.`
        : `Run \`${nextCommand}\` to finish setup.`
  };
}

// Sentinel so a successful `findProject` that returns null (stale pointer) is
// distinguishable from a DB that could not be reached at all.
class StaleActiveProjectError extends Error {}

async function requireActiveProject(env: CliEnv): Promise<string> {
  const explicitProjectId = env.GROWTH_OS_WORKSPACE_ID?.trim();
  const id = infiniteOsWorkspaceId({ env: env as NodeJS.ProcessEnv }); // throws NoActiveProjectError (empty state)
  if (explicitProjectId) {
    return id;
  }
  const cfg = loadOptionalInfiniteOsConfig(env);
  if (cfg?.databaseUrl) {
    const db = createInfiniteOsDb(cfg.databaseUrl);
    try {
      const found = await findProject(db, id);
      if (!found) {
        throw new StaleActiveProjectError(
          `Active project ${id} no longer exists. Run \`infinite project list\` then \`infinite project use <name>\`.`
        );
      }
    } finally {
      await db.close();
    }
  }
  return id;
}

async function setupQueryReadiness(env: CliEnv): Promise<Record<string, unknown>> {
  const readiness = await readSetupReadiness(env);
  return {
    ok: readiness.llmQuery === "ready",
    setupReadiness: readiness,
    next:
      readiness.llmQuery === "ready"
        ? "Run `infinite`, then type your question."
        : "Finish runtime, model/auth, and at least one marketing data connector."
  };
}

async function setupConnectors(args: string[], env: CliEnv): Promise<Record<string, unknown>> {
  const [provider, ...rest] = args;
  const definition = connectorSetupDefinition(provider);
  if (definition?.oauth && optionValue(rest, "--client-id")) {
    return setupOAuthConnector(definition, rest, env);
  }
  if (definition && !definition.oauth) {
    return setupTokenConnector(definition, rest, env);
  }
  if (!provider && input.isTTY === true && env.GROWTH_OS_CLI_NONINTERACTIVE !== "1") {
    const selected = await promptChecklist(
      "Select connectors to configure:",
      CONNECTOR_SETUP_REGISTRY.map((entry) => `${entry.label} (${entry.description})`)
    );
    if (!selected.length) {
      return {
        ok: false,
        section: "connectors",
        title: "Marketing data connectors",
        skipped: true,
        next: "Run `infinite setup connectors` when you are ready to connect marketing data."
      };
    }
    const configured = [];
    for (const index of selected) {
      const entry = CONNECTOR_SETUP_REGISTRY[index];
      if (!entry) {
        continue;
      }
      configured.push(await configureInteractiveConnector(entry, env));
    }
    return {
      ok: configured.every((entry) => entry.ok !== false),
      section: "connectors",
      configured,
      next: "Run `infinite setup query` or `infinite setup status` to review readiness."
    };
  }
  const readiness = await readSetupReadiness(env);
  const configuredProviders = await readConfiguredConnectorProviders(env);
  const configuredConnections = await readConfiguredConnectorConnections(env);
  return {
    ok: readiness.connectors === "connected",
    section: "connectors",
    title: "Marketing data connectors",
    configuredConnections,
    summary: connectorSummary(configuredConnections),
    providers: CONNECTOR_SETUP_REGISTRY.map((entry) => ({
      provider: entry.provider,
      label: entry.label,
      description: entry.description,
      docsUrl: entry.docsUrl,
      status: configuredProviders.has(entry.provider) ? "configured" : "not_configured",
      setup:
        entry.provider === "google_analytics_4"
          ? "infinite setup connectors google_analytics_4 --client-id <google_oauth_client_id>"
          : `${"infinite setup connectors"} ${entry.provider}`
    })),
    setupReadiness: readiness,
      next:
        readiness.connectors === "connected"
          ? "Connector readiness is satisfied."
          : "Connect at least one marketing data source before using `infinite` for GTM questions."
  };
}

function connectorSummary(
  configuredConnections: Array<{ provider: string; connectionName?: string; status?: string }>
): { configuredCount: number; degradedCount: number } {
  return {
    configuredCount: configuredConnections.length,
    degradedCount: configuredConnections.filter((connection) => connection.status === "degraded").length
  };
}

async function readConfiguredConnectorProviders(env: CliEnv): Promise<Set<string>> {
  const workspaceRoot = workspaceRootFor(env);
  let workspaceId: string;
  try {
    workspaceId = workspaceIdFor(env);
  } catch (error) {
    if (!(error instanceof NoActiveProjectError)) {
      throw error;
    }
    // EXEMPT (`setup connectors`) path: no active project means no configured
    // connectors yet — degrade to the empty default instead of throwing.
    return new Set<string>();
  }
  let config: InfiniteOsConfig | undefined;
  try {
    config = loadInfiniteOsConfig({ workspaceRoot, env: env as NodeJS.ProcessEnv });
  } catch {
    return new Set<string>();
  }

  try {
    const payload = await apiRequest("/sources", env, { config });
    return configuredProvidersFromPayload(payload);
  } catch {
    // Fall back to local DB when the app API is unavailable.
  }

  try {
    const db = createInfiniteOsDb(config.databaseUrl);
    try {
      const rows = await db.query<{ provider: string }>(
        "select provider from sources where workspace_id = $1 and status in ('connected', 'degraded')",
        [workspaceId]
      );
      return new Set(rows.map((row) => row.provider));
    } finally {
      await db.close();
    }
  } catch {
    return new Set<string>();
  }
}

function configuredProvidersFromPayload(payload: unknown): Set<string> {
  if (!isRecord(payload)) {
    return new Set<string>();
  }
  const data = isRecord(payload.data) ? dataFromPayload(payload.data) : dataFromPayload(payload);
  return new Set(
    data
      .filter((source) => source.status === "connected" || source.status === "degraded")
      .map((source) => source.provider)
      .filter((provider): provider is string => Boolean(provider))
  );
}

function dataFromPayload(payload: unknown): Array<{ provider?: string; status?: string }> {
  if (!isRecord(payload)) {
    return [];
  }
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  return sources
    .filter(isRecord)
    .map((source) => ({
      provider: stringValue(source.provider),
      status: stringValue(source.status)
    }));
}

async function readConfiguredConnectorConnections(
  env: CliEnv
): Promise<Array<{ provider: string; connectionName?: string; status?: string }>> {
  const workspaceRoot = workspaceRootFor(env);
  let workspaceId: string;
  try {
    workspaceId = workspaceIdFor(env);
  } catch (error) {
    if (!(error instanceof NoActiveProjectError)) {
      throw error;
    }
    // EXEMPT (`setup connectors`) path: no active project means no configured
    // connectors yet — degrade to the empty default instead of throwing.
    return [];
  }
  let config: InfiniteOsConfig | undefined;
  try {
    config = loadInfiniteOsConfig({ workspaceRoot, env: env as NodeJS.ProcessEnv });
  } catch {
    return [];
  }

  try {
    const payload = await apiRequest("/sources", env, { config });
    return configuredConnectionsFromPayload(payload);
  } catch {
    // Fall back to local DB when the app API is unavailable.
  }

  try {
    const db = createInfiniteOsDb(config.databaseUrl);
    try {
      const rows = await db.query<{ provider: string; connection_name: string; status: string }>(
        "select provider, connection_name, status from sources where workspace_id = $1 and status in ('connected', 'degraded') order by provider, connection_name",
        [workspaceId]
      );
      return rows.map((row) => ({
        provider: row.provider,
        connectionName: row.connection_name,
        status: row.status
      }));
    } finally {
      await db.close();
    }
  } catch {
    return [];
  }
}

function configuredConnectionsFromPayload(
  payload: unknown
): Array<{ provider: string; connectionName?: string; status?: string }> {
  if (!isRecord(payload)) {
    return [];
  }
  const data = isRecord(payload.data) ? payload.data : payload;
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const configuredConnections: Array<{ provider: string; connectionName?: string; status?: string }> = [];
  for (const source of sources) {
    if (!isRecord(source)) {
      continue;
    }
    const provider = stringValue(source.provider);
    if (!provider) {
      continue;
    }
    const status = stringValue(source.status);
    if (status !== "connected" && status !== "degraded") {
      continue;
    }
    configuredConnections.push({
      provider,
      connectionName: stringValue(source.connectionName) ?? stringValue(source.connection_name),
      status
    });
  }
  return configuredConnections;
}

async function configureInteractiveConnector(
  definition: ConnectorSetupDefinition,
  env: CliEnv
): Promise<Record<string, unknown>> {
  if (definition.oauth) {
    const connectionName = await promptFreeformValue("Connection name", definition.defaultConnectionName);
    const clientId = await promptFreeformValue(definition.fields[0]?.label ?? "Client ID");
    const propertyId = await promptFreeformValue("GA4 property ID (e.g. properties/123)");
    if (!clientId || !propertyId) {
      return connectorSetupNeedsInput(definition);
    }
    return setupOAuthConnector(
      definition,
      [
        "--client-id",
        clientId,
        "--property-id",
        propertyId,
        "--connection-name",
        connectionName ?? definition.defaultConnectionName
      ],
      env
    );
  }
  const connectionName = await promptFreeformValue("Connection name", definition.defaultConnectionName);
  const args = connectionName ? ["--connection-name", connectionName] : [];
  if (definition.provider === "meta_ads") {
    args.push(...metaAdsBackfillArgs(await promptMetaAdsBackfillOption()));
  }
  return setupTokenConnector(definition, args, env);
}

async function setupOAuthConnector(
  definition: ConnectorSetupDefinition,
  args: string[],
  env: CliEnv
): Promise<Record<string, unknown>> {
  const oauthResult = await connectorOAuthCommand([definition.provider, ...args], env);
  const sessionId =
    isRecord(oauthResult) && typeof oauthResult.sessionId === "string"
      ? oauthResult.sessionId
      : undefined;
  const propertyId = optionValue(args, "--property-id");
  if (!sessionId || !propertyId) {
    return {
      ...(isRecord(oauthResult) ? oauthResult : { ok: true }),
      section: "connectors",
      provider: definition.provider,
      label: definition.label,
      description: definition.description,
      docsUrl: definition.docsUrl
    };
  }
  const connectionName = optionValue(args, "--connection-name") ?? definition.defaultConnectionName;
  const exchangeResult = await connectorOAuthExchangeCommand(
    [
      sessionId,
      "--property-id",
      propertyId,
      "--connection-name",
      connectionName
    ],
    env
  );
  return {
    ...(isRecord(exchangeResult) ? exchangeResult : { ok: true }),
    section: "connectors",
    provider: definition.provider,
    label: definition.label,
    description: definition.description,
    docsUrl: definition.docsUrl,
    connectionName
  };
}

const PROVIDER_ALIASES: Record<string, string> = {
  meta: "meta_ads",
  "meta-ads": "meta_ads",
  facebook: "meta_ads",
  twitter: "x",
  ga4: "google_analytics_4",
  google: "google_analytics_4",
  google_analytics: "google_analytics_4",
  googleanalytics: "google_analytics_4",
  ga: "google_analytics_4"
};

export function connectorSetupDefinition(provider: string | undefined): ConnectorSetupDefinition | undefined {
  const lowered = provider?.toLowerCase() ?? "";
  const canonical = PROVIDER_ALIASES[lowered] ?? provider;
  return CONNECTOR_SETUP_REGISTRY.find((entry) => entry.provider === canonical);
}

// ── In-chat /connect wizard (#20) ────────────────────────────────────────────
// The TUI re-renders the connector field prompts itself (a masked Ink state
// machine) instead of the raw-mode `promptSecretValue` loop, then dispatches the
// already-supported non-interactive `connect <provider> <name> <json>` form. These
// pure, exportable helpers own the registry → descriptor mapping, the dispatch
// string, and the per-provider scope/where-to-find guidance copy; the TUI owns the
// render + raw-mode input. The secret NEVER touches these helpers as transcript or
// disk — it only enters the JSON arg `buildConnectDispatchLine` assembles, which is
// dispatched as a LEADING-SLASH line (routes to runCommand → POST /sources/connect,
// never the LLM chatRequest).

// Token providers that get the full in-chat masked field wizard this round.
// meta_ads joins via a system-user access token + a synthesised backfill-window
// choice step (see buildConnectSetupDescriptor); the in-chat path always uses the
// native marketing_api Graph transport (CLI/MCP transport stays terminal-only).
const IN_CHAT_CONNECT_TOKEN_PROVIDERS = new Set(["posthog", "stripe", "x", "meta_ads"]);
// Providers deferred to the terminal CLI for now (browser OAuth driver or
// backfill/transport sub-pickers the simple field loop can't drive in-chat).
const IN_CHAT_CONNECT_OAUTH_NOTE_PROVIDERS = new Set(["google_analytics_4"]);
const IN_CHAT_CONNECT_TERMINAL_ONLY_PROVIDERS = new Set(["shopify"]);

export interface ConnectWizardField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  guidance?: string;
  // A fixed pick-list (region step) rendered as a selection rather than free text.
  // Each option's `value` is the literal stored on the field; the wizard never
  // free-texts these.
  choices?: { value: string; label: string; description?: string }[];
}

export interface ConnectSetupDescriptor {
  provider: string;
  label: string;
  description: string;
  connectionName: string;
  docsUrl: string;
  fields: ConnectWizardField[];
}

// A line typed in chat that should NOT launch the field wizard: it either resolves
// to a deferred provider (show a note, no field loop, no LLM) or is unknown.
export type ConnectWizardDecision =
  | { kind: "wizard"; descriptor: ConnectSetupDescriptor }
  | { kind: "note"; text: string }
  | { kind: "none" };

// Per-provider, per-field guidance copy (scopes, where to find the id, masking
// reassurance). Keyed `provider:fieldKey`. Labels come from the registry; this is
// the human-facing help that replaces bare flag labels.
const CONNECT_FIELD_GUIDANCE: Record<string, string> = {
  "posthog:projectId":
    "The numeric project id from your PostHog URL — app.posthog.com/project/<THIS NUMBER>/… — or Settings → Project → General → \"Project ID\". Digits only (e.g. 12345).",
  "posthog:personalApiKey":
    "A Personal API key that starts with `phx_` (NOT the `phc_` project token). Create it at Settings → Personal API keys → \"Create personal API key\" with read scopes Query (`query:read`) and Project (`project:read`). Stays hidden in chat.",
  "posthog:apiHost":
    "Pick the cloud your PostHog account lives in. US → us.posthog.com, EU → eu.posthog.com. Choosing the wrong region returns 403s.",
  "stripe:secretKey":
    "Your Stripe secret key, starting `sk_live_` (or `sk_test_` for test mode), or a restricted key `rk_live_…`. Stripe Dashboard → Developers → API keys. Read access to Charges, Invoices, and Subscriptions is enough. Stays hidden in chat.",
  "x:bearerToken":
    "An X API v2 Bearer Token (App-only). X Developer Portal → your Project & App → Keys and tokens → \"Bearer Token\". Needs read access to the public-metrics/tweets endpoints. Stays hidden in chat.",
  "x:username":
    "The public @handle to track, e.g. `@infinite_os` (the leading @ is fine — it's stripped automatically).",
  "meta_ads:adAccountId":
    "Your Meta ad account ID, format `act_XXXXXXXXXX` (the `act_` prefix is fine — it's stripped automatically). Find it by running `meta ads adaccount list` and reading the `id` column, or in Meta Ads Manager's account dropdown.",
  "meta_ads:accessToken":
    "A Meta system-user access token. In Meta Business Suite → Settings → Users → System Users, click Add to create an Admin system user (e.g. \"Ads CLI\"), select it and Assign Assets to grant it the ad account you're connecting, add it as an App Admin under Meta for Developers → App Settings → Roles → Roles, then click Generate New Token, select your app, and grant the management scopes: business_management, ads_management, pages_show_list, pages_read_engagement, pages_manage_ads, catalog_management, read_insights. Click Generate Token and paste it here. Stays hidden in chat."
};

// The meta_ads backfill-window step (Option B): how far back to pull insights on
// first connect. Mirrors POSTHOG_REGION_CHOICES — a fixed pick-list whose `value`
// is the literal window the backfill queue understands (META_ADS_BACKFILL_OPTIONS).
// This is NOT a credential field; it's spliced into the dispatch line as a
// `--backfill-window` token, never into the credential JSON.
const META_ADS_BACKFILL_CHOICES: { value: string; label: string; description?: string }[] =
  META_ADS_BACKFILL_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description:
      option.value === DEFAULT_META_ADS_BACKFILL_OPTION.value ? "default" : undefined
  }));
// The synthesised wizard field key for the backfill window (NOT a registry field).
const META_ADS_BACKFILL_FIELD_KEY = "backfillWindow";

// The PostHog region step (BINDING REVISION): an explicit US/EU pick that sets
// apiHost, never a silent default-to-US free-text host (that 403'd the EU user).
const POSTHOG_REGION_CHOICES: { value: string; label: string; description?: string }[] = [
  { value: "us.posthog.com", label: "US (us.posthog.com)", description: "US cloud" },
  { value: "eu.posthog.com", label: "EU (eu.posthog.com)", description: "EU cloud" }
];

// Map a registry field to a wizard field, attaching guidance and (for the PostHog
// host) the region pick-list. Only fields the wizard actually prompts are mapped by
// the caller; this keeps the wizard as light as the gold-standard CLI flow.
function toConnectWizardField(provider: string, field: ConnectorFieldDefinition): ConnectWizardField {
  if (provider === "posthog" && field.key === "apiHost") {
    return {
      key: field.key,
      // Promote the optional host to a required region step (binding revision).
      label: "PostHog region",
      secret: false,
      required: true,
      guidance: CONNECT_FIELD_GUIDANCE["posthog:apiHost"],
      choices: POSTHOG_REGION_CHOICES
    };
  }
  return {
    key: field.key,
    label: field.label,
    secret: Boolean(field.secret),
    required: field.required,
    guidance: CONNECT_FIELD_GUIDANCE[`${provider}:${field.key}`]
  };
}

// Build the descriptor the TUI renders. Only token providers reach here (the
// dispatcher filters ga4/meta_ads/shopify to notes first). The wizard prompts the
// registry's REQUIRED fields (matching the terminal CLI) PLUS the deliberate
// PostHog region step. Pure + exportable for unit tests.
export function buildConnectSetupDescriptor(
  definition: ConnectorSetupDefinition
): ConnectSetupDescriptor {
  const fields: ConnectWizardField[] = [];
  for (const field of definition.fields) {
    if (definition.provider === "posthog" && field.key === "apiHost") {
      // Optional in the registry; promoted to the required region step.
      fields.push(toConnectWizardField(definition.provider, field));
      continue;
    }
    if (!field.required) {
      // Don't surface other optional fields — keep the wizard as light as the CLI.
      // (meta_ads cliCommand/mcpCommand/mcpToolName/apiVersion are dropped here, so
      // the in-chat path always lands on the native marketing_api transport.)
      continue;
    }
    fields.push(toConnectWizardField(definition.provider, field));
  }
  if (definition.provider === "meta_ads") {
    // Option B: ask how far back to backfill AFTER the credential fields, so the
    // masked token is collected first and the (non-secret) window pick is last
    // before the Connect/Cancel confirm. The chosen value is threaded into the
    // dispatch line by buildConnectDispatchLine (NOT into the credential JSON).
    fields.push({
      key: META_ADS_BACKFILL_FIELD_KEY,
      label: "Backfill window",
      secret: false,
      required: true,
      guidance:
        "How far back to pull Meta Ads insights on first connect. Larger windows take longer — you can always backfill more later.",
      choices: META_ADS_BACKFILL_CHOICES
    });
  }
  return {
    provider: definition.provider,
    label: definition.label,
    description: definition.description,
    connectionName: definition.defaultConnectionName,
    docsUrl: definition.docsUrl,
    fields
  };
}

// Decide what `/connect <line>` should do IN CHAT, before the operator gate or the
// LLM. Returns a `wizard` descriptor for the token providers, a one-line `note` for
// the deferred providers (ga4 → run `infinite setup`; meta_ads/shopify → run the
// terminal `infinite connect`), or `none` (unknown provider, inline JSON, or an
// oauth subcommand) so the existing routing handles it. Exported for tests.
export function decideConnectWizard(line: string): ConnectWizardDecision {
  const parts = (line.startsWith("/") ? line.slice(1) : line).trim().split(/\s+/);
  const [command, providerToken, ...rest] = parts;
  if (command !== "connect" || !providerToken) {
    return { kind: "none" };
  }
  // Power-user inline-JSON form (`/connect posthog {…}`) and the oauth subcommands
  // keep the existing non-interactive path — never the field wizard.
  if (["oauth", "oauth-status", "oauth-exchange"].includes(providerToken)) {
    return { kind: "none" };
  }
  if (rest.some((part) => part.trim().startsWith("{"))) {
    return { kind: "none" };
  }
  const definition = connectorSetupDefinition(providerToken);
  if (!definition) {
    return { kind: "none" };
  }
  if (IN_CHAT_CONNECT_OAUTH_NOTE_PROVIDERS.has(definition.provider)) {
    return {
      kind: "note",
      text: "GA4 quick-connect opens a browser — run `infinite setup` in your terminal to connect GA4."
    };
  }
  if (IN_CHAT_CONNECT_TERMINAL_ONLY_PROVIDERS.has(definition.provider)) {
    return {
      kind: "note",
      text: `Run \`infinite connect ${definition.provider}\` in your terminal for now.`
    };
  }
  if (!IN_CHAT_CONNECT_TOKEN_PROVIDERS.has(definition.provider)) {
    return { kind: "none" };
  }
  return { kind: "wizard", descriptor: buildConnectSetupDescriptor(definition) };
}

// Assemble the LEADING-SLASH non-interactive dispatch line the wizard re-submits on
// final confirm: `/connect <provider> <connectionName> <json>`. The leading slash is
// load-bearing — it routes runCommand → POST /sources/connect (never the LLM chat
// branch). `collected` is the wizard's in-memory field map; this is the ONLY place
// the secret leaves wizard state, and only into this dispatched line (never the
// transcript or input history). Exported for tests. `normalizeConnectorPayload`
// (now exported) drops empties and applies the per-field normalization (PostHog
// projectId→Number, apiHost via normalizePostHogApiHost, @handle stripping).
export function buildConnectDispatchLine(
  definition: ConnectorSetupDefinition,
  connectionName: string,
  collected: Record<string, string>
): string {
  // The meta_ads backfill window is NOT a credential — pull it out of the map
  // before normalizeConnectorPayload (so it never lands in the credential JSON) and
  // emit it as a pre-JSON `--backfill-window <value>` token. runCommand's connect
  // branch reads that token via metaAdsBackfillBody(connectionNameParts,…) and
  // stripBackfillFlags keeps it out of the connectionName — so the user's pick
  // actually drives queueMetaAdsBackfillForConnect (Option B), matching the
  // terminal/setup paths instead of silently defaulting to 30 days.
  const { [META_ADS_BACKFILL_FIELD_KEY]: backfillWindow, ...credentials } = collected;
  const payload = normalizeConnectorPayload(definition, credentials);
  const backfillToken =
    definition.provider === "meta_ads" && backfillWindow
      ? ` --backfill-window ${backfillWindow}`
      : "";
  return `/connect ${definition.provider} ${connectionName}${backfillToken} ${JSON.stringify(payload)}`;
}

export interface ExistingConnection {
  id: string;
  connectionName?: string;
  accountExternalId?: string;
  status?: string;
}

export type ConnectPickerAction = { kind: "reconnect"; sourceId: string } | { kind: "new" };

function formatConnectionLabel(connection: ExistingConnection): string {
  const name = connection.connectionName ?? "(unnamed)";
  const account = connection.accountExternalId ? ` · ${connection.accountExternalId}` : "";
  const status = connection.status ? ` [${connection.status}]` : "";
  return `Reconnect ${name}${account}${status}`;
}

export function buildConnectPicker(existing: ExistingConnection[]): {
  options: string[];
  actions: ConnectPickerAction[];
  defaultIndex: number;
} {
  const options = existing.map(formatConnectionLabel);
  options.push("➕ Connect a new account");
  const actions: ConnectPickerAction[] = existing.map((connection) => ({
    kind: "reconnect" as const,
    sourceId: connection.id
  }));
  actions.push({ kind: "new" });
  const brokenIndex = existing.findIndex(
    (connection) => connection.status !== undefined && connection.status !== "connected"
  );
  const defaultIndex = brokenIndex === -1 ? 0 : brokenIndex;
  return { options, actions, defaultIndex };
}

async function existingConnectionsForProvider(
  provider: string,
  env: CliEnv
): Promise<ExistingConnection[]> {
  try {
    const payload = await apiRequest("/sources", env);
    if (!isRecord(payload)) {
      return [];
    }
    const data = isRecord(payload.data) ? payload.data : payload;
    const sources = Array.isArray(data.sources) ? data.sources : [];
    const connections: ExistingConnection[] = [];
    for (const source of sources) {
      if (!isRecord(source)) {
        continue;
      }
      if (stringValue(source.provider) !== provider) {
        continue;
      }
      const id = stringValue(source.id);
      if (!id) {
        continue;
      }
      connections.push({
        id,
        connectionName: stringValue(source.connectionName) ?? stringValue(source.connection_name),
        accountExternalId:
          stringValue(source.accountExternalId) ?? stringValue(source.account_external_id),
        status: stringValue(source.status)
      });
    }
    return connections;
  } catch {
    return [];
  }
}

export async function connectProviderPicker(
  definition: ConnectorSetupDefinition,
  env: CliEnv,
  deps: {
    listExisting?: (provider: string, env: CliEnv) => Promise<ExistingConnection[]>;
    select?: (
      question: string,
      choices: string[],
      defaultIndex: number,
      description: string
    ) => Promise<number>;
    runNew?: (definition: ConnectorSetupDefinition, env: CliEnv) => Promise<Record<string, unknown>>;
    reconnect?: (sourceId: string, env: CliEnv) => Promise<unknown>;
  } = {}
): Promise<unknown> {
  const listExisting = deps.listExisting ?? existingConnectionsForProvider;
  const select =
    deps.select ?? ((question, choices, defaultIndex, description) =>
      promptChoice(question, choices, defaultIndex, { description }));
  const runNew = deps.runNew ?? configureInteractiveConnector;
  // FIX 3: the default `reconnect` collects a FRESH credential and submits it to
  // the reconnect route, so the server replaces the stored (possibly dead) token
  // and tests with the NEW one. The previous default POSTed an EMPTY body, which
  // re-authenticated with the stored old token — so "Reconnect <dead account>"
  // failed before the operator could ever supply a working credential.
  const reconnect =
    deps.reconnect ?? ((sourceId, reconnectEnv) => reconnectExistingConnector(definition, sourceId, reconnectEnv));

  const existing = await listExisting(definition.provider, env);
  if (existing.length === 0) {
    return runNew(definition, env);
  }
  const plan = buildConnectPicker(existing);
  const selected = await select(
    `Connect ${definition.label}`,
    plan.options,
    plan.defaultIndex,
    "Reconnect an existing account or connect a new one."
  );
  const action = plan.actions[selected];
  return action.kind === "new" ? runNew(definition, env) : reconnect(action.sourceId, env);
}

// Resolve the stored `credentialKind` for a connect/reconnect submission. Meta
// Ads varies by transport (mcp_stdio → mcp_server_command, meta_ads_cli →
// ads_cli); everything else uses the definition default. Shared by the new
// connect flow and the reconnect flow so they stay in lock-step.
function connectorCredentialKind(
  definition: ConnectorSetupDefinition,
  credentialPayload: Record<string, unknown>
): string {
  if (definition.provider === "meta_ads" && credentialPayload.transport === "mcp_stdio") {
    return "mcp_server_command";
  }
  if (definition.provider === "meta_ads" && credentialPayload.transport === "meta_ads_cli") {
    return "ads_cli";
  }
  return definition.credentialKind;
}

// FIX 3: reconnect an EXISTING source by collecting a NEW credential and handing
// it to the reconnect route, which revokes the stored credential, persists the
// new one, and ONLY THEN tests the connection — with the NEW token. We never POST
// an empty reconnect (the old broken behavior), so a dead stored token can no
// longer block the operator from entering a working one. OAuth providers re-run
// the browser OAuth flow (which already mints a fresh token) rather than this
// token-payload path.
export async function reconnectExistingConnector(
  definition: ConnectorSetupDefinition,
  sourceId: string,
  env: CliEnv,
  deps: {
    // Seam: collect the FRESH credential. Defaults to the interactive
    // flag/prompt resolver. Tests inject a deterministic payload without TTY.
    resolveCredential?: (
      definition: ConnectorSetupDefinition,
      args: string[],
      env: CliEnv
    ) => Promise<Record<string, unknown> | null>;
    // Seam: the OAuth re-auth path (GA4) that mints a brand-new token.
    runOAuth?: (definition: ConnectorSetupDefinition, env: CliEnv) => Promise<Record<string, unknown>>;
  } = {}
): Promise<Record<string, unknown>> {
  // OAuth providers (GA4) mint a brand-new token via the browser flow; defer to
  // the same `runNew` OAuth path, which always authenticates with the fresh
  // token. (The stored token is never consulted.)
  if (definition.oauth) {
    const runOAuth = deps.runOAuth ?? configureInteractiveConnector;
    return runOAuth(definition, env);
  }
  const resolveCredential = deps.resolveCredential ?? resolveConnectorCredentialPayload;
  const credentialPayload = await resolveCredential(definition, [], env);
  if (!credentialPayload) {
    return connectorSetupNeedsInput(definition);
  }
  const credentialKind = connectorCredentialKind(definition, credentialPayload);
  // The NEW credential goes in the reconnect body, so the server replaces the
  // stored token and tests with THIS one — it never pre-authenticates with the
  // old token. (This is the whole fix.)
  const response = await apiRequest(`/sources/${encodeURIComponent(sourceId)}/reconnect`, env, {
    method: "POST",
    operator: true,
    body: { credentialKind, credentialPayload }
  });
  return {
    ok: true,
    section: "connectors",
    provider: definition.provider,
    label: definition.label,
    description: definition.description,
    docsUrl: definition.docsUrl,
    reconnected: true,
    sourceId,
    result: response,
    next: "Reconnected. Run `infinite setup query` or `infinite` to continue."
  };
}

async function setupTokenConnector(
  definition: ConnectorSetupDefinition,
  args: string[],
  env: CliEnv
): Promise<Record<string, unknown>> {
  const connectionName = optionValue(args, "--connection-name") ?? definition.defaultConnectionName;
  const metaAdsBackfillOption =
    definition.provider === "meta_ads" ? resolveMetaAdsBackfillOption(args) : undefined;
  const credentialPayload = await resolveConnectorCredentialPayload(definition, args, env);
  if (!credentialPayload) {
    return connectorSetupNeedsInput(definition);
  }
  const credentialKind = connectorCredentialKind(definition, credentialPayload);
  const response = await apiRequest("/sources/connect", env, {
    method: "POST",
    operator: true,
    body: {
      provider: definition.provider,
      connectionName,
      credentialKind,
      credentialPayload
    }
  });
  const backfill =
    definition.provider === "meta_ads" && metaAdsBackfillOption
      ? await queueMetaAdsInitialBackfill(response, metaAdsBackfillOption, env)
      : undefined;
  const initialSync = initialSyncFromConnectResponse(response);
  return {
    ok: true,
    section: "connectors",
    provider: definition.provider,
    label: definition.label,
    description: definition.description,
    docsUrl: definition.docsUrl,
    connectionName,
    configuredFields: Object.keys(credentialPayload).filter(
      (key) =>
        key !== "mode" &&
        !definition.fields.find((field) => field.key === key && field.secret)
    ),
    result: response,
    ...(backfill ? { backfill } : {}),
    ...(initialSync ? { initialSync } : {}),
    next:
      backfill?.queued === true
        ? `Meta Ads ${backfill.windowLabel} backfill queued. Run \`infinite setup query\` or \`infinite\` to continue.`
        : initialSync?.queued === true
          ? "X timeline sync queued. Run `infinite setup query` or `infinite` to continue."
          : "Run `infinite setup query` or `infinite` to continue."
  };
}

function resolveMetaAdsBackfillOption(args: string[]): MetaAdsBackfillOption {
  const raw = optionValueAny(args, "--backfill-window", "--backfill", "--backfill-range");
  if (!raw) {
    return DEFAULT_META_ADS_BACKFILL_OPTION;
  }
  const option = metaAdsBackfillOption(raw);
  if (!option) {
    throw new Error(
      "meta_ads backfill window must be 7_days, 14_days, 30_days, 3_months, 6_months, 12_months, or all_time"
    );
  }
  return option;
}

function metaAdsBackfillOption(value: string): MetaAdsBackfillOption | undefined {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
  const aliases: Record<string, MetaAdsBackfillOption["value"]> = {
    "7": "7_days",
    "7d": "7_days",
    "7_day": "7_days",
    "7_days": "7_days",
    "14": "14_days",
    "14d": "14_days",
    "14_day": "14_days",
    "14_days": "14_days",
    "30": "30_days",
    "30d": "30_days",
    "30_day": "30_days",
    "30_days": "30_days",
    "3m": "3_months",
    "3_month": "3_months",
    "3_months": "3_months",
    "6m": "6_months",
    "6_month": "6_months",
    "6_months": "6_months",
    "12m": "12_months",
    "12_month": "12_months",
    "12_months": "12_months",
    "all": "all_time",
    "all_time": "all_time",
    "maximum": "all_time"
  };
  const canonical = aliases[normalized] ?? normalized;
  return META_ADS_BACKFILL_OPTIONS.find((option) => option.value === canonical);
}

function metaAdsBackfillArgs(option: MetaAdsBackfillOption): string[] {
  return ["--backfill-window", option.value];
}

async function promptMetaAdsBackfillOption(): Promise<MetaAdsBackfillOption> {
  const choice = await promptChoice(
    "Meta Ads backfill window:",
    META_ADS_BACKFILL_OPTIONS.map((option) => option.label),
    META_ADS_BACKFILL_OPTIONS.indexOf(DEFAULT_META_ADS_BACKFILL_OPTION),
    { description: META_ADS_BACKFILL_WARNING }
  );
  return META_ADS_BACKFILL_OPTIONS[choice] ?? DEFAULT_META_ADS_BACKFILL_OPTION;
}

async function queueMetaAdsInitialBackfill(
  connectResponse: unknown,
  option: MetaAdsBackfillOption,
  env: CliEnv
): Promise<Record<string, unknown>> {
  const sourceId = sourceIdFromConnectResponse(connectResponse);
  const payload = metaAdsBackfillPayload(option);
  if (!sourceId) {
    return {
      queued: false,
      reason: "source_id_missing",
      window: option.value,
      windowLabel: option.label,
      warning: META_ADS_BACKFILL_WARNING,
      payload
    };
  }
  try {
    const result = await apiRequest(`/sources/${encodeURIComponent(sourceId)}/sync`, env, {
      method: "POST",
      operator: true,
      body: payload
    });
    return {
      queued: true,
      sourceId,
      window: option.value,
      windowLabel: option.label,
      warning: META_ADS_BACKFILL_WARNING,
      progress: metaAdsBackfillProgress(0),
      payload,
      result
    };
  } catch (error) {
    return {
      queued: false,
      reason: "sync_request_failed",
      sourceId,
      window: option.value,
      windowLabel: option.label,
      warning: META_ADS_BACKFILL_WARNING,
      payload,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function metaAdsBackfillPayload(option: MetaAdsBackfillOption): Record<string, unknown> {
  return {
    mode: "backfill",
    backfillWindow: option.value,
    ...(option.refreshWindowDays === undefined ? {} : { refreshWindowDays: option.refreshWindowDays })
  };
}

function stripBackfillFlags(parts: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "--no-backfill") {
      continue;
    }
    if (
      part === "--backfill-window" ||
      part === "--backfill" ||
      part === "--backfill-range" ||
      part === "--days"
    ) {
      index += 1;
      continue;
    }
    if (
      part.startsWith("--backfill-window=") ||
      part.startsWith("--backfill=") ||
      part.startsWith("--backfill-range=") ||
      part.startsWith("--days=")
    ) {
      continue;
    }
    result.push(part);
  }
  return result;
}

function metaAdsBackfillBody(
  args: string[],
  options: { allowPositional?: boolean } = {}
): Record<string, unknown> {
  const days = optionValue(args, "--days");
  if (days !== undefined) {
    const parsed = Number(days);
    if (!/^\d+$/.test(days.trim()) || !Number.isInteger(parsed) || parsed <= 0 || parsed > 3650) {
      throw new Error(
        "backfill --days must be a positive integer between 1 and 3650 (use all_time for full history)"
      );
    }
    return { mode: "backfill", refreshWindowDays: parsed };
  }
  const positional = options.allowPositional
    ? args.find((arg) => !arg.startsWith("--"))
    : undefined;
  const raw = optionValueAny(args, "--backfill-window", "--backfill", "--backfill-range") ?? positional;
  if (!raw) {
    return metaAdsBackfillPayload(DEFAULT_META_ADS_BACKFILL_OPTION);
  }
  const option = metaAdsBackfillOption(raw);
  if (!option) {
    throw new Error(
      "meta_ads backfill window must be 7_days, 14_days, 30_days, 3_months, 6_months, 12_months, all_time, or use --days <n>"
    );
  }
  return metaAdsBackfillPayload(option);
}

async function queueMetaAdsBackfillForConnect(
  connectResponse: unknown,
  body: Record<string, unknown>,
  env: CliEnv
): Promise<Record<string, unknown>> {
  const sourceId = sourceIdFromConnectResponse(connectResponse);
  if (!sourceId) {
    return {
      queued: false,
      reason: "source_id_missing",
      payload: body,
      warning: META_ADS_BACKFILL_WARNING
    };
  }
  try {
    const result = await apiRequest(`/sources/${encodeURIComponent(sourceId)}/sync`, env, {
      method: "POST",
      operator: true,
      body
    });
    return {
      queued: true,
      sourceId,
      payload: body,
      progress: metaAdsBackfillProgress(0),
      warning: META_ADS_BACKFILL_WARNING,
      result
    };
  } catch (error) {
    return {
      queued: false,
      reason: "sync_request_failed",
      sourceId,
      payload: body,
      warning: META_ADS_BACKFILL_WARNING,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function metaAdsBackfillProgress(percent: number): Record<string, unknown> {
  return {
    percent,
    max: 100,
    bar: renderProgressBar(percent)
  };
}

const SYNC_PROVIDER_ALIASES: Record<string, string> = {
  meta: "meta_ads",
  meta_ads: "meta_ads",
  metaads: "meta_ads",
  facebook: "meta_ads",
  fb: "meta_ads",
  ga4: "google_analytics_4",
  ga: "google_analytics_4",
  google_analytics_4: "google_analytics_4",
  stripe: "stripe",
  posthog: "posthog",
  x: "x",
  twitter: "x",
  shopify: "shopify"
};

interface SyncSourceRow {
  id: string;
  provider: string;
  connectionName?: string;
  accountExternalId?: string;
}

const SYNC_WINDOW_CHOICES: ReadonlyArray<{ label: string; option: MetaAdsBackfillOption | null }> = [
  { label: "Since last sync (new data only)", option: null },
  ...META_ADS_BACKFILL_OPTIONS.map((option) => ({
    label: option.value === "all_time" ? "Re-pull all history" : `Re-pull last ${option.label}`,
    option
  }))
];

async function runSyncCommand(args: string[], env: CliEnv, options: RunCommandOptions = {}): Promise<unknown> {
  const positionals = syncPositionalArgs(args);
  const [rawTarget, rawWindow] = positionals;
  const windowToken = optionValue(args, "--window") ?? rawWindow;
  const interactive = shouldUseInteractivePrompts() && env.GROWTH_OS_CLI_NONINTERACTIVE !== "1";
  const shouldWaitForJobs = !hasFlag(args, "--no-wait") && (hasFlag(args, "--wait") || Boolean(options.onProgress));

  // Resolve any explicit window token first so bad input fails fast.
  const explicitOption = resolveSyncWindowToken(windowToken);

  let targetIds: string[];
  let option: MetaAdsBackfillOption | null;

  if (!rawTarget) {
    if (!interactive) {
      throw new Error(
        "sync requires a source id, provider (e.g. meta), or 'all'. Run `infinite sync` in a terminal to pick interactively."
      );
    }
    const picked = await runSyncWizard(await fetchSyncSources(env));
    targetIds = picked.ids;
    option = picked.option;
  } else if (isExplicitSourceId(rawTarget)) {
    // Explicit source id is the quick form: never prompt. No window = incremental.
    targetIds = [rawTarget];
    option = explicitOption ?? null;
  } else {
    const matches = resolveSyncTargets(await fetchSyncSources(env), rawTarget);
    if (!matches.length) {
      throw new Error(syncTargetNotFoundMessage(rawTarget));
    }
    targetIds = matches.map((source) => source.id);
    if (explicitOption !== undefined) {
      option = explicitOption;
    } else if (interactive) {
      option = await promptSyncWindow();
    } else {
      return syncWindowRequiredResult(rawTarget, matches);
    }
  }

  const body = option ? metaAdsSyncBody(option) : {};
  const synced: Array<Record<string, unknown>> = [];
  for (const sourceId of targetIds) {
    emitSyncProgress(options, `Queueing sync for ${sourceId}...`);
    const result = await apiRequest(`/sources/${encodeURIComponent(sourceId)}/sync`, env, {
      method: "POST",
      operator: true,
      body
    });
    if (!shouldWaitForJobs) {
      synced.push({ sourceId, result });
      continue;
    }
    synced.push(await waitForQueuedSyncJob(sourceId, result, env, options));
  }

  if (shouldWaitForJobs) {
    return {
      ok: synced.every((item) => stringValue(item.status) === "succeeded"),
      section: "sync",
      status: syncOverallStatus(synced),
      window: option ? option.value : "incremental",
      waited: true,
      synced
    };
  }

  if (synced.length === 1) {
    return synced[0].result;
  }
  return {
    ok: true,
    section: "sync",
    window: option ? option.value : "incremental",
    synced
  };
}

async function waitForQueuedSyncJob(
  sourceId: string,
  queuedResult: unknown,
  env: CliEnv,
  options: RunCommandOptions
): Promise<Record<string, unknown>> {
  const startedAt = syncNow(options);
  const job = syncJobFromQueuedResult(queuedResult);
  const jobId = stringValue(job?.id);
  if (!jobId) {
    emitSyncProgress(options, `Sync queued for ${sourceId}, but the API did not return a job id.`, "warn");
    return {
      sourceId,
      status: "queued",
      result: queuedResult,
      waitedMs: 0,
      warning: "missing_job_id"
    };
  }

  emitSyncProgress(options, `Sync queued for ${sourceId} as ${jobId}. Waiting for worker...`);
  const pollIntervalMs = options.syncPollIntervalMs ?? numberEnv(env.GROWTH_OS_SYNC_POLL_INTERVAL_MS, 1000);
  const timeoutMs = options.syncWaitTimeoutMs ?? numberEnv(env.GROWTH_OS_SYNC_WAIT_TIMEOUT_MS, 10 * 60 * 1000);
  const sleep = options.sleep ?? delay;
  let lastStatus = "";
  let lastJob: Record<string, unknown> | undefined = job;
  let lastSyncRun: Record<string, unknown> | null | undefined;

  for (;;) {
    const response = await apiRequest(`/jobs/${encodeURIComponent(jobId)}`, env);
    const data = isRecord(response) && isRecord(response.data) ? response.data : response;
    const currentJob = isRecord(data) && isRecord(data.job) ? data.job : undefined;
    const currentSyncRun = isRecord(data) && isRecord(data.syncRun) ? data.syncRun : null;
    lastJob = currentJob ?? lastJob;
    lastSyncRun = currentSyncRun;
    const status = stringValue(currentJob?.status) ?? "unknown";
    if (status !== lastStatus) {
      emitSyncProgress(options, syncProgressMessage(sourceId, jobId, status), status === "failed" ? "error" : "status");
      lastStatus = status;
    }
    if (status === "succeeded" || status === "failed" || status === "cancelled") {
      const waitedMs = syncNow(options) - startedAt;
      const loaded = syncRecordsLoaded(currentSyncRun);
      emitSyncProgress(
        options,
        status === "succeeded"
          ? `Sync completed for ${sourceId}${loaded === undefined ? "." : ` (${loaded} records loaded).`}`
          : `Sync ${status} for ${sourceId}.`,
        status === "succeeded" ? "info" : "error"
      );
      return {
        sourceId,
        status,
        result: queuedResult,
        job: currentJob ?? lastJob,
        syncRun: currentSyncRun,
        waitedMs
      };
    }
    const elapsedMs = syncNow(options) - startedAt;
    if (elapsedMs >= timeoutMs) {
      emitSyncProgress(options, `Sync still ${status} for ${sourceId} after ${Math.round(elapsedMs / 1000)}s.`, "warn");
      return {
        sourceId,
        status: "timed_out",
        result: queuedResult,
        job: lastJob,
        syncRun: lastSyncRun ?? null,
        waitedMs: elapsedMs,
        warning: "sync_wait_timeout"
      };
    }
    await sleep(pollIntervalMs);
  }
}

function syncJobFromQueuedResult(result: unknown): Record<string, unknown> | undefined {
  const data = isRecord(result) && isRecord(result.data) ? result.data : undefined;
  return data && isRecord(data.job) ? data.job : undefined;
}

function syncProgressMessage(sourceId: string, jobId: string, status: string): string {
  if (status === "queued") {
    return `Sync ${jobId} for ${sourceId} is queued.`;
  }
  if (status === "running") {
    return `Sync ${jobId} for ${sourceId} is running.`;
  }
  if (status === "succeeded") {
    return `Sync ${jobId} for ${sourceId} succeeded.`;
  }
  return `Sync ${jobId} for ${sourceId} is ${status}.`;
}

function emitSyncProgress(
  options: RunCommandOptions,
  message: string,
  kind: Extract<ChatProgressEvent, { type: "status.update" }>["kind"] = "status"
): void {
  options.onProgress?.({
    type: "status.update",
    stage: "status",
    kind,
    message,
    text: message
  });
}

function syncNow(options: RunCommandOptions): number {
  return options.now?.() ?? Date.now();
}

function syncRecordsLoaded(syncRun: unknown): number | undefined {
  if (!isRecord(syncRun)) {
    return undefined;
  }
  const value = syncRun.records_loaded ?? syncRun.recordsLoaded;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function syncOverallStatus(synced: Array<Record<string, unknown>>): string {
  const statuses = synced.map((item) => stringValue(item.status) ?? "queued");
  if (statuses.every((status) => status === "succeeded")) {
    return "succeeded";
  }
  if (statuses.some((status) => status === "failed" || status === "cancelled")) {
    return "failed";
  }
  if (statuses.some((status) => status === "timed_out")) {
    return "timed_out";
  }
  return "queued";
}

function syncWindowRequiredResult(target: string, sources: SyncSourceRow[]): Record<string, unknown> {
  return {
    ok: false,
    section: "sync_window_required",
    target,
    sourceCount: sources.length,
    choices: SYNC_WINDOW_CHOICES.map((choice) => {
      const value = choice.option?.value ?? "incremental";
      return {
        value,
        label: choice.label,
        slashCommand: `/sync ${target} ${value}`,
        cliCommand: `infinite sync ${target} ${value}`
      };
    })
  };
}

// undefined -> no window supplied (caller decides); null -> incremental; option -> re-pull that window.
function resolveSyncWindowToken(
  windowToken: string | undefined
): MetaAdsBackfillOption | null | undefined {
  if (windowToken === undefined) {
    return undefined;
  }
  const normalized = windowToken.trim().toLowerCase();
  if (normalized === "incremental" || normalized === "new" || normalized === "since_last_sync") {
    return null;
  }
  const option = metaAdsBackfillOption(windowToken);
  if (!option) {
    throw new Error(
      "sync window must be 7_days, 14_days, 30_days, 3_months, 6_months, 12_months, all_time, or incremental"
    );
  }
  return option;
}

function syncPositionalArgs(args: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--window") {
      index += 1; // skip the flag's value so it is not treated as the target
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

function syncTargetNotFoundMessage(target: string): string {
  const normalized = target.trim().toLowerCase().replace(/[-\s]/g, "_");
  const knownProvider = SYNC_PROVIDER_ALIASES[normalized];
  if (knownProvider) {
    return `No ${knownProvider} source is connected. Connect one with \`infinite connect\` or \`infinite setup connectors\`.`;
  }
  return `No connected source matches "${target}". Run \`infinite sources\` to list connected sources.`;
}

function isExplicitSourceId(target: string): boolean {
  return /^src_/i.test(target);
}

function resolveSyncTargets(sources: SyncSourceRow[], target: string): SyncSourceRow[] {
  if (target.trim().toLowerCase() === "all") {
    return sources;
  }
  const normalized = target.trim().toLowerCase().replace(/[-\s]/g, "_");
  const provider = SYNC_PROVIDER_ALIASES[normalized] ?? normalized;
  const byProvider = sources.filter((source) => source.provider.toLowerCase() === provider);
  if (byProvider.length) {
    return byProvider;
  }
  return sources.filter((source) => source.id === target);
}

async function fetchSyncSources(env: CliEnv): Promise<SyncSourceRow[]> {
  const response = await apiRequest("/sources", env);
  const data = isRecord(response) && isRecord(response.data) ? response.data : response;
  const rawSources = isRecord(data) && Array.isArray(data.sources) ? data.sources : [];
  return rawSources
    .filter(isRecord)
    .map((source) => ({
      id: stringValue(source.id) ?? "",
      provider: stringValue(source.provider) ?? "",
      connectionName: stringValue(source.connection_name) ?? stringValue(source.connectionName),
      accountExternalId: stringValue(source.account_external_id) ?? stringValue(source.accountExternalId)
    }))
    .filter((source) => source.id !== "");
}

async function runSyncWizard(
  sources: SyncSourceRow[]
): Promise<{ ids: string[]; option: MetaAdsBackfillOption | null }> {
  if (!sources.length) {
    throw new Error(
      "No connected sources to sync. Connect one first with `infinite connect` or `infinite setup connectors`."
    );
  }
  const sourceChoices = [...sources.map(syncSourceChoiceLabel), "All sources"];
  const sourceIndex = await promptChoice("Which source do you want to sync?", sourceChoices, 0);
  const targets = sourceIndex >= sources.length ? sources : [sources[sourceIndex]];
  const option = await promptSyncWindow();
  return { ids: targets.map((source) => source.id), option };
}

async function promptSyncWindow(): Promise<MetaAdsBackfillOption | null> {
  const labels = SYNC_WINDOW_CHOICES.map((choice) => choice.label);
  const index = await promptChoice("How far back should we sync?", labels, 0, {
    description:
      "\"Since last sync\" only adds new data. A window re-pulls that range to fill or correct history."
  });
  return SYNC_WINDOW_CHOICES[index]?.option ?? null;
}

function syncSourceChoiceLabel(source: SyncSourceRow): string {
  const name = source.connectionName ?? source.accountExternalId ?? source.id;
  return `${source.provider} — ${name}`;
}

function metaAdsSyncBody(option: MetaAdsBackfillOption): Record<string, unknown> {
  return {
    backfillWindow: option.value,
    ...(option.refreshWindowDays === undefined ? {} : { refreshWindowDays: option.refreshWindowDays })
  };
}

function sourceIdFromConnectResponse(response: unknown): string | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  const data = isRecord(response.data) ? response.data : response;
  const source = isRecord(data.source) ? data.source : data;
  return stringValue(source.id) ?? stringValue(source.sourceId);
}

function initialSyncFromConnectResponse(response: unknown): Record<string, unknown> | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  const data = isRecord(response.data) ? response.data : response;
  return isRecord(data.initialSync) ? data.initialSync : undefined;
}

function connectorSetupNeedsInput(definition: ConnectorSetupDefinition): Record<string, unknown> {
  return {
    ok: false,
    section: "connectors",
    provider: definition.provider,
    label: definition.label,
    description: definition.description,
    docsUrl: definition.docsUrl,
    error: {
      code: "growth_os_connector_setup_requires_input",
      message: `Provide the required ${definition.label} connector fields.`,
      examples: [
        connectorSetupExample(definition)
      ]
    }
  };
}

function connectorSetupExample(definition: ConnectorSetupDefinition): string {
  const parts = ["infinite", "setup", "connectors", definition.provider];
  for (const field of definition.fields) {
    const placeholderName = field.flag.replace(/^--/, "").replace(/-/g, "_");
    const placeholder = field.required ? `<${placeholderName}>` : `[<${placeholderName}>]`;
    parts.push(field.flag, placeholder);
  }
  if (definition.provider === "meta_ads") {
    parts.push("--backfill-window", "<7_days|14_days|30_days|3_months|6_months|12_months|all_time>");
  }
  return parts.join(" ");
}

async function resolveConnectorCredentialPayload(
  definition: ConnectorSetupDefinition,
  args: string[],
  env: CliEnv
): Promise<Record<string, unknown> | null> {
  const values = Object.fromEntries(
    definition.fields.map((field) => [field.key, optionValueAny(args, field.flag, ...(field.aliases ?? []))])
  ) as Record<string, string | undefined>;
  const missingRequired = definition.fields.filter((field) => {
    if (!field.required) return false;
    if (definition.provider === "meta_ads" && field.key === "accessToken" && (values.mcpCommand || values.cliCommand)) {
      return false;
    }
    return !values[field.key];
  });
  if (missingRequired.length === 0) {
    return normalizeConnectorPayload(definition, values);
  }
  if (definition.provider === "meta_ads" && values.adAccountId && (values.accessToken || values.mcpCommand || values.cliCommand)) {
    return normalizeConnectorPayload(definition, values);
  }
  if (env.GROWTH_OS_CLI_NONINTERACTIVE === "1" || input.isTTY !== true) {
    return null;
  }
  const prompted = { ...values };
  for (const field of missingRequired) {
    prompted[field.key] = field.secret
      ? await promptSecretValue(`${field.label}: `)
      : await promptFreeformValue(`${field.label}: `);
  }
  return normalizeConnectorPayload(definition, prompted);
}

async function promptFreeformValue(question: string, fallback?: string): Promise<string | undefined> {
  const rl = createInterface({ input, output });
  try {
    const prompt = fallback ? `${question} [${fallback}]: ` : question;
    const answer = (await rl.question(prompt)).trim();
    return answer || fallback || undefined;
  } finally {
    rl.close();
  }
}

async function promptSecretValue(question: string, fallback?: string): Promise<string | undefined> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) {
    return promptFreeformValue(question, fallback);
  }
  return await new Promise<string | undefined>((resolve) => {
    let value = "";
    const onData = (chunk: Buffer | string) => {
      const key = String(chunk);
      if (key === "\r" || key === "\n") {
        stdout.write("\n");
        stdin.off("data", onData);
        stdin.setRawMode?.(false);
        stdin.pause();
        resolve(value || fallback || undefined);
        return;
      }
      if (key === "\u0003") {
        stdout.write("\n");
        stdin.off("data", onData);
        stdin.setRawMode?.(false);
        stdin.pause();
        resolve(undefined);
        return;
      }
      if (key === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += key;
    };
    stdout.write(fallback ? `${question} [press Enter to keep current]: ` : question);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export function normalizeConnectorPayload(
  definition: ConnectorSetupDefinition,
  values: Record<string, string | undefined>
): Record<string, unknown> {
  const payload: Record<string, unknown> = { mode: "live" };
  if (definition.provider === "meta_ads") {
    payload.transport = values.mcpCommand ? "mcp_stdio" : values.cliCommand ? "meta_ads_cli" : "marketing_api";
  }
  for (const field of definition.fields) {
    const value = values[field.key];
    if (!value) {
      continue;
    }
    if (definition.provider === "posthog" && field.key === "apiHost") {
      const normalizedHost = normalizePostHogApiHost(value);
      if (normalizedHost) {
        payload[field.key] = normalizedHost;
      }
      continue;
    }
    payload[field.key] =
      definition.provider === "posthog" && field.key === "projectId"
        ? Number.isFinite(Number(value))
          ? Number(value)
          : value
        : field.key === "storeDomain"
          ? value.replace(/^https?:\/\//, "").replace(/\/$/, "")
          : field.key === "adAccountId"
            ? value.replace(/^act_/, "")
        : field.key === "username"
          ? value.replace(/^@/, "")
          : value;
  }
  return payload;
}

// Single source of truth for docker-stack secrets: the CLI-managed
// `.growth-os/.env`. docker-compose.yml ships no secret defaults (they are
// `${VAR:?…}`); compose interpolates `${VAR}` from the process env, so we feed
// these in here rather than maintaining a second repo-root `.env`. Keeps the CLI
// and the containers on identical keys/tokens/password.
function composeStackEnv(workspaceRoot: string): Record<string, string> {
  const envPath = join(workspaceRoot, ".growth-os", ".env");
  if (!existsSync(envPath)) {
    return {};
  }
  const parsed = parseDotEnv(readFileSync(envPath, "utf8"));
  const out: Record<string, string> = {};
  for (const key of ["GROWTH_OS_ENCRYPTION_KEY", "GROWTH_OS_OPERATOR_TOKEN", "GROWTH_OS_READ_TOKEN"]) {
    if (parsed[key]) {
      out[key] = parsed[key];
    }
  }
  // The compose postgres service + container DATABASE_URL are derived from these.
  // `.growth-os/.env` only allows the deployment-secret keys above, so parse the
  // postgres password/user/db out of the (host) DATABASE_URL already stored there.
  if (parsed.DATABASE_URL) {
    try {
      const url = new URL(parsed.DATABASE_URL);
      if (url.password) out.POSTGRES_PASSWORD = decodeURIComponent(url.password);
      if (url.username) out.POSTGRES_USER = decodeURIComponent(url.username);
      const db = url.pathname.replace(/^\//, "");
      if (db) out.POSTGRES_DB = db;
    } catch {
      // non-URL DATABASE_URL — compose falls back to its required-var error
    }
  }
  return out;
}

// `infinite start`/`up` and `infinite update` share the same "bring the stack
// up onto the current checkout" path: `docker compose up -d` (which recreates
// app/worker when GROWTH_OS_CODE_VERSION moved — see composeCodeVersion — and
// runs migrations), then optionally block until the app server answers. Factored
// out so `update` restarts identically to `start` instead of duplicating it.
async function runStartStack(args: string[], env: CliEnv): Promise<Record<string, unknown>> {
  let compose: Record<string, unknown>;
  try {
    compose = runComposeCommand(["up", "-d"], env);
  } catch (error) {
    const failure = localRuntimeComposeFailureResult(error, {
      action: "start",
      mode: "local_docker"
    });
    if (failure) {
      return failure;
    }
    throw error;
  }
  // app/worker recreation only ever comes from config drift, and the drift
  // we stamp on purpose is GROWTH_OS_CODE_VERSION — say so instead of
  // leaving a silent container bounce.
  const recreated = composeRecreatedServices(compose);
  if (recreated.length > 0) {
    errorOutput.write(`code changed since containers started — recreating ${recreated.join("/")}\n`);
  }
  // Dry-run (tests/CI) and explicit --no-wait keep the old fire-and-forget
  // behavior. Otherwise block until the app server actually answers, so
  // "start" finishing means the API is usable — not just that containers
  // were created (they still build for minutes before listening).
  if (env.GROWTH_OS_CLI_DRY_RUN === "1" || hasFlag(args, "--no-wait")) {
    return compose;
  }
  errorOutput.write(
    "Containers started. Waiting for the app server to finish building and listen on the API port (first boot can take a few minutes)…\n"
  );
  const readiness = await waitForAppReady(env, {
    onProgress: (message) => errorOutput.write(`${message}\n`)
  });
  const appBaseUrl = readiness.appUrl.replace(/\/health$/, "");
  if (readiness.ready) {
    errorOutput.write(`App server ready at ${appBaseUrl} after ${Math.round(readiness.waitedMs / 1000)}s.\n`);
  } else {
    errorOutput.write(
      `App server still not responding after ${Math.round(readiness.waitedMs / 1000)}s ` +
        `(last: ${readiness.lastError ?? "no response"}). It may still be building — ` +
        "check `infinite logs app`, then retry.\n"
    );
  }
  return {
    ...(compose as Record<string, unknown>),
    ready: readiness.ready,
    appUrl: appBaseUrl,
    waitedMs: readiness.waitedMs,
    ...(readiness.ready ? {} : { warning: "app_not_ready_yet", lastError: readiness.lastError ?? null })
  };
}

// Read a checkout's current commit via the same spawnSync+git approach as
// composeCodeVersion. Returns undefined outside a git checkout (or git
// unavailable), which is how `update` decides it can't self-update.
function gitHeadSha(workspaceRoot: string): string | undefined {
  const head = spawnSync("git", ["-C", workspaceRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (head.error || head.status !== 0) {
    return undefined;
  }
  const sha = head.stdout.trim();
  return sha || undefined;
}

// The current branch name (e.g. "main"), or undefined when detached/outside git.
function gitCurrentBranch(workspaceRoot: string): string | undefined {
  const branch = spawnSync("git", ["-C", workspaceRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (branch.error || branch.status !== 0) {
    return undefined;
  }
  const name = branch.stdout.trim();
  return name && name !== "HEAD" ? name : undefined;
}

// True when the working tree has staged or unstaged changes (tracked or
// untracked). Mirrors install.sh's `git status --porcelain` gate. Undefined
// return is treated by callers as "can't tell" (skip the destructive path).
function gitWorkingTreeDirty(workspaceRoot: string): boolean | undefined {
  const status = spawnSync("git", ["-C", workspaceRoot, "status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024
  });
  if (status.error || status.status !== 0) {
    return undefined;
  }
  return status.stdout.trim() !== "";
}

// `infinite update` — the in-place counterpart to the install script's
// clean-tree/ff-pull update (scripts/install.sh): pull the latest code on the
// current branch, then bring the stack up onto it via the same path as
// `infinite start`. Safety mirrors install.sh exactly: never touch a dirty
// tree, never force, never throw on divergence. All git goes through spawnSync;
// no network library is used (fetch/pull reach origin via the configured remote).
async function runUpdateCommand(args: string[], env: CliEnv): Promise<Record<string, unknown>> {
  const workspaceRoot = workspaceRootFor(env);
  const previousHead = gitHeadSha(workspaceRoot);
  // Not a git checkout (or git unavailable) — nothing to pull. The install-script
  // route is the only supported update path here; do nothing destructive.
  if (!previousHead) {
    return {
      ok: false,
      command: "update",
      workspaceRoot,
      updated: false,
      reason: "not_a_git_install",
      message:
        "This isn't a git install, so `infinite update` can't pull new code. Reinstall via the install script to update."
    };
  }
  const branch = gitCurrentBranch(workspaceRoot);
  const dirty = gitWorkingTreeDirty(workspaceRoot);
  // Dirty tree → skip the pull entirely (do NOT stash/discard). Same stance as
  // install.sh: leave local changes as-is and tell the operator to deal with them.
  if (dirty !== false) {
    return {
      ok: true,
      command: "update",
      workspaceRoot,
      branch: branch ?? null,
      previousHead,
      newHead: previousHead,
      pulled: false,
      codeChanged: false,
      updated: false,
      reason: dirty === undefined ? "git_status_unavailable" : "working_tree_dirty",
      warning:
        dirty === undefined
          ? "Couldn't read git status, so the update was skipped. Resolve the git issue, then retry."
          : "Local changes detected — skipping update so they aren't disturbed. Commit or stash them, then retry `infinite update`.",
      note: "The CLI itself refreshes on the next `infinite` launch (the wrapper rebuilds when the source is stale)."
    };
  }
  // Clean tree → fetch, then fast-forward-only pull on the current branch.
  // A failed pull (divergence, no upstream, offline) is a friendly warning, not
  // a throw — exactly like install.sh's non-fatal `pull --ff-only` branch.
  const fetch = spawnSync("git", ["-C", workspaceRoot, "fetch", "origin"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const pullArgs = branch
    ? ["-C", workspaceRoot, "pull", "--ff-only", "origin", branch]
    : ["-C", workspaceRoot, "pull", "--ff-only"];
  const pull = spawnSync("git", pullArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const pulled = !pull.error && pull.status === 0;
  const newHead = gitHeadSha(workspaceRoot) ?? previousHead;
  const codeChanged = newHead !== previousHead;
  if (!pulled) {
    const detail = (pull.stderr || fetch.stderr || "").trim().split(/\r?\n/).filter(Boolean).pop();
    return {
      ok: true,
      command: "update",
      workspaceRoot,
      branch: branch ?? null,
      previousHead,
      newHead,
      pulled: false,
      codeChanged,
      updated: false,
      reason: "pull_failed",
      warning:
        "Couldn't fast-forward this branch (divergence, no upstream, or no network) — leaving the checkout as-is. " +
        "Resolve it, then retry `infinite update`." + (detail ? ` (${detail})` : ""),
      note: "The CLI itself refreshes on the next `infinite` launch (the wrapper rebuilds when the source is stale)."
    };
  }
  // Pull succeeded (possibly a no-op already-up-to-date) — bring the stack up
  // onto the (possibly new) commit via the same path as `infinite start`. This
  // recreates app/worker when the code moved and runs migrations.
  const start = await runStartStack(args, env);
  return {
    ok: true,
    command: "update",
    workspaceRoot,
    branch: branch ?? null,
    previousHead,
    newHead,
    pulled: true,
    codeChanged,
    updated: codeChanged,
    start,
    note: "The CLI itself refreshes on the next `infinite` launch (the wrapper rebuilds when the source is stale)."
  };
}

// ── Once-per-day, offline-safe "update available" notice ─────────────────────
// This is a self-hosted, offline-first product, so the notice must NEVER delay
// a command, NEVER fail when there's no network, and NEVER nag: at most one
// bounded network probe (`git ls-remote`) per 24h, served from cache between
// checks. It writes only to stderr (so it can't corrupt --json/piped stdout)
// and is a complete no-op when offline / not a git repo / cache fresh / already
// up to date. All git goes through spawnSync; no network library is used.
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // ≤ one network check per day
const UPDATE_LS_REMOTE_TIMEOUT_MS = 2500; // bounded; a hung/slow remote never blocks the user

interface UpdateCheckCache {
  lastCheckTs: number;
  remoteSha?: string;
}

interface MaybeNotifyUpdateOptions {
  command?: string;
  args?: string[];
  // Test seams: inject the stderr stream, the clock, and the cache path so the
  // throttle/cache/no-network branches are deterministic.
  stderrStream?: { write(chunk: string): unknown };
  now?: () => number;
  cachePath?: string;
}

// ~/.infinite (or under GROWTH_OS_HOME when set) — the per-user state dir.
function infiniteHomeDir(env: CliEnv): string {
  return env.GROWTH_OS_HOME ? resolve(env.GROWTH_OS_HOME) : join(homedir(), ".infinite");
}

// ~/.infinite/update-check.json (or under GROWTH_OS_HOME when set).
function updateCheckCachePath(env: CliEnv): string {
  return join(infiniteHomeDir(env), "update-check.json");
}

// ~/.infinite/welcome-seen — written once the first-run welcome is dismissed.
function welcomeSeenPath(env: CliEnv): string {
  return join(infiniteHomeDir(env), "welcome-seen");
}

// Show the big-INFINITE welcome on first interactive launch only. `INFINITE_FORCE_WELCOME`
// replays it (for previewing); `INFINITE_NO_ANIMATION` skips the splash entirely.
function shouldShowInfiniteWelcome(env: CliEnv): boolean {
  const flags = env as NodeJS.ProcessEnv;
  if (flags.INFINITE_FORCE_WELCOME === "1" || flags.INFINITE_FORCE_WELCOME === "true") {
    return true;
  }
  if (flags.INFINITE_NO_ANIMATION === "1" || flags.INFINITE_NO_ANIMATION === "true") {
    return false;
  }
  try {
    return !existsSync(welcomeSeenPath(env));
  } catch {
    return false;
  }
}

function recordInfiniteWelcomeSeen(env: CliEnv): void {
  try {
    const path = welcomeSeenPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "seen\n");
  } catch {
    // Best-effort: a marker we can't persist just means the welcome may replay.
  }
}

function readUpdateCheckCache(cachePath: string): UpdateCheckCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<UpdateCheckCache>;
    if (typeof parsed.lastCheckTs !== "number" || !Number.isFinite(parsed.lastCheckTs)) {
      return undefined;
    }
    return {
      lastCheckTs: parsed.lastCheckTs,
      remoteSha: typeof parsed.remoteSha === "string" ? parsed.remoteSha : undefined
    };
  } catch {
    // Missing or corrupt cache → treat as empty (forces a check next time).
    return undefined;
  }
}

function writeUpdateCheckCache(cachePath: string, cache: UpdateCheckCache): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(cache)}\n`);
  } catch {
    // A failed cache write must never surface — the notice is best-effort.
  }
}

// Bounded, object-free remote tip lookup: `git ls-remote origin <branch>` reads
// just the ref's SHA without fetching objects, with a hard timeout so a slow or
// unreachable remote can't block the user. Returns undefined on ANY error.
function gitRemoteTipSha(workspaceRoot: string, branch: string): string | undefined {
  const result = spawnSync("git", ["-C", workspaceRoot, "ls-remote", "origin", branch], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: UPDATE_LS_REMOTE_TIMEOUT_MS
  });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  const sha = result.stdout.trim().split(/\s+/)[0];
  return sha && /^[0-9a-f]{7,40}$/.test(sha) ? sha : undefined;
}

export function maybeNotifyUpdateAvailable(env: CliEnv, options: MaybeNotifyUpdateOptions = {}): void {
  try {
    const command = options.command;
    // Suppressed for `update` (redundant) and any --json invocation (keep
    // machine output clean). Non-interactive batch runs also opt out.
    if (command === "update") {
      return;
    }
    if (options.args && hasFlag(options.args, "--json")) {
      return;
    }
    if (env.GROWTH_OS_CLI_NONINTERACTIVE === "1") {
      return;
    }
    const workspaceRoot = workspaceRootFor(env);
    const branch = gitCurrentBranch(workspaceRoot);
    const localHead = gitHeadSha(workspaceRoot);
    // Not a git checkout / detached HEAD → nothing to compare against. No-op.
    if (!branch || !localHead) {
      return;
    }
    const now = options.now ?? Date.now;
    const cachePath = options.cachePath ?? updateCheckCachePath(env);
    const cache = readUpdateCheckCache(cachePath);
    const nowTs = now();
    const stale = !cache || nowTs - cache.lastCheckTs > UPDATE_CHECK_INTERVAL_MS;
    let remoteSha = cache?.remoteSha;
    if (stale) {
      // The one bounded network probe. On ANY failure (offline/timeout/non-zero)
      // we still advance lastCheckTs so we don't retry every invocation — the
      // whole point of the ≤once/24h throttle. We keep the previously cached
      // remoteSha (if any) so an offline run can still serve a known-behind notice.
      const probed = gitRemoteTipSha(workspaceRoot, branch);
      if (probed) {
        remoteSha = probed;
      }
      writeUpdateCheckCache(cachePath, { lastCheckTs: nowTs, remoteSha });
    }
    // Only notify when we have a remote SHA that differs from local HEAD AND the
    // working tree is clean (avoids dev false-positives from local edits). A dev
    // ahead of origin on a clean tree may rarely see it — acceptable.
    if (!remoteSha || remoteSha === localHead) {
      return;
    }
    if (gitWorkingTreeDirty(workspaceRoot) !== false) {
      return;
    }
    const stream = options.stderrStream ?? errorOutput;
    stream.write(
      `⬆ Update available — run \`infinite update\` (${localHead.slice(0, 7)} → ${remoteSha.slice(0, 7)}).\n`
    );
  } catch {
    // The notice is strictly best-effort: it must never throw, delay, or block a
    // command. Any unexpected failure is swallowed.
  }
}

// The app/worker containers run long-lived node processes over a bind mount of
// this checkout (docker-compose.yml), so when `docker compose up -d` is a config
// no-op they keep executing whatever code was loaded at process start — a
// `git pull` never reaches a running container. We stamp the checkout's code
// identity into app/worker's compose `environment:` (GROWTH_OS_CODE_VERSION);
// compose treats a changed value as config drift and recreates exactly those
// services, while an unchanged value keeps `up -d` a no-op. A dirty tree hashes
// the diff so successive local edits each count as new code (a bare `-dirty`
// suffix would only trigger one recreate per base commit). Outside a git
// checkout (or with git unavailable) this degrades to the compose default
// "dev": never a recreate trigger, never an error.
// The product version, read from this package's package.json (single source of
// truth). `../package.json` resolves correctly from both the compiled entry
// (apps/cli/dist/index.js) and the tsx source entry (apps/cli/src/index.ts).
// Report the ROOT runtime version (package.json `name: "infinite-os-runtime"`),
// which is the canonical version bumped by hand per release (AGENTS.md →
// "Versioning & releases"). The previous impl read apps/cli/package.json, which
// is NOT bumped — so the banner / `infinite version` showed a stale number
// (e.g. 0.1.0) even after the runtime moved, which read as "the update didn't
// land". Walk UP from this module to the nearest package.json named
// "infinite-os-runtime"; fall back to the nearest package.json version, then
// "0.0.0", so a relocated/packaged build still degrades gracefully.
export function cliVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    let nearest: string | undefined;
    for (let depth = 0; depth < 8; depth += 1) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
        const version = typeof pkg.version === "string" && pkg.version ? pkg.version : undefined;
        if (pkg.name === "infinite-os-runtime" && version) {
          return version;
        }
        nearest ??= version;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return nearest ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// `infinite version` — product name + version + the short commit it's running.
// The commit reuses composeCodeVersion (git HEAD, with a -dirty marker when the
// tracked tree differs); outside a git checkout it degrades to "dev".
function versionText(env: CliEnv): string {
  const version = cliVersion();
  const code = env.GROWTH_OS_CODE_VERSION ?? composeCodeVersion(workspaceRootFor(env));
  if (!code || code === "dev") {
    return `Infinite OS ${version}`;
  }
  const [sha, dirty] = code.split("-dirty.");
  const short = sha.slice(0, 7);
  return `Infinite OS ${version} (${short}${dirty ? "-dirty" : ""})`;
}

export function composeCodeVersion(workspaceRoot: string): string {
  const head = spawnSync("git", ["-C", workspaceRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (head.error || head.status !== 0) {
    return "dev";
  }
  const sha = head.stdout.trim();
  if (!sha) {
    return "dev";
  }
  // Staged + unstaged tracked changes vs HEAD. Untracked files are ignored on
  // purpose: a running container never loaded them either, and anything that
  // imports them is itself a tracked edit.
  const diff = spawnSync("git", ["-C", workspaceRoot, "diff", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024
  });
  if (diff.error || diff.status !== 0 || diff.stdout.trim() === "") {
    return sha;
  }
  return `${sha}-dirty.${createHash("sha256").update(diff.stdout).digest("hex").slice(0, 12)}`;
}

// `docker compose up -d` recreates a service when its rendered config changed;
// with GROWTH_OS_CODE_VERSION stamped into app/worker that means "the code
// moved since these containers started". Compose reports it as
// " Container growth-os-app-1  Recreated" — surface the affected services so
// `infinite start` visibly explains why the containers bounced.
const COMPOSE_STACK_SERVICES = ["app", "worker", "migrate", "postgres"] as const;

function composeRecreatedServices(compose: Record<string, unknown>): string[] {
  const text = [compose.stdout, compose.stderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const recreated = new Set<string>();
  const pattern = /Container\s+\S*-(app|worker|migrate|postgres)-\d+\s+Recreate/g;
  for (const match of text.matchAll(pattern)) {
    recreated.add(match[1]);
  }
  return COMPOSE_STACK_SERVICES.filter((service) => recreated.has(service));
}

class ComposeCommandError extends Error {
  readonly command: string[];
  readonly cwd: string;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: {
    command: string[];
    cwd: string;
    status: number | null;
    stdout: string;
    stderr: string;
  }) {
    super(input.stderr || input.stdout || `docker compose exited with status ${String(input.status)}`);
    this.name = "ComposeCommandError";
    this.command = input.command;
    this.cwd = input.cwd;
    this.status = input.status;
    this.stdout = input.stdout;
    this.stderr = input.stderr;
  }
}

function localRuntimeComposeFailureResult(
  error: unknown,
  input: {
    action: "setup" | "start";
    mode: "local_docker";
    configPath?: string;
    envPath?: string;
    databaseUrl?: string;
  }
): Record<string, unknown> | undefined {
  if (!(error instanceof ComposeCommandError) || !isComposeManagedMigrationFailure(error)) {
    return undefined;
  }
  const detail = composeCommandConciseDetail(error);
  return {
    ok: false,
    section: "runtime",
    runtime: {
      action: input.action,
      mode: input.mode,
      workspaceRoot: error.cwd,
      ...(input.configPath ? { configPath: input.configPath } : {}),
      ...(input.envPath ? { envPath: input.envPath } : {}),
      ...(input.databaseUrl ? { databaseUrl: input.databaseUrl } : {}),
      start: {
        ok: false,
        command: error.command,
        status: error.status
      },
      migrations: {
        ok: false,
        failed: true,
        mode: "compose_managed",
        logsCommand: "infinite logs migrate"
      }
    },
    error: {
      code: "growth_os_local_workspace_migration_failed",
      message: "We couldn't start the local workspace because the database migration step failed.",
      detail,
      logsCommand: "infinite logs migrate"
    },
    next: "Run `infinite logs migrate`, fix the migration error, then retry `infinite setup` or `infinite start`."
  };
}

function isComposeManagedMigrationFailure(error: ComposeCommandError): boolean {
  const combined = `${error.stderr}\n${error.stdout}`.toLowerCase();
  return (
    combined.includes("service \"migrate\" didn't complete successfully") ||
    combined.includes("service 'migrate' didn't complete successfully") ||
    (combined.includes("migrate") && combined.includes("didn't complete successfully"))
  );
}

function composeCommandConciseDetail(error: ComposeCommandError): string | undefined {
  const lines = `${error.stderr}\n${error.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((line) => /service ["']?migrate["']? didn't complete successfully/i.test(line)) ??
    lines[0]
  );
}

function runComposeCommand(composeArgs: string[], env: CliEnv): Record<string, unknown> {
  const workspaceRoot = workspaceRootFor(env);
  const dockerBin = env.GROWTH_OS_DOCKER_BIN ?? "docker";
  const projectArgs = env.GROWTH_OS_COMPOSE_PROJECT ? ["-p", env.GROWTH_OS_COMPOSE_PROJECT] : [];
  const command = [dockerBin, "compose", ...projectArgs, ...composeArgs];
  const stackEnv = composeStackEnv(workspaceRoot);
  // Code identity for the app/worker services (see composeCodeVersion): a value
  // that moved since the containers were created makes `up -d` recreate them
  // onto the current bind-mounted code. An explicit env override wins so ops
  // can pin or force a version.
  const codeVersion = env.GROWTH_OS_CODE_VERSION ?? composeCodeVersion(workspaceRoot);
  if (env.GROWTH_OS_CLI_DRY_RUN === "1") {
    return {
      ok: true,
      cwd: workspaceRoot,
      command,
      composeEnvKeys: Object.keys(stackEnv),
      codeVersion
    };
  }

  const result = spawnSync(dockerBin, ["compose", ...projectArgs, ...composeArgs], {
    cwd: workspaceRoot,
    // `.growth-os/.env` secrets win over the ambient env so the file is authoritative for the stack.
    env: { ...process.env, ...env, ...stackEnv, GROWTH_OS_CODE_VERSION: codeVersion, PWD: workspaceRoot },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) {
    throw result.error;
  }
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (result.status !== 0) {
    throw new ComposeCommandError({
      command,
      cwd: workspaceRoot,
      status: result.status ?? null,
      stdout,
      stderr
    });
  }
  return {
    ok: true,
    cwd: workspaceRoot,
    command,
    stdout,
    stderr,
    status: result.status
  };
}

interface WaitForAppReadyOptions {
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

interface AppReadyResult {
  ready: boolean;
  appUrl: string;
  attempts: number;
  waitedMs: number;
  lastError?: string;
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Poll the app server's /health endpoint until it responds or we time out.
// Used by `infinite start` so the command only returns once the API is
// actually usable. `fetchImpl`/`now`/`sleep` are injectable for tests.
export async function waitForAppReady(env: CliEnv, options: WaitForAppReadyOptions = {}): Promise<AppReadyResult> {
  // Use the injected fetch (if any) for discovery too, so a test can drive the whole
  // ladder; production passes nothing and resolveDaemonEndpoint uses global fetch.
  const baseUrl = await resolveApiBaseUrlOnce(env, undefined, options.fetchImpl);
  const appUrl = `${baseUrl}/health`;
  // SECURITY (§10 LOW): the URL can carry userinfo (a user:pass@host
  // GROWTH_OS_API_URL). Redact it before it enters appUrl-in-message, onProgress,
  // lastError, or the returned JSON — nothing secret-bearing reaches a transcript.
  const safeAppUrl = redactUrlUserinfo(appUrl);
  const timeoutMs = options.timeoutMs ?? parsePositiveIntEnv(env.GROWTH_OS_START_TIMEOUT_MS, 300_000);
  const intervalMs = options.intervalMs ?? parsePositiveIntEnv(env.GROWTH_OS_START_POLL_INTERVAL_MS, 3_000);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const fetchImpl = options.fetchImpl ?? fetch;
  const start = now();
  let attempts = 0;
  let lastError: string | undefined;

  for (;;) {
    attempts += 1;
    try {
      const response = await fetchImpl(appUrl, { method: "GET" });
      if (response.ok) {
        // Identity assertion (design §3 / spec item 2): a 200 from a FOREIGN server
        // (e.g. a squatting `next dev` on the config port) must NOT count as ready.
        // Require the body to be the Infinite OS daemon (service === "growth-os-app")
        // before declaring ready, instead of trusting bare response.ok.
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = undefined;
        }
        if (isRecord(body) && body.service === "growth-os-app") {
          return { ready: true, appUrl: safeAppUrl, attempts, waitedMs: now() - start };
        }
        // A 200 that isn't our daemon — keep polling (the real daemon may still be
        // coming up on this address); never echo the foreign body into lastError.
        lastError = "foreign /health response (service mismatch)";
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message || String(error) : String(error);
    }

    const elapsed = now() - start;
    if (elapsed >= timeoutMs) {
      return { ready: false, appUrl: safeAppUrl, attempts, waitedMs: elapsed, lastError };
    }
    options.onProgress?.(
      `Waiting for the app server at ${safeAppUrl} — still booting ` +
        `(${Math.round(elapsed / 1000)}s elapsed; last: ${lastError ?? "no response"})`
    );
    await sleep(intervalMs);
  }
}

function savedReportCommand(args: string[], env: CliEnv): Promise<unknown> {
  const [subcommand, reportIdOrName, ...rest] = args;
  if (subcommand === "create") {
    return apiRequest("/tools/call", env, {
      method: "POST",
      operator: true,
      body: {
        actionId: "create_saved_report",
        input: {
          name: reportIdOrName ?? "Saved Infinite OS report",
          toolPlan: parseJsonInput(rest.join(" "))
        }
      }
    });
  }
  if (subcommand === "run") {
    if (!reportIdOrName) throw new Error("saved-report run requires a report id");
    return apiRequest("/tools/call", env, {
      method: "POST",
      operator: true,
      body: { actionId: "run_saved_report", input: { reportId: reportIdOrName } }
    });
  }
  if (subcommand === "export") {
    if (!reportIdOrName) throw new Error("saved-report export requires a report id");
    return apiRequest("/tools/call", env, {
      method: "POST",
      operator: true,
      body: {
        actionId: "export_saved_report",
        input: { reportId: reportIdOrName, format: rest[0] ?? "json" }
      }
    });
  }
  throw new Error("saved-report requires create, run, or export");
}

function parseJsonInput(value: string): unknown {
  if (!value.trim()) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON input: ${message}`);
  }
}

function credentialKindForProvider(provider: string): string {
  if (provider === "google_analytics_4") return "oauth_access_token";
  if (provider === "posthog") return "personal_api_key";
  if (provider === "x") return "bearer_token";
  if (provider === "stripe") return "api_key";
  if (provider === "shopify") return "admin_api_access_token";
  if (provider === "meta_ads") return "marketing_api_access_token";
  return "fixture";
}

function connectorOAuthCommand(args: string[], env: CliEnv): Promise<unknown> {
  const [provider, ...rest] = args;
  if (!provider) {
    throw new Error("connect oauth requires a provider");
  }
  const clientId = optionValue(rest, "--client-id");
  if (!clientId) {
    throw new Error("connect oauth requires --client-id");
  }
  return apiRequest("/oauth/sessions", env, {
    method: "POST",
    operator: true,
    body: {
      provider,
      clientId,
      redirectUri: optionValue(rest, "--redirect-uri"),
      authorizationBaseUrl: optionValue(rest, "--authorization-base-url"),
      scope: optionValue(rest, "--scope")
    }
  });
}

function connectorOAuthStatusCommand(args: string[], env: CliEnv): Promise<unknown> {
  const [sessionId] = args;
  if (!sessionId) {
    throw new Error("connect oauth-status requires a session id");
  }
  return apiRequest(`/oauth/sessions/${encodeURIComponent(sessionId)}`, env, {
    operator: true
  });
}

function connectorOAuthExchangeCommand(args: string[], env: CliEnv): Promise<unknown> {
  const [sessionId, ...rest] = args;
  if (!sessionId) {
    throw new Error("connect oauth-exchange requires a session id");
  }
  const propertyId = optionValue(rest, "--property-id");
  return apiRequest(`/oauth/sessions/${encodeURIComponent(sessionId)}/exchange`, env, {
    method: "POST",
    operator: true,
    body: {
      propertyId,
      connectionName: optionValue(rest, "--connection-name"),
      clientSecret: optionValue(rest, "--client-secret"),
      tokenUrl: optionValue(rest, "--token-url"),
      apiBaseUrl: optionValue(rest, "--api-base-url")
    }
  });
}

async function interactiveSession(env: CliEnv): Promise<void> {
  // First-run front door: the big INFINITE welcome, before readiness/preflight.
  // Only on an Ink-capable interactive TTY; "press Enter to launch" hands off
  // into the session (which lands on the rocket home banner).
  if (shouldShowInfiniteWelcome(env) && shouldUseInkInteractiveSession(input, output, env)) {
    await runInfiniteWelcome({
      columns: output.columns,
      errorOutput,
      input,
      output
    });
    recordInfiniteWelcomeSeen(env);
  }

  const readiness = await localChatReadiness(env);
  if (!readiness.ok) {
    if (env.GROWTH_OS_CLI_NONINTERACTIVE === "1" || input.isTTY !== true) {
      output.write(`${renderCliResult(readiness)}\n`);
      return;
    }
    const proceed = await handleInteractiveSetupPreflight(env, readiness);
    if (!proceed) {
      return;
    }
  }
  const workspaceRoot = workspaceRootFor(env);
  const memoryStore = createFileSessionMemoryStore(workspaceRoot);
  const memory = createOperatorSessionMemory({
    workspaceRoot
  }, memoryStore);
  const chatState: InteractiveChatState = { conversationId: `cli_${randomUUID()}` };
  const localAgentRuntime = () => ensureActiveAgentRuntime(() => createCliAgentRuntime(env));
  // Interactive shells (Ink raw mode / readline) already own stdin, so commands
  // dispatched from them must not launch their own raw-mode wizards. Force
  // non-interactive dispatch; commands degrade to guidance/quick forms instead.
  const interactiveCommandEnv: CliEnv = { ...env, GROWTH_OS_CLI_NONINTERACTIVE: "1" };

  // No default on load unless one is persisted: load `defaultProjectId` into the
  // session env pin (else leave unpinned) and surface the one-time legacy notice.
  const migrationNotice = applySessionDefaultPin(env);
  if (migrationNotice) {
    output.write(`${migrationNotice}\n`);
  }

  if (shouldUseInkInteractiveSession(input, output, env)) {
    // Resolve the active project's name once so the per-answer label is ready
    // on the first render; refreshed in-process on `/project use` / `new`.
    // Load the project-list cache too, so the `@name` resolver and Tab
    // completion have it synchronously available (refreshed on `project new`).
    await refreshActiveProjectLabel(env);
    await loadProjectListCache(env);
    const theme = resolveTheme(env as NodeJS.ProcessEnv);
    // Home inventory (every-launch startup screen). Tools/Commands are static +
    // registry-derived; the Connected line is LIVE but BOUNDED — the fetch is
    // capped by `readinessProbeTimeoutMs` and returns `undefined` on any failure,
    // so a missing/zombie daemon degrades to a muted note and never hangs startup.
    const homeInventoryConnections = await fetchHomeInventoryConnections(env);
    try {
      await runInkInteractiveSession({
        columns: output.columns,
        errorOutput,
        getAgentTitle: () =>
          activeProjectLabel ? `${theme.brand.name} — ${activeProjectLabel}` : undefined,
        getCompletions: (value) => completeInteractiveInputForCli(value, env),
        homeInventory: {
          tools: HOME_INVENTORY_TOOLS,
          commands: homeInventoryCommands(),
          connections: homeInventoryConnections,
          version: cliVersion(),
          workspace: activeProjectLabel
        },
        initialInputHistory: loadPersistentInputHistory(env as NodeJS.ProcessEnv),
        input,
        onRememberInput: (line) => appendPersistentInputHistory(line, env as NodeJS.ProcessEnv),
        output,
        promptPlaceholder: "Type a message, /help, or /exit.",
        // In-chat /connect (#20): for token providers this returns a `wizard`
        // descriptor the TUI renders as a masked field loop (NOT the operator
        // confirm gate, NOT the LLM); for ga4/meta_ads/shopify it returns a `note`
        // the TUI shows as a system line. index.ts owns the registry/copy; the TUI
        // owns the render + raw-mode input. The terminal readline path below keeps
        // its `requiresOperatorConfirmation` "Type confirm" gate untouched.
        connectWizard: (line) => decideConnectWizard(line),
        // On the wizard's final "Connect" confirm, the TUI calls this to assemble
        // the leading-slash dispatch line from the in-memory collected fields. The
        // normalization (projectId→Number, apiHost via normalizePostHogApiHost,
        // @handle stripping) stays HERE; the secret only enters the line at dispatch
        // time and the line routes to POST /sources/connect (never the LLM).
        buildConnectDispatch: (provider, connectionName, collected) => {
          const definition = connectorSetupDefinition(provider);
          if (!definition) {
            throw new Error(`Unknown connector provider: ${provider}`);
          }
          return buildConnectDispatchLine(definition, connectionName, collected);
        },
        requiresConfirmation: (line) =>
          requiresOperatorConfirmation(line) ? `${operatorConfirmationText(line)} Type confirm to continue.` : undefined,
        requiresSelection: syncWindowSelectionPrompt,
        status: () => chatState.sessionId ? [`session ${chatState.sessionId}`] : [],
        theme,
        title: "Infinite TUI",
        async onSubmitLine(line, onProgress) {
          // PR5 — pre-turn project selection. A pin-less session FAIL-CLOSES at
          // runtime construction (`infiniteOsWorkspaceId` throws `NoActiveProjectError`
          // at `createCliAgentRuntime`, BEFORE any tool), so the decision must be
          // made HERE, before the runtime is built/used. Three triggers route to the
          // picker instead of surfacing "No active project" or a not-found message:
          //
          //   (a) multiple distinct `@a @b` → offer {a,b};
          //   (b) `@unknown` → offer the full list;
          //   (c) no pin + no `@` + no default → offer the full list.
          //
          // The wrapper returns a `needsProjectSelection` variant (it does NOT build
          // the runtime); `interactive-session.tsx` renders the picker and on a pick
          // re-submits `@<pickedName> <originalLine>` back through this same wrapper,
          // where the PR4 `@`-resolver below sets the pin and answers. End-to-end
          // reuse of PR4 — no switch logic is duplicated in the picker path.
          const selection = decidePreTurnProjectSelection(env, line);
          if (selection) {
            return { needsProjectSelection: selection };
          }

          // 1. `@name` resolution runs BEFORE dispatch. The switch mutates the
          //    *original* `env` (in scope here), which `localAgentRuntime` closes
          //    over — a copy (`interactiveCommandEnv`) would not re-scope it.
          const pin = resolveProjectPin(line);
          let pinnedProject: { id: string; name: string } | undefined;
          if (pin.status === "unknown") {
            // `@unknown` normally routes to the picker above; this is only reached
            // when there are no projects to pick from (empty cache). Surface the
            // not-found message rather than silently falling back to another project.
            return {
              messages: [{
                kind: "slash",
                role: "system",
                text: `No project matches @${pin.token}. Create one with \`/project new <name>\`.`
              } as Msg]
            };
          }
          if (pin.status === "ambiguous") {
            // Defensive: an ambiguous `@token` (slug collision) normally routes to
            // the picker via `decidePreTurnProjectSelection` above. If we ever reach
            // here, never silently pin an arbitrary one — ask the operator to use
            // the unique id rather than the colliding `@<name>`.
            const ids = (pin.candidates ?? []).map((c) => `@${c.id}`).join(", ");
            return {
              messages: [{
                kind: "slash",
                role: "system",
                text: `@${pin.token} matches more than one project. Use a unique id: ${ids}.`
              } as Msg]
            };
          }
          if (pin.status === "switched" && pin.project) {
            applySessionPin(env, pin.project);
            pinnedProject = pin.project;
            // Bare `@name` (no remaining question) → confirm the switch, no turn.
            if (!pin.remainder) {
              return {
                messages: [{
                  kind: "slash",
                  role: "system",
                  text: `→ pinned to ${pin.project.name}`
                } as Msg],
                project: pin.project
              };
            }
          }

          // 2. Dispatch the remainder (token stripped).
          const result = await runSlashCommand(pin.remainder, interactiveCommandEnv, memory, memoryStore, chatState, localAgentRuntime, { onProgress });

          // 3. `/project use` fold-in: it returns a pin-change signal rather than
          //    persisting; apply it here via the same env-pin mechanism.
          const pinChange = readProjectPinChange(result);
          if (pinChange) {
            applySessionPin(env, pinChange);
            pinnedProject = pinChange;
          }

          // 4. Return the resolved project so the answer's title re-stamps from
          //    the pin the turn actually answered for (the switch happened after
          //    the pre-call title capture).
          return { messages: interactiveResultMessages(result), project: pinnedProject };
        }
      });
    } finally {
      resetAgentRuntime();
    }
    return;
  }

  const rl = createInterface({ input, output, prompt: "infinite> " });
  output.write(
    "Infinite OS session. Type a message, /help, or /exit.\n"
  );
  try {
    for (;;) {
      const line = (await rl.question("infinite> ")).trim();
      if (!line || line === "/exit" || line === "/quit") {
        return;
      }
      try {
        if (requiresOperatorConfirmation(line)) {
          const confirmation = await rl.question(`${operatorConfirmationText(line)} Type confirm to continue: `);
          if (confirmation.trim().toLowerCase() !== "confirm") {
            output.write("Cancelled operator action.\n");
            continue;
          }
        }
        const result = await runSlashCommand(line, interactiveCommandEnv, memory, memoryStore, chatState, localAgentRuntime);
        output.write(`${renderCliResultForStream(result, output, env)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.write(`error: ${message}\n`);
      }
    }
  } finally {
    rl.close();
    resetAgentRuntime();
  }
}

export async function runSlashCommand(
  line: string,
  env: CliEnv,
  memory?: OperatorSessionMemory,
  memoryStore?: SessionMemoryStore,
  chatState?: InteractiveChatState,
  agentRuntime?: CliAgentRuntimeSource,
  options: RunSlashCommandOptions = {}
): Promise<unknown> {
  // Bare auth commands typed without a slash (e.g. `codex login`) dispatch as
  // commands so the suggestion we print is literally typeable in the TUI. The
  // matcher is strict (whole-line + known flags), so real chat is never eaten.
  const bareCommand = bareInfiniteCommand(line);
  if (bareCommand) {
    const result = await runCommand(bareCommand.command, bareCommand.args, env, { onProgress: options.onProgress });
    rememberResult(memory, memoryStore, result);
    return result;
  }
  if (!line.startsWith("/")) {
    memory?.rememberQuestion(line);
    const progress = options.onProgress
      ? undefined
      : createCliProgressReporter(options.progressStream ?? output, env, {
        promptPlaceholder: "Type a message, /help, or /exit.",
        status: chatState?.sessionId ? [`session ${chatState.sessionId}`] : []
      });
    let result: unknown;
    try {
      result = await chatRequest(
        // Pass the IMMUTABLE conversation id (the runtime derives the
        // per-workspace controller session id), never the round-tripped
        // `chatState.sessionId` — see InteractiveChatState.
        line,
        env,
        chatState?.conversationId,
        agentRuntime,
        options.onProgress ?? ((event) => progress?.progress(event))
      );
    } finally {
      progress?.stop();
    }
    updateChatState(chatState, result);
    rememberResult(memory, memoryStore, result);
    return result;
  }

  const [slashCommand, ...rest] = line.slice(1).split(/\s+/);
  if (slashCommand === "help") {
    return helpText();
  }
  if (slashCommand === "memory") {
    return memoryCommand(rest, env, memory, memoryStore, chatState, agentRuntime);
  }
  if (slashCommand === "sessions") {
    return withCliAgentRuntime(env, agentRuntime, (runtime) => runtime.listSessions());
  }
  if (slashCommand === "resume") {
    // `/sessions` surfaces the conversation id (the `:<ws>` suffix stripped), so
    // the argument here is a conversation id. Re-point the immutable
    // conversationId; the runtime re-derives the per-workspace controller id.
    const [conversationId] = rest;
    if (!conversationId) {
      throw new Error("resume requires a session id");
    }
    const result = await withCliAgentRuntime(env, agentRuntime, (runtime) =>
      runtime.resumeSession(conversationId)
    );
    if (chatState) {
      chatState.conversationId = conversationId;
    }
    return result;
  }
  if (slashCommand === "new") {
    const conversationId = `cli_${randomUUID()}`;
    if (chatState) {
      chatState.conversationId = conversationId;
    }
    return { ok: true, sessionId: conversationId };
  }
  if (slashCommand === "compact") {
    if (!chatState?.conversationId) {
      throw new Error("compact requires an active session");
    }
    const summaryText = rest.join(" ").trim();
    return withCliAgentRuntime(env, agentRuntime, (runtime) =>
      runtime.compactSession(chatState.conversationId, summaryText || undefined)
    );
  }
  if (slashCommand === "confirm") {
    const [confirmationId] = rest;
    if (!confirmationId) {
      throw new Error("confirm requires a confirmation id");
    }
    return withCliAgentRuntime(env, agentRuntime, (runtime) => runtime.confirmAction(confirmationId));
  }
  if (slashCommand === "call") {
    const result = await runCommand("call", rest, env, { onProgress: options.onProgress });
    rememberResult(memory, memoryStore, result);
    return result;
  }
  const result = await runCommand(slashCommand, rest, env, { onProgress: options.onProgress });
  rememberResult(memory, memoryStore, result);
  return result;
}

function interactiveResultMessages(result: unknown): Msg[] {
  const rendered = renderCliResult(result).trim();
  if (!rendered) {
    return [];
  }

  if (isChatResponseResult(result)) {
    return [{ role: "assistant", text: rendered }];
  }

  return [{ kind: "slash", role: "system", text: rendered }];
}

export async function handleInteractiveSetupPreflight(
  env: CliEnv,
  readiness: Record<string, unknown> & { ok: boolean },
  options: {
    chooseAction?: () => Promise<SetupPreflightAction>;
    runWizard?: (args: string[], env: CliEnv) => Promise<unknown>;
    checkReadiness?: (env: CliEnv) => Promise<Record<string, unknown> & { ok: boolean }>;
    writeLine?: (text: string) => void;
  } = {}
): Promise<boolean> {
  const writeLine = options.writeLine ?? ((text: string) => output.write(`${text}\n`));
  writeLine("Infinite is not set up yet.");
  writeLine("");
  writeLine("Recommended: run the setup wizard now.");
  writeLine("");
  writeLine("Options:");
  writeLine("  Continue setup");
  writeLine("  Show current status");
  writeLine("  Exit");

  const action = options.chooseAction
    ? await options.chooseAction()
    : await promptSetupPreflightAction();

  if (action === "status") {
    writeLine("");
    writeLine(renderCliResult(readiness));
    return false;
  }
  if (action === "exit") {
    return false;
  }

  const wizardResult = await (options.runWizard ?? runSetupWizard)([], env);
  writeLine("");
  writeLine(renderCliResult(wizardResult));
  const nextReadiness = await (options.checkReadiness ?? localChatReadiness)(env);
  if (!nextReadiness.ok) {
    writeLine("");
    writeLine(renderCliResult(nextReadiness));
    return false;
  }
  return true;
}

export async function maybeLaunchInfiniteAfterSetup(
  result: unknown,
  env: CliEnv,
  options: {
    confirm?: () => Promise<boolean>;
    interactive?: boolean;
    launch?: () => Promise<void>;
  } = {}
): Promise<boolean> {
  if (!shouldOfferLaunchAfterSetup(result, env, options.interactive)) {
    return false;
  }
  const confirmed = options.confirm
    ? await options.confirm()
    : await promptYesNo("Launch infinite now?", true);
  if (!confirmed) {
    return false;
  }
  await (options.launch ?? (() => interactiveSession(env)))();
  return true;
}

async function promptSetupPreflightAction(): Promise<SetupPreflightAction> {
  const choices: SetupPreflightAction[] = ["continue", "status", "exit"];
  const selected = await promptChoice("Select next action:", choices, 0, {
    description: "Continue setup is the default. Status shows current blockers without changing anything."
  });
  return choices[selected] as SetupPreflightAction;
}

function shouldOfferLaunchAfterSetup(result: unknown, env: CliEnv, interactiveOverride?: boolean): boolean {
  const isInteractive = interactiveOverride ?? (input.isTTY === true);
  if (env.GROWTH_OS_CLI_NONINTERACTIVE === "1" || !isInteractive) {
    return false;
  }
  if (!isRecord(result)) {
    return false;
  }
  if (result.section === "wizard") {
    return result.ok === true;
  }
  if (result.section === "status" && isRecord(result.setupReadiness)) {
    return result.setupReadiness.llmQuery === "ready";
  }
  return false;
}

export interface ProjectCommandOptions {
  // Confirm seam for `project delete`. Defaults to an interactive yes/no prompt
  // on a TTY; unit tests inject a deterministic confirm without juggling stdin.
  confirmDelete?: (project: { id: string; name: string }) => Promise<boolean>;
}

// `apiRequest` throws `new Error(JSON.stringify({ ok:false, error:{ code } }))`
// on a non-2xx response. Detect the API's `project_not_found` envelope so the CLI
// can surface a friendly message instead of raw JSON.
function isProjectNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  try {
    const payload = JSON.parse(error.message) as { error?: { code?: string } };
    return payload?.error?.code === "project_not_found";
  } catch {
    return false;
  }
}

// ── Meta Ads WRITE/management surface ──────────────────────────────────────
// `infinite meta <object> <action>`. CREATE always lands PAUSED (money-safety
// INV-1); going live is the separate, gated `activate` transition (INV-2). All
// write verbs route to `/tools/call` with `operator:true` — the operator token
// is attached by `apiRequest`, NEVER echoed. Reads (list/get) are ungated. The
// CLI gates writes in TWO independent places: (a) this terminal sub-command gate
// — `--yes`/`--force`/`-y` skip, non-interactive WITHOUT a skip flag THROWS, the
// yes/no prompt defaults to NO — with a STRICTER typed-confirm for `activate`
// (type the id or the word "activate"); (b) `requiresOperatorConfirmation("meta")`
// gates the interactive session. There is intentionally NO `--token` flag — the
// secret contract keeps the access token server-side only.

const META_OBJECTS = ["campaign", "adset", "ad", "creative"] as const;
type MetaObject = (typeof META_OBJECTS)[number];

const META_ENTITY_FOR_OBJECT: Record<MetaObject, "campaign" | "adset" | "ad" | "creative"> = {
  campaign: "campaign",
  adset: "adset",
  ad: "ad",
  creative: "creative"
};

// `activate`/`pause` map directly onto a single `set_meta_entity_status` action;
// `creative` has no go-live, so it is excluded from the status verbs below.
const META_STATUS_OBJECTS = ["campaign", "adset", "ad"] as const;
type MetaStatusObject = (typeof META_STATUS_OBJECTS)[number];

export interface MetaCommandOptions {
  // Confirm seam for the terminal write gate (create/pause/delete). Defaults to
  // an interactive yes/no prompt (default NO) on a TTY; unit tests inject a
  // deterministic confirm without juggling stdin.
  confirmMutation?: (details: { action: string; object: MetaObject; summary: string }) => Promise<boolean>;
  // Stricter typed-confirm seam for `activate` (the only money-spending
  // transition): the operator must type the entity id or the word "activate".
  // Returns the raw typed string; the caller validates it.
  confirmActivate?: (details: { object: MetaStatusObject; entityId: string }) => Promise<string>;
  // Optional override for the ad-account currency shown on budget entry. Tests
  // inject a deterministic value; the default is a generic note (a live currency
  // read is deferred — there is no client-resolvable account-currency action).
  adAccountCurrency?: string;
}

function metaSourceIdFromArgs(args: string[]): string {
  const sourceId = optionValue(args, "--source-id") ?? optionValue(args, "--source");
  if (!sourceId) {
    throw new Error("meta requires --source-id <id> (the connected meta_ads source)");
  }
  return sourceId;
}

// Value-taking flags across the whole `meta` surface. The positional-id resolver
// MUST skip both the flag AND its following value so that, e.g.,
// `--source-id act_123 cmp_999` resolves to `cmp_999` (the entity id), NOT to
// `act_123` (a flag value). Getting this wrong on `activate`/`pause` could target
// the WRONG (money-spending) entity — this is a money-safety boundary.
const META_VALUE_FLAGS = new Set<string>([
  "--source-id",
  "--source",
  "--name",
  "--objective",
  "--daily-budget",
  "--lifetime-budget",
  "--bid-amount",
  "--optimization-goal",
  "--billing-event",
  "--targeting-countries",
  "--pixel-id",
  "--custom-event-type",
  "--start-time",
  "--end-time",
  "--creative-id",
  "--page-id",
  "--link-url",
  "--body",
  "--title",
  "--description",
  "--call-to-action",
  "--instagram-user-id",
  "--image-hash",
  "--client-token",
  "--fields",
  "-l",
  "--limit"
]);

// Resolve the positional entity id for a `meta <object> <action>` invocation.
// Unlike the generic `firstPositionalArg`, this skips known value-taking flags
// AND the value that follows them, so a flag value can never be mistaken for the
// positional id regardless of argument ordering. `--flag=value` forms carry their
// value inline (no separate token to skip). Boolean flags (`--yes`, `--json`, …)
// take no value and are simply skipped.
function metaPositionalId(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith("--") && arg.includes("=")) {
      // `--flag=value` — inline value, nothing to skip after it.
      continue;
    }
    if (META_VALUE_FLAGS.has(arg)) {
      // Skip this flag AND consume its value token so the value is never read
      // as the positional id.
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      // Any other flag (boolean like --yes/--json/--force/-y, or an unknown
      // flag) — skip the flag itself; it carries no positional meaning.
      continue;
    }
    return arg;
  }
  return undefined;
}

// Parse an integer-cents flag. Budgets/bids are INTEGER minor units (cents) in
// the ad-account currency (5000 = $50.00). Reject non-integers up front so a
// malformed amount never reaches the Graph POST.
function metaCentsFlag(args: string[], flag: string): number | undefined {
  const raw = optionValue(args, flag);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${flag} must be an integer number of cents (e.g. 5000 = $50.00)`);
  }
  return Number.parseInt(raw.trim(), 10);
}

function metaCsvFlag(args: string[], flag: string): string[] | undefined {
  const raw = optionValue(args, flag);
  if (raw === undefined) {
    return undefined;
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

// Render the budget line shown on the write confirmation. The amount is integer
// cents; the currency follows the ad account. We surface the ISO code when a
// deterministic value is supplied (test seam) and otherwise note it generically.
function metaBudgetSummary(
  input: { dailyBudget?: number; lifetimeBudget?: number; bidAmount?: number },
  currency?: string
): string {
  const suffix = currency ? ` ${currency}` : " (ad-account currency)";
  const parts: string[] = [];
  if (input.dailyBudget !== undefined) {
    parts.push(`daily budget ${input.dailyBudget} cents${suffix}`);
  }
  if (input.lifetimeBudget !== undefined) {
    parts.push(`lifetime budget ${input.lifetimeBudget} cents${suffix}`);
  }
  if (input.bidAmount !== undefined) {
    parts.push(`bid ${input.bidAmount} cents${suffix}`);
  }
  return parts.join(", ");
}

function metaWriteSkipConfirm(rest: string[]): boolean {
  const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
  return flags.has("--yes") || flags.has("--force") || rest.includes("-y");
}

function metaInteractive(env: CliEnv): boolean {
  return input.isTTY === true && env.GROWTH_OS_CLI_NONINTERACTIVE !== "1";
}

async function metaToolCall(actionId: string, toolInput: Record<string, unknown>, env: CliEnv): Promise<unknown> {
  return apiRequest("/tools/call", env, {
    method: "POST",
    operator: true,
    body: { actionId, input: toolInput }
  });
}

export async function metaCommand(
  args: string[],
  env: CliEnv,
  options: MetaCommandOptions = {}
): Promise<unknown> {
  const [object, action, ...rest] = args;
  if (!object || !action) {
    throw new Error(
      "Usage: infinite meta <campaign|adset|ad|creative> <create|activate|pause|delete|list|get> [...]"
    );
  }
  if (!META_OBJECTS.includes(object as MetaObject)) {
    throw new Error(`Unknown meta object: ${object} (expected campaign|adset|ad|creative)`);
  }
  const metaObject = object as MetaObject;
  const json = hasFlag(rest, "--json");
  const sourceId = metaSourceIdFromArgs(rest);

  // ── READS (ungated) ──────────────────────────────────────────────────────
  if (action === "list") {
    const limit = metaCentsFlag(rest, "-l") ?? metaCentsFlag(rest, "--limit");
    const fields = optionValue(rest, "--fields");
    return metaToolCall(
      "list_meta_entities",
      {
        sourceId,
        entity: META_ENTITY_FOR_OBJECT[metaObject],
        ...(limit === undefined ? {} : { limit }),
        ...(fields ? { fields } : {})
      },
      env
    );
  }
  if (action === "get") {
    const entityId = metaPositionalId(rest);
    if (!entityId) {
      throw new Error(`meta ${metaObject} get requires an entity id`);
    }
    const fields = optionValue(rest, "--fields");
    // FIX 1: pass the entity kind so `get` requests the SAME full field set as
    // `list` (id/name/status/…) instead of degrading to Graph's id-only node.
    return metaToolCall(
      "get_meta_entity",
      { sourceId, entityId, entity: META_ENTITY_FOR_OBJECT[metaObject], ...(fields ? { fields } : {}) },
      env
    );
  }

  // ── WRITES (gated) ───────────────────────────────────────────────────────
  if (action === "create") {
    return metaCreateCommand(metaObject, rest, env, options, { json, sourceId });
  }
  if (action === "activate" || action === "pause") {
    if (!META_STATUS_OBJECTS.includes(metaObject as MetaStatusObject)) {
      throw new Error(`meta ${metaObject} has no ${action} transition (creatives never go live)`);
    }
    return metaStatusCommand(
      metaObject as MetaStatusObject,
      action,
      rest,
      env,
      options,
      { json, sourceId }
    );
  }
  if (action === "delete") {
    return metaDeleteCommand(metaObject, rest, env, options, { json, sourceId });
  }
  throw new Error(
    `Unknown meta action: ${action} (expected create|activate|pause|delete|list|get)`
  );
}

// FIX 2: `infinite meta {campaign|adset|ad} delete <id> --source-id <id> [--yes]
// [--json]`. Delete is an IRREVERSIBLE cleanup (no spend), so it goes through the
// SAME standard destructive confirm gate as `pause` — NOT the stricter typed
// confirm reserved for `activate` (the spend path). Creatives are not deletable
// via this verb (matches the runtime `entity` enum + the engine handler). The
// entity-kind hint is passed for a precise audit row.
async function metaDeleteCommand(
  object: MetaObject,
  rest: string[],
  env: CliEnv,
  options: MetaCommandOptions,
  ctx: { json: boolean; sourceId: string }
): Promise<unknown> {
  if (!META_STATUS_OBJECTS.includes(object as MetaStatusObject)) {
    throw new Error(`meta ${object} has no delete verb (creatives are not deletable here)`);
  }
  const entityId = metaPositionalId(rest);
  if (!entityId) {
    throw new Error(`meta ${object} delete requires an entity id`);
  }
  const section = `meta_${object}_delete`;
  const proceed = await metaConfirmWrite(
    "delete",
    object,
    `Permanently DELETE ${object} ${entityId} (irreversible)`,
    rest,
    env,
    options,
    section
  );
  if (!proceed.ok) {
    return proceed.result;
  }
  return metaToolCall(
    "delete_meta_entity",
    { sourceId: ctx.sourceId, entityId, entity: META_ENTITY_FOR_OBJECT[object] },
    env
  );
}

async function metaCreateCommand(
  object: MetaObject,
  rest: string[],
  env: CliEnv,
  options: MetaCommandOptions,
  ctx: { json: boolean; sourceId: string }
): Promise<unknown> {
  const clientToken = optionValue(rest, "--client-token");
  const section = `meta_${object}_create`;
  let actionId: string;
  let toolInput: Record<string, unknown>;

  if (object === "campaign") {
    const name = requireMetaFlag(rest, "--name", "campaign create");
    const objective = requireMetaFlag(rest, "--objective", "campaign create");
    const dailyBudget = metaCentsFlag(rest, "--daily-budget");
    const lifetimeBudget = metaCentsFlag(rest, "--lifetime-budget");
    actionId = "create_meta_campaign";
    toolInput = {
      sourceId: ctx.sourceId,
      name,
      objective,
      ...(dailyBudget === undefined ? {} : { dailyBudget }),
      ...(lifetimeBudget === undefined ? {} : { lifetimeBudget }),
      ...(clientToken ? { clientToken } : {})
    };
  } else if (object === "adset") {
    const campaignId = metaPositionalId(rest);
    if (!campaignId) {
      throw new Error("meta adset create requires a campaign id (positional)");
    }
    const name = requireMetaFlag(rest, "--name", "adset create");
    const optimizationGoal = requireMetaFlag(rest, "--optimization-goal", "adset create");
    const billingEvent = requireMetaFlag(rest, "--billing-event", "adset create");
    const dailyBudget = metaCentsFlag(rest, "--daily-budget");
    const lifetimeBudget = metaCentsFlag(rest, "--lifetime-budget");
    const bidAmount = metaCentsFlag(rest, "--bid-amount");
    const targetingCountries = metaCsvFlag(rest, "--targeting-countries");
    const pixelId = optionValue(rest, "--pixel-id");
    const customEventType = optionValue(rest, "--custom-event-type");
    const startTime = optionValue(rest, "--start-time");
    const endTime = optionValue(rest, "--end-time");
    actionId = "create_meta_ad_set";
    toolInput = {
      sourceId: ctx.sourceId,
      campaignId,
      name,
      optimizationGoal,
      billingEvent,
      ...(dailyBudget === undefined ? {} : { dailyBudget }),
      ...(lifetimeBudget === undefined ? {} : { lifetimeBudget }),
      ...(bidAmount === undefined ? {} : { bidAmount }),
      ...(startTime ? { startTime } : {}),
      ...(endTime ? { endTime } : {}),
      ...(targetingCountries ? { targetingCountries } : {}),
      ...(pixelId ? { pixelId } : {}),
      ...(customEventType ? { customEventType } : {}),
      ...(clientToken ? { clientToken } : {})
    };
  } else if (object === "creative") {
    const name = requireMetaFlag(rest, "--name", "creative create");
    const pageId = requireMetaFlag(rest, "--page-id", "creative create");
    const linkUrl = optionValue(rest, "--link-url");
    const body = optionValue(rest, "--body");
    const title = optionValue(rest, "--title");
    const description = optionValue(rest, "--description");
    const callToAction = optionValue(rest, "--call-to-action");
    const instagramUserId = optionValue(rest, "--instagram-user-id");
    // STANDARD creatives only: a single uploaded image referenced by hash. The
    // `/adimages` upload→imageHash flow is deferred; we pass a supplied hash.
    const imageHash = optionValue(rest, "--image-hash");
    actionId = "create_meta_creative";
    toolInput = {
      sourceId: ctx.sourceId,
      name,
      pageId,
      ...(imageHash ? { imageHash } : {}),
      ...(instagramUserId ? { instagramUserId } : {}),
      ...(linkUrl ? { linkUrl } : {}),
      ...(body ? { body } : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(callToAction ? { callToAction } : {}),
      ...(clientToken ? { clientToken } : {})
    };
  } else {
    const adsetId = metaPositionalId(rest);
    if (!adsetId) {
      throw new Error("meta ad create requires an ad set id (positional)");
    }
    const name = requireMetaFlag(rest, "--name", "ad create");
    const creativeId = requireMetaFlag(rest, "--creative-id", "ad create");
    actionId = "create_meta_ad";
    toolInput = {
      sourceId: ctx.sourceId,
      adsetId,
      name,
      creativeId,
      ...(clientToken ? { clientToken } : {})
    };
  }

  // Confirm gate (create lands PAUSED — no spend — but it is still an operator
  // mutation, so it goes through the same terminal gate as `project delete`).
  const budgetLine = metaBudgetSummary(toolInput as never, options.adAccountCurrency);
  const summary =
    `Create ${object} "${String(toolInput.name)}" (lands PAUSED — never spends until you activate it)` +
    (budgetLine ? ` — ${budgetLine}` : "");
  const proceed = await metaConfirmWrite(`create`, object, summary, rest, env, options, section);
  if (!proceed.ok) {
    return proceed.result;
  }
  return metaToolCall(actionId, toolInput, env);
}

async function metaStatusCommand(
  object: MetaStatusObject,
  action: "activate" | "pause",
  rest: string[],
  env: CliEnv,
  options: MetaCommandOptions,
  ctx: { json: boolean; sourceId: string }
): Promise<unknown> {
  const entityId = metaPositionalId(rest);
  if (!entityId) {
    throw new Error(`meta ${object} ${action} requires an entity id`);
  }
  const section = `meta_${object}_${action}`;
  const status = action === "activate" ? "ACTIVE" : "PAUSED";
  // `entity` is REQUIRED by set_meta_entity_status (the handler uses it to pick the CLI
  // `ads <entity> update` subcommand and rejects its absence uniformly). The status object
  // (campaign|adset|ad) IS the entity, so thread it through — without it the daemon rejects
  // every activate/pause before doing anything.
  const toolInput = { sourceId: ctx.sourceId, entityId, status, entity: object };

  if (action === "pause") {
    // Pause is naturally idempotent but still gated by the standard write gate.
    const proceed = await metaConfirmWrite(
      "pause",
      object,
      `Pause ${object} ${entityId}`,
      rest,
      env,
      options,
      section
    );
    if (!proceed.ok) {
      return proceed.result;
    }
    return metaToolCall("set_meta_entity_status", toolInput, env);
  }

  // ── activate: the only money-spending transition → STRICTER typed-confirm ──
  // `--yes`/`--force`/`-y` skip the gate (scripted operators opt in explicitly);
  // otherwise the operator must type the entity id or the literal word
  // "activate". Non-interactive WITHOUT a skip flag THROWS (never silently go
  // live in a script).
  if (!metaWriteSkipConfirm(rest)) {
    if (!options.confirmActivate && !metaInteractive(env)) {
      throw new Error(
        `Refusing to activate ${object} ${entityId} without confirmation. ` +
          `Re-run with --yes to confirm (this transition spends money).`
      );
    }
    const typed = (
      options.confirmActivate
        ? await options.confirmActivate({ object, entityId })
        : await metaPromptTypedConfirm(object, entityId)
    ).trim();
    const expected = new Set([entityId, "activate"]);
    if (!expected.has(typed)) {
      return {
        ok: false,
        section,
        cancelled: true,
        object,
        entityId,
        reason: "typed_confirmation_mismatch"
      };
    }
  }
  // The operator confirmed (typed-id / "activate" / --yes). Carry the engine's transport-agnostic
  // activation gate: confirmActivation MUST echo entityId for the handler to permit status:ACTIVE.
  return metaToolCall(
    "set_meta_entity_status",
    { ...toolInput, confirmActivation: entityId },
    env
  );
}

// Terminal write gate, mirroring `project delete`: `--yes`/`--force`/`-y` skip;
// otherwise prompt (default NO). Non-interactive WITHOUT a skip flag and WITHOUT
// an injected seam is a hard refusal. Returns `{ok:false}` on a NO/cancel with a
// `cancelled` envelope; `{ok:true}` to proceed.
async function metaConfirmWrite(
  action: string,
  object: MetaObject,
  summary: string,
  rest: string[],
  env: CliEnv,
  options: MetaCommandOptions,
  section: string
): Promise<{ ok: true } | { ok: false; result: Record<string, unknown> }> {
  if (metaWriteSkipConfirm(rest)) {
    return { ok: true };
  }
  if (!options.confirmMutation && !metaInteractive(env)) {
    throw new Error(
      `Refusing to ${action} ${object} without confirmation. Re-run with --yes to confirm.`
    );
  }
  const confirm =
    options.confirmMutation ??
    (async () =>
      promptYesNo(`${summary}. Proceed?`, false, { io: { input, output: errorOutput } }));
  const confirmed = await confirm({ action, object, summary });
  if (!confirmed) {
    return {
      ok: false,
      result: { ok: false, section, cancelled: true, object }
    };
  }
  return { ok: true };
}

async function metaPromptTypedConfirm(object: MetaStatusObject, entityId: string): Promise<string> {
  const rl = createInterface({ input, output: errorOutput });
  try {
    return await rl.question(
      `Activating ${object} ${entityId} will start spending money. ` +
        `Type the id (${entityId}) or "activate" to confirm: `
    );
  } finally {
    rl.close();
  }
}

function requireMetaFlag(args: string[], flag: string, context: string): string {
  const value = optionValue(args, flag);
  if (!value) {
    throw new Error(`meta ${context} requires ${flag} <value>`);
  }
  return value;
}

export async function projectCommand(
  args: string[],
  env: CliEnv,
  options: ProjectCommandOptions = {}
): Promise<unknown> {
  const sub = args[0];
  if (sub === "new") {
    const name = args.slice(1).join(" ").trim();
    if (!name) throw new Error("project new requires a name");
    const res = (await apiRequest("/projects", env, {
      method: "POST",
      body: { name },
      operator: true,
      omitWorkspace: true
    })) as {
      project: { id: string; name: string };
    };
    writeActiveProjectId(res.project.id, env as NodeJS.ProcessEnv);
    activeProjectLabel = res.project.name;
    // Keep the `@name`/completion cache in sync with the new project.
    if (!projectListCache.some((p) => p.id === res.project.id)) {
      projectListCache = [...projectListCache, { id: res.project.id, name: res.project.name }];
    }
    return { ok: true, activeProjectId: res.project.id, name: res.project.name };
  }
  if (sub === "list") {
    const res = (await apiRequest("/projects", env, { operator: true, omitWorkspace: true })) as {
      projects: Array<{ id: string; name: string }>;
    };
    const active = readActiveProjectId(env as NodeJS.ProcessEnv);
    return { ok: true, projects: res.projects.map((p) => ({ ...p, active: p.id === active })) };
  }
  if (sub === "use") {
    const idOrName = args.slice(1).join(" ").trim();
    if (!idOrName) throw new Error("project use requires a name or id");
    const res = (await apiRequest(`/projects`, env, { operator: true, omitWorkspace: true })) as {
      projects: Array<{ id: string; name: string }>;
    };
    const match = res.projects.find((p) => p.id === idOrName || p.name === idOrName);
    if (!match) throw new Error(`Unknown project: ${idOrName}`);
    // [major] fix (PR4): `/project use` is a SESSION pin, not a persisted active
    // pointer. We do NOT `writeActiveProjectId` here. `projectCommand` runs with a
    // COPY of the session env (`interactiveCommandEnv`), so mutating env/resetting
    // the runtime here would not affect the runtime the wrapper closes over. We
    // return a pin-change signal; the `onSubmitLine` wrapper (which holds the
    // original session `env`) applies it via `env.GROWTH_OS_WORKSPACE_ID` +
    // `resetAgentRuntime()` — the same channel as an `@name` switch.
    activeProjectLabel = match.name;
    // The `[PROJECT_PIN_CHANGE]` signal is ONLY consumed by the interactive
    // `onSubmitLine` wrapper (which holds the original session `env` and applies
    // the pin). Run standalone — `infinite project use <name>` outside the
    // interactive TUI — nothing consumes it, so the command would otherwise
    // succeed while doing nothing visible. We detect "not the interactive
    // wrapper" by the absence of the wrapper's `GROWTH_OS_CLI_NONINTERACTIVE=1`
    // marker (the wrapper runs commands with `interactiveCommandEnv`, which sets
    // it; a standalone TTY invocation does not) and attach a user-facing hint.
    // `renderProjectUseResult` surfaces this hint as plain text below.
    const standalone = env.GROWTH_OS_CLI_NONINTERACTIVE !== "1";
    return {
      ok: true,
      section: "project_use" as const,
      activeProjectId: match.id,
      name: match.name,
      [PROJECT_PIN_CHANGE]: { id: match.id, name: match.name },
      ...(standalone
        ? {
            hint:
              `\`/project use\` pins a project for an interactive session only — it does not persist.\n` +
              `Run \`infinite project default set ${match.name}\` to make it the persisted default.`
          }
        : {})
    };
  }
  if (sub === "default") {
    return projectDefaultCommand(args.slice(1), env);
  }
  if (sub === "current") {
    // The session pin is the in-process env override (set by `@name` / `/project
    // use`), falling back to the legacy `activeProjectId` pointer — same
    // precedence as `infiniteOsWorkspaceId`. The persisted default is separate.
    const pin = env.GROWTH_OS_WORKSPACE_ID?.trim() || readActiveProjectId(env as NodeJS.ProcessEnv);
    const defaultProjectId = readDefaultProjectId(env as NodeJS.ProcessEnv);
    if (!pin && !defaultProjectId) {
      return { ok: false, error: { code: "no_active_project" } };
    }
    // `activeProjectId` is retained for backward compatibility with existing
    // callers/tests that read the current pin off this key.
    return {
      ok: true,
      activeProjectId: pin,
      pin: pin ?? null,
      defaultProjectId: defaultProjectId ?? null
    };
  }
  if (sub === "delete" || sub === "rm") {
    const rest = args.slice(1);
    const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
    // `-y` is a single-dash short flag, so it never lands in `flags` (which only
    // collects `--` tokens). Match it against the raw args instead.
    const skipConfirm = flags.has("--yes") || flags.has("--force") || rest.includes("-y");
    const idOrName = rest
      .filter((arg) => !arg.startsWith("--") && arg !== "-y")
      .join(" ")
      .trim();
    if (!idOrName) throw new Error("project delete requires a name or id");
    // Resolve name -> id against the live list (same lookup as `project use`).
    const res = (await apiRequest(`/projects`, env, { operator: true, omitWorkspace: true })) as {
      projects: Array<{ id: string; name: string }>;
    };
    const match = res.projects.find((p) => p.id === idOrName || p.name === idOrName);
    if (!match) throw new Error(`Unknown project: ${idOrName}`);
    // Refuse to delete the last remaining project — a workspace-less install is a
    // broken state (no active pin can ever resolve).
    if (res.projects.length <= 1) {
      return {
        ok: false,
        section: "project_delete" as const,
        error: { code: "cannot_delete_last_project" },
        name: match.name,
        id: match.id
      };
    }
    // Confirm unless `--yes`/`--force`. Non-interactive without a skip flag is a
    // refusal (never silently delete in a script).
    if (!skipConfirm) {
      const interactive = input.isTTY === true && env.GROWTH_OS_CLI_NONINTERACTIVE !== "1";
      const confirm =
        options.confirmDelete ??
        ((project) =>
          promptYesNo(
            `Delete project "${project.name}" (${project.id})? This permanently removes its synced data, connections, chats, and reports. This cannot be undone.`,
            false,
            { io: { input, output: errorOutput } }
          ));
      if (!options.confirmDelete && !interactive) {
        throw new Error(
          `Refusing to delete "${match.name}" without confirmation. Re-run with --yes to confirm.`
        );
      }
      const confirmed = await confirm(match);
      if (!confirmed) {
        return {
          ok: false,
          section: "project_delete" as const,
          cancelled: true,
          name: match.name,
          id: match.id
        };
      }
    }
    try {
      await apiRequest(`/projects/${encodeURIComponent(match.id)}`, env, {
        method: "DELETE",
        operator: true,
        omitWorkspace: true
      });
    } catch (error) {
      // Friendly 404 if the project vanished between the list lookup and the
      // DELETE (another operator/tab raced us). apiRequest throws a JSON-encoded
      // error envelope on non-2xx.
      if (isProjectNotFoundError(error)) {
        throw new Error(`Unknown project: ${idOrName}`);
      }
      throw error;
    }
    // Local pointer cleanup: the active pin and persisted default are client-side
    // (`~/.growth-os/state.json`) — clear either if it pointed at the deleted id.
    const clearedActive = readActiveProjectId(env as NodeJS.ProcessEnv) === match.id;
    if (clearedActive) {
      clearActiveProjectId(env as NodeJS.ProcessEnv);
    }
    const clearedDefault = readDefaultProjectId(env as NodeJS.ProcessEnv) === match.id;
    if (clearedDefault) {
      clearDefaultProjectId(env as NodeJS.ProcessEnv);
    }
    // Drop the deleted project from the in-memory `@name`/completion cache.
    projectListCache = projectListCache.filter((p) => p.id !== match.id);
    if (activeProjectLabel === match.name) {
      activeProjectLabel = undefined;
    }
    return {
      ok: true,
      section: "project_delete" as const,
      deleted: true,
      id: match.id,
      name: match.name,
      clearedActivePin: clearedActive,
      clearedDefault
    };
  }
  throw new Error("Usage: infinite project <new|list|use|current|default|delete>");
}

async function projectDefaultCommand(args: string[], env: CliEnv): Promise<unknown> {
  const sub = args[0];
  if (sub === "set") {
    const idOrName = args.slice(1).join(" ").trim();
    if (!idOrName) throw new Error("project default set requires a name or id");
    const res = (await apiRequest(`/projects`, env, { operator: true, omitWorkspace: true })) as {
      projects: Array<{ id: string; name: string }>;
    };
    const match = res.projects.find((p) => p.id === idOrName || p.name === idOrName);
    if (!match) throw new Error(`Unknown project: ${idOrName}`);
    // Merge-preserving: writeDefaultProjectId keeps any sibling `activeProjectId`.
    writeDefaultProjectId(match.id, env as NodeJS.ProcessEnv);
    return { ok: true, defaultProjectId: match.id, name: match.name };
  }
  if (sub === "clear") {
    clearDefaultProjectId(env as NodeJS.ProcessEnv);
    return { ok: true, defaultProjectId: null };
  }
  if (sub === "show") {
    const id = readDefaultProjectId(env as NodeJS.ProcessEnv);
    return { ok: true, defaultProjectId: id ?? null };
  }
  throw new Error("Usage: infinite project default <set|clear|show>");
}

async function modelCommand(args: string[], env: CliEnv): Promise<Record<string, unknown>> {
  const [subcommand, provider, model, ...rest] = args;
  if (subcommand === "list") {
    return {
      ok: true,
      providers: Object.entries(MODEL_PROVIDER_CATALOG).map(([provider, entry]) => ({
        provider,
        models: entry.models
      }))
    };
  }
  if (subcommand === "use") {
    if (!provider && input.isTTY === true) {
      const initialSelection = readInfiniteOsModelSelection(env as NodeJS.ProcessEnv);
      return runModelSetup(env, {
        initialProvider: initialSelection.provider,
        model: initialSelection.model
      });
    }
    if (!provider) {
      return modelSetupNeedsInputResult();
    }
    const authMode = authModeFromSetupInput(optionValue(rest, "--auth") ?? optionValue(rest, "--mode"));
    return applyExplicitModelSelection(provider, model, authMode, env);
  }
  if (subcommand === "status") {
    const selection = readInfiniteOsModelSelection(env as NodeJS.ProcessEnv);
    return {
      ok: true,
      provider: selection.provider ?? null,
      model: selection.model ?? null
    };
  }
  throw new Error("model requires list, use, or status");
}

async function applyExplicitModelSelection(
  providerInput: string | undefined,
  modelInput: string | undefined,
  authMode: SetupAuthMode | undefined,
  env: CliEnv
): Promise<Record<string, unknown> & { auth: Record<string, unknown> }> {
  const provider = providerFromInput(providerInput);
  if (!provider) {
    throw new Error("model use requires provider codex or claude");
  }
  if (!modelInput) {
    throw new Error("model use requires a model name");
  }
  const model = normalizeModelChoice(provider, modelInput);
  if (!model) {
    throw new Error(`unsupported model for ${provider}: ${modelInput}`);
  }
  return applyModelSelection(provider, model, authMode ?? defaultSetupAuthMode(provider), env);
}

async function applyModelSelection(
  provider: InfiniteOsModelProvider,
  model: string,
  authMode: SetupAuthMode,
  env: CliEnv
): Promise<Record<string, unknown> & { auth: Record<string, unknown> }> {
  if (!isSetupAuthModeForProvider(provider, authMode)) {
    throw new Error(
      provider === "codex"
        ? "codex model auth must be login, import, or none"
        : "claude model auth must be login, reuse, setup-token, or none"
    );
  }
  if (authMode === "none") {
    const selection = writeInfiniteOsModelSelection({ provider, model }, env as NodeJS.ProcessEnv);
    return {
      ...selection,
      auth: {
        ok: false,
        provider,
        mode: "none",
        skipped: true,
        ready: false,
        reason: "auth_mode_none",
        nextStep: modelAuthRerunCommand(provider)
      }
    };
  }

  const auth = await setupAuth(provider, authMode, env);
  const readiness = await verifyInfiniteOsProviderAuth(provider, env);
  if (!readiness.ok) {
    throw new Error(
      [
        `${provider} model auth is not ready after ${authMode}: ${readiness.reason}.`,
        `Run \`${modelAuthRerunCommand(provider)}\`, then retry \`infinite model use ${provider} ${model}\`.`
      ].join(" ")
    );
  }
  const selection = writeInfiniteOsModelSelection({ provider, model }, env as NodeJS.ProcessEnv);
  return {
    ...selection,
    auth: {
      ...auth,
      ready: true,
      verifiedSource: readiness.source
    }
  };
}

async function authCommand(args: string[], env: CliEnv): Promise<Record<string, unknown>> {
  const [subcommand, provider, ...rest] = args;
  if (subcommand === "status") {
    const summary = readInfiniteOsAuthSummary(env as NodeJS.ProcessEnv);
    const providers = authStatusProviders(summary.providers, env);
    const selectedProviders =
      provider === "codex" || provider === "claude"
        ? providers.filter((record) => record.provider === provider)
        : providers;
    return {
      ok: true,
      provider: provider ?? "all",
      authPath: summary.authPath,
      hasInfiniteOsAuth: summary.hasInfiniteOsAuth,
      providers: await Promise.all(selectedProviders.map(async (record) => {
        const readiness = await verifyInfiniteOsProviderAuth(record.provider, env);
        return {
          ...record,
          ready: readiness.ok,
          reason: readiness.reason
        };
      })),
      selectedModel: readInfiniteOsModelSelection(env as NodeJS.ProcessEnv)
    };
  }
  if (subcommand === "import" && provider === "codex") {
    return codexImportStatus(env);
  }
  if (subcommand !== "login") {
    throw new Error("auth requires login, import, or status");
  }
  if (provider === "codex") {
    const force = hasFlag(rest, "--force") || hasFlag(rest, "--reauth");
    return codexLogin(env, { force });
  }
  if (provider === "claude") {
    const mode = optionValue(rest, "--mode") ?? "reuse";
    if (mode === "reuse") {
      return claudeCredentialStatus(env, "reuse");
    }
    if (mode === "setup-token") {
      const result = spawnSync(env.GROWTH_OS_CLAUDE_BIN ?? "claude", ["setup-token"], {
        env: { ...process.env, ...env },
        stdio: "inherit"
      });
      if (result.error) {
        throw result.error;
      }
      return {
        ...claudeCredentialStatus(env, "setup-token"),
        setupTokenExitCode: result.status
      };
    }
    if (mode === "growth-os-oauth") {
      return {
        ok: true,
        provider: "claude",
        mode,
        nextStep: "growth_os_anthropic_pkce_not_wired_in_this_pass"
      };
    }
    throw new Error("claude auth mode must be reuse, setup-token, or growth-os-oauth");
  }
  throw new Error("auth login requires provider codex or claude");
}

// `codex <login|import|status>` — a provider-first surface that mirrors the
// upstream `codex` CLI (better muscle memory than `auth login codex`). `auth …`
// stays as an alias. `codex login --force`/`--reauth` bypasses the idempotent
// reuse short-circuit and always runs a fresh Infinite OS-owned device login.
async function codexCommand(args: string[], env: CliEnv): Promise<Record<string, unknown>> {
  const [subcommand = "login", ...rest] = args;
  if (subcommand === "login") {
    const force = hasFlag(rest, "--force") || hasFlag(rest, "--reauth");
    return codexLogin(env, { force });
  }
  if (subcommand === "import") {
    return codexImportStatus(env);
  }
  if (subcommand === "status") {
    return authCommand(["status", "codex"], env);
  }
  throw new Error("codex requires login, import, or status");
}

async function verifyInfiniteOsProviderAuth(
  provider: InfiniteOsModelProvider,
  env: CliEnv
): Promise<{ ok: boolean; provider: InfiniteOsModelProvider; source?: string; reason: string }> {
  const record = readInfiniteOsAuthState(env as NodeJS.ProcessEnv).providers[provider];
  const claudeCredentials = provider === "claude" ? readClaudeCodeCredentials(env) : null;
  const claudePrefersDiscoveredCredentials =
    provider === "claude" &&
    Boolean(claudeCredentials?.source) &&
    (record?.source === "macos-keychain" || record?.source === "claude-code-credentials-file");
  if (provider === "claude" && env.ANTHROPIC_API_KEY) {
    return { ok: true, provider, source: "anthropic-api-key-dev-fallback", reason: "env_auth_ready" };
  }
  if (
    provider === "claude" &&
    record?.token &&
    isClaudeCodeOauthToken(record.token)
  ) {
    return { ok: false, provider, source: record.source, reason: CLAUDE_OAUTH_UNSUPPORTED_REASON };
  }
  if (record?.token && !isExpired(record.expiresAt) && !claudePrefersDiscoveredCredentials) {
    return { ok: true, provider, source: record.source, reason: "growth_os_auth_ready" };
  }
  if (provider === "codex" && env.OPENAI_API_KEY) {
    return { ok: true, provider, source: "openai-api-key-dev-fallback", reason: "env_auth_ready" };
  }
  if (provider === "codex") {
    const imported = codexImportCandidate(env);
    if (imported?.token) {
      return { ok: true, provider, source: imported.path, reason: "codex_cli_auth_ready" };
    }
  }
  if (provider === "claude" && (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_TOKEN)) {
    const bearerToken = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_TOKEN;
    if (isClaudeCodeOauthToken(bearerToken)) {
      return { ok: false, provider, source: "claude-bearer-env", reason: CLAUDE_OAUTH_UNSUPPORTED_REASON };
    }
    return { ok: true, provider, source: "claude-bearer-env", reason: "env_auth_ready" };
  }
  if (provider === "claude") {
    const tokens = claudeCredentials?.tokens ?? {};
    if (claudeCredentials?.source && isClaudeCodeOauthToken(tokens.token)) {
      return { ok: false, provider, source: claudeCredentials.source, reason: CLAUDE_OAUTH_UNSUPPORTED_REASON };
    }
    if (
      claudeCredentials?.source &&
      tokens.token &&
      !isExpired(tokens.expiresAt) &&
      !isClaudeCodeOauthToken(tokens.token)
    ) {
      return { ok: true, provider, source: claudeCredentials.source, reason: "claude_code_credentials_ready" };
    }
    if (claudeCredentials?.source && tokens.refreshToken) {
      const refreshed = await refreshInfiniteOsProviderAuth(
        provider,
        {
          provider,
          source: claudeCredentials.source,
          authMode: "reuse",
          token: tokens.token,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt
        },
        env
      );
      if (refreshed?.token && !isExpired(refreshed.expiresAt)) {
        return { ok: true, provider, source: refreshed.source, reason: "claude_code_credentials_refreshed" };
      }
      return { ok: false, provider, source: claudeCredentials.source, reason: "claude_code_credentials_refresh_failed" };
    }
  }
  if (record?.refreshToken) {
    const refreshed = await refreshInfiniteOsProviderAuth(provider, record, env);
    if (refreshed?.token && !isExpired(refreshed.expiresAt)) {
      return { ok: true, provider, source: refreshed.source, reason: "stored_auth_refreshed" };
    }
    return { ok: false, provider, source: record.source, reason: "stored_auth_refresh_failed" };
  }
  if (record?.token && isExpired(record.expiresAt)) {
    return { ok: false, provider, source: record.source, reason: "stored_auth_expired" };
  }
  if (record) {
    return { ok: false, provider, source: record.source, reason: "stored_auth_missing_token" };
  }
  return { ok: false, provider, reason: "auth_missing" };
}

async function refreshInfiniteOsProviderAuth(
  provider: InfiniteOsModelProvider,
  auth: InfiniteOsAuthRecord,
  env: CliEnv
): Promise<InfiniteOsAuthRecord | null> {
  if (provider === "codex") {
    return refreshStoredCodexAuth(auth, env);
  }
  return refreshStoredClaudeAuth(auth, env);
}

async function refreshStoredCodexAuth(
  auth: InfiniteOsAuthRecord,
  env: CliEnv
): Promise<InfiniteOsAuthRecord | null> {
  if (!auth.refreshToken) {
    return null;
  }
  const response = await fetch(env.GROWTH_OS_CODEX_TOKEN_URL ?? DEFAULT_CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
      client_id: CODEX_OAUTH_CLIENT_ID
    }).toString()
  }).catch(() => null);
  if (!response?.ok) {
    return null;
  }
  return persistRefreshedAuth("codex", auth, await response.json().catch(() => ({})), env);
}

async function refreshStoredClaudeAuth(
  auth: InfiniteOsAuthRecord,
  env: CliEnv
): Promise<InfiniteOsAuthRecord | null> {
  if (!auth.refreshToken) {
    return null;
  }
  const refreshUrls = env.GROWTH_OS_CLAUDE_REFRESH_URL
    ? [env.GROWTH_OS_CLAUDE_REFRESH_URL]
    : DEFAULT_CLAUDE_REFRESH_URLS;
  for (const refreshUrl of refreshUrls) {
    const response = await fetch(refreshUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "claude-cli/unknown (external, cli)"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
        client_id: CLAUDE_CODE_OAUTH_CLIENT_ID
      }).toString()
    }).catch(() => null);
    if (!response?.ok) {
      continue;
    }
    const refreshed = persistRefreshedAuth("claude", auth, await response.json().catch(() => ({})), env);
    if (refreshed) {
      return refreshed;
    }
  }
  return null;
}

function persistRefreshedAuth(
  provider: InfiniteOsModelProvider,
  auth: InfiniteOsAuthRecord,
  json: unknown,
  env: CliEnv
): InfiniteOsAuthRecord | null {
  if (!isRecord(json)) {
    return null;
  }
  const token = stringValue(json.access_token) ?? stringValue(json.accessToken) ?? stringValue(json.token);
  if (!token) {
    return null;
  }
  const refreshed: InfiniteOsAuthRecord = {
    ...auth,
    provider,
    token,
    refreshToken:
      stringValue(json.refresh_token) ??
      stringValue(json.refreshToken) ??
      auth.refreshToken,
    expiresAt:
      stringValue(json.expires_at) ??
      stringValue(json.expiresAt) ??
      expiresAtFromSeconds(json.expires_in) ??
      expiresAtFromMilliseconds(json.expires_at_ms) ??
      auth.expiresAt,
    importedAt: new Date().toISOString()
  };
  writeInfiniteOsAuthRecord(refreshed, env as NodeJS.ProcessEnv);
  return refreshed;
}

function isUsableAuthRecord(record: {
  token?: string;
  refreshToken?: string;
  expiresAt?: string;
}): boolean {
  if (!record.token && !record.refreshToken) {
    return false;
  }
  if (!isExpired(record.expiresAt)) {
    return true;
  }
  return Boolean(record.refreshToken);
}

function modelAuthRerunCommand(provider: InfiniteOsModelProvider): string {
  return provider === "codex"
    ? "infinite codex login"
    : "infinite auth login claude --mode setup-token";
}

function authStatusProviders(
  storedProviders: Array<{
    provider: InfiniteOsModelProvider;
    source: string;
    authMode: string;
    expiresAt: string | null;
    hasToken: boolean;
    hasRefreshToken: boolean;
  }>,
  env: CliEnv
) {
  const providers = [...storedProviders];
  const stored = new Set(providers.map((record) => record.provider));
  if (!stored.has("codex") && env.OPENAI_API_KEY) {
    providers.push({
      provider: "codex",
      source: "openai-api-key-dev-fallback",
      authMode: "api-key-fallback",
      expiresAt: null,
      hasToken: true,
      hasRefreshToken: false
    });
  }
  if (!stored.has("codex")) {
    const imported = codexImportCandidate(env);
    if (imported?.token || imported?.refreshToken) {
      providers.push({
        provider: "codex",
        source: imported.path,
        authMode: imported.authMode ?? "import",
        expiresAt: imported.expiresAt ?? null,
        hasToken: Boolean(imported.token),
        hasRefreshToken: Boolean(imported.refreshToken)
      });
    }
  }
  if (!stored.has("claude")) {
    const claudeCredentials = readClaudeCodeCredentials(env);
    if (claudeCredentials?.source) {
      providers.push({
        provider: "claude",
        source: claudeCredentials.source,
        authMode: "reuse",
        expiresAt: claudeCredentials.tokens.expiresAt ?? null,
        hasToken: Boolean(claudeCredentials.tokens.token),
        hasRefreshToken: Boolean(claudeCredentials.tokens.refreshToken)
      });
      return providers;
    }
  }
  if (!stored.has("claude") && (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_TOKEN)) {
    providers.push({
      provider: "claude",
      source: "claude-bearer-env",
      authMode: "setup-token-env",
      expiresAt: null,
      hasToken: true,
      hasRefreshToken: false
    });
  } else if (!stored.has("claude") && env.ANTHROPIC_API_KEY) {
    providers.push({
      provider: "claude",
      source: "anthropic-api-key-dev-fallback",
      authMode: "api-key-fallback",
      expiresAt: null,
      hasToken: true,
      hasRefreshToken: false
    });
  }
  return providers;
}

export function renderDetectedModelAuthStatus(env: CliEnv): string {
  const lines = ["Detected credentials:"];
  const stored = readInfiniteOsAuthState(env as NodeJS.ProcessEnv).providers;
  const codexStatus = stored.codex?.source
    ? `Infinite OS auth (${stored.codex.source})`
    : codexImportCandidate(env)?.path
      ? `Codex CLI auth (${codexImportCandidate(env)?.path})`
      : env.OPENAI_API_KEY
        ? "OPENAI_API_KEY env fallback"
        : "none detected";
  const claudeCredentials = readClaudeCodeCredentials(env);
  const claudeStatus = stored.claude?.source
    ? `Infinite OS auth (${stored.claude.source})`
    : claudeCredentials?.source
      ? `Claude Code credentials (${claudeCredentials.source})`
      : env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_TOKEN
        ? "Claude bearer env token"
        : env.ANTHROPIC_API_KEY
          ? "ANTHROPIC_API_KEY env fallback"
          : "none detected";
  lines.push(`  Codex: ${codexStatus}`);
  lines.push(`  Claude: ${claudeStatus}`);
  return lines.join("\n");
}

async function codexLogin(
  env: CliEnv,
  options: { force?: boolean } = {}
): Promise<Record<string, unknown>> {
  // Default is idempotent reuse (fast, no surprise browser pop). `--force`/
  // `--reauth` skips every reuse path and runs a fresh device login, so a user
  // can re-authenticate even when a valid session already exists.
  if (!options.force) {
    const existing = readInfiniteOsAuthState(env as NodeJS.ProcessEnv).providers.codex;
    if (existing?.token && !isExpired(existing.expiresAt)) {
      return {
        ok: true,
        provider: "codex",
        mode: "login",
        source: existing.source,
        authMode: existing.authMode,
        reused: true
      };
    }
    if (existing?.refreshToken) {
      const refreshed = await refreshStoredCodexAuth(existing, env);
      if (refreshed?.token && !isExpired(refreshed.expiresAt)) {
        return {
          ok: true,
          provider: "codex",
          mode: "login",
          source: refreshed.source,
          authMode: refreshed.authMode,
          reused: true,
          refreshed: true
        };
      }
    }
    const importCandidate = codexImportCandidate(env);
    if (importCandidate?.token || importCandidate?.refreshToken) {
      const imported = codexImportStatus(env);
      if (imported.imported) {
        return {
          ...imported,
          mode: "login",
          reused: true
        };
      }
    }
  }
  const tokens = await runCodexDeviceCodeLogin(env);
  const saved = writeInfiniteOsAuthRecord(
    {
      provider: "codex",
      source: "growth-os-codex",
      authMode: "device-code",
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt
    },
    env as NodeJS.ProcessEnv
  );
  return {
    ok: true,
    provider: "codex",
    mode: "login",
    source: saved.source,
    authMode: saved.authMode,
    reused: false,
    authPath: saved.path
  };
}

async function runCodexDeviceCodeLogin(env: CliEnv): Promise<{
  token?: string;
  refreshToken?: string;
  expiresAt?: string;
}> {
  const authBaseUrl = (env.GROWTH_OS_CODEX_AUTH_BASE_URL ?? DEFAULT_CODEX_AUTH_BASE_URL).replace(/\/$/, "");
  const tokenUrl = env.GROWTH_OS_CODEX_TOKEN_URL ?? DEFAULT_CODEX_TOKEN_URL;
  const userCodeResponse = await fetchJson(`${authBaseUrl}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID })
  }, "Codex device-code request");
  const userCode = stringValue(userCodeResponse.user_code);
  const deviceAuthId = stringValue(userCodeResponse.device_auth_id);
  const pollMs = numberEnv(env.GROWTH_OS_CODEX_AUTH_POLL_MS, numberValue(userCodeResponse.interval, 3) * 1000);
  if (!userCode || !deviceAuthId) {
    throw new Error("Codex device-code response was missing user_code or device_auth_id");
  }

  const verificationUrl = `${authBaseUrl}/codex/device`;
  if (env.GROWTH_OS_CODEX_AUTH_SILENT !== "1") {
    const browser = openBrowserForAuth(verificationUrl, env);
    output.write(
      [
        "Open this URL in your browser:",
        `  ${verificationUrl}`,
        "Enter this code:",
        `  ${userCode}`,
        browser.opened ? "Browser opened for Codex sign-in." : "Browser was not opened automatically.",
        "Waiting for Codex sign-in..."
      ].join("\n") + "\n"
    );
  }

  const authorization = await pollCodexAuthorizationCode(authBaseUrl, deviceAuthId, userCode, env, pollMs);
  const tokenResponse = await fetchJson(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorization.authorizationCode,
      redirect_uri: `${authBaseUrl}/deviceauth/callback`,
      client_id: CODEX_OAUTH_CLIENT_ID,
      code_verifier: authorization.codeVerifier
    }).toString()
  }, "Codex token exchange");
  const token = stringValue(tokenResponse.access_token) ?? stringValue(tokenResponse.accessToken) ?? stringValue(tokenResponse.token);
  if (!token) {
    throw new Error("Codex token exchange did not return an access token");
  }
  return {
    token,
    refreshToken:
      stringValue(tokenResponse.refresh_token) ??
      stringValue(tokenResponse.refreshToken) ??
      stringValue(tokenResponse.refresh),
    expiresAt:
      stringValue(tokenResponse.expires_at) ??
      stringValue(tokenResponse.expiresAt) ??
      expiresAtFromSeconds(tokenResponse.expires_in)
  };
}

async function pollCodexAuthorizationCode(
  authBaseUrl: string,
  deviceAuthId: string,
  userCode: string,
  env: CliEnv,
  pollMs: number
): Promise<{ authorizationCode: string; codeVerifier: string }> {
  const startedAt = Date.now();
  const timeoutMs = numberEnv(env.GROWTH_OS_CODEX_AUTH_TIMEOUT_MS, 15 * 60 * 1000);
  while (Date.now() - startedAt <= timeoutMs) {
    if (pollMs > 0) {
      await delay(pollMs);
    }
    const response = await fetch(`${authBaseUrl}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode })
    });
    if (response.status === 403 || response.status === 404) {
      continue;
    }
    const json = await responseJson(response, "Codex device-code poll");
    const authorizationCode = stringValue(json.authorization_code) ?? stringValue(json.authorizationCode);
    const codeVerifier = stringValue(json.code_verifier) ?? stringValue(json.codeVerifier);
    if (!authorizationCode || !codeVerifier) {
      throw new Error("Codex device-code poll response was missing authorization_code or code_verifier");
    }
    return { authorizationCode, codeVerifier };
  }
  throw new Error("Codex login timed out before authorization completed");
}

async function fetchJson(url: string, init: RequestInit, label: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  return responseJson(response, label);
}

/** Heuristic remote/SSH detection so we can warn about the loopback redirect (#7). */
function isRemoteSession(env: CliEnv): boolean {
  return Boolean(env.SSH_CONNECTION?.trim() || env.SSH_TTY?.trim());
}

/** True when the OAuth redirect targets a loopback host — the callback lands on THIS box. */
function isLoopbackRedirect(redirectUri: string | undefined): boolean {
  if (!redirectUri) {
    return false;
  }
  try {
    const host = new URL(redirectUri).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

/**
 * Fallback GA4 guidance renderer used when the loaded setup module isn't injected (tests /
 * the bootstrap start site). Mirrors provider-guidance.ts `quick_connect`/`byo`. Kept minimal
 * and load-bearing on the "paste this link" line + the remote/SSH note.
 */
function localGa4Guidance(
  step: GuidanceStep,
  ctx: { authorizationUrl?: string; remoteLoopbackHint?: boolean }
): string {
  const lines: string[] = [
    "Connecting Google Analytics — opening your browser now.",
    "What to do there:",
    "  1. Sign in to Google (Infinite never sees your password).",
    step === "byo"
      ? "  2. If you see \"Google hasn't verified this app\", click Advanced → Continue (it's your own unverified app — expected)."
      : "  2. If you see \"Google hasn't verified this app\", click Advanced → Continue (it's Infinite's app, pending Google review).",
    "  3. Approve the Analytics permissions and accept any Terms of Service.",
    "Why: lets Infinite create/read your GA4 property + web stream and capture the Measurement ID (G-…) to install on your site.",
    "Confirm: this terminal continues automatically once Google redirects back (or press Ctrl-C for more options)."
  ];
  const url = ctx.authorizationUrl?.trim();
  if (url) {
    lines.push(`Didn't open / wrong machine? Paste this link:\n  ${url}`);
    if (ctx.remoteLoopbackHint) {
      lines.push(
        "Remote/SSH note: the sign-in redirect lands on 127.0.0.1 of THIS machine, not your browser's. " +
          "If your browser is on a different machine, use your own Google Cloud app or install the tag manually instead."
      );
    }
  }
  lines.push("Skip: press Ctrl-C to use your own Google Cloud app or install the tag manually later.");
  return lines.join("\n");
}

function openBrowserForAuth(url: string, env: CliEnv): { opened: boolean; command?: string; reason?: string } {
  if (env.GROWTH_OS_CLI_DRY_RUN === "1") {
    return { opened: false, reason: "dry_run" };
  }
  if (env.GROWTH_OS_CLI_NONINTERACTIVE === "1" || input.isTTY !== true) {
    return { opened: false, reason: "noninteractive" };
  }
  const command =
    env.GROWTH_OS_AUTH_BROWSER_BIN ??
    (process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open");
  const executable = process.platform === "win32" && !env.GROWTH_OS_AUTH_BROWSER_BIN ? "cmd" : command;
  const args = process.platform === "win32" && !env.GROWTH_OS_AUTH_BROWSER_BIN ? ["/c", "start", "", url] : [url];
  const result = spawnSync(executable, args, {
    stdio: ["ignore", "ignore", "ignore"]
  });
  if (result.error || result.status !== 0) {
    return { opened: false, command: executable, reason: result.error?.message ?? `exit_${String(result.status)}` };
  }
  return { opened: true, command: executable };
}

async function responseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed with status ${response.status}: ${text}`);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to the normalized error below.
  }
  throw new Error(`${label} returned invalid JSON`);
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function expiresAtFromSeconds(value: unknown): string | undefined {
  const seconds = numberValue(value, Number.NaN);
  if (!Number.isFinite(seconds)) {
    return undefined;
  }
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function expiresAtFromMilliseconds(value: unknown): string | undefined {
  const milliseconds = numberValue(value, Number.NaN);
  if (!Number.isFinite(milliseconds)) {
    return undefined;
  }
  return new Date(milliseconds).toISOString();
}

function isExpired(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function isClaudeCodeOauthToken(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value.startsWith("sk-ant-oat") || value.startsWith("cc-") || value.startsWith("eyJ");
}

function codexImportStatus(env: CliEnv): Record<string, unknown> {
  const candidate = codexImportCandidate(env);
  if (candidate?.path) {
    const tokens = candidate;
    const source = candidate.path;
    if (tokens.token || tokens.refreshToken) {
      writeInfiniteOsAuthRecord(
        {
          provider: "codex",
          source: "codex-cli-import",
          authMode: "device-code",
          token: tokens.token,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt
        },
        env as NodeJS.ProcessEnv
      );
      return {
        ok: true,
        provider: "codex",
        mode: "import",
        source,
        imported: true
      };
    }
  }
  return {
    ok: true,
    provider: "codex",
    mode: "import",
    source: candidate?.path ?? null,
    imported: false,
    nextStep: candidate?.path ? "codex_import_copy_not_wired_in_this_pass" : "no_codex_cli_auth_found"
  };
}

function codexImportCandidate(
  env: CliEnv
): ({ path: string } & { token?: string; refreshToken?: string; expiresAt?: string; authMode?: string }) | null {
  const candidates = [
    ...(env.CODEX_HOME ? [join(env.CODEX_HOME, "auth.json")] : []),
    join(env.HOME ?? "", ".codex", "auth.json")
  ].filter((path) => path !== join("", ".codex", "auth.json"));
  const source = candidates.find((path) => existsSync(path));
  if (!source) {
    return null;
  }
  return {
    path: source,
    ...readCodexTokens(source)
  };
}

function claudeCredentialStatus(env: CliEnv, mode: string): Record<string, unknown> {
  const credentials = readClaudeCodeCredentials(env);
  const tokens = credentials?.tokens ?? {};
  const usable = isUsableAuthRecord(tokens);
  if (usable && (mode === "reuse" || mode === "setup-token")) {
    writeInfiniteOsAuthRecord(
      {
        provider: "claude",
        source: credentials?.source ?? "claude-code",
        authMode: mode,
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt
      },
      env as NodeJS.ProcessEnv
    );
  }
  return {
    ok: true,
    provider: "claude",
    mode,
    source: credentials?.source ?? null,
    hasCredentials: Boolean(credentials) && usable,
    credentialsPath: credentials?.path ?? null,
    staleCredentials: Boolean(credentials) && !usable
  };
}

function readClaudeCodeCredentials(env: CliEnv): {
  source: string;
  path?: string;
  tokens: { token?: string; refreshToken?: string; expiresAt?: string };
} | null {
  const keychainCredentials = readClaudeCodeCredentialsFromKeychain(env);
  if (keychainCredentials) {
    return keychainCredentials;
  }

  const home = env.HOME;
  const credentialsPath = home ? join(home, ".claude", ".credentials.json") : undefined;
  if (!credentialsPath || !existsSync(credentialsPath)) {
    return null;
  }
  const tokens = readClaudeTokens(credentialsPath);
  if (!tokens.token && !tokens.refreshToken) {
    return null;
  }
  return {
    source: "claude-code-credentials-file",
    path: credentialsPath,
    tokens
  };
}

function readClaudeCodeCredentialsFromKeychain(env: CliEnv): {
  source: string;
  tokens: { token?: string; refreshToken?: string; expiresAt?: string };
} | null {
  const hasIsolatedHome = Boolean(env.HOME && process.env.HOME && env.HOME !== process.env.HOME);
  if (process.platform !== "darwin" || hasIsolatedHome) {
    return null;
  }
  const result = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    const tokens = tokensFromClaudeRecord(parsed);
    if (!tokens.token && !tokens.refreshToken) {
      return null;
    }
    return {
      source: "macos-keychain",
      tokens
    };
  } catch {
    return null;
  }
}

function readCodexTokens(path: string): { token?: string; refreshToken?: string; expiresAt?: string; authMode?: string } {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : parsed;
  return {
    token: stringValue(tokens.access_token) ?? stringValue(tokens.accessToken) ?? stringValue(tokens.token),
    refreshToken:
      stringValue(tokens.refresh_token) ?? stringValue(tokens.refreshToken) ?? stringValue(tokens.refresh),
    expiresAt: stringValue(tokens.expires_at) ?? stringValue(tokens.expiresAt),
    authMode: stringValue(parsed.auth_mode) ?? stringValue(parsed.authMode)
  };
}

function readClaudeTokens(path: string): { token?: string; refreshToken?: string; expiresAt?: string } {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return tokensFromClaudeRecord(parsed);
}

function tokensFromClaudeRecord(parsed: Record<string, unknown>): {
  token?: string;
  refreshToken?: string;
  expiresAt?: string;
} {
  const oauth = isRecord(parsed.claudeAiOauth)
    ? parsed.claudeAiOauth
    : isRecord(parsed.oauth)
      ? parsed.oauth
      : parsed;
  return {
    token: stringValue(oauth.accessToken) ?? stringValue(oauth.access_token) ?? stringValue(oauth.token),
    refreshToken:
      stringValue(oauth.refreshToken) ?? stringValue(oauth.refresh_token) ?? stringValue(oauth.refresh),
    expiresAt: stringValue(oauth.expiresAt) ?? stringValue(oauth.expires_at)
  };
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index !== -1) {
    return args[index + 1];
  }
  const prefix = `${option}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function chatRequest(
  message: string,
  env: CliEnv,
  sessionId?: string,
  agentRuntime?: CliAgentRuntimeSource,
  onProgress?: (event: ChatProgressEvent) => void,
  progressMode: ChatProgressMode = "rich"
): Promise<unknown> {
  if (!agentRuntime) {
    const readiness = await localChatReadiness(env);
    if (!readiness.ok) {
      return readiness;
    }
  }
  try {
    return await withCliAgentRuntime(env, agentRuntime, (runtime) =>
      runtime.chat({ message, sessionId, progressMode, onProgress })
    );
  } catch (error) {
    if (isWorkspaceBootstrapError(error)) {
      return workspaceNotReadyResult(env, error);
    }
    throw error;
  }
}

export async function localChatReadiness(env: CliEnv): Promise<Record<string, unknown> & { ok: boolean }> {
  const readiness = await readSetupReadiness(env);
  if (readiness.llmQuery === "ready") {
    return { ok: true, workspaceRoot: readiness.workspaceRoot, setupReadiness: readiness };
  }
  return workspaceNotReadyFromSetupReadiness(readiness);
}

export async function readSetupReadiness(env: CliEnv): Promise<SetupReadiness> {
  const workspaceRoot = workspaceRootFor(env);
  const blockingReasons: string[] = [];
  let config: InfiniteOsConfig | undefined;
  let runtimeConfig: SetupReadiness["runtimeConfig"] = "missing";
  let runtimeServices: SetupReadiness["runtimeServices"] = "unknown";
  let database: SetupReadiness["database"] = "missing";
  try {
    config = loadInfiniteOsConfig({ workspaceRoot, env: env as NodeJS.ProcessEnv });
    runtimeConfig = "configured";
    database = "unknown";
  } catch (error) {
    blockingReasons.push(`runtime_config_incomplete: ${error instanceof Error ? error.message : String(error)}`);
  }

  const selection = readInfiniteOsModelSelection(env as NodeJS.ProcessEnv);
  let model: SetupReadiness["model"] = "missing";
  let auth: SetupReadiness["auth"] = "missing";
  let authProvider: SetupReadiness["authProvider"] | undefined;
  if (!selection.provider || !selection.model) {
    blockingReasons.push("model_missing: Choose Codex or Claude before chatting.");
  } else {
    model = "selected";
    const authReadiness = await verifyInfiniteOsProviderAuth(selection.provider, env);
    authProvider = {
      provider: authReadiness.provider,
      source: authReadiness.source,
      reason: authReadiness.reason
    };
    if (authReadiness.ok) {
      auth = "ready";
    } else {
      blockingReasons.push(`model_auth_incomplete: ${selection.provider} auth is not ready: ${authReadiness.reason}.`);
    }
  }

  const sourceCheck = config
    ? await readConnectedSourceReadiness(env, config)
    : { connectors: "none" as const, connectedSourceCount: 0, database, runtimeServices };
  database = sourceCheck.database;
  runtimeServices = sourceCheck.runtimeServices;
  if (sourceCheck.database === "missing") {
    blockingReasons.push("database_missing: Runtime database is not reachable or migrated.");
  }
  if (sourceCheck.connectors === "none") {
    blockingReasons.push("connectors_missing: Connect at least one marketing data source.");
  }

  const activeSetupRun = await readActiveSetupRunSummary(env, config);
  const llmQuery =
    runtimeConfig === "configured" &&
    database !== "missing" &&
    model === "selected" &&
    auth === "ready" &&
    sourceCheck.connectors === "connected"
      ? "ready"
      : "blocked";
  return {
    ok: llmQuery === "ready",
    workspaceRoot,
    runtimeConfig,
    runtimeServices,
    database,
    model,
    auth,
    connectors: sourceCheck.connectors,
    llmQuery,
    blockingReasons,
    modelSelection: {
      provider: selection.provider,
      model: selection.model
    },
    authProvider,
    activeSetupRun,
    connectedSourceCount: sourceCheck.connectedSourceCount
  };
}

interface SetupRunSummaryRow {
  id: string;
  tool?: string | null;
  provider?: string | null;
  status?: string | null;
  updated_at?: string | Date | null;
  phase_state?: Record<string, unknown> | null;
  pending_handoff?: Record<string, unknown> | null;
  site_id?: string | null;
  site_url?: string | null;
  site_repo_path?: string | null;
  site_app_dir?: string | null;
  site_framework?: string | null;
  site_business_type?: string | null;
}

const SETUP_RUN_SUMMARY_SELECT = `
  select
    r.id,
    r.tool,
    r.provider,
    r.status,
    r.updated_at,
    r.phase_state,
    r.pending_handoff,
    r.site_id,
    s.url as site_url,
    s.repo_path as site_repo_path,
    s.app_dir as site_app_dir,
    s.framework as site_framework,
    s.business_type as site_business_type
  from setup_runs r
  left join workspace_sites s on s.id = r.site_id
`;

async function readActiveSetupRunSummary(
  env: CliEnv,
  config?: InfiniteOsConfig
): Promise<SetupRunSummary | null> {
  let workspaceId: string;
  try {
    workspaceId = workspaceIdFor(env);
  } catch (error) {
    if (error instanceof NoActiveProjectError) {
      return null;
    }
    throw error;
  }

  if (config) {
    // Probe the app API only when there's a daemon to talk to (explicit
    // GROWTH_OS_API_URL, network mode, or a live discovered daemon). Otherwise go
    // straight to the DB — the hang fix (design §3/§7): a pure-local CLI shouldn't
    // block on a (possibly squatted) config port here.
    const shouldProbeApi =
      env.GROWTH_OS_API_URL !== undefined ||
      config.runtimeMode === "network" ||
      (await resolveDaemonEndpoint(env as NodeJS.ProcessEnv)) !== null;
    if (shouldProbeApi) {
      try {
        // Cap the probe so a missing/zombie daemon falls through to the DB fast.
        const payload = await apiRequest("/setup/runs/active", env, {
          config,
          timeoutMs: readinessProbeTimeoutMs(env)
        });
        const run = isRecord(payload) ? normalizeSetupRunSummary(payload.run) : null;
        if (run || (isRecord(payload) && payload.run === null)) {
          return run;
        }
      } catch {
        // Fall back to direct DB access when the app API is not reachable.
      }
    }

    try {
      const db = createInfiniteOsDb(config.databaseUrl);
      try {
        const row = await db.one<SetupRunSummaryRow>(
          `
            ${SETUP_RUN_SUMMARY_SELECT}
            where r.workspace_id = $1 and r.status in ('running', 'paused_handoff')
            order by r.updated_at desc, r.created_at desc
            limit 1
          `,
          [workspaceId]
        );
        return normalizeSetupRunSummary(row);
      } finally {
        await db.close();
      }
    } catch {
      return null;
    }
  }

  return null;
}

async function readSetupRunSummaryById(
  runId: string,
  env: CliEnv,
  config: InfiniteOsConfig,
  workspaceId: string
): Promise<SetupRunSummary | null> {
  try {
    const payload = await apiRequest(`/setup/runs/${encodeURIComponent(runId)}`, env, { config });
    const run = isRecord(payload) ? normalizeSetupRunSummary(payload.run) : null;
    if (run || (isRecord(payload) && payload.run === null)) {
      return run;
    }
  } catch {
    // Fall back to direct DB access when the app API is not reachable.
  }

  try {
    const db = createInfiniteOsDb(config.databaseUrl);
    try {
      const row = await db.one<SetupRunSummaryRow>(
        `
          ${SETUP_RUN_SUMMARY_SELECT}
          where r.workspace_id = $1 and r.id = $2
          limit 1
        `,
        [workspaceId, runId]
      );
      return normalizeSetupRunSummary(row);
    } finally {
      await db.close();
    }
  } catch {
    return null;
  }
}

export async function resolveSetupResumePostHogResumeSecrets(
  args: string[],
  env: CliEnv,
  workspaceId: string,
  deps: {
    interactive?: boolean;
    readRunSummary?: (runId: string) => Promise<SetupRunSummary | null>;
    promptSecret?: (question: string) => Promise<string | undefined>;
    promptChoice?: (
      question: string,
      choices: string[],
      defaultIndex?: number,
      options?: { description?: string }
    ) => Promise<number>;
    promptUrl?: (question: string, defaultValue?: string) => Promise<string>;
    loadConfig?: () => InfiniteOsConfig;
  } = {}
): Promise<SetupResumePostHogSecrets | undefined> {
  const explicitKeyFile = optionValue(args, "--posthog-personal-api-key-file");
  const explicitKey = optionValueAny(args, "--personal-api-key", "--posthog-personal-api-key") ??
    (explicitKeyFile
      ? readLocalSecretFileValue(explicitKeyFile, "PostHog personal API key")
      : undefined);
  const explicitApiHost = normalizePostHogApiHost(optionValueAny(args, "--posthog-api-host", "--api-host"));

  const [subcommand, runId] = args;
  if (subcommand !== "resume" || !runId) {
    return buildSetupResumePostHogSecrets(explicitKey, explicitApiHost);
  }
  if ((deps.interactive ?? input.isTTY === true) !== true || env.GROWTH_OS_CLI_NONINTERACTIVE === "1") {
    return buildSetupResumePostHogSecrets(explicitKey, explicitApiHost);
  }

  const summary = deps.readRunSummary
    ? await deps.readRunSummary(runId)
    : await (() => {
        const config =
          deps.loadConfig?.() ??
          (() => {
            try {
              return loadInfiniteOsConfig({
                workspaceRoot: workspaceRootFor(env),
                env: env as NodeJS.ProcessEnv
              });
            } catch {
              return null;
            }
          })();
        if (!config) {
          return Promise.resolve<SetupRunSummary | null>(null);
        }
        return readSetupRunSummaryById(runId, env, config, workspaceId);
      })();
  if (!summary || !setupResumeNeedsPostHogPersonalApiKey(summary)) {
    return buildSetupResumePostHogSecrets(explicitKey, explicitApiHost);
  }
  const personalApiKey = explicitKey ?? await (deps.promptSecret ?? ((question) => promptSecretValue(question)))(
    "Paste PostHog personal API key (starts with phx_; stored encrypted): "
  );
  if (!personalApiKey) {
    return buildSetupResumePostHogSecrets(undefined, explicitApiHost);
  }
  const apiHost = explicitApiHost ?? await promptSetupResumePostHogApiHost(summary, deps);
  return buildSetupResumePostHogSecrets(personalApiKey, apiHost);
}

export async function resolveSetupResumePostHogPersonalApiKey(
  args: string[],
  env: CliEnv,
  workspaceId: string,
  deps: {
    interactive?: boolean;
    readRunSummary?: (runId: string) => Promise<SetupRunSummary | null>;
    promptSecret?: (question: string) => Promise<string | undefined>;
    promptChoice?: (
      question: string,
      choices: string[],
      defaultIndex?: number,
      options?: { description?: string }
    ) => Promise<number>;
    promptUrl?: (question: string, defaultValue?: string) => Promise<string>;
    loadConfig?: () => InfiniteOsConfig;
  } = {}
): Promise<string | undefined> {
  const explicitKeyFile = optionValue(args, "--posthog-personal-api-key-file");
  const explicitKey = optionValueAny(args, "--personal-api-key", "--posthog-personal-api-key") ??
    (explicitKeyFile
      ? readLocalSecretFileValue(explicitKeyFile, "PostHog personal API key")
      : undefined);
  if (explicitKey) {
    return explicitKey;
  }

  const [subcommand, runId] = args;
  if (subcommand !== "resume" || !runId) {
    return undefined;
  }
  if ((deps.interactive ?? input.isTTY === true) !== true || env.GROWTH_OS_CLI_NONINTERACTIVE === "1") {
    return undefined;
  }

  const summary = deps.readRunSummary
    ? await deps.readRunSummary(runId)
    : await (() => {
        const config =
          deps.loadConfig?.() ??
          (() => {
            try {
              return loadInfiniteOsConfig({
                workspaceRoot: workspaceRootFor(env),
                env: env as NodeJS.ProcessEnv
              });
            } catch {
              return null;
            }
          })();
        if (!config) {
          return Promise.resolve<SetupRunSummary | null>(null);
        }
        return readSetupRunSummaryById(runId, env, config, workspaceId);
      })();
  if (!setupResumeNeedsPostHogPersonalApiKey(summary)) {
    return undefined;
  }
  return (deps.promptSecret ?? ((question) => promptSecretValue(question)))(
    "Paste PostHog personal API key (starts with phx_; stored encrypted): "
  );
}

function setupResumeNeedsPostHogPersonalApiKey(summary: SetupRunSummary | null): boolean {
  return (
    summary?.provider === "posthog" &&
    summary.status === "paused_handoff" &&
    typeof summary.pendingHandoff?.url === "string" &&
    summary.pendingHandoff.url.includes("/settings/user-api-keys")
  );
}

function buildSetupResumePostHogSecrets(
  personalApiKey: string | undefined,
  apiHost: string | undefined
): SetupResumePostHogSecrets | undefined {
  if (!personalApiKey && !apiHost) {
    return undefined;
  }
  return {
    ...(personalApiKey ? { personalApiKey } : {}),
    ...(apiHost ? { apiHost } : {})
  };
}

async function promptSetupResumePostHogApiHost(
  summary: SetupRunSummary,
  deps: {
    promptChoice?: (
      question: string,
      choices: string[],
      defaultIndex?: number,
      options?: { description?: string }
    ) => Promise<number>;
    promptUrl?: (question: string, defaultValue?: string) => Promise<string>;
  }
): Promise<string | undefined> {
  const detectedApiHost = normalizePostHogApiHost(
    detectSetupResumePostHogApiHost(summary, { preferLastUrl: true })
  );
  const promptDefaultApiHost = normalizePostHogApiHost(detectSetupResumePostHogApiHost(summary));
  const choice = await (deps.promptChoice ?? promptChoice)(
    "Which PostHog host matches the browser address bar?",
    [
      "EU (https://eu.posthog.com)",
      "US (https://us.posthog.com)",
      "Custom"
    ],
    setupResumePostHogHostChoiceIndex(defaultSetupResumePostHogHostChoice(detectedApiHost)),
    {
      description: "Choose the PostHog region/browser host so Infinite uses the personal API key against the correct workspace."
    }
  );
  const selected = setupResumePostHogHostChoiceFromIndex(choice);
  if (selected === "eu") {
    return "https://eu.posthog.com";
  }
  if (selected === "us") {
    return "https://us.posthog.com";
  }
  return normalizePostHogApiHost(
    await (deps.promptUrl ?? promptUrl)(
      "PostHog host:",
      promptDefaultApiHost ?? detectedApiHost ?? "https://"
    )
  );
}

function detectSetupResumePostHogApiHost(
  summary: SetupRunSummary,
  options: { preferLastUrl?: boolean } = {}
): string | undefined {
  const candidates = options.preferLastUrl
    ? [summary.pendingHandoff?.lastUrl]
    : [summary.pendingHandoff?.lastUrl, summary.pendingHandoff?.url];
  for (const candidate of candidates) {
    const raw = normalizeOptionalInterviewText(candidate);
    if (!raw) {
      continue;
    }
    try {
      return new URL(raw).origin;
    } catch {
      return raw;
    }
  }
  return undefined;
}

function defaultSetupResumePostHogHostChoice(value: string | undefined): PostHogResumeHostChoice {
  if (value?.includes("eu.posthog.com")) {
    return "eu";
  }
  if (value?.includes("us.posthog.com") || value?.includes("app.posthog.com")) {
    return "us";
  }
  if (value) {
    return "custom";
  }
  return "eu";
}

function setupResumePostHogHostChoiceIndex(choice: PostHogResumeHostChoice): number {
  if (choice === "us") {
    return 1;
  }
  if (choice === "custom") {
    return 2;
  }
  return 0;
}

function setupResumePostHogHostChoiceFromIndex(index: number): PostHogResumeHostChoice {
  if (index === 1) {
    return "us";
  }
  if (index === 2) {
    return "custom";
  }
  return "eu";
}

function normalizeSetupRunSummary(value: unknown): SetupRunSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const phaseState = isRecord(value.phase_state) ? value.phase_state : {};
  const interviewCandidate = isRecord(value.interview) ? value.interview : isRecord(phaseState.interview) ? phaseState.interview : undefined;
  const selectedProvidersCandidate = Array.isArray(value.selectedProviders)
    ? value.selectedProviders
    : Array.isArray(phaseState.selectedProviders)
      ? phaseState.selectedProviders
      : [];
  const recommendedProvidersCandidate = Array.isArray(value.recommendedProviders)
    ? value.recommendedProviders
    : Array.isArray(phaseState.recommendedProviders)
      ? phaseState.recommendedProviders
      : [];
  const providersCandidate = isRecord(value.providers)
    ? value.providers
    : isRecord(phaseState.providers)
      ? phaseState.providers
      : {};
  const pendingHandoffCandidate = isRecord(value.pendingHandoff)
    ? value.pendingHandoff
    : isRecord(value.pending_handoff)
      ? value.pending_handoff
      : undefined;
  const site = normalizeSetupRunSite(value);

  return {
    id: stringValue(value.id) ?? "",
    tool: stringValue(value.tool),
    provider: stringValue(value.provider),
    status: stringValue(value.status),
    updatedAt: timestampValue(value.updatedAt ?? value.updated_at),
    interview: interviewCandidate
      ? {
          projectName: stringValue(interviewCandidate.projectName),
          productDescription: stringValue(interviewCandidate.productDescription),
          websiteUrl: stringValue(interviewCandidate.websiteUrl),
          productSurface: stringValue(interviewCandidate.productSurface)
        }
      : null,
    selectedProviders: stringArrayValue(selectedProvidersCandidate),
    recommendedProviders: stringArrayValue(recommendedProvidersCandidate),
    providers: normalizeSetupRunProviders(providersCandidate),
    pendingHandoff: pendingHandoffCandidate
      ? {
          kind: stringValue(pendingHandoffCandidate.kind),
          url: stringValue(pendingHandoffCandidate.url),
          lastUrl: stringValue(pendingHandoffCandidate.lastUrl) ?? stringValue(pendingHandoffCandidate.lastKnownUrl),
          instructions: stringValue(pendingHandoffCandidate.instructions)
        }
      : null,
    site
  };
}

function normalizeSetupRunProviders(value: unknown): Record<string, SetupRunProviderSummary> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const providers: Record<string, SetupRunProviderSummary> = {};
  for (const [provider, summary] of Object.entries(value)) {
    if (!isRecord(summary)) {
      continue;
    }
    const phases: Record<string, { status?: string; detail?: string }> = {};
    if (isRecord(summary.phases)) {
      for (const [phaseName, phase] of Object.entries(summary.phases)) {
        if (!isRecord(phase)) {
          continue;
        }
        phases[phaseName] = {
          status: stringValue(phase.status),
          detail: stringValue(phase.detail)
        };
      }
    }
    const verificationValue = isRecord(summary.verification) ? summary.verification : undefined;
    providers[provider] = {
      phases: Object.keys(phases).length > 0 ? phases : undefined,
      verification: verificationValue
        ? {
            installStatus: stringValue(verificationValue.installStatus),
            queryabilityStatus: stringValue(verificationValue.queryabilityStatus),
            lastCheckedAt: stringValue(verificationValue.lastCheckedAt)
          }
        : null
    };
  }
  return Object.keys(providers).length > 0 ? providers : undefined;
}

function normalizeSetupRunSite(value: Record<string, unknown>): SetupRunSummary["site"] {
  const siteCandidate = isRecord(value.site)
    ? value.site
    : {
        id: value.site_id,
        url: value.site_url,
        repoPath: value.site_repo_path,
        appDir: value.site_app_dir,
        framework: value.site_framework,
        businessType: value.site_business_type
      };
  if (!isRecord(siteCandidate)) {
    return null;
  }
  const site = {
    id: stringValue(siteCandidate.id),
    url: stringValue(siteCandidate.url),
    repoPath: stringValue(siteCandidate.repoPath),
    appDir: stringValue(siteCandidate.appDir),
    framework: stringValue(siteCandidate.framework),
    businessType: stringValue(siteCandidate.businessType)
  };
  return Object.values(site).some(Boolean) ? site : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function workspaceNotReadyFromSetupReadiness(readiness: SetupReadiness): Record<string, unknown> & { ok: boolean } {
  return {
    ok: false,
    setupReadiness: readiness,
    error: {
      code: "growth_os_workspace_not_ready",
      message: "Infinite is not ready to answer through the local LLM runtime.",
      workspaceRoot: readiness.workspaceRoot,
      reasons: readiness.blockingReasons.map((reason) => {
        const separator = reason.indexOf(":");
        return separator === -1
          ? { code: reason, message: reason }
          : { code: reason.slice(0, separator), message: reason.slice(separator + 1).trim() };
      }),
      nextSteps: [
        "infinite setup",
        "infinite start",
        "infinite setup connectors",
        "infinite model use <codex|claude> <model>",
        "infinite auth login <codex|claude>"
      ]
    }
  };
}

// Cap each API probe on the INTERACTIVE readiness path so a missing/zombie daemon
// (or a foreign server squatting the config port) yields a fast, friendly "no daemon"
// message instead of the 5-minute startup hang (design §1/§3/§7). Discovery's own
// identity probes already use resolveDaemonEndpoint's 1.5s default; this bounds the
// post-discovery /health + /sources + /projects calls. Honors an explicit override so
// slow networks can extend it, but defaults short. The total budget across the handful
// of probes stays well under a minute.
function readinessProbeTimeoutMs(env: CliEnv): number {
  // Default 1.5s per probe — generous for a healthy loopback daemon, short enough that
  // a squatting server that accepts the TCP connection but never answers (the
  // 127.0.0.1:3000 next-dev case from design §1) fails fast. The readiness path makes a
  // handful of serial probes; at 1.5s each the whole interactive budget stays a few
  // seconds (well under a minute — spec item 3), instead of the old 5-minute hang.
  return parsePositiveIntEnv(env.GROWTH_OS_READINESS_PROBE_TIMEOUT_MS, 1_500);
}

async function readConnectedSourceReadiness(
  env: CliEnv,
  config: InfiniteOsConfig
): Promise<{
  connectors: "none" | "connected";
  connectedSourceCount: number;
  database: SetupReadiness["database"];
  runtimeServices: SetupReadiness["runtimeServices"];
}> {
  try {
    const db = createInfiniteOsDb(config.databaseUrl);
    try {
      // Cross-workspace readiness: "ready if ANY project has a connected source".
      // We intentionally do NOT filter by `workspace_id` and do NOT resolve a pin
      // (`workspaceIdFor` would throw on a no-pin session). The TUI gates on chat
      // readiness; scoping this to the single active workspace would route a
      // no-default session (or one whose active project's source is errored) to
      // the SETUP wizard instead of chat — even though another project is fully
      // connected. Counting across all workspaces lets a pin-less session reach
      // chat (and PR5's pre-turn picker).
      const rows = await db.query<{ status: string }>(
        "select status from sources where status in ('connected', 'degraded') limit 10"
      );
      return {
        connectors: rows.length > 0 ? "connected" : "none",
        connectedSourceCount: rows.length,
        database: "migrated",
        runtimeServices: await readRuntimeServicesReadiness(env, config)
      };
    } finally {
      await db.close();
    }
  } catch {
    // Fall through to the app API only when the operator explicitly configured one.
  }

  if (!env.GROWTH_OS_API_URL && config.runtimeMode !== "network") {
    return {
      connectors: "none",
      connectedSourceCount: 0,
      database: "missing",
      runtimeServices: "down"
    };
  }

  try {
    // Same cross-workspace semantics over the app API. `/sources` is hard-scoped
    // to one workspace (it 400s without an `x-growth-os-workspace` header), so we
    // fan out over the project list and stop at the first project with a
    // connected source. This must NOT depend on a resolved pin — a pin-less
    // networked session has to pass readiness when ANY project is connected.
    const connectedSourceCount = await countConnectedSourcesAcrossWorkspaces(env, config);
    return {
      connectors: connectedSourceCount > 0 ? "connected" : "none",
      connectedSourceCount,
      database: "migrated",
      runtimeServices: "ready"
    };
  } catch {
    return {
      connectors: "none",
      connectedSourceCount: 0,
      database: "missing",
      runtimeServices: "down"
    };
  }
}

// Count connected/degraded sources across ALL workspaces via the app API. We list
// projects (operator, workspace-less) and check each project's `/sources`,
// short-circuiting at the first project that has a connected source — readiness
// only cares whether SOME project is connected, not the exact total. If the
// project list is unavailable (e.g. a read-only token can't reach the operator
// `/projects` route), fall back to the single best-effort pinned workspace, which
// is still pin-tolerant (`apiRequest` omits the header on a no-pin session).
async function countConnectedSourcesAcrossWorkspaces(
  env: CliEnv,
  config: InfiniteOsConfig
): Promise<number> {
  const timeoutMs = readinessProbeTimeoutMs(env);
  let projects: Array<{ id: string }> = [];
  try {
    const payload = await apiRequest("/projects", env, { config, operator: true, omitWorkspace: true, timeoutMs });
    projects = isRecord(payload) && Array.isArray(payload.projects)
      ? payload.projects.filter(isRecord).map((p) => ({ id: stringValue(p.id) ?? "" })).filter((p) => p.id)
      : [];
  } catch {
    // No project list (read-only token / older app): fall back to the pinned
    // workspace's `/sources` (pin-tolerant — see `apiRequest`).
    const payload = await apiRequest("/sources", env, { config, timeoutMs });
    return countConnectedSources(payload);
  }
  let total = 0;
  for (const project of projects) {
    let count = 0;
    try {
      const payload = await apiRequest("/sources", env, {
        config,
        workspaceId: project.id,
        timeoutMs
      });
      count = countConnectedSources(payload);
    } catch {
      // One project's `/sources` failing (no access / transient) must NOT abort
      // the cross-workspace count — treat it as 0 and keep scanning, so a
      // connected project later in the list still makes the session ready.
      count = 0;
    }
    if (count > 0) {
      // Short-circuit: readiness is "ANY project connected".
      return count;
    }
    total += count;
  }
  return total;
}

async function readRuntimeServicesReadiness(
  env: CliEnv,
  config: InfiniteOsConfig
): Promise<SetupReadiness["runtimeServices"]> {
  // Skip the /health probe entirely when there's no daemon to talk to: no explicit
  // GROWTH_OS_API_URL, not network mode, AND descriptor-first discovery found no live
  // daemon. This is the hang fix (design §3/§7) — a pure-local CLI talks to the DB
  // directly, so probing a (possibly squatted) config port here only burns the
  // readiness budget. resolveDaemonEndpoint is memoized, so this is a cheap re-check.
  if (env.GROWTH_OS_API_URL === undefined && config.runtimeMode !== "network") {
    const discovered = await resolveDaemonEndpoint(env as NodeJS.ProcessEnv);
    if (!discovered) {
      return "down";
    }
  }
  try {
    await apiRequest("/health", env, { config, timeoutMs: readinessProbeTimeoutMs(env) });
    return "ready";
  } catch {
    return "down";
  }
}

function countConnectedSources(payload: unknown): number {
  const sources = sourcesFromPayload(payload);
  return sources.filter((source) => source.status === "connected" || source.status === "degraded").length;
}

function sourcesFromPayload(payload: unknown): Array<{ status?: string }> {
  if (!isRecord(payload)) {
    return [];
  }
  const data = isRecord(payload.data) ? payload.data : payload;
  const sources = Array.isArray(data.sources) ? data.sources : [];
  return sources.filter(isRecord).map((source) => ({ status: stringValue(source.status) }));
}

function isWorkspaceBootstrapError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return [
    "DATABASE_URL is required",
    "GROWTH_OS_ENCRYPTION_KEY is required"
  ].includes(error.message);
}

function workspaceNotReadyResult(env: CliEnv, error: unknown): Record<string, unknown> {
  const workspaceRoot = workspaceRootFor(env);
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: {
      code: "growth_os_workspace_not_ready",
      message: `Infinite OS local chat is not ready: ${message}.`,
      workspaceRoot,
      nextSteps: [
        "infinite setup",
        "infinite start",
        "infinite model list",
        "infinite model use <codex|claude> <model>",
        "infinite auth login <codex|claude>"
      ]
    }
  };
}

async function withCliAgentRuntime<T>(
  env: CliEnv,
  source: CliAgentRuntimeSource | undefined,
  fn: (runtime: CliAgentRuntime) => Promise<T>
): Promise<T> {
  if (source) {
    return fn(resolveCliAgentRuntime(source));
  }
  const runtime = createCliAgentRuntime(env);
  try {
    return await fn(runtime);
  } finally {
    await runtime.close?.();
  }
}

function resolveCliAgentRuntime(source: CliAgentRuntimeSource): CliAgentRuntime {
  return typeof source === "function" ? source() : source;
}

export function createCliAgentRuntime(env: CliEnv = process.env): CliAgentRuntime {
  const workspaceRoot = workspaceRootFor(env);
  const workspaceId = workspaceIdFor(env);
  const config = loadInfiniteOsConfig({ workspaceRoot, env: env as NodeJS.ProcessEnv });
  if (!process.env.GROWTH_OS_ENCRYPTION_KEY && config.encryptionKey) {
    process.env.GROWTH_OS_ENCRYPTION_KEY = config.encryptionKey;
  }
  const database = createInfiniteOsDb(config.databaseUrl);
  const dbAdapter = sessionStoreDb(database);
  const sessionStore = createSessionStore(dbAdapter);
  const registry = createInfiniteOsRegistry(createActionHandlers(database));
  const modelClient = createConfiguredModelClient({ env: env as NodeJS.ProcessEnv });
  const memoryManager = createCuratedMemoryManager({
    db: dbAdapter,
    reviewer: createModelBackedMemoryReviewer(modelClient)
  });
  const queryAdvisor = createSourceAwareQueryAdvisor({
    listConnectedXIdentities: createDbBackedConnectedXIdentityLookup(dbAdapter)
  });
  const controller = createLlmController({ registry, sessionStore, modelClient, memoryManager, queryAdvisor });

  // Local-path workspace validation. The gateway/platform path validates the
  // bound id against `workspaces` (`apps/app/src/index.ts` `select 1 ... from
  // workspaces`); the local CLI path historically did not (auth here is role-only).
  // Assert the pinned id ∈ `workspaces` before any data-touching method runs so a
  // stale/unknown pin fails closed instead of silently querying an empty scope.
  // Memoized: one round-trip per runtime; throws NoActiveProjectError on a miss so
  // the existing CLI `instanceof NoActiveProjectError` guards catch it.
  let workspaceCheck: Promise<void> | undefined;
  const assertWorkspaceExists = (): Promise<void> => {
    // Memoize on SUCCESS ONLY. A `??=` that caches the rejected promise would
    // pin a *transient* DB failure (e.g. a momentary connection error) for the
    // runtime's whole life — every later method would re-reject from the cached
    // promise even after the DB recovered. So on failure we clear the memo and
    // rethrow: a genuine not-found still throws NoActiveProjectError each call,
    // but a transient error becomes retryable. On success the promise stays
    // cached, preserving the "one round-trip per runtime" behavior.
    workspaceCheck ??= (async () => {
      try {
        const row = await database.one<{ ok: number }>(
          "select 1 as ok from workspaces where id = $1",
          [workspaceId]
        );
        if (!row) {
          throw new NoActiveProjectError(
            `Project "${workspaceId}" was not found. Run \`infinite project new <name>\` or pick an existing one.`
          );
        }
      } catch (error) {
        workspaceCheck = undefined;
        throw error;
      }
    })();
    return workspaceCheck;
  };

  // Per-project controller session id. `chat_sessions` keys rows on
  // `(workspace_id, session_key)` but inserts `id = session_key = sessionId`
  // (`session-store.ts`), so two workspaces sharing one UI conversation id would
  // re-insert the same PK and throw. Qualify the immutable conversation id with
  // the bound `workspaceId` here (the single place `workspaceId` is in scope) so
  // chat / resume / compact / list all key the same per-project row.
  // The argument is ALWAYS an immutable conversation id (`cli_<uuid>`); callers
  // must never pass a value that already carries a `:<ws>` suffix.
  const deriveControllerSessionId = (conversationId: string): string =>
    `${conversationId}:${workspaceId}`;

  return {
    async chat(input) {
      await assertWorkspaceExists();
      return controller.chat({
        message: input.message,
        sessionId: input.sessionId ? deriveControllerSessionId(input.sessionId) : undefined,
        workspaceId,
        actorId: "cli",
        surface: "cli",
        progressMode: input.progressMode,
        onProgress: input.onProgress
      });
    },
    async listSessions() {
      await assertWorkspaceExists();
      const sessions = await sessionStore.listSessions(workspaceId);
      // Surface the conversation id (strip the `:<ws>` suffix) so `/resume`
      // round-trips to a value the runtime can re-derive.
      return {
        ok: true,
        sessions: sessions.map((session) => ({
          ...session,
          id: stripWorkspaceSuffix(session.id, workspaceId)
        }))
      };
    },
    async resumeSession(conversationId) {
      await assertWorkspaceExists();
      const controllerSessionId = deriveControllerSessionId(conversationId);
      await sessionStore.resumeSession(controllerSessionId);
      return { ok: true, sessionId: conversationId };
    },
    async compactSession(conversationId, summaryText) {
      await assertWorkspaceExists();
      const controllerSessionId = deriveControllerSessionId(conversationId);
      const finalSummary =
        summaryText || (await generateCompactSummary(sessionStore, modelClient, controllerSessionId));
      const compacted = await sessionStore.compactSession({
        sessionId: controllerSessionId,
        summaryText: finalSummary
      });
      return { ok: true, ...compacted, summaryText: finalSummary };
    },
    async confirmAction(confirmationId) {
      await assertWorkspaceExists();
      // P0-A: scope the lookup by the env-bound workspace ($2). confirmation_id is NOT
      // unique across workspaces, so an unscoped lookup could return another brand's row.
      const pending = await sessionStore.getPendingActionCall?.(confirmationId, workspaceId);
      if (!pending) {
        return { ok: false, error: { code: "confirmation_not_found" } };
      }
      // P0-A: the workspace-scoped getPendingActionCall(confirmationId, workspaceId) above IS
      // the cross-workspace control — a confirmation authored by another project is invisible
      // to it (returns null → confirmation_not_found above). This CLI path was a second
      // confused-deputy that used to execute under the env-bound active project; it now always
      // executes under the pending row's own authoring workspace.
      const envelope = await registry.execute(
        pending.actionId,
        pending.input,
        createSessionContext({
          // Execute under the pending row's own authoring workspace, never the env-bound project.
          workspaceId: pending.workspaceId,
          sessionId: pending.sessionId,
          actorId: "cli",
          authority: "operator",
          surface: "cli"
        })
      );
      await sessionStore.confirmActionCall?.({
        confirmationId,
        outputEnvelope: envelope,
        status: envelope.status,
        // P0-A: scope the confirm UPDATE to the pending row's workspace.
        workspaceId: pending.workspaceId
      });
      return {
        ok: true,
        confirmationId,
        sessionId: pending.sessionId,
        actionId: pending.actionId,
        inputHash: pending.inputHash ?? null,
        envelope
      };
    },
    // TODO(@-pin): PR2's enumerated Changes list chat/resume/compact/list, but
    // chat writes memory facts under the DERIVED controller session id
    // (`source_session_id = ${conversationId}:${ws}`). The `/memory` methods
    // receive the immutable conversation id, so they must derive the same id or
    // chat-written facts go invisible to `/memory list|delete`. Deriving here
    // keeps them consistent — a direct continuation of "apply it uniformly".
    async listMemory(conversationId) {
      await assertWorkspaceExists();
      const sessionId = deriveControllerSessionId(conversationId);
      const memories = await dbAdapter.query(
        `
          select id, scope, fact, source_session_id as "sourceSessionId",
            source_message_id as "sourceMessageId", created_at as "createdAt",
            updated_at as "updatedAt", expires_at as "expiresAt", blocked_reason as "blockedReason"
          from chat_memory_facts
          where workspace_id = $1
            and blocked_reason is null
            and (source_session_id = $2 or source_session_id is null)
          order by updated_at desc
          limit 100
        `,
        [workspaceId, sessionId]
      );
      return { ok: true, sessionId: conversationId, memories };
    },
    async addMemory(conversationId, scope, fact) {
      await assertWorkspaceExists();
      const sessionId = deriveControllerSessionId(conversationId);
      const [candidate] = filterCuratedMemoryCandidates([{ scope, fact }]);
      if (!candidate) {
        return {
          ok: false,
          error: { code: "memory_fact_rejected", message: "Memory fact is outside the curated Infinite OS policy." }
        };
      }
      const memoryId = `mem_${randomUUID()}`;
      await dbAdapter.query(
        `
          insert into chat_memory_facts (
            id, workspace_id, actor_id, scope, fact, source_session_id
          )
          select $1, $2, $3, $4, $5, $6
          where not exists (
            select 1 from chat_memory_facts
            where workspace_id = $2 and scope = $4 and lower(fact) = lower($5)
              and blocked_reason is null
          )
        `,
        [memoryId, workspaceId, "operator", candidate.scope, candidate.fact, sessionId]
      );
      return { ok: true, memory: { id: memoryId, scope: candidate.scope, fact: candidate.fact } };
    },
    async deleteMemory(conversationId, memoryId) {
      await assertWorkspaceExists();
      const sessionId = deriveControllerSessionId(conversationId);
      await dbAdapter.query(
        `
          update chat_memory_facts
          set blocked_reason = 'operator_deleted', updated_at = now()
          where id = $1 and workspace_id = $2
            and (source_session_id = $3 or source_session_id is null)
        `,
        [memoryId, workspaceId, sessionId]
      );
      return { ok: true, sessionId: conversationId, memoryId };
    },
    close: () => database.close()
  };
}

// Strip the trailing `:${workspaceId}` that `deriveControllerSessionId` appends,
// recovering the immutable conversation id for display / `/resume`. Matches the
// literal suffix (workspace ids may themselves contain `:`), so a stored id with
// no suffix (legacy/foreign row) is returned unchanged.
function stripWorkspaceSuffix(id: string, workspaceId: string): string {
  const suffix = `:${workspaceId}`;
  return id.endsWith(suffix) ? id.slice(0, -suffix.length) : id;
}

function sessionStoreDb(database: InfiniteOsDb) {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      return database.query(sql, params) as Promise<T[]>;
    },
    async one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
      return database.one(sql, params) as Promise<T | null>;
    }
  };
}

async function generateCompactSummary(
  sessionStore: ChatSessionStore,
  modelClient: InfiniteOsModelClient,
  sessionId: string
): Promise<string> {
  const session = await sessionStore.getSession(sessionId);
  if (!session) {
    return "";
  }
  const response = await modelClient.complete({
    systemPrompt: [
      "Create a compact Infinite OS session summary for continuation.",
      "Preserve user intent, selected sources, metrics/views, action IDs, bounded result summaries, caveats, unresolved questions, and next actions.",
      "Do not preserve credentials, raw provider payloads, unbounded rows, or arbitrary SQL."
    ].join("\n"),
    userMessage: JSON.stringify({
      messages: session.messages,
      actionCalls: session.actionCalls
    }),
    tools: [],
    toolResults: []
  });
  return (response.message ?? "").trim();
}

function updateChatState(chatState: InteractiveChatState | undefined, result: unknown): void {
  if (!chatState || !isRecord(result) || typeof result.sessionId !== "string") {
    return;
  }
  // `result.sessionId` is the DERIVED controller id (`${conversationId}:${ws}`).
  // Record it for display only — NEVER write it back into `conversationId`, or
  // the `:<ws>` suffix would compound on every turn (`:wsA:wsA…`).
  chatState.sessionId = result.sessionId;
}

function memoryCommand(
  args: string[],
  env: CliEnv,
  memory: OperatorSessionMemory | undefined,
  memoryStore: SessionMemoryStore | undefined,
  chatState: InteractiveChatState | undefined,
  agentRuntime?: CliAgentRuntimeSource
): Promise<unknown> | string {
  if (args[0] === "set") {
    return updateMemoryPreference(args.slice(1), memory, memoryStore);
  }
  // Use the immutable conversation id (stable from session start), not the
  // round-tripped display `sessionId`; the runtime derives the per-workspace id.
  const sessionId = chatState?.conversationId;
  if (!sessionId) {
    return renderMemory(memory?.snapshot());
  }
  if (args[0] === "add") {
    const [scope, ...factParts] = args.slice(1);
    const fact = factParts.join(" ").trim();
    if (!scope || !fact) {
      throw new Error("Usage: /memory add <scope> <fact>");
    }
    return withCliAgentRuntime(env, agentRuntime, (runtime) => runtime.addMemory(sessionId, scope, fact));
  }
  if (args[0] === "delete") {
    const [memoryId] = args.slice(1);
    if (!memoryId) {
      throw new Error("Usage: /memory delete <memory_id>");
    }
    return withCliAgentRuntime(env, agentRuntime, (runtime) => runtime.deleteMemory(sessionId, memoryId));
  }
  return withCliAgentRuntime(env, agentRuntime, (runtime) => runtime.listMemory(sessionId));
}

export function renderCliResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (isChatResponseResult(result)) {
    return renderChatResponse(result);
  }
  if (isSyncWindowRequiredResult(result)) {
    return renderSyncWindowRequiredResult(result);
  }
  if (isSyncCommandResult(result)) {
    return renderSyncCommandResult(result);
  }
  if (isEnvelope(result)) {
    return renderEnvelope(result);
  }
  if (isWorkspaceNotReadyResult(result)) {
    return renderWorkspaceNotReady(result);
  }
  if (isSetupResult(result)) {
    return renderSetupResult(result);
  }
  if (isSetupWizardResult(result)) {
    return renderSetupWizardResult(result);
  }
  if (isRuntimeSetupResult(result)) {
    return renderRuntimeSetupResult(result);
  }
  if (isSetupOnboardingResult(result)) {
    return renderSetupOnboardingResult(result);
  }
  if (isConnectorSetupResult(result)) {
    return renderConnectorSetupResult(result);
  }
  if (isSetupReadinessResult(result)) {
    return renderSetupReadinessResult(result);
  }
  if (isSetupResetResult(result)) {
    return renderSetupResetResult(result);
  }
  if (isProjectUseResult(result)) {
    return renderProjectUseResult(result);
  }
  if (isProjectDeleteResult(result)) {
    return renderProjectDeleteResult(result);
  }
  return JSON.stringify(result, null, 2);
}

interface ProjectDeleteResult {
  ok?: boolean;
  section: "project_delete";
  name: string;
  id: string;
  deleted?: boolean;
  cancelled?: boolean;
  clearedActivePin?: boolean;
  clearedDefault?: boolean;
  error?: { code?: string };
}

function isProjectDeleteResult(result: unknown): result is ProjectDeleteResult {
  return (
    isRecord(result) &&
    result.section === "project_delete" &&
    typeof result.name === "string" &&
    typeof result.id === "string"
  );
}

export function renderProjectDeleteResult(result: ProjectDeleteResult): string {
  if (result.error?.code === "cannot_delete_last_project") {
    return (
      `Cannot delete "${result.name}" — it is the last remaining project.\n` +
      `Create another project first (\`infinite project new <name>\`), then delete this one.`
    );
  }
  if (result.cancelled) {
    return `Cancelled — "${result.name}" was not deleted.`;
  }
  const lines = [`Deleted project: ${result.name} (${result.id})`];
  if (result.clearedActivePin) {
    lines.push("Cleared the active project pin (it pointed at the deleted project).");
  }
  if (result.clearedDefault) {
    lines.push("Cleared the persisted default project (it pointed at the deleted project).");
  }
  return lines.join("\n");
}

function isProjectUseResult(result: unknown): result is {
  ok?: boolean;
  section: "project_use";
  activeProjectId: string;
  name: string;
  hint?: string;
} {
  return (
    isRecord(result) &&
    result.section === "project_use" &&
    typeof result.name === "string" &&
    typeof result.activeProjectId === "string"
  );
}

function renderProjectUseResult(result: {
  name: string;
  hint?: string;
}): string {
  const lines = [`Pinned project: ${result.name}`];
  if (result.hint) {
    lines.push("", result.hint);
  }
  return lines.join("\n");
}

function isSetupResetResult(result: unknown): result is {
  ok?: boolean;
  section: "reset";
  cleared: Array<{ id: string; tool: string }>;
  error?: string;
  next?: string;
} {
  return isRecord(result) && result.section === "reset" && Array.isArray(result.cleared);
}

function renderSetupResetResult(result: {
  ok?: boolean;
  cleared: Array<{ id: string; tool: string }>;
  error?: string;
  next?: string;
}): string {
  const lines = result.error
    ? [result.error]
    : result.cleared.length === 0
      ? ["No active setup runs to clear."]
      : [
          `Cleared ${result.cleared.length} active setup run${result.cleared.length === 1 ? "" : "s"}:`,
          ...result.cleared.map((run) => `  - ${run.tool}: ${run.id}`)
        ];
  if (result.next) {
    lines.push("", "Next:", `  ${result.next.replace(/`/g, "")}`);
  }
  return lines.join("\n");
}

export function renderCliResultForStream(
  result: unknown,
  stream: CliOutputStream = output,
  env: CliEnv = process.env
): string {
  const rendered = renderCliResult(result);
  const assistantStreamSurface = consumeAssistantStreamSurface();
  const renderSurface = resolveCliRenderSurface(stream, env as NodeJS.ProcessEnv);
  const interactiveChat = isChatResponseResult(result) && shouldUseInteractiveRenderer(stream, env as NodeJS.ProcessEnv);
  const theme = resolveTheme(env as NodeJS.ProcessEnv);

  if (isChatResponseResult(result) && assistantStreamSurface !== "none") {
    if (interactiveChat && usesTranscriptRenderSurface(renderSurface)) {
      return renderChatAppChrome(result, rendered, stream, {
        includeAssistant: assistantStreamSurface === "transcript",
        theme
      });
    }
    return interactiveChat ? renderChatStatusFooter(result, stream, theme) : "";
  }

  if (!interactiveChat) {
    return rendered;
  }

  if (usesTranscriptRenderSurface(renderSurface)) {
    return renderChatAppChrome(result, rendered, stream, { includeAssistant: true, theme });
  }

  const renderer = createCliRenderer({ stream, theme });
  const footer = renderChatStatusFooter(result, stream, theme);
  return [renderer.renderAssistant(rendered), footer].filter(Boolean).join("\n");
}

function renderChatResponse(result: {
  message: string;
  provenance?: string[];
}): string {
  const message = result.message.trim();
  if (!message) {
    return "No answer was produced.";
  }
  return message;
}

function isSyncWindowRequiredResult(result: unknown): result is {
  section: "sync_window_required";
  target: string;
  sourceCount?: number;
  choices: Array<{ value: string; label: string; slashCommand: string; cliCommand: string }>;
} {
  return isRecord(result) && result.section === "sync_window_required" && typeof result.target === "string" && Array.isArray(result.choices);
}

function renderSyncWindowRequiredResult(result: {
  target: string;
  sourceCount?: number;
  choices: Array<{ value: string; label: string; slashCommand: string; cliCommand: string }>;
}): string {
  const lines = [
    `How far back should we sync ${result.target}?`,
    result.sourceCount && result.sourceCount > 1 ? `This will sync ${result.sourceCount} sources.` : undefined,
    "",
    "No sync has been queued yet.",
    "\"Since last sync\" only adds new data. A window re-pulls that range to fill or correct history.",
    "",
    "Choose one:"
  ].filter((line): line is string => line !== undefined);
  for (const choice of result.choices) {
    lines.push(`  ${choice.slashCommand}  — ${choice.label}`);
  }
  lines.push("", "Terminal equivalents:");
  for (const choice of result.choices) {
    lines.push(`  ${choice.cliCommand}`);
  }
  return lines.join("\n");
}

function isSyncCommandResult(result: unknown): result is {
  section: "sync";
  status?: string;
  waited?: boolean;
  window?: string;
  synced: Array<Record<string, unknown>>;
} {
  return isRecord(result) && result.section === "sync" && Array.isArray(result.synced);
}

function renderSyncCommandResult(result: {
  status?: string;
  waited?: boolean;
  window?: string;
  synced: Array<Record<string, unknown>>;
}): string {
  const status = result.status ?? syncOverallStatus(result.synced);
  const title = result.waited
    ? status === "succeeded"
      ? "Sync completed."
      : status === "timed_out"
        ? "Sync still in progress."
        : "Sync finished with errors."
    : "Sync queued.";
  const lines = [title];
  if (result.window) {
    lines.push(`Window: ${result.window}`);
  }
  lines.push("", "Sources:");
  for (const item of result.synced) {
    const sourceId = stringValue(item.sourceId) ?? "unknown source";
    const itemStatus = stringValue(item.status) ?? queuedSyncStatus(item.result);
    const job = isRecord(item.job) ? item.job : syncJobFromQueuedResult(item.result);
    const jobId = stringValue(job?.id);
    const syncRun = isRecord(item.syncRun) ? item.syncRun : undefined;
    const loaded = syncRecordsLoaded(syncRun);
    const parts = [
      itemStatus,
      jobId ? `job ${jobId}` : undefined,
      loaded === undefined ? undefined : `${loaded} ${loaded === 1 ? "record" : "records"} loaded`
    ].filter((part): part is string => Boolean(part));
    lines.push(`  ${sourceId}: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

function queuedSyncStatus(result: unknown): string {
  return isRecord(result) ? stringValue(result.status) ?? "queued" : "queued";
}

function renderChatStatusFooter(
  result: {
    sessionId: string;
    provenance?: string[];
    actionCalls?: unknown[];
    modelName?: string;
    modelProvider?: string;
    modelAuthSource?: string;
    usage?: { promptTokens?: number; completionTokens?: number };
  },
  stream: CliOutputStream,
  theme: Theme = resolveTheme()
): string {
  const parts = chatStatusParts(result);

  const renderer = createCliRenderer({ stream, theme });
  return groupStatusParts(parts, stream.columns ?? 88)
    .map((lineParts) => renderer.renderStatus(lineParts))
    .join("\n");
}

function renderChatAppChrome(
  result: {
    sessionId: string;
    provenance?: string[];
    actionCalls?: unknown[];
    modelName?: string;
    modelProvider?: string;
    modelAuthSource?: string;
    usage?: { promptTokens?: number; completionTokens?: number };
  },
  message: string,
  stream: CliOutputStream,
  options: {
    includeAssistant: boolean;
    theme?: Theme;
  }
): string {
  const messages: Msg[] = [
    ...chatActionTrailMessages(result.actionCalls),
    ...(options.includeAssistant ? [{ role: "assistant" as const, text: message }] : [])
  ];
  return renderInfiniteAppChrome(
    {
      prompt: { placeholder: "Type a message, /help, or /exit." },
      status: chatStatusParts(result),
      transcript: {
        messages
      }
    },
    {
      color: Boolean(stream.isTTY && !process.env.NO_COLOR),
      columns: stream.columns,
      theme: options.theme
    }
  );
}

function chatStatusParts(result: {
  sessionId: string;
  provenance?: string[];
  actionCalls?: unknown[];
  modelName?: string;
  modelProvider?: string;
  modelAuthSource?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}): string[] {
  const model = [result.modelProvider, result.modelName].filter(Boolean).join(":");
  const usage = result.usage;
  return [
    `session ${result.sessionId}`,
    model ? `model ${model}` : undefined,
    usage?.promptTokens || usage?.completionTokens
      ? `tokens ${usage.promptTokens ?? 0}/${usage.completionTokens ?? 0}`
      : undefined,
    Array.isArray(result.actionCalls) && result.actionCalls.length > 0 ? `actions ${result.actionCalls.length}` : undefined,
    Array.isArray(result.provenance) && result.provenance.length > 0 ? `sources ${result.provenance.length}` : undefined,
    result.modelAuthSource ? `auth ${result.modelAuthSource}` : undefined
  ].filter((part): part is string => Boolean(part));
}

function chatActionTrailMessages(actionCalls: unknown[] | undefined): Msg[] {
  const trail = (actionCalls ?? [])
    .map(chatActionTrailLine)
    .filter((line): line is string => Boolean(line));

  return trail.length ? [{ kind: "trail", role: "system", text: "", tools: trail }] : [];
}

function chatActionTrailLine(call: unknown): string | undefined {
  if (!isRecord(call)) {
    return undefined;
  }

  const actionId = stringValue(call.actionId) ?? stringValue(call.name) ?? "action";
  const envelope = isRecord(call.envelope) ? call.envelope : undefined;
  const status = stringValue(call.status) ?? stringValue(envelope?.status) ?? "ok";
  const detail = chatActionTrailDetail(call, envelope, status);
  const context = chatActionInputPreview(call.input);
  const failed = Boolean(call.error) || status === "error" || stringValue(envelope?.status) === "error";

  return buildToolTrailLine(actionId, context, failed, detail);
}

function chatActionTrailDetail(
  call: Record<string, unknown>,
  envelope: Record<string, unknown> | undefined,
  status: string
): string {
  const error = isRecord(call.error)
    ? stringValue(call.error.message) ?? stringValue(call.error.code)
    : undefined;
  if (error) {
    return error;
  }

  if (!envelope) {
    return status === "requires_confirmation" ? "requires confirmation" : status;
  }

  const rows = envelopeRowsCount(envelope);
  const provenance = Array.isArray(envelope.provenance) ? envelope.provenance.length : 0;
  const caveats = Array.isArray(envelope.caveats) ? envelope.caveats.length : 0;
  const freshness = isRecord(envelope.freshness)
    ? stringValue(envelope.freshness.asOf) ?? stringValue(envelope.freshness.target)
    : undefined;
  const parts = [
    stringValue(envelope.status) ?? status,
    rows !== undefined ? `${rows} row${rows === 1 ? "" : "s"}` : undefined,
    provenance > 0 ? `${provenance} source${provenance === 1 ? "" : "s"}` : undefined,
    caveats > 0 ? `${caveats} caveat${caveats === 1 ? "" : "s"}` : undefined,
    freshness ? `fresh ${freshness}` : undefined
  ].filter((part): part is string => Boolean(part));

  return parts.join("; ");
}

function envelopeRowsCount(envelope: Record<string, unknown>): number | undefined {
  const data = isRecord(envelope.data) ? envelope.data : undefined;
  return Array.isArray(data?.rows) ? data.rows.length : undefined;
}

function chatActionInputPreview(input: unknown): string {
  if (!isRecord(input)) {
    return "";
  }

  const preferred = ["metric", "view", "provider", "sourceId", "connectionName", "reportId", "dimension", "limit"];
  const parts = preferred
    .map((key) => {
      const value = input[key];
      if (value === undefined || value === null || value === "") {
        return undefined;
      }
      if (Array.isArray(value)) {
        return `${key}=${value.map((item) => String(item)).slice(0, 3).join(",")}`;
      }
      if (typeof value === "object") {
        return undefined;
      }
      return `${key}=${String(value)}`;
    })
    .filter((part): part is string => Boolean(part));

  return compactPreview(parts.join(" "), 96);
}

function groupStatusParts(parts: readonly string[], columns: number): string[][] {
  const width = Math.max(12, Math.min(160, Number.isFinite(columns) ? Math.floor(columns) : 88));
  const groups: string[][] = [];
  let current: string[] = [];
  for (const part of parts) {
    const candidate = [...current, part];
    const candidateWidth = displayWidth(candidate.join("  |  "));
    if (current.length > 0 && candidateWidth > width) {
      groups.push(current);
      current = [part];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

export function operatorConfirmationText(line: string): string {
  const command = line.startsWith("/") ? line.slice(1).split(/\s+/)[0] : line.split(/\s+/)[0];
  return `Operator action "${command}" can change sources, schedules, jobs, or reports.`;
}

export function requiresOperatorConfirmation(line: string): boolean {
  const command = line.startsWith("/") ? line.slice(1).split(/\s+/)[0] : line.split(/\s+/)[0];
  if (command === "sync") {
    return syncLineRequiresOperatorConfirmation(line);
  }
  return [
    "connect",
    "call",
    "recipe",
    "saved-report",
    "reconnect",
    "revoke",
    "meta",
    "update_source_schedule",
    "pause_source_schedule",
    "resume_source_schedule"
  ].includes(command);
}

function syncLineRequiresOperatorConfirmation(line: string): boolean {
  const parts = commandLineParts(line);
  const args = parts[0] === "sync" ? parts.slice(1) : [];
  const [rawTarget, rawWindow] = syncPositionalArgs(args);
  if (!rawTarget) {
    return false;
  }
  if (isExplicitSourceId(rawTarget)) {
    return true;
  }
  return Boolean(optionValue(args, "--window") ?? rawWindow);
}

function syncWindowSelectionPrompt(line: string): InkInteractiveSelectionPrompt | undefined {
  const parts = commandLineParts(line);
  const command = parts[0];
  if (command !== "sync") {
    return undefined;
  }
  const args = parts.slice(1);
  const [rawTarget, rawWindow] = syncPositionalArgs(args);
  if (
    !rawTarget ||
    isExplicitSourceId(rawTarget) ||
    !isKnownSyncConnectorTarget(rawTarget) ||
    optionValue(args, "--window") ||
    rawWindow
  ) {
    return undefined;
  }
  return {
    question: `How far back should we sync ${rawTarget}?`,
    description:
      "No sync has been queued yet. Since last sync only adds new data; a window re-pulls that range.",
    options: SYNC_WINDOW_CHOICES.map((choice) => {
      const value = choice.option?.value ?? "incremental";
      return {
        label: choice.label,
        line: syncLineWithWindow(line, value)
      };
    })
  };
}

function syncLineWithWindow(line: string, window: string): string {
  const hasSlash = line.trim().startsWith("/");
  const parts = commandLineParts(line);
  const args = syncArgsWithWindow(parts[0] === "sync" ? parts.slice(1) : [], window);
  return `${hasSlash ? "/" : ""}sync ${args.join(" ")}`.trim();
}

function syncArgsWithWindow(args: string[], window: string): string[] {
  const result: string[] = [];
  let inserted = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    result.push(arg);
    if (arg === "--window") {
      const value = args[index + 1];
      if (value !== undefined) {
        result.push(value);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    if (!inserted) {
      result.push(window);
      inserted = true;
    }
  }
  if (!inserted) {
    result.push(window);
  }
  return result;
}

function isKnownSyncConnectorTarget(target: string): boolean {
  const normalized = target.trim().toLowerCase().replace(/[-\s]/g, "_");
  return normalized === "all" || Boolean(SYNC_PROVIDER_ALIASES[normalized]);
}

function commandLineParts(line: string): string[] {
  const normalized = line.trim().startsWith("/") ? line.trim().slice(1) : line.trim();
  return normalized.split(/\s+/).filter(Boolean);
}

function renderEnvelope(envelope: ActionEnvelope): string {
  const sections: Array<[string, string[]]> = [
    ["Answer", answerLines(envelope)],
    ["Assumptions", assumptionsLines(envelope)],
    ["Caveats", envelope.caveats],
    ["Freshness", freshnessLines(envelope)],
    ["Provenance", envelope.provenance],
    ["Next actions", envelope.nextActions]
  ];
  return sections
    .filter(([, lines]) => lines.length > 0)
    .map(([title, lines]) => `${title}\n${lines.map((line) => `  ${line}`).join("\n")}`)
    .join("\n\n");
}

function isWorkspaceNotReadyResult(result: unknown): result is {
  error: {
    code: "growth_os_workspace_not_ready";
    message?: string;
    workspaceRoot?: string;
    reasons?: Array<{ code?: string; message?: string }>;
    nextSteps?: string[];
  };
} {
  return isRecord(result) && isRecord(result.error) && result.error.code === "growth_os_workspace_not_ready";
}

function isChatResponseResult(result: unknown): result is {
  ok: boolean;
  sessionId: string;
  message: string;
  provenance?: string[];
  actionCalls?: unknown[];
  modelName?: string;
  modelProvider?: string;
  modelAuthSource?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
} {
  return (
    isRecord(result) &&
    typeof result.ok === "boolean" &&
    typeof result.sessionId === "string" &&
    typeof result.message === "string" &&
    Array.isArray(result.actionCalls)
  );
}

function renderWorkspaceNotReady(result: {
  error: {
    message?: string;
    workspaceRoot?: string;
    reasons?: Array<{ code?: string; message?: string }>;
    nextSteps?: string[];
  };
}): string {
  const lines = [
    "Infinite is not set up yet.",
    "",
    result.error.message ?? "The local LLM runtime is not ready.",
    ...(result.error.workspaceRoot ? ["", `Workspace: ${result.error.workspaceRoot}`] : [])
  ];
  if (Array.isArray(result.error.reasons) && result.error.reasons.length > 0) {
    lines.push("", "Missing:");
    for (const reason of result.error.reasons) {
      lines.push(`  - ${reason.code ?? "unknown"}: ${reason.message ?? "No detail available."}`);
    }
  }
  lines.push("", "Next:");
  for (const step of result.error.nextSteps ?? ["infinite setup"]) {
    lines.push(`  ${step}`);
  }
  return lines.join("\n");
}

function isSetupResult(result: unknown): result is {
  ok?: boolean;
  init?: Record<string, unknown>;
  model?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  next?: string;
} {
  return isRecord(result) && isRecord(result.init) && isRecord(result.model) && isRecord(result.runtime);
}

function renderSetupResult(result: {
  ok?: boolean;
  init?: Record<string, unknown>;
  model?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  next?: string;
}): string {
  const model = result.model ?? {};
  const auth = result.auth ?? {};
  const runtime = result.runtime ?? {};
  const init = result.init ?? {};
  const command = Array.isArray(runtime.command) ? runtime.command.map(String).join(" ") : undefined;
  const lines = [
    result.ok ? "Infinite setup complete." : "Infinite setup needs attention.",
    "",
    "Runtime:",
    `  Config: ${String(init.configPath ?? "not written")}`,
    `  Env: ${String(init.envPath ?? "not written")}`,
    `  Start: ${runtime.skipped ? "skipped" : command ?? String(runtime.status ?? "unknown")}`,
    "",
    "Model:",
    `  Provider: ${String(model.provider ?? auth.provider ?? "not selected")}`,
    `  Model: ${String(model.model ?? "not selected")}`,
    `  Auth: ${auth.ready ? "ready" : auth.skipped ? "skipped" : auth.hasCredentials ? "linked" : "not ready"}`
  ];
  if (typeof auth.source === "string") {
    lines.push(`  Source: ${auth.source}`);
  }
  if (typeof result.next === "string") {
    lines.push("", "Next:", `  ${result.next.replace(/`/g, "")}`);
  }
  return lines.join("\n");
}

function isSetupWizardResult(result: unknown): result is {
  section: "wizard";
  sections: Array<{ id: string; title: string; result: unknown }>;
  next?: string;
  ok?: boolean;
} {
  return isRecord(result) && result.section === "wizard" && Array.isArray(result.sections);
}

function renderSetupWizardResult(result: {
  section: "wizard";
  sections: Array<{ id: string; title: string; result: unknown }>;
  next?: string;
  ok?: boolean;
  setupMode?: string;
  existingInstall?: boolean;
}): string {
  const lines = ["Infinite setup", ""];
  if (result.existingInstall && result.setupMode === "full") {
    lines.push("Mode");
    lines.push(`  Reconfigure (${result.setupMode ?? "full"})`);
    lines.push("");
  } else if (result.existingInstall && result.setupMode === "reuse") {
    lines.push("Mode");
    lines.push("  Using existing setup");
    lines.push("");
  } else if (result.setupMode) {
    lines.push("Mode");
    lines.push(`  ${result.setupMode}`);
    lines.push("");
  }
  for (const section of result.sections) {
    lines.push(section.title);
    lines.push(`  ${setupSectionOneLine(section.id, section.result)}`);
    for (const detail of setupSectionDetailLines(section.id, section.result)) {
      lines.push(`  ${detail}`);
    }
    lines.push("");
  }
  const statusSection = result.sections.find((section) => section.id === "status");
  const statusFiles = isRecord(statusSection?.result) && isRecord(statusSection.result.files)
    ? statusSection.result.files
    : undefined;
  if (statusFiles) {
    lines.push("Files");
    lines.push(`  Project config: ${String(statusFiles.projectConfigPath ?? "unknown")}`);
    lines.push(`  Runtime secrets: ${String(statusFiles.runtimeEnvPath ?? "unknown")}`);
    lines.push(`  User model/auth: ${String(statusFiles.userConfigPath ?? "unknown")} | ${String(statusFiles.userAuthPath ?? "unknown")}`);
    lines.push("");
  }
  lines.push(result.ok ? "Setup complete." : "Setup incomplete.");
  if (result.next) {
    lines.push("", "Next:", `  ${result.next.replace(/`/g, "")}`);
  }
  return lines.join("\n");
}

function setupSectionOneLine(sectionId: string, result: unknown): string {
  if (!isRecord(result)) {
    return "No status available.";
  }
  if (sectionId === "project" && isRecord(result.interview) && Array.isArray(result.interview.providerInventory)) {
    const selected = (result.interview.providerInventory as Array<Record<string, unknown>>)
      .filter((row) => row.selected === true)
      .map((row) => String(row.provider).toUpperCase());
    return `project=${String(result.interview.projectName ?? result.name ?? "pending")} surface=${String(result.interview.productSurface ?? "unknown")} providers=${selected.join(", ") || "none"}`;
  }
  if (sectionId === "runtime" && isRecord(result.runtime)) {
    if (result.reused === true) {
      return `mode=${String(result.runtime.mode ?? "unknown")} using existing setup`;
    }
    const migrations = isRecord(result.runtime.migrations) ? result.runtime.migrations : undefined;
    const migrationState =
      isRecord(result.error) && result.error.code === "growth_os_local_workspace_migration_failed"
        ? "failed"
        : migrations?.alreadyUpToDate
          ? "ready"
          : migrations?.dryRun
            ? "dry-run"
            : "applied";
    return `mode=${String(result.runtime.mode ?? "unknown")} migrations=${String(migrationState)}`;
  }
  if (sectionId === "model") {
    if (result.reused === true) {
      return `provider=${String(result.provider ?? "unknown")} model=${String(result.model ?? "unknown")} using existing setup`;
    }
    return `provider=${String(result.provider ?? "unknown")} model=${String(result.model ?? "unknown")} auth=${String(isRecord(result.auth) ? result.auth.reason ?? result.auth.mode ?? "unknown" : "unknown")}`;
  }
  if (sectionId === "connectors" && isSetupOnboardingResult(result)) {
    return [
      `selected=${result.selectedProviders.map(formatSetupProviderLabel).join(",") || "none"}`,
      `completed=${result.completed.map(formatSetupProviderLabel).join(",") || "none"}`,
      `paused=${result.paused.map(formatSetupProviderLabel).join(",") || "none"}`,
      `failed=${result.failed.map(formatSetupProviderLabel).join(",") || "none"}`
    ].join(" ");
  }
  if (sectionId === "connectors" && Array.isArray(result.providers)) {
    return `options=${String(result.providers.length)} connectors=${String(isRecord(result.setupReadiness) ? result.setupReadiness.connectors ?? "unknown" : "unknown")}`;
  }
  if ((sectionId === "query" || sectionId === "status") && isRecord(result.setupReadiness)) {
    const base = `llmQuery=${String(result.setupReadiness.llmQuery ?? "unknown")} blockers=${String(Array.isArray(result.setupReadiness.blockingReasons) ? result.setupReadiness.blockingReasons.length : 0)}`;
    const run = normalizeSetupRunSummary(result.setupReadiness.activeSetupRun);
    return run ? `${base} ${setupRunOneLine(run)}` : base;
  }
  return result.ok === false ? "Incomplete." : "Ready.";
}

function setupSectionDetailLines(sectionId: string, result: unknown): string[] {
  if (!isRecord(result)) {
    return [];
  }
  if (sectionId === "project" && isRecord(result.interview) && Array.isArray(result.interview.providerInventory)) {
    const lines: string[] = [];
    const productDescription =
      typeof result.interview.productDescription === "string" ? result.interview.productDescription : undefined;
    if (productDescription) {
      lines.push(`Building: ${productDescription}`);
    }
    const websiteUrl = typeof result.interview.websiteUrl === "string" ? result.interview.websiteUrl : undefined;
    if (websiteUrl) {
      lines.push(`Website: ${websiteUrl}`);
    }
    for (const row of result.interview.providerInventory as Array<Record<string, unknown>>) {
      lines.push(
        `${String(row.provider).toUpperCase()}: account=${row.hasAccount === true ? "yes" : "no"}, ` +
        `install=${String(row.installState ?? "unknown")}, selected=${row.selected === true ? "yes" : "no"}`
      );
    }
    return lines;
  }
  if (sectionId === "connectors" && result.skipped === true) {
    return ["Skipped in quick setup. Run `infinite setup connectors` to connect marketing data."];
  }
  if (sectionId === "runtime" && result.reused === true) {
    return ["Using existing runtime configuration. Run `infinite setup runtime --reconfigure` to change it."];
  }
  if (sectionId === "runtime" && isRecord(result.error) && result.error.code === "growth_os_local_workspace_migration_failed") {
    const lines = [String(result.error.message ?? "Runtime startup failed.")];
    if (typeof result.error.detail === "string" && result.error.detail.trim()) {
      lines.push(`Technical detail: ${result.error.detail}`);
    }
    lines.push("Logs: infinite logs migrate");
    lines.push("Retry: infinite setup or infinite start");
    return lines;
  }
  if (sectionId === "model" && result.reused === true) {
    return ["Using existing model and auth configuration."];
  }
  if (sectionId === "connectors" && isSetupOnboardingResult(result)) {
    return result.providers.flatMap((provider) => {
      const lines = [`${formatSetupProviderLabel(provider.provider)}: ${provider.status}`];
      const handoffUrl = displaySetupHandoffUrl(provider.handoff?.url);
      const lastHandoffUrl = displaySetupHandoffUrl(provider.handoff?.lastUrl);
      if (provider.runId) {
        lines.push(`  Run ID: ${provider.runId}`);
        lines.push(`  Resume: ${setupResumeCommand({ id: provider.runId })}`);
      }
      if (provider.detail) {
        lines.push(`  Detail: ${provider.detail}`);
      }
      if (provider.handoff?.instructions) {
        lines.push(`  Action required: ${provider.handoff.instructions}`);
      }
      if (handoffUrl) {
        lines.push(`  Open this page: ${handoffUrl}`);
      }
      if (lastHandoffUrl && lastHandoffUrl !== handoffUrl) {
        lines.push(`  Last URL: ${lastHandoffUrl}`);
      }
      return lines;
    });
  }
  if (sectionId === "connectors" && Array.isArray(result.configuredConnections) && result.configuredConnections.length > 0) {
    return result.configuredConnections.map((connection) =>
      `${String(connection.provider)}: ${String(connection.connectionName ?? "configured")} (${String(connection.status ?? "unknown")})`
    );
  }
  if (sectionId === "status" && isRecord(result.setupReadiness)) {
    const run = normalizeSetupRunSummary(result.setupReadiness.activeSetupRun);
    if (run) {
      return setupRunDetailLines(run);
    }
  }
  return [];
}

function isRuntimeSetupResult(result: unknown): result is {
  section: "runtime";
  runtime: Record<string, unknown>;
  next?: string;
} {
  return isRecord(result) && result.section === "runtime" && isRecord(result.runtime);
}

function renderRuntimeSetupResult(result: {
  section: "runtime";
  runtime: Record<string, unknown>;
  error?: Record<string, unknown>;
  next?: string;
}): string {
  const runtime = result.runtime;
  const start = isRecord(runtime.start) ? runtime.start : {};
  const migrations = isRecord(runtime.migrations) ? runtime.migrations : {};
  const startCommand = Array.isArray(start.command) ? start.command.map(String).join(" ") : undefined;
  if (isRecord(result.error) && result.error.code === "growth_os_local_workspace_migration_failed") {
    const lines = [
      runtime.action === "start" ? "Infinite runtime startup failed." : "Infinite runtime setup failed.",
      "",
      String(result.error.message ?? "We couldn't start the local workspace."),
      "",
      "Runtime:",
      `  Mode: ${String(runtime.mode ?? "unknown")}`,
      ...(typeof runtime.workspaceRoot === "string" ? [`  Workspace: ${runtime.workspaceRoot}`] : []),
      ...(typeof runtime.configPath === "string" ? [`  Config: ${runtime.configPath}`] : []),
      ...(typeof runtime.envPath === "string" ? [`  Env: ${runtime.envPath}`] : []),
      ...(typeof runtime.databaseUrl === "string" ? [`  Database: ${runtime.databaseUrl}`] : []),
      `  Start: ${startCommand ?? "docker compose up -d"}`,
      `  Migrations: ${String(migrations.mode ?? "compose_managed")} failed`
    ];
    if (typeof result.error.detail === "string" && result.error.detail.trim()) {
      lines.push("", "Technical detail:", `  ${result.error.detail}`);
    }
    if (result.next) {
      lines.push("", "Next:", `  ${result.next.replace(/`/g, "")}`);
    }
    return lines.join("\n");
  }
  const lines = [
    "Infinite runtime setup",
    "",
    "Runtime:",
    `  Mode: ${String(runtime.mode ?? "unknown")}`,
    `  Config: ${String(runtime.configPath ?? "not written")}`,
    `  Env: ${String(runtime.envPath ?? "not written")}`,
    `  Database: ${String(runtime.databaseUrl ?? "unknown")}`,
    `  Start: ${start.skipped ? String(start.reason ?? "skipped") : startCommand ?? "not run"}`,
    `  Migrations: ${migrations.skipped ? String(migrations.mode ?? "skipped") : migrations.dryRun ? "dry-run" : migrations.alreadyUpToDate ? "already up to date" : "applied"}`
  ];
  if (result.next) {
    lines.push("", "Next:", `  ${result.next.replace(/`/g, "")}`);
  }
  return lines.join("\n");
}

function isConnectorSetupResult(result: unknown): result is {
  section: "connectors";
  provider: string;
  label?: string;
  connectionName?: string;
  configuredFields?: string[];
  docsUrl?: string;
  next?: string;
  ok?: boolean;
} {
  return isRecord(result) && result.section === "connectors" && typeof result.provider === "string" && "connectionName" in result;
}

function isSetupOnboardingResult(result: unknown): result is SetupOnboardingResult {
  return (
    isRecord(result) &&
    result.section === "connectors" &&
    result.workflow === "onboarding" &&
    Array.isArray(result.providers)
  );
}

function renderSetupOnboardingResult(result: SetupOnboardingResult): string {
  const lines = ["Infinite analytics onboarding", "", `Project: ${result.interview.projectName || "unknown"}`];

  if (result.interview.productDescription) {
    lines.push(`Building: ${result.interview.productDescription}`);
  }

  lines.push(
    `Surface: ${result.interview.productSurface}`,
    `Website: ${result.interview.websiteUrl ?? "not provided"}`
  );

  // #14 PRIMARY verdict: when nothing was even attempted, lead with the no-data-source
  // banner so the founder reads it before the (secondary) deferred provider rows below.
  const noDataSource =
    result.completed.length === 0 && result.paused.length === 0 && result.failed.length === 0;
  if (noDataSource) {
    lines.push(
      "",
      "No data source was configured — nothing was set up.",
      "Pick at least one analytics source (GA4 or PostHog are free) so Infinite has data to work with:",
      "  Run `infinite setup` and select a provider to get started."
    );
  }

  lines.push("", "Providers:");

  for (const provider of result.providers) {
    const handoffUrl = displaySetupHandoffUrl(provider.handoff?.url);
    const lastHandoffUrl = displaySetupHandoffUrl(provider.handoff?.lastUrl);
    lines.push(`  - ${formatSetupProviderLabel(provider.provider)}: ${provider.status}`);
    if (provider.runId) {
      lines.push(`    Run ID: ${provider.runId}`);
      lines.push(`    Resume: ${setupResumeCommand({ id: provider.runId })}`);
    }
    if (provider.detail) {
      lines.push(`    Detail: ${provider.detail}`);
    }
    // #13 a deferred (ticked-but-dropped / default-deferred) provider gets a rationale +
    // a concrete enable path so it is never a silent "not_selected".
    if (provider.status === "deferred") {
      if (provider.deferralReason) {
        lines.push(`    Why: ${provider.deferralReason}`);
      }
      lines.push(
        provider.deferralKind === "future"
          ? "    Enable it: Not available in this version yet — tracked for a future release."
          : `    Enable it: re-run \`infinite setup\` and tick ${formatSetupProviderLabel(provider.provider)} to set it up now.`
      );
    }
    if (provider.handoff?.instructions) {
      lines.push(`    Action required: ${provider.handoff.instructions}`);
    }
    if (handoffUrl) {
      lines.push(`    Open this page: ${handoffUrl}`);
    }
    if (lastHandoffUrl && lastHandoffUrl !== handoffUrl) {
      lines.push(`    Last URL: ${lastHandoffUrl}`);
    }
  }

  const hasResolvedArtifacts =
    Boolean(result.resolvedPublicArtifacts?.ga4 && Object.values(result.resolvedPublicArtifacts.ga4).some(Boolean)) ||
    Boolean(result.resolvedPublicArtifacts?.posthog && Object.values(result.resolvedPublicArtifacts.posthog).some(Boolean)) ||
    Boolean(result.resolvedPublicArtifacts?.x && Object.values(result.resolvedPublicArtifacts.x).some(Boolean));

  if (hasResolvedArtifacts && result.resolvedPublicArtifacts) {
    lines.push("", "Resolved public artifacts:");
    if (result.resolvedPublicArtifacts.ga4 && Object.values(result.resolvedPublicArtifacts.ga4).some(Boolean)) {
      lines.push(`  GA4: ${JSON.stringify(result.resolvedPublicArtifacts.ga4)}`);
    }
    if (result.resolvedPublicArtifacts.posthog && Object.values(result.resolvedPublicArtifacts.posthog).some(Boolean)) {
      lines.push(`  PostHog: ${JSON.stringify(result.resolvedPublicArtifacts.posthog)}`);
    }
    if (result.resolvedPublicArtifacts.x && Object.values(result.resolvedPublicArtifacts.x).some(Boolean)) {
      lines.push(`  X: ${JSON.stringify(result.resolvedPublicArtifacts.x)}`);
    }
  }

  if (result.installCommand) {
    lines.push(
      "",
      "Install your analytics tags — run this inside your website's code repo:",
      `  ${result.installCommand}`
    );
    if (result.installArtifactsPath) {
      lines.push(
        `  (on this machine you can simply run: npx infinite-tag install — Infinite saved your public keys to ${contractHomePath(result.installArtifactsPath)})`
      );
    }
    // #12 the install command only covers FINISHED providers (paused/failed never produced
    // a public id). Name every not-covered provider + its resume/retry path so the founder
    // is never handed a command that silently omits a source they selected.
    const notCovered = [...result.providers].filter(
      (provider) => provider.status === "paused_handoff" || provider.status === "failed"
    );
    if (notCovered.length > 0) {
      lines.push("", "Heads up: this command only installs tags for the providers that finished. Still to do:");
      for (const provider of notCovered) {
        const label = formatSetupProviderLabel(provider.provider);
        if (!provider.runId) {
          lines.push(`  - ${label}: not finished — run \`infinite setup status\` to continue, then re-run the install command.`);
        } else if (provider.status === "paused_handoff") {
          lines.push(`  - ${label}: paused mid-setup — finish it with \`${setupResumeCommand({ id: provider.runId })}\`, then re-run the install command.`);
        } else {
          lines.push(`  - ${label}: setup failed — retry with \`${setupResumeCommand({ id: provider.runId })}\` (see \`infinite setup status\`), then re-run the install command.`);
        }
      }
    }
  }

  // #11 Surface EVERY still-paused provider (not just the first/scoped one) so the 2nd/3rd
  // is never silently abandoned. Numbered for skimmability; the `--all` footer appears at ≥2.
  if (result.outstanding && result.outstanding.length > 0) {
    lines.push("", "Still paused (finish these to capture every selected provider):");
    result.outstanding.forEach((entry, index) => {
      const label = formatSetupProviderLabel(entry.provider);
      const lead = entry.instructions ? entry.instructions : "finish the step in your browser";
      lines.push(`  ${index + 1}. ${label} — ${lead}, then run \`${setupResumeCommand({ id: entry.runId })}\`.`);
    });
    if (result.outstanding.length >= 2) {
      lines.push("  Or resume them all in order: `infinite setup resume --all`");
    }
  }

  if (result.next) {
    lines.push("", "Next:", `  ${result.next.replace(/`/g, "")}`);
  }

  return lines.join("\n");
}

function renderConnectorSetupResult(result: {
  provider: string;
  label?: string;
  connectionName?: string;
  configuredFields?: string[];
  docsUrl?: string;
  next?: string;
  ok?: boolean;
  configuredConnections?: Array<{ provider: string; connectionName?: string; status?: string }>;
}): string {
  const lines = [
    "Infinite connector setup",
    "",
    `Provider: ${result.label ?? result.provider}`,
    `Connection: ${result.connectionName ?? result.provider}`,
    `Configured fields: ${Array.isArray(result.configuredFields) && result.configuredFields.length ? result.configuredFields.join(", ") : "secret fields only"}`
  ];
  if (Array.isArray(result.configuredConnections) && result.configuredConnections.length > 0) {
    lines.push("", "Current connections:");
    for (const connection of result.configuredConnections) {
      lines.push(`  ${connection.provider}: ${connection.connectionName ?? "configured"} (${connection.status ?? "unknown"})`);
    }
  }
  if (result.docsUrl) {
    lines.push(`Docs: ${result.docsUrl}`);
  }
  if (Array.isArray(result.configuredConnections) && result.configuredConnections.some((connection) => connection.status === "degraded")) {
    lines.push("", "Attention:");
    for (const connection of result.configuredConnections.filter((connection) => connection.status === "degraded")) {
      lines.push(`  ${connection.provider}: connection needs attention.`);
    }
  }
  if (result.next) {
    lines.push("", "Next:", `  ${result.next.replace(/`/g, "")}`);
  }
  return lines.join("\n");
}

function isSetupReadinessResult(result: unknown): result is {
  ok?: boolean;
  section?: string;
  setupReadiness: SetupReadiness;
  providers?: Array<Record<string, unknown>>;
  next?: string;
} {
  return isRecord(result) && isRecord(result.setupReadiness);
}

function setupResultConfiguredConnections(
  result: Record<string, unknown>
): Array<{ provider?: string; connectionName?: string; status?: string }> {
  return Array.isArray(result.configuredConnections)
    ? result.configuredConnections as Array<{ provider?: string; connectionName?: string; status?: string }>
    : [];
}

function renderSetupReadinessResult(result: {
  ok?: boolean;
  section?: string;
  setupReadiness: SetupReadiness;
  providers?: Array<Record<string, unknown>>;
  files?: SetupFilesSummary;
  nextCommand?: string;
  next?: string;
}): string {
  const readiness = result.setupReadiness;
  const lines = [
    result.section === "connectors" ? "Infinite connector setup" : "Infinite setup status",
    "",
    "Runtime:",
    `  Config: ${readiness.runtimeConfig}`,
    `  Services: ${readiness.runtimeServices}`,
    `  Database: ${readiness.database}`,
    "",
    "Model:",
    `  Provider: ${readiness.modelSelection?.provider ?? "not selected"}`,
    `  Model: ${readiness.modelSelection?.model ?? "not selected"}`,
    `  Auth: ${readiness.auth}${readiness.authProvider?.source ? ` (${readiness.authProvider.source})` : ""}`,
    "",
    "Connectors:",
    `  Marketing data: ${readiness.connectors}`,
    `  Connected sources: ${String(readiness.connectedSourceCount ?? 0)}`
  ];
  if (Array.isArray(result.providers) && result.providers.length > 0) {
    lines.push("", "Connector options:");
    for (const provider of result.providers) {
      lines.push(
        `  - ${String(provider.label ?? provider.provider)}: ${String(provider.status ?? "unknown")} ` +
        `| ${String(provider.setup ?? "not available")}`
      );
      if (typeof provider.docsUrl === "string") {
        lines.push(`    docs: ${provider.docsUrl}`);
      }
      const guidance = connectorGuidance(String(provider.provider ?? ""));
      if (guidance) {
        lines.push(`    ${guidance}`);
      }
    }
  }
  const configuredConnections = setupResultConfiguredConnections(result as Record<string, unknown>);
  if (configuredConnections.length > 0) {
    lines.push("", "Configured connectors:");
    for (const connection of configuredConnections) {
      lines.push(`  - ${String(connection.provider ?? "unknown")}: ${String(connection.connectionName ?? "configured")} (${String(connection.status ?? "unknown")})`);
    }
  }
  if (readiness.activeSetupRun) {
    lines.push("", "Active setup run:");
    for (const detail of setupRunDetailLines(readiness.activeSetupRun)) {
      lines.push(`  ${detail}`);
    }
  }
  if (result.files) {
    lines.push("", "Files:");
    lines.push(`  Project config: ${result.files.projectConfigPath}`);
    lines.push(`  Runtime secrets: ${result.files.runtimeEnvPath}`);
    lines.push(`  User model config: ${result.files.userConfigPath}`);
    lines.push(`  User auth state: ${result.files.userAuthPath}`);
  }
  lines.push("", "Query runtime:", `  ${readiness.llmQuery}`);
  if (readiness.blockingReasons.length > 0) {
    lines.push("", "Blocking reasons:");
    for (const reason of readiness.blockingReasons) {
      lines.push(`  - ${reason}`);
    }
  }
  if (result.nextCommand) {
    lines.push("", result.ok ? "Next:" : "Rerun:");
    lines.push(`  ${result.nextCommand}`);
  }
  if (result.next) {
    lines.push("", "Status:", `  ${result.next.replace(/`/g, "")}`);
  }
  return lines.join("\n");
}

function setupRunOneLine(run: SetupRunSummary): string {
  const parts = [
    `run=${run.id}`,
    `status=${run.status ?? "unknown"}`
  ];
  const handoff = run.pendingHandoff?.instructions;
  if (handoff) {
    parts.push(`handoff=${handoff}`);
  }
  const verification = setupRunVerificationSummary(run);
  if (verification.length > 0) {
    parts.push(`verify=${verification.join(",")}`);
  }
  if (isResumableSetupRunSummary(run)) {
    parts.push(`resume=${setupResumeCommand(run)}`);
  }
  return parts.join(" ");
}

// Mirrors SETUP_RUN_STALE_MS in @infinite-os/setup (setup-run-store.ts); the setup
// module is loaded dynamically here, so the constant cannot be imported statically.
const SETUP_RUN_STALE_MS = 15 * 60 * 1000;

function isStaleSetupRunSummary(run: SetupRunSummary, nowMs = Date.now()): boolean {
  if (run.status !== "running" && run.status !== "paused_handoff") {
    return false;
  }
  if (!run.updatedAt) {
    return false;
  }
  const updatedAtMs = Date.parse(run.updatedAt);
  if (Number.isNaN(updatedAtMs)) {
    return false;
  }
  return nowMs - updatedAtMs > SETUP_RUN_STALE_MS;
}

function setupRunDetailLines(run: SetupRunSummary): string[] {
  const lines = [
    `ID: ${run.id}`,
    `Tool: ${run.tool ?? run.provider ?? "unknown"}`,
    `Status: ${run.status ?? "unknown"}`
  ];
  const handoffUrl = displaySetupHandoffUrl(run.pendingHandoff?.url);
  const lastHandoffUrl = displaySetupHandoffUrl(run.pendingHandoff?.lastUrl);
  if (run.interview?.projectName || run.interview?.productDescription || run.interview?.productSurface || run.interview?.websiteUrl) {
    const interviewParts = [
      run.interview.projectName,
      run.interview.productDescription,
      run.interview.productSurface,
      run.interview.websiteUrl
    ].filter(Boolean);
    lines.push(`Interview: ${interviewParts.join(" | ")}`);
  }
  if (run.selectedProviders && run.selectedProviders.length > 0) {
    lines.push(`Selected providers: ${run.selectedProviders.map(formatSetupProviderLabel).join(", ")}`);
  }
  if (run.recommendedProviders && run.recommendedProviders.length > 0) {
    lines.push(`Recommended providers: ${run.recommendedProviders.map(formatSetupProviderLabel).join(", ")}`);
  }
  if (run.pendingHandoff?.instructions) {
    lines.push(`Action required: ${run.pendingHandoff.instructions}`);
  }
  if (setupRunNeedsPostHogKeyImportHint(run)) {
    lines.push(
      `Key file import: ${setupResumeCommand(run)} --posthog-personal-api-key-file .growth-os/tmp/posthog-personal-api-key --posthog-api-host <https://eu.posthog.com|https://us.posthog.com>`
    );
  }
  if (handoffUrl) {
    lines.push(`Open this page: ${handoffUrl}`);
  }
  if (lastHandoffUrl && lastHandoffUrl !== handoffUrl) {
    lines.push(`Last URL: ${lastHandoffUrl}`);
  }
  if (isResumableSetupRunSummary(run)) {
    lines.push(`Resume: ${setupResumeCommand(run)}`);
  }
  const verification = setupRunVerificationLines(run);
  if (verification.length > 0) {
    lines.push("Verification:");
    lines.push(...verification.map((detail) => `  ${detail}`));
  }
  const site = run.site;
  if (site && (site.url || site.repoPath || site.appDir || site.framework)) {
    lines.push(
      `Site: ${[site.url, site.repoPath, site.appDir, site.framework].filter(Boolean).join(" | ")}`
    );
  }
  if (isStaleSetupRunSummary(run)) {
    lines.push("⚠ This run looks stale — run `infinite setup reset` to clear it.");
  }
  return lines;
}

function setupRunVerificationSummary(run: SetupRunSummary): string[] {
  const lines: string[] = [];
  for (const [provider, summary] of Object.entries(run.providers ?? {})) {
    if (!summary.verification) {
      continue;
    }
    const install = summary.verification.installStatus ?? "unknown";
    const queryability = summary.verification.queryabilityStatus ?? "unknown";
    lines.push(`${provider}:${install}/${queryability}`);
  }
  return lines;
}

function setupRunNeedsPostHogKeyImportHint(run: SetupRunSummary): boolean {
  const provider = run.provider ?? run.tool;
  if (provider !== "posthog" || !isResumableSetupRunSummary(run)) {
    return false;
  }
  const handoffUrl = run.pendingHandoff?.url ?? run.pendingHandoff?.lastUrl ?? "";
  const instructions = run.pendingHandoff?.instructions ?? "";
  return (
    handoffUrl.includes("/settings/user-api-keys") ||
    /personal api key|api key/i.test(instructions)
  );
}

function setupRunVerificationLines(run: SetupRunSummary): string[] {
  return Object.entries(run.providers ?? {})
    .filter(([, summary]) => Boolean(summary.verification))
    .map(([provider, summary]) =>
      `${provider}: install=${summary.verification?.installStatus ?? "unknown"}, ` +
      `queryability=${summary.verification?.queryabilityStatus ?? "unknown"}`
    );
}

function displaySetupHandoffUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return value;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return value;
  }
}

function formatSetupProviderLabel(provider: string): string {
  return provider.toUpperCase();
}

function connectorGuidance(provider: string): string | undefined {
  if (provider === "google_analytics_4") {
    return "Needs Google authorization for sync/query. The website install uses the GA4 Measurement ID (G-...) discovered from the web stream; only advanced users need a Google Cloud OAuth client ID.";
  }
  if (provider === "posthog") {
    return "Needs a project ID and a personal API key from your PostHog workspace.";
  }
  if (provider === "stripe") {
    return "Needs a Stripe secret key; optional API base URL is only for non-default environments.";
  }
  if (provider === "x") {
    return "Needs a bearer token and the X username to resolve the timeline source.";
  }
  if (provider === "shopify") {
    return "Needs a Shopify store domain and an Admin API access token; optional API version defaults later in the connector.";
  }
  if (provider === "meta_ads") {
    return "Needs a Meta ad account ID plus either a Marketing API access token or an MCP command/tool name if you already have a Meta Ads MCP server installed.";
  }
  return undefined;
}

function answerLines(envelope: ActionEnvelope): string[] {
  const data = isRecord(envelope.data) ? envelope.data : {};
  if (envelope.status === "unsupported") {
    return [
      `Unsupported: ${envelope.error?.code ?? "unsupported"}`,
      ...(typeof data.question === "string" ? [`Question: ${data.question}`] : [])
    ];
  }
  if (["run_metric_query", "run_breakdown_query", "run_funnel_query"].includes(envelope.actionId)) {
    return [
      `${String(data.metric ?? envelope.actionId)} on ${String(data.view ?? "queryable view")}`,
      `Rows: ${Array.isArray(data.rows) ? data.rows.length : 0}`,
      JSON.stringify(data.rows ?? [], null, 2)
    ];
  }
  if (envelope.actionId === "explain_answer") {
    return [
      `Metric: ${String(data.metric ?? "unknown")}`,
      `Authority: ${String(data.sourceAuthority ?? "not supplied")}`,
      `Drilldown: ${String(data.drilldownAction ?? "drilldown_result")}`
    ];
  }
  if (envelope.actionId === "drilldown_result") {
    return [
      `Metric: ${String(data.metric ?? "unknown")}`,
      `Rows: ${Array.isArray(data.rows) ? data.rows.length : 0}`,
      JSON.stringify(data.rows ?? [], null, 2)
    ];
  }
  if (envelope.status === "queued") {
    return [`Queued ${envelope.actionId}`, JSON.stringify(data, null, 2)];
  }
  return [JSON.stringify(data, null, 2)];
}

function assumptionsLines(envelope: ActionEnvelope): string[] {
  const data = isRecord(envelope.data) ? envelope.data : {};
  const plan = isRecord(data.plan) ? data.plan : undefined;
  const assumptions = plan?.assumptions;
  return Array.isArray(assumptions) ? assumptions.filter((item): item is string => typeof item === "string") : [];
}

function freshnessLines(envelope: ActionEnvelope): string[] {
  if (!envelope.freshness) return [];
  return [
    `Target: ${envelope.freshness.target}`,
    `As of: ${envelope.freshness.asOf ?? "not available"}`,
    `Stale: ${String(envelope.freshness.stale)}`
  ];
}

function renderMemory(memory: SessionMemoryState | undefined): string {
  if (!memory) return "No operator session memory is active.";
  return [
    "Session memory",
    `  workspaceId: ${memory.workspaceId}`,
    `  workspaceRoot: ${memory.workspaceRoot ?? "not set"}`,
    `  activeSourceIds: ${memory.activeSourceIds.join(", ") || "none"}`,
    `  lastQuestion: ${memory.lastQuestion ?? "none"}`,
    `  lastAnswerId: ${memory.lastAnswerId ?? "none"}`,
    `  lastAnswerSummary: ${memory.lastAnswerSummary ?? "none"}`,
    `  preferredTimezone: ${memory.preferredTimezone ?? "UTC"}`,
    `  defaultPopularityMetric: ${memory.defaultPopularityMetric ?? "none"}`,
    `  lastReportId: ${memory.lastReportId ?? "none"}`,
    `  lastExportTarget: ${memory.lastExportTarget ?? "none"}`
  ].join("\n");
}

function rememberResult(
  memory: OperatorSessionMemory | undefined,
  memoryStore: SessionMemoryStore | undefined,
  result: unknown
): void {
  if (memory && isEnvelope(result)) {
    memory.rememberEnvelope(result);
    memoryStore?.save(memory.persistedState());
  }
}

function updateMemoryPreference(
  args: string[],
  memory: OperatorSessionMemory | undefined,
  memoryStore: SessionMemoryStore | undefined
): string {
  if (!memory) return "No operator session memory is active.";
  const [key, ...valueParts] = args;
  const value = valueParts.join(" ").trim();
  if (!key || !value) {
    return "Usage: /memory set timezone <iana_timezone> | popularity-metric <metric> | sources <source_id,source_id>";
  }
  if (key === "timezone") {
    memory.updatePreferences({ preferredTimezone: value });
  } else if (key === "popularity-metric") {
    memory.updatePreferences({ defaultPopularityMetric: value });
  } else if (key === "sources") {
    memory.updatePreferences({ activeSourceIds: value.split(",").map((sourceId) => sourceId.trim()) });
  } else {
    throw new Error(`unknown_memory_preference:${key}`);
  }
  memoryStore?.save(memory.persistedState());
  return renderMemory(memory.snapshot());
}

async function runCliRecipe(recipeId: RecipeId, input: unknown, env: CliEnv): Promise<unknown> {
  const context = createSessionContext({
    workspaceId: workspaceIdFor(env),
    authority: "operator",
    surface: "cli"
  });
  return runRecipe(
    recipeId,
    isRecord(input) ? input : {},
    context,
    (actionId, actionInput, recipeContext) =>
      apiRequest("/tools/call", env, {
        method: "POST",
        operator: recipeContext.authority === "operator",
        body: { actionId, input: actionInput }
      }) as Promise<ActionEnvelope>
  );
}

function workspaceIdFor(env: CliEnv): string {
  return infiniteOsWorkspaceId({ env: env as NodeJS.ProcessEnv });
}

function isEnvelope(value: unknown): value is ActionEnvelope {
  return (
    isRecord(value) &&
    typeof value.actionId === "string" &&
    typeof value.status === "string" &&
    typeof value.authority === "string" &&
    Array.isArray(value.provenance) &&
    Array.isArray(value.caveats) &&
    Array.isArray(value.nextActions)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

// Timestamps arrive as Date objects from direct DB reads and as ISO strings
// from the app API; normalize both to an ISO string.
function timestampValue(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return stringValue(value);
}

async function apiRequest(path: string, env: CliEnv, options: ApiOptions = {}): Promise<unknown> {
  const hydrated = hydrateApiSettings(env, options.config);
  const baseUrl = await resolveApiBaseUrlOnce(env, options.config);
  const token = options.operator
    ? hydrated.operatorToken
    : hydrated.readToken ?? hydrated.operatorToken;
  let workspaceId: string | undefined;
  if (options.workspaceId) {
    // Explicit override (cross-workspace readiness scopes `/sources` per project).
    workspaceId = options.workspaceId;
  } else if (!options.omitWorkspace) {
    try {
      workspaceId = workspaceIdFor(env);
    } catch (error) {
      if (!(error instanceof NoActiveProjectError)) {
        throw error;
      }
      // Exempt/no-project paths (e.g. `health`, first `project new`) still reach the
      // API; the workspace header is conditionally added below, so leave it unset.
      workspaceId = undefined;
    }
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(workspaceId ? { "X-Growth-Os-Workspace": workspaceId } : {}),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // Short, explicit cap on the interactive readiness path so a squatting server
      // that never answers can't hang startup; uncapped for normal commands.
      ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {})
    });
  } catch (error) {
    // A connection error means the daemon we resolved is gone (or moved to a new
    // ephemeral port). Drop the memoized base URL so the NEXT request re-runs the
    // descriptor ladder instead of hammering a dead address. Redact userinfo before
    // it can reach a thrown Error / transcript (a user:pass@host GROWTH_OS_API_URL).
    invalidateApiBaseUrl();
    throw new Error(`API request to ${redactUrlUserinfo(baseUrl)}${path} failed: ${connectionErrorMessage(error)}`);
  }
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }
  return payload;
}

// Strip userinfo (user:password@) from a URL before it can enter a thrown Error,
// onProgress message, lastError, or any returned JSON. Mirrors redactDatabaseUrl's
// URL.password pattern but redacts the WHOLE userinfo so neither the user nor the
// password leaks. Best-effort: a non-URL string is returned with a userinfo-shaped
// substring scrubbed.
function redactUrlUserinfo(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    return value.replace(/\/\/[^/@]*@/, "//[redacted]@");
  }
}

// Connection errors can carry a `cause` whose message embeds the address; surface a
// short, safe message rather than the full chain. The address in `${baseUrl}${path}`
// is already redacted at the call site, so we keep only the error's own text.
function connectionErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "connection error";
  }
  return String(error);
}

// The tokens + the candidate `configBaseUrl` are resolved synchronously from config;
// the *actual* base URL is resolved asynchronously (descriptor-first discovery) by
// resolveApiBaseUrlOnce below. We split them because the URL ladder now does network
// identity probes, while the tokens never need I/O.
function hydrateApiSettings(
  env: CliEnv,
  suppliedConfig?: InfiniteOsConfig
): { configBaseUrl?: string; readToken?: string; operatorToken?: string } {
  const config = suppliedConfig ?? loadOptionalInfiniteOsConfig(env);
  // KEEP configBaseUrl — the dockerized `infinite start` app writes its descriptor
  // INSIDE the container, so host CLIs reach it only via this fixed host:port. The
  // hardcoded "http://127.0.0.1:3000" literal is GONE; the equivalent default now
  // lives in resolveDaemonEndpoint's configBaseUrl rung (design §3).
  const configBaseUrl = config ? `http://${config.appHost}:${config.appPort}` : undefined;
  return {
    configBaseUrl,
    readToken: env.GROWTH_OS_READ_TOKEN ?? config?.readToken,
    operatorToken: env.GROWTH_OS_OPERATOR_TOKEN ?? config?.operatorToken
  };
}

// Per-process memo of the resolved API base URL. resolveDaemonEndpoint is itself
// memoized, but it returns null when no daemon answers — in which case we still want
// to fall back to configBaseUrl, and we don't want to re-run the (config-dependent)
// ladder on every apiRequest. invalidate via invalidateApiBaseUrl() when a request
// hits a connection error (the daemon may have moved to a new ephemeral port).
let apiBaseUrlMemo: string | undefined;

// Exported so tests can reset the per-process discovery memo between cases (a process
// runs many scenarios; production only ever has one daemon). Also called internally on
// a connection error so a daemon that moved to a new ephemeral port is rediscovered.
export function invalidateApiBaseUrl(): void {
  apiBaseUrlMemo = undefined;
  // Also drop the shared resolver's memo so the descriptor ladder re-probes — a
  // daemon that just (re)started on a new port must be rediscovered.
  invalidateResolvedDaemonEndpoint();
}

/**
 * Resolve the API base URL with descriptor-first discovery (design §3/§7), memoized
 * per process. Ladder: GROWTH_OS_API_URL → a validated live daemon (descriptor /
 * configBaseUrl, identity-probed by resolveDaemonEndpoint) → configBaseUrl.
 *
 * configBaseUrl is the LAST-RESORT fallback so the dockerized `infinite start` app
 * (reachable only on the fixed port) still works even if its in-container descriptor
 * isn't visible to the host and its /health hasn't come up yet. Never throws — a dead
 * daemon yields the configBaseUrl fallback (or, with no config, a loopback default),
 * which the caller's own timeout/identity check then rejects fast.
 */
async function resolveApiBaseUrlOnce(
  env: CliEnv,
  suppliedConfig?: InfiniteOsConfig,
  // Injectable only so the discovery ladder can be exercised in tests; production
  // always uses the global fetch via resolveDaemonEndpoint's own default.
  fetchImpl?: typeof fetch
): Promise<string> {
  // The explicit override is a pure env read — return it directly, never memoized, so
  // it always reflects the CURRENT env (and so a process that runs many envs — tests —
  // can't serve a stale value). It is intentionally NOT identity-probed here: it's the
  // operator's escape hatch, and waitForAppReady / apiRequest still validate the
  // /health identity before trusting any response from it.
  const override = env.GROWTH_OS_API_URL?.trim();
  if (override) {
    return override.replace(/\/$/, "");
  }
  // Discovery path is the per-process memoized one (single daemon per machine).
  if (apiBaseUrlMemo !== undefined) {
    return apiBaseUrlMemo;
  }
  const { configBaseUrl } = hydrateApiSettings(env, suppliedConfig);
  const resolved =
    (await resolveDaemonEndpoint(env as NodeJS.ProcessEnv, fetchImpl ? { fetchImpl } : undefined))?.url ??
    configBaseUrl ??
    "http://127.0.0.1:3000";
  apiBaseUrlMemo = resolved.replace(/\/$/, "");
  return apiBaseUrlMemo;
}

function loadOptionalInfiniteOsConfig(env: CliEnv): InfiniteOsConfig | undefined {
  try {
    return loadInfiniteOsConfig({ workspaceRoot: workspaceRootFor(env), env: env as NodeJS.ProcessEnv });
  } catch {
    return undefined;
  }
}

function workspaceRootFor(env: CliEnv): string {
  if (env.GROWTH_OS_WORKSPACE_ROOT) {
    return resolve(env.GROWTH_OS_WORKSPACE_ROOT);
  }
  const start = resolve(env.PWD ?? process.cwd());
  // Prefer the repo discovered from the invocation directory (`./infinite` run
  // inside a checkout). When `infinite` is launched from anywhere via the global
  // wrapper, cwd is not the repo, so the upward search from `start` fails — fall
  // back to the checkout that contains this CLI's own entry file before giving
  // up. Without this, `docker compose` runs in cwd and fails with
  // "no configuration file provided: not found".
  return (
    findInfiniteOsRepoRoot(start) ??
    findInfiniteOsRepoRoot(dirname(CLI_ENTRY_PATH)) ??
    start
  );
}

function findInfiniteOsRepoRoot(start: string): string | undefined {
  let current = start;
  for (;;) {
    if (existsSync(join(current, "docker-compose.yml")) && existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

const CLI_ENTRY_PATH = fileURLToPath(import.meta.url);
const INVOKED_PATH = process.argv[1] ? resolve(process.argv[1]) : "";

if (INVOKED_PATH && (CLI_ENTRY_PATH === INVOKED_PATH || realpathSync.native?.(CLI_ENTRY_PATH) === realpathSync.native?.(INVOKED_PATH))) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    output.write(`${message}\n`);
    process.exitCode = 1;
  });
}
