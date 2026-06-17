import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { decryptCredentialPayload, encryptCredentialPayload, refreshOAuthToken } from "@infinite-os/core";
import { readLatestSetupPublicArtifacts, type InfiniteOsDb, type SetupResolvedArtifacts } from "@infinite-os/db";
import type { SessionContext } from "@infinite-os/runtime";

import { runOnboarding, type OnboardingResult } from "./onboarding-controller.js";
import { providerGuidance, type GuidanceStep } from "./provider-guidance.js";
import { buildProviderConfirmations } from "./confirmations.js";
import { writeSetupArtifactsFile } from "./artifacts-file.js";
import { buildInstrumentInstallCommand } from "./install-command.js";
import {
  browserSessionKeyForProvider,
  buildBrowserSessionKey,
  createFileBrowserSessionStore,
  type BrowserSessionStore
} from "./browser/session-store.js";
import { createPlaywrightBrowserFactory, type PlaywrightBrowserFactoryOptions } from "./browser/playwright.js";
import type { LocalBrowser, LocalBrowserFactory } from "./browser/types.js";
import type { SetupRunStore } from "./setup-controller.js";
import { createDbSetupRunStore } from "./setup-run-store.js";
import {
  createGa4Provisioner,
  createPostHogProvisioner,
  createXProvisioner,
  type ActionRunner,
  type Prompter,
  type Provisioner,
  type ProvisionerContext
} from "./provisioner.js";
import {
  createGa4AdminApiClient,
  createGa4LiveDependencies,
  type Ga4AuthResolution,
  type Ga4AuthorizedSession
} from "./providers/ga4.js";
import {
  createPostHogApiClient,
  createPostHogLiveDependencies,
  derivePostHogPublicApiHost,
  isPostHogPersonalApiKey,
  normalizePostHogApiHost,
  sanitizePostHogBrowserUrl,
  type PostHogResolvedAccess
} from "./providers/posthog-live.js";
import type { PostHogHumanHandoffRequest, PostHogTransport } from "./providers/posthog.js";
import { createXLiveDependencies, type XAdsState, type XStoredCredentials } from "./providers/x.js";
import type {
  SetupBrowserHandoffRef,
  SetupInterview,
  SetupProviderId,
  SetupProviderPublicArtifacts
} from "./types.js";

interface ProviderCredentialRow {
  source_id: string;
  credential_id: string;
  credential_kind: string;
  encrypted_payload: string;
}

interface ProviderOauthStateRow {
  oauth_app_id?: string | null;
  oauth_token_id: string;
  encrypted_app_payload?: string | null;
  encrypted_token_payload: string;
}

interface SetupRunStateRow {
  id: string;
  tool?: string | null;
  provider?: string | null;
  status?: string | null;
  phase_state?: Record<string, unknown> | null;
  pending_handoff?: Record<string, unknown> | null;
  browser_profile?: string | null;
}

export interface PersistedSetupHandoff {
  provider: SetupProviderId;
  runId: string;
  kind?: "window_open" | "open_url";
  url?: string;
  instructions?: string;
  reason?: string;
  resume?: Record<string, string>;
  browser?: SetupBrowserHandoffRef;
}

export interface ActiveSetupRun {
  id: string;
  tool?: string;
  provider?: string;
  status?: string;
  pendingHandoff?: PersistedSetupHandoff | null;
  browserProfile?: string | null;
}

export interface LiveSetupOnboardingResult extends OnboardingResult {
  interview: SetupInterview;
  activeRuns: ActiveSetupRun[];
  resolvedPublicArtifacts: SetupResolvedArtifacts;
  /** Complete `npx infinite-tag install …` command for the founder's website repo; null when nothing installable was captured. */
  installCommand: string | null;
  /**
   * Absolute path of the same-machine handoff file (`~/.infinite/artifacts/<workspaceId>.json`)
   * holding the whitelisted PUBLIC artifacts, so a bare `npx infinite-tag install` on this
   * machine needs no flags; null when nothing was saved.
   */
  installArtifactsPath: string | null;
}

export interface LiveSetupExecutionOptions {
  db: InfiniteOsDb;
  workspaceId: string;
  interview: SetupInterview;
  actions: ActionRunner;
  prompt: Prompter;
  repoRoot?: string;
  browserFactory?: ProvisionerContext["browser"];
  browserSessionStore?: BrowserSessionStore;
  ga4OauthBootstrap?: Ga4OauthBootstrapClient;
  createProvisioners?: (input: {
    db: InfiniteOsDb;
    workspaceId: string;
    interview: SetupInterview;
    prompt: Prompter;
    browserSessionStore: BrowserSessionStore;
    browserFactory: ProvisionerContext["browser"];
    ga4OauthBootstrap?: Ga4OauthBootstrapClient;
    resumeHandoffs?: Partial<Record<SetupProviderId, PersistedSetupHandoff | null>>;
    resumeSecrets?: ResumeSetupSecrets;
    resumePublicArtifacts?: Partial<Record<SetupProviderId, SetupProviderPublicArtifacts | undefined>>;
  }) => Promise<Provisioner[]>;
  handoffLauncher?: (input: BrowserHandoffLaunchInput) => Promise<void>;
  /**
   * Per-provider sequencing gate (#8 Part 1). After each paused provider's browser opens,
   * the CLI awaits this gate (an Enter-to-continue ack on a TTY) before the next provider's
   * browser opens — so hand-offs are strictly one-at-a-time. Non-interactive callers leave
   * it undefined (default no-op), preserving today's "open all, return URLs" behavior.
   *
   * This is the SHARED wait/gate seam #7 and #8 compose on: #8 supplies sequencing here, #7
   * threads its `AbortSignal` so Ctrl-C cancels the current provider's wait. The setup
   * package never owns the TTY — this is implemented in the CLI and injected.
   */
  awaitProviderHandoff?: ProviderHandoffGate;
  /** Per-provider "Now connecting <Provider> (N of M)…" boundary, printed by the CLI. */
  onProviderStart?: (input: { provider: SetupProviderId; index: number; total: number }) => void;
  runStore?: SetupRunStore;
  timeZone?: string;
  log?: ProvisionerContext["log"];
  /** Total time to block on the GA4 OAuth browser consent before falling back to a resumable pause. */
  ga4OauthWaitMs?: number;
  /** Interval between GA4 OAuth status polls while blocking on the browser consent. */
  ga4OauthPollIntervalMs?: number;
  /** Injectable sleep for tests so the GA4 OAuth poll loop does not wait real time. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional cancellable-wait interaction for the GA4 OAuth poll (#7). The setup package
   * stays free of TTY/readline: the CLI implements the keypress + options menu and injects
   * it here. Undefined on non-interactive / --json / headless runs — the poll then keeps
   * today's print-URL + poll + resumable-pause behavior and NEVER blocks on a keypress.
   */
  ga4OauthInteraction?: Ga4OauthWaitInteraction;
}

const DEFAULT_GA4_OAUTH_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_GA4_OAUTH_POLL_INTERVAL_MS = 2000;

/**
 * The shared per-provider hand-off gate (`awaitProviderHandoff`). Resolves when the founder
 * acks the current provider's browser hand-off (or immediately on non-interactive paths).
 * #7 adds the `signal`: when aborted (Ctrl-C), the gate rejects/returns and the provider is
 * left `paused_handoff`.
 */
export type ProviderHandoffGate = (
  provider: SetupProviderId,
  context: { index: number; total: number; url?: string; signal?: AbortSignal }
) => Promise<void>;

/** Outcome the founder chose from the cancellable GA4 OAuth wait menu (#7). */
export type Ga4OauthWaitDecision = "retry" | "byo" | "manual" | "quit";

/**
 * CLI-implemented interaction surface for the cancellable GA4 OAuth wait (#7). All methods
 * are optional so a partial stub works in tests. The setup package only calls these — it
 * never touches stdin/raw mode itself.
 */
export interface Ga4OauthWaitInteraction {
  /** Called once when the wait begins, with the pasteable authorization URL. */
  onWaitStarted?(input: { authorizationUrl?: string; sessionId: string }): void;
  /**
   * Races against the status poll. Resolve with a decision when the founder interrupts the
   * wait (keypress / Ctrl-C then a menu choice); resolve with `null` to let the poll continue.
   * Never resolve (or return a never-settling promise) on non-interactive paths — but on
   * those paths this interaction is simply not injected.
   */
  waitForDecision?(): Promise<Ga4OauthWaitDecision | null>;
  /**
   * Tears down any armed keypress wait NOW (remove the listener, restore raw mode, resolve the
   * pending `waitForDecision` so it can never fire later). The poll calls this the instant it
   * reaches ANY terminal state — before `onTimeout`/`onFailed` open their menu, and before it
   * returns an authorized result — so whatever prompt runs next gets a clean stdin. Idempotent
   * and exception-safe; a no-op when no wait is armed.
   */
  cancelWait?(): void;
  /** Called when the poll window elapses with no terminal status; returns the menu choice (or null to pause). */
  onTimeout?(input: { error?: string | null; sessionId: string }): Promise<Ga4OauthWaitDecision | null>;
  /** Called when the OAuth session reports `failed`; surfaces `status.error` and returns the menu choice (or null to pause). */
  onFailed?(input: { error?: string | null; sessionId: string }): Promise<Ga4OauthWaitDecision | null>;
}

/** Typed outcome of the GA4 OAuth poll/race (replaces the old bare `null`). */
type Ga4OauthPollOutcome =
  | { kind: "authorized"; resolution: Ga4AuthResolution }
  | { kind: "decision"; decision: Ga4OauthWaitDecision; error?: string | null }
  | { kind: "timeout"; error?: string | null }
  | { kind: "failed"; error?: string | null };

interface Ga4OauthPollConfig {
  waitMs: number;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  interaction?: Ga4OauthWaitInteraction;
}

/** Canonical provider order for sequencing hand-offs (#8): GA4 → PostHog → X. */
const CANONICAL_PROVIDER_ORDER: SetupProviderId[] = ["ga4", "posthog", "x"];

function canonicalProviderRank(provider: SetupProviderId): number {
  const rank = CANONICAL_PROVIDER_ORDER.indexOf(provider);
  return rank === -1 ? CANONICAL_PROVIDER_ORDER.length : rank;
}

export interface ResumeLiveSetupExecutionOptions extends Omit<LiveSetupExecutionOptions, "interview"> {
  runId: string;
  resumeSecrets?: ResumeSetupSecrets;
}

export interface ResumeSetupSecrets {
  posthog?: {
    apiHost?: string;
    personalApiKey?: string;
  };
}

export interface LaunchPersistedSetupHandoffOptions {
  db: InfiniteOsDb;
  workspaceId: string;
  runId: string;
  browserFactory?: ProvisionerContext["browser"];
  browserSessionStore?: BrowserSessionStore;
}

export interface LiveSetupHandoffSession {
  runId: string;
  provider: SetupProviderId;
  url: string;
  pendingHandoff: PersistedSetupHandoff;
  browser: LocalBrowser;
}

interface BrowserHandoffLaunchInput {
  provider: string;
  url: string;
  contextRef: string;
  sessionKey: string;
}

export interface Ga4OauthBootstrapConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}

export interface Ga4OauthBootstrapStatus {
  sessionId: string;
  provider: string;
  status: "pending" | "completed" | "failed";
  authorizationUrl?: string;
  redirectUri?: string;
  expiresAt?: string;
  hasAuthorizationCode?: boolean;
  error?: string | null;
}

export interface Ga4OauthBootstrapExchangeResult {
  ok: boolean;
  sessionId: string;
  provider: string;
  status: string;
  oauthAppId?: string | null;
  oauthTokenId?: string | null;
}

export interface Ga4OauthBootstrapClient {
  prepareConfig(): Promise<Ga4OauthBootstrapConfig | null>;
  start(input: Ga4OauthBootstrapConfig): Promise<Ga4OauthBootstrapStatus>;
  status(sessionId: string): Promise<Ga4OauthBootstrapStatus>;
  exchange(sessionId: string): Promise<Ga4OauthBootstrapExchangeResult>;
}

type PostHogPlannedHandoff = PostHogHumanHandoffRequest & {
  browser?: SetupBrowserHandoffRef;
  lastKnownUrl?: string;
};

const DEFAULT_BROWSER_SESSION_STORE = createFileBrowserSessionStore(
  join(homedir(), ".growth-os", "browser-sessions.json")
);

const ACTIVE_RUN_SELECT = `
  select
    id,
    tool,
    provider,
    status,
    phase_state,
    pending_handoff,
    browser_profile
  from setup_runs
`;

export async function runLiveSetupOnboarding(
  options: LiveSetupExecutionOptions
): Promise<LiveSetupOnboardingResult> {
  const browserSessionStore = options.browserSessionStore ?? DEFAULT_BROWSER_SESSION_STORE;
  const runStore = options.runStore ?? createDbSetupRunStore(options.db);
  const browserSessionScope = buildWorkspaceBrowserSessionScope(options.workspaceId);
  return executeLiveSetupOnboarding(
    options,
    options.interview,
    browserSessionStore,
    browserSessionScope,
    runStore,
    {},
    {},
    {}
  );
}

async function executeLiveSetupOnboarding(
  options: Omit<LiveSetupExecutionOptions, "interview">,
  interview: SetupInterview,
  browserSessionStore: BrowserSessionStore,
  browserSessionScope: string,
  runStore: SetupRunStore,
  resumeHandoffs: Partial<Record<SetupProviderId, PersistedSetupHandoff | null>>,
  resumeSecrets: ResumeSetupSecrets,
  resumePublicArtifacts: Partial<Record<SetupProviderId, SetupProviderPublicArtifacts | undefined>>
): Promise<LiveSetupOnboardingResult> {
  const browserFactory = options.browserFactory ?? createPlaywrightBrowserFactory({
    sessionStore: browserSessionStore
  } satisfies PlaywrightBrowserFactoryOptions);
  const ga4OauthPoll: Ga4OauthPollConfig = {
    waitMs: options.ga4OauthWaitMs ?? DEFAULT_GA4_OAUTH_WAIT_MS,
    pollIntervalMs: options.ga4OauthPollIntervalMs ?? DEFAULT_GA4_OAUTH_POLL_INTERVAL_MS,
    sleep: options.sleep ?? ((ms) => delay(ms)),
    interaction: options.ga4OauthInteraction
  };
  const createProvisioners =
    options.createProvisioners ??
    ((input) => createLiveSetupProvisioners({
      db: input.db,
      workspaceId: input.workspaceId,
      interview: input.interview,
      prompt: input.prompt,
      browserSessionScope,
      browserSessionStore: input.browserSessionStore,
      browserFactory: input.browserFactory,
      ga4OauthBootstrap: input.ga4OauthBootstrap,
      ga4OauthPoll,
      resumeHandoffs: input.resumeHandoffs,
      resumeSecrets: input.resumeSecrets,
      resumePublicArtifacts: input.resumePublicArtifacts
    }));
  const provisioners = await createProvisioners({
    db: options.db,
    workspaceId: options.workspaceId,
    interview,
    prompt: options.prompt,
    browserSessionStore,
    browserFactory,
    ga4OauthBootstrap: options.ga4OauthBootstrap,
    resumeHandoffs,
    resumeSecrets,
    resumePublicArtifacts
  });
  const ctx: ProvisionerContext = {
    workspaceId: options.workspaceId,
    browser: browserFactory,
    actions: options.actions,
    prompt: options.prompt,
    repoRoot: options.repoRoot,
    log: options.log ?? (() => undefined),
    setup: {
      timeZone: options.timeZone
    }
  };
  const result = await runOnboarding(
    {
      interview,
      provisioners
    },
    ctx,
    runStore,
    { onProviderStart: options.onProviderStart }
  );

  await launchPausedHandoffs(
    result,
    options.handoffLauncher ??
      ((input) => launchBrowserHandoff(input, browserSessionStore)),
    options.prompt,
    browserSessionScope,
    options.awaitProviderHandoff
  );

  const activeRuns = await listActiveSetupRuns(options.db, options.workspaceId);
  // Per-provider confirmation: ✓/✗ status, what was captured, and the concrete next step.
  for (const confirmation of buildProviderConfirmations({
    interview,
    runs: result.runs,
    activeRuns,
    workspaceId: options.workspaceId
  })) {
    options.prompt.note(confirmation);
  }

  const resolvedPublicArtifacts = await readLatestSetupPublicArtifacts(options.db, options.workspaceId);
  const installCommand = buildInstrumentInstallCommand({
    workspaceId: options.workspaceId,
    artifacts: resolvedPublicArtifacts
  });
  // Same-machine handoff: persist the whitelisted PUBLIC artifacts so a bare
  // `npx infinite-tag install` on this machine discovers them without pasted flags.
  // Failing to write must never fail the setup run — the command above still works.
  let installArtifactsPath: string | null = null;
  if (installCommand) {
    try {
      installArtifactsPath = writeSetupArtifactsFile({
        workspaceId: options.workspaceId,
        artifacts: resolvedPublicArtifacts
      });
    } catch (error) {
      options.prompt.note(
        `Infinite could not save your public install keys to a local handoff file (${
          error instanceof Error ? error.message : String(error)
        }). The npx install command still works.`
      );
    }
  }
  return {
    ...result,
    interview,
    activeRuns,
    resolvedPublicArtifacts,
    installCommand,
    installArtifactsPath
  };
}

export const startLiveSetupOnboarding = runLiveSetupOnboarding;

export async function resumeLiveSetupOnboarding(
  options: ResumeLiveSetupExecutionOptions
): Promise<LiveSetupOnboardingResult> {
  const resumable = await readResumableSetupRun(options.db, options.workspaceId, options.runId);
  const browserSessionStore = options.browserSessionStore ?? DEFAULT_BROWSER_SESSION_STORE;
  const runStore = createPinnedSetupRunStore(
    options.runId,
    resumable.provider,
    options.runStore ?? createDbSetupRunStore(options.db)
  );

  return executeLiveSetupOnboarding(
    options,
    scopeInterviewToProvider(resumable.interview, resumable.provider, resumable.pendingHandoff),
    browserSessionStore,
    buildRunBrowserSessionScope(options.workspaceId, options.runId),
    runStore,
    { [resumable.provider]: resumable.pendingHandoff },
    options.resumeSecrets ?? {},
    { [resumable.provider]: resumable.publicArtifacts }
  );
}

export async function listActiveSetupRuns(
  db: InfiniteOsDb,
  workspaceId: string
): Promise<ActiveSetupRun[]> {
  const rows = await db.query<SetupRunStateRow>(
    `
      ${ACTIVE_RUN_SELECT}
      where workspace_id = $1 and status in ('running', 'paused_handoff')
      order by updated_at desc, created_at desc
    `,
    [workspaceId]
  );

  return rows.map((row) => ({
    id: row.id,
    tool: stringValue(row.tool),
    provider: stringValue(row.provider),
    status: stringValue(row.status),
    pendingHandoff: sanitizeHandoff(row.pending_handoff, {
      runId: row.id,
      provider: stringValue(row.provider),
      browserProfile: stringValue(row.browser_profile),
      providerState: providerStateBrowser(row.phase_state, stringValue(row.provider))
    }),
    browserProfile: stringValue(row.browser_profile) ?? null
  }));
}

export async function readLiveSetupPublicArtifacts(
  db: InfiniteOsDb,
  workspaceId: string
): Promise<SetupResolvedArtifacts> {
  return readLatestSetupPublicArtifacts(db, workspaceId);
}

export async function launchPersistedSetupHandoff(
  options: LaunchPersistedSetupHandoffOptions
): Promise<LiveSetupHandoffSession> {
  const pendingHandoff = await readPersistedSetupHandoff(options.db, options.workspaceId, options.runId);
  if (!pendingHandoff?.url) {
    throw new Error(`setup run ${options.runId} does not contain a launchable handoff URL`);
  }

  const browserSessionStore = options.browserSessionStore ?? DEFAULT_BROWSER_SESSION_STORE;
  const browserFactory = options.browserFactory ?? createPlaywrightBrowserFactory({
    sessionStore: browserSessionStore
  } satisfies PlaywrightBrowserFactoryOptions);
  const browserSessionScope = buildRunBrowserSessionScope(options.workspaceId, options.runId);
  const contextRef =
    pendingHandoff.browser?.profileRef ??
    pendingHandoff.resume?.profileRef ??
    pendingHandoff.provider;
  const sessionKey =
    browserSessionKeyForProvider(
      pendingHandoff.browser?.sessionKey ?? pendingHandoff.resume?.sessionKey,
      pendingHandoff.provider
    ) ??
    buildBrowserSessionKey(pendingHandoff.provider, contextRef, browserSessionScope);
  const browser = await browserFactory.create({
    provider: pendingHandoff.provider,
    purpose: "provider_auth",
    contextRef,
    sessionKey
  });
  await browser.goto(pendingHandoff.url);

  return {
    runId: pendingHandoff.runId,
    provider: pendingHandoff.provider,
    url: pendingHandoff.url,
    pendingHandoff,
    browser
  };
}

export async function readSetupInterviewFromRun(
  db: InfiniteOsDb,
  workspaceId: string,
  runId: string
): Promise<SetupInterview | null> {
  const row = await readSetupRunRow(db, workspaceId, runId);
  return parseSetupInterview(row?.phase_state);
}

async function readResumableSetupRun(
  db: InfiniteOsDb,
  workspaceId: string,
  runId: string
): Promise<{
  interview: SetupInterview;
  provider: SetupProviderId;
  pendingHandoff: PersistedSetupHandoff | null;
  publicArtifacts?: SetupProviderPublicArtifacts;
}> {
  const row = await readSetupRunRow(db, workspaceId, runId);
  const provider = stringValue(row?.provider);
  const status = stringValue(row?.status);
  const interview = parseSetupInterview(row?.phase_state);

  if (!row || !interview || !isSetupProviderId(provider) || !isResumableRunStatus(status)) {
    throw new Error(`setup run ${runId} is not resumable`);
  }

  return {
    interview,
    provider,
    pendingHandoff: sanitizeHandoff(row.pending_handoff, {
      runId,
      provider,
      browserProfile: stringValue(row.browser_profile),
      providerState: providerStateBrowser(row.phase_state, provider)
    }),
    publicArtifacts: providerStatePublicArtifacts(row.phase_state, provider)
  };
}

async function readSetupRunRow(
  db: InfiniteOsDb,
  workspaceId: string,
  runId: string
): Promise<SetupRunStateRow | null> {
  return db.one<SetupRunStateRow>(
    `
      ${ACTIVE_RUN_SELECT}
      where workspace_id = $1 and id = $2
    `,
    [workspaceId, runId]
  );
}

function parseSetupInterview(phaseState: unknown): SetupInterview | null {
  if (!isRecord(phaseState) || !isRecord(phaseState.interview)) {
    return null;
  }

  const interview = phaseState.interview;
  if (!Array.isArray(interview.providerInventory) || !stringValue(interview.projectName)) {
    return null;
  }

  const providerInventory = interview.providerInventory
    .filter(isRecord)
    .flatMap((entry) => {
      const provider = stringValue(entry.provider);
      if (!isSetupProviderId(provider)) {
        return [];
      }
      return [{
        provider,
        hasAccount: entry.hasAccount === true,
        installState: normalizeInstallState(entry.installState),
        selected: entry.selected !== false,
        recommended: entry.recommended !== false
      }];
    });

  if (providerInventory.length === 0) {
    return null;
  }

  return {
    projectName: stringValue(interview.projectName) ?? "",
    productDescription: stringValue(interview.productDescription) ?? undefined,
    websiteUrl: stringValue(interview.websiteUrl) ?? undefined,
    productSurface: interview.productSurface === "mobile" ? "mobile" : "web",
    providerInventory
  };
}

async function readPersistedSetupHandoff(
  db: InfiniteOsDb,
  workspaceId: string,
  runId: string
): Promise<PersistedSetupHandoff | null> {
  const row = await db.one<SetupRunStateRow>(
    `
      ${ACTIVE_RUN_SELECT}
      where workspace_id = $1 and id = $2
    `,
    [workspaceId, runId]
  );
  if (!row) {
    return null;
  }

  return sanitizeHandoff(row.pending_handoff, {
    runId,
    provider: stringValue(row.provider),
    browserProfile: stringValue(row.browser_profile),
    providerState: providerStateBrowser(row.phase_state, stringValue(row.provider))
  });
}

async function createLiveSetupProvisioners(input: {
  db: InfiniteOsDb;
  workspaceId: string;
  interview: SetupInterview;
  prompt: Prompter;
  browserSessionScope: string;
  browserSessionStore: BrowserSessionStore;
  browserFactory: ProvisionerContext["browser"];
  ga4OauthBootstrap?: Ga4OauthBootstrapClient;
  ga4OauthPoll?: Ga4OauthPollConfig;
  resumeHandoffs?: Partial<Record<SetupProviderId, PersistedSetupHandoff | null>>;
  resumeSecrets?: ResumeSetupSecrets;
  resumePublicArtifacts?: Partial<Record<SetupProviderId, SetupProviderPublicArtifacts | undefined>>;
}): Promise<Provisioner[]> {
  const inventory = new Map(
    input.interview.providerInventory.map((row) => [row.provider, row] as const)
  );
  const ga4ResumeHandoff = input.resumeHandoffs?.ga4 ?? null;
  const posthogResumeHandoff = input.resumeHandoffs?.posthog ?? null;
  const posthogResumeSecret = input.resumeSecrets?.posthog;
  const posthogResumePublicArtifacts = input.resumePublicArtifacts?.posthog;
  // discoverAccess() runs once per phase; memoize the personal-key provisioning so
  // Infinite never mints more than one PostHog personal API key per setup execution.
  const posthogPersonalKeyProvision: PostHogPersonalKeyProvision = {};

  return [
    createGa4Provisioner(
      createGa4LiveDependencies({
        oauth: {
          authorize: () =>
            authorizeGa4Session(
              input.db,
              input.workspaceId,
              input.browserSessionScope,
              input.browserSessionStore,
              inventory.get("ga4")?.hasAccount === true,
              input.prompt,
              input.ga4OauthBootstrap,
              ga4ResumeHandoff,
              input.ga4OauthPoll
            )
        },
        admin: createGa4AdminApiClient()
      }),
      {
        projectName: input.interview.projectName,
        websiteUrl: input.interview.websiteUrl,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      }
    ),
    createPostHogProvisioner(
      createPostHogLiveDependencies({
        access: {
          resolve: () =>
            resolvePostHogAccess(
              input.db,
              input.workspaceId,
              input.browserSessionScope,
              input.browserSessionStore,
              input.browserFactory,
              inventory.get("posthog")?.hasAccount === true,
              input.prompt,
              posthogPersonalKeyProvision,
              posthogResumeHandoff,
              posthogResumePublicArtifacts,
              posthogResumeSecret
            )
        },
        api: createPostHogApiClient(),
        handoff: {
          plan: async (handoff: PostHogPlannedHandoff) => ({
            ...handoff,
            browser: await ensureBrowserSessionRef(
              input.browserSessionStore,
              {
                provider: "posthog",
                contextRef: handoff.browser?.profileRef ?? posthogBrowserContextRef(handoff.reason),
                scope: input.browserSessionScope,
                sessionKey: browserSessionKeyForProvider(handoff.browser?.sessionKey, "posthog"),
                handoffUrl: handoff.handoffUrl
              }
            ),
            lastKnownUrl: handoff.browser?.lastUrl ?? handoff.lastKnownUrl ?? handoff.handoffUrl
          })
        }
      }),
      {
        projectName: input.interview.projectName
      }
    ),
    createXProvisioner(
      createXLiveDependencies({
        credentials: {
          load: () => loadXStoredCredentials(input.db, input.workspaceId),
          save: (credentials) => saveXStoredCredentials(input.db, input.workspaceId, credentials)
        },
        developerApi: {
          async mintBearerToken() {
            return {
              kind: "needs_human",
              reason: "billing",
              handoffUrl: "https://developer.x.com/",
              instructions:
                "Use the X developer portal to mint or copy a bearer token, then reconnect the X source and resume setup."
            };
          }
        },
        users: {
          async lookupAuthenticatedUser() {
            return { kind: "not_found" };
          },
          async lookupByUsername() {
            return { kind: "not_found" };
          },
          async lookupById() {
            return { kind: "not_found" };
          }
        },
        ads: {
          detectState: (state) => readStoredXAdsState(input.db, input.workspaceId, state.websiteUrl)
        },
        handoff: {
          forStage: async (stage) =>
            ensureBrowserSessionRef(input.browserSessionStore, {
              provider: "x",
              contextRef: `x-${stage}`,
              scope: input.browserSessionScope
            })
        }
      }),
      {
        websiteUrl: input.interview.websiteUrl
      }
    )
  ];
}

async function authorizeGa4Session(
  db: InfiniteOsDb,
  workspaceId: string,
  browserSessionScope: string,
  browserSessionStore: BrowserSessionStore,
  hasAccount: boolean,
  _prompt: Prompter,
  bootstrap: Ga4OauthBootstrapClient | undefined,
  resumeHandoff?: PersistedSetupHandoff | null,
  oauthPoll?: Ga4OauthPollConfig
): Promise<Ga4AuthResolution> {
  const browser = await ensureBrowserSessionRef(browserSessionStore, {
    provider: "ga4",
    contextRef: "ga4-google",
    scope: browserSessionScope,
    sessionKey: browserSessionKeyForProvider(resumeHandoff?.browser?.sessionKey, "ga4"),
    handoffUrl:
      sanitizePersistedBrowserUrl(resumeHandoff?.browser?.handoffUrl) ??
      sanitizePersistedBrowserUrl(resumeHandoff?.browser?.lastUrl) ??
      "https://analytics.google.com/analytics/web/"
  });
  const credential = await readLatestProviderCredential(db, workspaceId, "google_analytics_4");
  if (credential) {
    const payload = credential.payload;
    const accessToken = stringValue(payload.accessToken);
    if (accessToken && !isExpiredTimestamp(stringValue(payload.expiresAt))) {
      return {
        kind: "authorized",
        session: {
          refs: legacyOauthRefs(credential.sourceId, credential.credentialId),
          accessToken,
          refreshToken: stringValue(payload.refreshToken) ?? undefined,
          expiresAt: stringValue(payload.expiresAt) ?? undefined,
          browser
        } satisfies Ga4AuthorizedSession
      };
    }
  }

  const oauthState = await readLatestProviderOauthState(db, workspaceId, "google_analytics_4");
  const resolvedOauthSession = oauthState
    ? await resolveStoredGa4OauthSession(db, workspaceId, oauthState)
    : null;
  if (oauthState && resolvedOauthSession?.accessToken) {
    return {
      kind: "authorized",
      session: {
        refs: {
          oauthAppId: oauthState.oauthAppId,
          oauthTokenId: oauthState.oauthTokenId
        },
        accessToken: resolvedOauthSession.accessToken,
        refreshToken: resolvedOauthSession.refreshToken,
        expiresAt: resolvedOauthSession.expiresAt,
        browser
      } satisfies Ga4AuthorizedSession
    };
  }

  if (bootstrap) {
    const resumedBootstrap = await resumeGa4OauthBootstrap({
      db,
      workspaceId,
      bootstrap,
      browser,
      hasAccount,
      resumeHandoff
    });
    if (resumedBootstrap) {
      return resumedBootstrap;
    }

    const config = await bootstrap.prepareConfig();
    if (config) {
      const poll = oauthPoll ?? {
        waitMs: DEFAULT_GA4_OAUTH_WAIT_MS,
        pollIntervalMs: DEFAULT_GA4_OAUTH_POLL_INTERVAL_MS,
        sleep: (ms: number) => delay(ms)
      };
      // `retry` re-starts the SAME bootstrap idempotently — at most one extra start, so a
      // cancel→retry never spawns an unbounded chain of orphaned OAuth sessions. byo/manual/
      // quit and timeout all fall through to the resumable pause (resume keeps working).
      const maxStarts = 2;
      let session: Ga4OauthBootstrapStatus | undefined;
      for (let attempt = 0; attempt < maxStarts; attempt += 1) {
        session = await bootstrap.start(config);
        const oauthSessionId = stringValue(session.sessionId);
        if (!oauthSessionId) {
          break;
        }
        const outcome = await pollGa4OauthUntilComplete({
          db,
          workspaceId,
          bootstrap,
          browser,
          oauthSessionId,
          authorizationUrl: stringValue(session.authorizationUrl),
          timeoutMs: poll.waitMs,
          intervalMs: poll.pollIntervalMs,
          sleep: poll.sleep,
          interaction: poll.interaction
        });
        if (outcome.kind === "authorized") {
          return outcome.resolution;
        }
        if (outcome.kind === "decision" && outcome.decision === "retry" && attempt < maxStarts - 1) {
          // Loop and re-start the bootstrap (idempotent). The prior pending session is
          // superseded server-side by the next start; we never leave it actively polled.
          continue;
        }
        // byo / manual / quit / timeout / failed → resumable pause, surfacing the real error.
        break;
      }
      if (session) {
        return ga4BootstrapNeedsHuman(session, browser, {
          hasAccount,
          source: "setup_owned_oauth_bootstrap"
        });
      }
    }
  }
  const ga4CredentialResumeNotice =
    "In Google Analytics, create or select the property, open the Web data stream for this site, and keep the Measurement ID (G-...) visible. Resume setup afterward. Infinite keeps this setup run state. GA4 authorization lets Infinite create/read the Analytics property and web stream for sync/query, then store the Measurement ID for site installation.";

  return {
    kind: "needs_human",
    reason: "google_login",
    handoffUrl: "https://analytics.google.com/analytics/web/",
    instructions: hasAccount
      ? `Infinite is opening Google Analytics authorization in your browser. Sign in to Google Analytics, approve access for this workspace, and accept any pending Analytics Terms of Service prompts. ${ga4CredentialResumeNotice}`
      : `Infinite is opening Google Analytics account setup in your browser. Sign in to Google Analytics, complete Google auth, and accept the Analytics Terms of Service if prompted. ${ga4CredentialResumeNotice}`,
    browser,
    resume: {
      status: hasAccount ? "pending_auth" : "pending_account_setup",
      phase: hasAccount ? "credential_setup" : "account_setup",
      step: "ga4_google_auth",
      source: credential ? "connected_source" : "manual_handoff",
      nextAction: "resume_for_ga4_credential_check",
      sessionKey: browser.sessionKey
    }
  };
}

async function finalizeGa4OauthSession(input: {
  db: InfiniteOsDb;
  workspaceId: string;
  bootstrap: Ga4OauthBootstrapClient;
  oauthSessionId: string;
  browser: SetupBrowserHandoffRef;
}): Promise<Ga4AuthResolution | null> {
  await input.bootstrap.exchange(input.oauthSessionId);
  const oauthState = await readLatestProviderOauthState(input.db, input.workspaceId, "google_analytics_4");
  const resolved = oauthState
    ? await resolveStoredGa4OauthSession(input.db, input.workspaceId, oauthState)
    : null;
  if (oauthState && resolved?.accessToken) {
    return {
      kind: "authorized",
      session: {
        refs: {
          oauthAppId: oauthState.oauthAppId,
          oauthTokenId: oauthState.oauthTokenId
        },
        accessToken: resolved.accessToken,
        refreshToken: resolved.refreshToken,
        expiresAt: resolved.expiresAt,
        browser: input.browser
      } satisfies Ga4AuthorizedSession
    };
  }
  return null;
}

const CANCEL_SENTINEL = Symbol("ga4-oauth-cancel");

async function pollGa4OauthUntilComplete(input: {
  db: InfiniteOsDb;
  workspaceId: string;
  bootstrap: Ga4OauthBootstrapClient;
  browser: SetupBrowserHandoffRef;
  oauthSessionId: string;
  authorizationUrl?: string;
  timeoutMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  interaction?: Ga4OauthWaitInteraction;
}): Promise<Ga4OauthPollOutcome> {
  const interaction = input.interaction;
  // Tell the CLI the wait has started (so it can always print the pasteable URL and arm
  // the keypress listener). On non-interactive paths `interaction` is undefined → no-op.
  interaction?.onWaitStarted?.({
    authorizationUrl: input.authorizationUrl,
    sessionId: input.oauthSessionId
  });

  // `waitForDecision` is a single long-lived promise we race against each poll tick. When it
  // resolves with a decision the founder interrupted the wait; `null` means keep polling.
  // It NEVER blocks on its own — the poll's own timeout still fires independently below.
  const decisionPromise: Promise<Ga4OauthWaitDecision | typeof CANCEL_SENTINEL> | null =
    interaction?.waitForDecision
      ? interaction
          .waitForDecision()
          .then((decision) => decision ?? CANCEL_SENTINEL)
          .catch(() => CANCEL_SENTINEL)
      : null;
  let pendingDecision: Ga4OauthWaitDecision | null = null;
  if (decisionPromise) {
    void decisionPromise.then((value) => {
      if (value !== CANCEL_SENTINEL) {
        pendingDecision = value;
      }
    });
  }

  // Disarm the keypress wait the instant the poll reaches a terminal state. The wait was armed
  // once at the top (waitForDecision arms a persistent 'keypress' listener + raw mode); if a key
  // was never pressed it is STILL attached. Calling cancelWait() here removes that listener,
  // restores raw mode, and resolves the pending waitForDecision so it can never fire later —
  // BEFORE onTimeout/onFailed open their menu, and before we return an authorized result — so the
  // next prompt gets a clean stdin. Idempotent + exception-safe; a no-op when no wait is armed.
  const tearDownWait = (): void => {
    try {
      interaction?.cancelWait?.();
    } catch {
      // best-effort: a teardown failure must never mask the poll outcome.
    }
  };

  const start = Date.now();
  let lastError: string | null | undefined;
  while (Date.now() - start < input.timeoutMs) {
    const status = await input.bootstrap.status(input.oauthSessionId);
    lastError = status.error;
    if (status.status === "completed") {
      const resolution = await finalizeGa4OauthSession({
        db: input.db,
        workspaceId: input.workspaceId,
        bootstrap: input.bootstrap,
        oauthSessionId: input.oauthSessionId,
        browser: input.browser
      });
      if (resolution) {
        tearDownWait();
        return { kind: "authorized", resolution };
      }
      // Exchange produced no usable token — treat as a failure so the founder can act.
      tearDownWait();
      return interactionFailed(interaction, input.oauthSessionId, status.error);
    }
    if (status.status === "failed") {
      tearDownWait();
      return interactionFailed(interaction, input.oauthSessionId, status.error);
    }
    if (pendingDecision) {
      // A decision means a key was pressed → the wait already tore itself down. Disarm again is
      // a no-op (idempotent) but keeps the invariant explicit.
      tearDownWait();
      return { kind: "decision", decision: pendingDecision, error: lastError };
    }
    // Race the poll interval against the founder's decision so a keypress interrupts promptly.
    const raced = await raceSleepAgainstDecision(input.sleep(input.intervalMs), decisionPromise);
    if (raced !== CANCEL_SENTINEL && raced !== undefined) {
      tearDownWait();
      return { kind: "decision", decision: raced, error: lastError };
    }
  }

  // Timeout: disarm the still-armed wait BEFORE opening the menu, then surface the real error and
  // offer the same options menu (or pause when no interaction).
  tearDownWait();
  if (interaction?.onTimeout) {
    const decision = await interaction.onTimeout({ error: lastError, sessionId: input.oauthSessionId });
    if (decision) {
      return { kind: "decision", decision, error: lastError };
    }
  }
  return { kind: "timeout", error: lastError };
}

async function interactionFailed(
  interaction: Ga4OauthWaitInteraction | undefined,
  sessionId: string,
  error: string | null | undefined
): Promise<Ga4OauthPollOutcome> {
  // Defensive: callers already disarm the wait before reaching here, but onFailed opens a menu so
  // make sure no stale keypress listener survives even if a future caller forgets. Idempotent.
  try {
    interaction?.cancelWait?.();
  } catch {
    // best-effort
  }
  if (interaction?.onFailed) {
    const decision = await interaction.onFailed({ error, sessionId });
    if (decision) {
      return { kind: "decision", decision, error };
    }
  }
  return { kind: "failed", error };
}

async function raceSleepAgainstDecision(
  sleep: Promise<void>,
  decisionPromise: Promise<Ga4OauthWaitDecision | typeof CANCEL_SENTINEL> | null
): Promise<Ga4OauthWaitDecision | typeof CANCEL_SENTINEL | undefined> {
  if (!decisionPromise) {
    await sleep;
    return undefined;
  }
  const result = await Promise.race([
    sleep.then(() => undefined as undefined),
    decisionPromise
  ]);
  return result;
}

async function resumeGa4OauthBootstrap(input: {
  db: InfiniteOsDb;
  workspaceId: string;
  bootstrap: Ga4OauthBootstrapClient;
  browser: SetupBrowserHandoffRef;
  hasAccount: boolean;
  resumeHandoff?: PersistedSetupHandoff | null;
}): Promise<Ga4AuthResolution | null> {
  const oauthSessionId = stringValue(input.resumeHandoff?.resume?.oauthSessionId);
  if (!oauthSessionId) {
    return null;
  }

  const status = await input.bootstrap.status(oauthSessionId);
  if (status.status === "completed") {
    const finalized = await finalizeGa4OauthSession({
      db: input.db,
      workspaceId: input.workspaceId,
      bootstrap: input.bootstrap,
      oauthSessionId,
      browser: input.browser
    });
    if (finalized) {
      return finalized;
    }
  }

  if (status.status === "pending") {
    return ga4BootstrapNeedsHuman(status, input.browser, {
      hasAccount: input.hasAccount,
      source: "setup_owned_oauth_bootstrap"
    });
  }

  return null;
}

async function resolveStoredGa4OauthSession(
  db: InfiniteOsDb,
  workspaceId: string,
  oauthState: {
    oauthAppId: string;
    oauthTokenId: string;
    appPayload: Record<string, unknown>;
    tokenPayload: Record<string, unknown>;
  }
): Promise<{ accessToken?: string; refreshToken?: string; expiresAt?: string } | null> {
  const accessToken = stringValue(oauthState.tokenPayload.accessToken);
  const refreshToken = stringValue(oauthState.tokenPayload.refreshToken) ?? undefined;
  const expiresAt = stringValue(oauthState.tokenPayload.expiresAt) ?? undefined;
  if (accessToken && !isExpiredTimestamp(expiresAt)) {
    return { accessToken, refreshToken, expiresAt };
  }
  return refreshStoredGa4OauthSession(db, workspaceId, oauthState);
}

async function refreshStoredGa4OauthSession(
  db: InfiniteOsDb,
  workspaceId: string,
  oauthState: {
    oauthAppId: string;
    oauthTokenId: string;
    appPayload: Record<string, unknown>;
    tokenPayload: Record<string, unknown>;
  }
): Promise<{ accessToken?: string; refreshToken?: string; expiresAt?: string } | null> {
  const refreshToken = stringValue(oauthState.tokenPayload.refreshToken);
  const clientId = stringValue(oauthState.appPayload.clientId);
  const clientSecret = stringValue(oauthState.appPayload.clientSecret);
  const tokenUrl = stringValue(oauthState.appPayload.tokenUrl) ?? "https://oauth2.googleapis.com/token";
  if (!refreshToken || !clientId || !clientSecret) {
    return null;
  }

  const refreshed = await refreshOAuthToken({ tokenUrl, clientId, clientSecret, refreshToken });
  if (!refreshed) {
    return null;
  }
  const nextAccessToken = refreshed.accessToken;
  const nextExpiresAt = refreshed.expiresAt;
  const nextRefreshToken = refreshed.refreshToken ?? refreshToken;
  const nextPayload = compactRecord({
    accessToken: nextAccessToken,
    refreshToken: nextRefreshToken,
    expiresAt: nextExpiresAt,
    oauthApp: Object.keys(oauthState.appPayload).length > 0 ? oauthState.appPayload : undefined
  });
  await db.query(
    `
      update oauth_tokens
      set
        encrypted_payload = $2,
        expires_at = $3,
        last_rotated_at = now(),
        revoked_at = null
      where id = $1
        and workspace_id = $4
    `,
    [
      oauthState.oauthTokenId,
      encryptCredentialPayload(nextPayload, requiredEncryptionKey()),
      nextExpiresAt ?? null,
      workspaceId
    ]
  );
  return {
    accessToken: nextAccessToken,
    refreshToken: nextRefreshToken,
    expiresAt: nextExpiresAt
  };
}

function ga4BootstrapNeedsHuman(
  status: Ga4OauthBootstrapStatus,
  browser: SetupBrowserHandoffRef,
  input: {
    hasAccount: boolean;
    source: string;
  }
): Ga4AuthResolution {
  const handoffUrl = status.authorizationUrl ?? "https://accounts.google.com/";
  return {
    kind: "needs_human",
    reason: "google_login",
    handoffUrl,
    instructions: input.hasAccount
      ? "Infinite is opening Google OAuth consent in your browser. Approve Google Analytics access for this workspace, let Google redirect back to Infinite, then resume setup."
      : "Infinite is opening Google OAuth consent in your browser. Sign in to Google, approve Google Analytics access for this workspace, let Google redirect back to Infinite, then resume setup.",
    browser: withHandoffUrl(browser, sanitizePersistedBrowserUrl(handoffUrl)),
    resume: compactRecord({
      status: "pending_auth",
      phase: "credential_setup",
      step: "ga4_oauth_consent",
      source: input.source,
      nextAction: "resume_for_ga4_oauth_exchange",
      oauthSessionId: status.sessionId
    })
  };
}

async function resolvePostHogAccess(
  db: InfiniteOsDb,
  workspaceId: string,
  browserSessionScope: string,
  browserSessionStore: BrowserSessionStore,
  browserFactory: LocalBrowserFactory,
  hasAccount: boolean,
  prompt: Prompter,
  personalKeyProvision: PostHogPersonalKeyProvision,
  resumeHandoff?: PersistedSetupHandoff | null,
  resumePublicArtifacts?: SetupProviderPublicArtifacts,
  resumeSecret?: ResumeSetupSecrets["posthog"]
): Promise<PostHogResolvedAccess> {
  const credential = await readLatestProviderCredential(db, workspaceId, "posthog");
  if (credential) {
    const payload = credential.payload;
    const apiHost = stringValue(payload.apiHost);
    if (apiHost) {
      const publicApiHost = derivePostHogPublicApiHost(apiHost);
      const accessToken = stringValue(payload.accessToken);
      if (accessToken) {
        return {
          kind: "oauth",
          session: {
            refs: legacyOauthRefs(credential.sourceId, credential.credentialId),
            apiHost,
            publicApiHost,
            accessToken,
            projectIdHint: stringValue(payload.projectId) ?? undefined
          }
        };
      }
      const personalApiKey =
        stringValue(payload.personalApiKey) ?? stringValue(payload.apiKey) ?? undefined;
      if (personalApiKey) {
        return {
          kind: "credential",
          session: {
            refs: { connectionCredentialId: credential.credentialId },
            apiHost,
            publicApiHost,
            personalApiKey,
            projectIdHint: stringValue(payload.projectId) ?? undefined
          }
        };
      }
    }
  }

  const importedPersonalApiKey = stringValue(resumeSecret?.personalApiKey);
  if (importedPersonalApiKey) {
    const apiHost = normalizePostHogApiHost(
      stringValue(resumeSecret?.apiHost) ??
        stringValue(resumePublicArtifacts?.apiHost) ??
        posthogAppHost(
          resumeHandoff?.browser?.lastUrl ??
            resumeHandoff?.browser?.handoffUrl ??
            resumeHandoff?.url
        ) ??
        "https://us.posthog.com"
    );
    return {
      kind: "credential",
      session: {
        apiHost,
        publicApiHost: derivePostHogPublicApiHost(apiHost),
        personalApiKey: importedPersonalApiKey,
        projectIdHint: stringValue(resumePublicArtifacts?.projectId) ?? undefined
      }
    };
  }

  const provisionedKey = personalKeyProvision.outcome;
  if (provisionedKey && provisionedKey !== "unavailable") {
    return {
      kind: "credential",
      session: {
        apiHost: provisionedKey.apiHost,
        publicApiHost: derivePostHogPublicApiHost(provisionedKey.apiHost),
        personalApiKey: provisionedKey.personalApiKey,
        projectIdHint: stringValue(resumePublicArtifacts?.projectId) ?? undefined
      }
    };
  }

  const resumedFromSignup =
    resumeHandoff?.provider === "posthog" && resumeHandoff.reason === "posthog_signup";
  const accountReady = hasAccount || resumedFromSignup;
  if (handoffBrowserMode() === "playwright") {
    // Just-in-time guidance (#8 Part 2): the PostHog browser opens HERE during the run in
    // playwright mode, so print the what/why/confirm block before it opens (the system-mode
    // open + its note happen later in launchPausedHandoffs).
    prompt.note(providerGuidance("posthog", accountReady ? "api_key" : "signup"));
    const browserSession = await resolvePostHogBrowserSession({
      browserFactory,
      browserSessionStore,
      browserSessionScope,
      resumeHandoff
    });
    if (browserSession) {
      const provisioned = await providePostHogPersonalApiKey(
        browserSession,
        prompt,
        personalKeyProvision
      );
      if (provisioned) {
        return {
          kind: "credential",
          session: {
            apiHost: provisioned.apiHost,
            publicApiHost: derivePostHogPublicApiHost(provisioned.apiHost),
            personalApiKey: provisioned.personalApiKey,
            projectIdHint: stringValue(resumePublicArtifacts?.projectId) ?? undefined
          }
        };
      }
      return {
        kind: "browser",
        session: browserSession
      };
    }
  }
  const handoffUrl = accountReady
    ? "https://us.posthog.com/settings/user-api-keys"
    : "https://us.posthog.com/signup";
  const resumeBrowser = resumeHandoff?.browser;
  const browser = await ensureBrowserSessionRef(browserSessionStore, {
    provider: "posthog",
    contextRef: resumeBrowser?.profileRef ?? (accountReady ? "posthog-api-key" : "posthog-signup"),
    scope: browserSessionScope,
    sessionKey: browserSessionKeyForProvider(resumeBrowser?.sessionKey, "posthog"),
    handoffUrl
  });
  return {
    kind: "needs_human",
    reason: accountReady ? "posthog_manual_key" : "posthog_signup",
    handoffUrl,
    instructions: accountReady
      ? "Infinite is opening the PostHog API key page in your browser. Create a scoped personal API key, then run resume again and paste it into Infinite or import it from a local key file. Infinite uses that key to read your PostHog project ID, project API key (phc_...), and API host for site installation and data sync."
      : "Infinite is starting PostHog account setup in your browser. Finish signup, login, or email verification until you reach a PostHog project home page. Then return to this terminal and run resume. Infinite will open the API-key step next; you do not need to find the project API key/pixel yet.",
    browser,
    lastKnownUrl: handoffUrl
  };
}

async function resolvePostHogBrowserSession(input: {
  browserFactory: LocalBrowserFactory;
  browserSessionStore: BrowserSessionStore;
  browserSessionScope: string;
  resumeHandoff?: PersistedSetupHandoff | null;
}): Promise<{
  apiHost: string;
  publicApiHost: string;
  browser: SetupBrowserHandoffRef;
  transport: PostHogTransport;
} | null> {
  const resumeHandoff = input.resumeHandoff;
  if (!resumeHandoff || resumeHandoff.provider !== "posthog") {
    return null;
  }

  const contextRef =
    resumeHandoff.browser?.profileRef ??
    resumeHandoff.resume?.profileRef ??
    "posthog-signup";
  const sessionKey =
    browserSessionKeyForProvider(
      resumeHandoff.browser?.sessionKey ?? resumeHandoff.resume?.sessionKey,
      "posthog"
    ) ??
    buildBrowserSessionKey("posthog", contextRef, input.browserSessionScope);
  const persisted = await input.browserSessionStore.load(sessionKey);
  const lastUrl = sanitizePostHogBrowserUrl(
    persisted?.lastUrl ??
      resumeHandoff.browser?.lastUrl ??
      resumeHandoff.browser?.handoffUrl ??
      resumeHandoff.url
  );
  const apiHost = posthogAppHost(lastUrl) ?? "https://us.posthog.com";
  const handoffUrl = buildPostHogUserApiKeyUrl(apiHost);
  const browser = await savePostHogBrowserRef(input.browserSessionStore, {
    profileRef: persisted?.profileRef ?? resumeHandoff.browser?.profileRef ?? contextRef,
    resumeNonce: persisted?.resumeNonce ?? resumeHandoff.browser?.resumeNonce ?? randomUUID(),
    sessionKey,
    handoffUrl,
    lastUrl: lastUrl ?? handoffUrl
  });

  return {
    apiHost,
    publicApiHost: derivePostHogPublicApiHost(apiHost),
    browser,
    transport: async (url, init) => {
      const localBrowser = await input.browserFactory.create({
        provider: "posthog",
        purpose: "provider_auth",
        contextRef: browser.profileRef,
        sessionKey
      });
      try {
        const warmUrl = sanitizePostHogBrowserUrl(browser.lastUrl) ?? browser.handoffUrl ?? apiHost;
        if (warmUrl) {
          await localBrowser.goto(warmUrl);
        }
        return await localBrowser.request(url, init);
      } finally {
        await localBrowser.destroy().catch(() => undefined);
      }
    }
  };
}

interface PostHogPersonalKeyProvision {
  outcome?: { apiHost: string; personalApiKey: string } | "unavailable";
}

/**
 * Provisions the PostHog PERSONAL API key (phx_...) that Infinite needs for
 * server-side sync: first by auto-creating one through the founder's
 * authenticated browser session, then by falling back to a manual paste.
 * The outcome is memoized so a setup execution never mints duplicate keys.
 */
async function providePostHogPersonalApiKey(
  session: {
    apiHost: string;
    publicApiHost: string;
    browser: SetupBrowserHandoffRef;
    transport: PostHogTransport;
  },
  prompt: Prompter,
  provision: PostHogPersonalKeyProvision
): Promise<{ apiHost: string; personalApiKey: string } | null> {
  if (provision.outcome === "unavailable") {
    return null;
  }
  if (provision.outcome) {
    return provision.outcome;
  }
  const personalApiKey =
    (await autoCreatePostHogPersonalApiKey(session, prompt)) ??
    (await askPostHogPersonalApiKey(prompt, session.apiHost));
  provision.outcome = personalApiKey
    ? { apiHost: session.apiHost, personalApiKey }
    : "unavailable";
  return provision.outcome === "unavailable" ? null : provision.outcome;
}

async function autoCreatePostHogPersonalApiKey(
  session: {
    apiHost: string;
    publicApiHost: string;
    browser: SetupBrowserHandoffRef;
    transport: PostHogTransport;
  },
  prompt: Prompter
): Promise<string | null> {
  try {
    const personalApiKey = await createPostHogApiClient().createPersonalApiKey(session, {
      label: "Infinite"
    });
    prompt.note(
      "POSTHOG: Infinite created an \"Infinite\" personal API key (phx_...) from your logged-in PostHog session. It is stored encrypted and used only for server-side data sync."
    );
    return personalApiKey;
  } catch (error) {
    prompt.note(
      `POSTHOG: Infinite could not create a personal API key automatically (${redactPostHogSecrets(
        error instanceof Error ? error.message : String(error)
      )}).`
    );
    return null;
  }
}

async function askPostHogPersonalApiKey(
  prompt: Prompter,
  apiHost: string
): Promise<string | undefined> {
  const answer = (
    await prompt.ask(
      `Paste a PostHog personal API key (phx_...) to continue, or press Enter to skip. Create one at ${buildPostHogUserApiKeyUrl(apiHost)} (PostHog Settings -> Personal API keys).`
    )
  ).trim();
  if (answer === "") {
    return undefined;
  }
  if (!isPostHogPersonalApiKey(answer)) {
    prompt.note(
      "POSTHOG: that value is not a personal API key. Personal API keys start with phx_; phc_ values are the public project key, which Infinite already has. Create one under PostHog Settings -> Personal API keys, then resume setup to paste or import it."
    );
    return undefined;
  }
  return answer;
}

function redactPostHogSecrets(message: string): string {
  return message.replace(/phx_[A-Za-z0-9_-]+/g, "phx_[redacted]");
}

async function loadXStoredCredentials(
  db: InfiniteOsDb,
  workspaceId: string
): Promise<XStoredCredentials | null> {
  const credential = await readLatestProviderCredential(db, workspaceId, "x");
  if (!credential) {
    return null;
  }

  return {
    refs: { connectionCredentialId: credential.credentialId },
    bearerToken: stringValue(credential.payload.bearerToken) ?? undefined,
    apiKey: stringValue(credential.payload.apiKey) ?? undefined,
    apiSecret: stringValue(credential.payload.apiSecret) ?? undefined,
    username: stringValue(credential.payload.username) ?? undefined,
    userId: stringValue(credential.payload.userId) ?? undefined
  };
}

async function saveXStoredCredentials(
  db: InfiniteOsDb,
  workspaceId: string,
  credentials: XStoredCredentials
): Promise<void> {
  const credentialId = credentials.refs.connectionCredentialId;
  if (!credentialId) {
    return;
  }

  const existing = await db.one<{ source_id: string; credential_kind: string }>(
    `
      select source_id, credential_kind
      from connection_credentials
      where id = $1 and workspace_id = $2
      limit 1
    `,
    [credentialId, workspaceId]
  );
  if (!existing?.source_id) {
    return;
  }

  await db.query(
    "update connection_credentials set revoked_at = now() where workspace_id = $1 and source_id = $2 and revoked_at is null",
    [workspaceId, existing.source_id]
  );
  await db.query(
    `
      insert into connection_credentials (
        id, workspace_id, source_id, credential_kind, encrypted_payload, last_rotated_at
      )
      values ($1, $2, $3, $4, $5, now())
    `,
    [
      `cred_${randomUUID()}`,
      workspaceId,
      existing.source_id,
      existing.credential_kind,
      encryptCredentialPayload(
        compactRecord({
          mode: "live",
          bearerToken: credentials.bearerToken,
          apiKey: credentials.apiKey,
          apiSecret: credentials.apiSecret,
          username: credentials.username,
          userId: credentials.userId
        }),
        requiredEncryptionKey()
      )
    ]
  );
}

async function readStoredXAdsState(
  db: InfiniteOsDb,
  workspaceId: string,
  _websiteUrl?: string
): Promise<XAdsState | null> {
  const run = await db.one<SetupRunStateRow>(
    `
      ${ACTIVE_RUN_SELECT}
      where workspace_id = $1 and provider = 'x'
      order by updated_at desc, created_at desc
      limit 1
    `,
    [workspaceId]
  );
  if (!run || !isRecord(run.phase_state) || !isRecord(run.phase_state.providers) || !isRecord(run.phase_state.providers.x)) {
    return null;
  }
  const providerState = run.phase_state.providers.x;
  const publicArtifacts = isRecord(providerState.publicArtifacts) ? providerState.publicArtifacts : {};
  const browser = isRecord(providerState.browser) ? providerState.browser : {};
  const adsAccountId =
    stringValue(publicArtifacts.adsAccountId) ??
    stringValue(browser.adsAccountId) ??
    stringValue(providerState.adsAccountId) ??
    undefined;

  if (!publicArtifacts.pixelId && !adsAccountId) {
    return null;
  }

  return {
    hasAdsAccount: Boolean(adsAccountId),
    adsAccountId,
    billingEnabled: Boolean(adsAccountId),
    paymentCardAdded: Boolean(adsAccountId),
    pixelId: stringValue(publicArtifacts.pixelId) ?? undefined,
    eventTagIds: stringRecord(publicArtifacts.eventTagIds)
  };
}

async function launchPausedHandoffs(
  result: OnboardingResult,
  launch: (input: BrowserHandoffLaunchInput) => Promise<void>,
  prompt: Prompter,
  browserSessionScope: string,
  awaitProviderHandoff?: ProviderHandoffGate
): Promise<void> {
  // Strictly sequential, gated hand-offs (#8 Part 1): sort by canonical provider order
  // (GA4 → PostHog → X), NOT DB recency, then open AT MOST ONE browser at a time. The gate
  // (`awaitProviderHandoff`) is awaited between launches so the next browser does not open
  // until the founder acks the current one. Non-interactive callers leave the gate undefined
  // → it is a no-op and every URL is still surfaced (today's behavior, no prompt).
  const launchable = result.paused
    .map((provider) => {
      const run = result.runs[provider];
      const handoff = firstHandoff(run);
      const url = stringValue(handoff?.url);
      const profileRef = stringValue(run?.providerState?.browser?.profileRef);
      if (!handoff || !url || !profileRef) {
        return null;
      }
      const sessionKey =
        browserSessionKeyForProvider(stringValue(run?.providerState?.browser?.sessionKey), provider) ??
        buildBrowserSessionKey(provider, profileRef, browserSessionScope);
      return {
        provider,
        url,
        instructions: stringValue(handoff.instructions),
        profileRef,
        sessionKey
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => canonicalProviderRank(left.provider) - canonicalProviderRank(right.provider));

  const total = launchable.length;
  let index = 0;
  for (const { provider, url, instructions, profileRef, sessionKey } of launchable) {
    index += 1;
    // Print the just-in-time guidance block BEFORE the browser opens so it reuses the same
    // per-provider template as the resume path (one source of truth).
    prompt.note(pausedHandoffGuidance(provider, { url, instructions }));
    await launch({
      provider,
      url,
      contextRef: profileRef,
      sessionKey
    });
    // Gate before the NEXT provider opens. On non-interactive paths this is a no-op.
    if (awaitProviderHandoff) {
      await awaitProviderHandoff(provider, { index, total, url });
    }
  }
}

/**
 * Builds the per-provider paused/resume note. It REUSES the data-driven guidance template
 * (provider-guidance.ts) so just-in-time and resume copy stay identical, while still carrying
 * the run-specific `instructions` + pasteable URL that the needs_human resolution attached.
 */
function pausedHandoffGuidance(
  provider: SetupProviderId,
  handoff: { url: string; instructions?: string }
): string {
  const url = displayHandoffUrl(handoff.url);
  const step = guidanceStepForPausedProvider(provider, handoff.url);
  const block = providerGuidance(provider, step, { authorizationUrl: url });
  const instructions = stringValue(handoff.instructions);
  // The run-specific header line (carrying resolution-specific instructions + the Open: URL)
  // stays first and verbatim, then the shared guidance template is appended so just-in-time
  // and resume copy come from one source of truth.
  const header = instructions
    ? `${provider.toUpperCase()}: ${instructions} Open: ${url}`
    : `${provider.toUpperCase()}: finish the browser handoff at ${url}, then resume setup so Infinite can pick up the next required step.`;
  return `${header}\n\n${block}`;
}

function guidanceStepForPausedProvider(provider: SetupProviderId, url: string): GuidanceStep {
  if (provider === "posthog") {
    // The signup URL ends in /signup; the personal-key URL ends in /settings/user-api-keys.
    return url.includes("/signup") ? "signup" : "api_key";
  }
  if (provider === "x") {
    return "billing";
  }
  return "tos";
}

async function launchBrowserHandoff(
  input: BrowserHandoffLaunchInput,
  sessionStore: BrowserSessionStore
): Promise<void> {
  const ref = await ensureBrowserSessionRef(sessionStore, {
    provider: input.provider,
    contextRef: input.contextRef,
    sessionKey: input.sessionKey,
    handoffUrl: input.url
  });
  if (handoffBrowserMode() !== "playwright") {
    openUrlInSystemBrowser(input.url);
    return;
  }

  const helperPath = detachedHandoffHelperPath();
  if (helperPath) {
    const child = spawn(
      process.execPath,
      [
        helperPath,
        input.provider,
        input.url,
        ref.profileRef ?? input.contextRef,
        String(15 * 60 * 1000),
        input.sessionKey
      ],
      {
        detached: true,
        stdio: "ignore"
      }
    );
    child.unref();
    return;
  }

  openUrlInSystemBrowser(input.url);
}

function handoffBrowserMode(): "system" | "playwright" {
  return process.env.INFINITE_SETUP_HANDOFF_BROWSER?.trim().toLowerCase() === "playwright"
    ? "playwright"
    : "system";
}

async function ensureBrowserSessionRef(
  sessionStore: BrowserSessionStore,
  input: {
    provider: string;
    contextRef: string;
    scope?: string;
    sessionKey?: string;
    handoffUrl?: string;
  }
): Promise<SetupBrowserHandoffRef> {
  const sessionKey =
    input.sessionKey ?? buildBrowserSessionKey(input.provider, input.contextRef, input.scope);
  const existing = await sessionStore.load(sessionKey);
  const profileRef = existing?.profileRef ?? input.contextRef;
  const resumeNonce = existing?.resumeNonce ?? randomUUID();
  await sessionStore.save(sessionKey, {
    profileRef,
    resumeNonce,
    lastUrl: input.handoffUrl ?? existing?.lastUrl
  });
  return {
    profileRef,
    resumeNonce,
    sessionKey,
    handoffUrl: input.handoffUrl ?? existing?.lastUrl,
    lastUrl: input.handoffUrl ?? existing?.lastUrl
  };
}

function posthogBrowserContextRef(
  reason: "posthog_signup" | "posthog_email_verification" | "posthog_sso" | "posthog_2fa" | "posthog_manual_key"
): string {
  if (reason === "posthog_manual_key") {
    return "posthog-api-key";
  }
  return "posthog-signup";
}

function buildPostHogUserApiKeyUrl(apiHost: string): string {
  return new URL("/settings/user-api-keys", apiHost.endsWith("/") ? apiHost : `${apiHost}/`).toString();
}

function posthogAppHost(url: string | undefined): string | undefined {
  const safeUrl = sanitizePostHogBrowserUrl(url);
  if (!safeUrl) {
    return undefined;
  }
  try {
    return new URL(safeUrl).origin;
  } catch {
    return undefined;
  }
}

async function savePostHogBrowserRef(
  store: BrowserSessionStore,
  ref: Required<Pick<SetupBrowserHandoffRef, "profileRef" | "resumeNonce" | "sessionKey">> &
    Pick<SetupBrowserHandoffRef, "handoffUrl" | "lastUrl">
): Promise<SetupBrowserHandoffRef> {
  const saved = await store.save(ref.sessionKey, {
    profileRef: ref.profileRef,
    resumeNonce: ref.resumeNonce,
    lastUrl: ref.lastUrl ?? ref.handoffUrl
  });
  return {
    profileRef: saved.profileRef,
    resumeNonce: saved.resumeNonce,
    sessionKey: ref.sessionKey,
    handoffUrl: ref.handoffUrl,
    lastUrl: saved.lastUrl
  };
}

function createPinnedSetupRunStore(
  runId: string,
  provider: SetupProviderId,
  delegate: SetupRunStore
): SetupRunStore {
  return {
    async startOrResume(_workspaceId, tool) {
      if (tool !== provider) {
        throw new Error(`setup resume ${runId} is pinned to ${provider}, received ${tool}`);
      }
      return { runId, resumed: true };
    },
    recordPhase: delegate.recordPhase.bind(delegate),
    finish: delegate.finish.bind(delegate),
    recordSetupState: delegate.recordSetupState?.bind(delegate)
  };
}

function scopeInterviewToProvider(
  interview: SetupInterview,
  provider: SetupProviderId,
  pendingHandoff?: PersistedSetupHandoff | null
): SetupInterview {
  const resumePromotesAccount =
    provider === "posthog" &&
    pendingHandoff?.provider === "posthog" &&
    pendingHandoff.reason === "posthog_signup";
  return {
    ...interview,
    providerInventory: interview.providerInventory.map((row) => ({
      ...row,
      hasAccount: row.provider === provider && resumePromotesAccount ? true : row.hasAccount,
      selected: row.provider === provider,
      recommended: row.provider === provider ? row.recommended : false
    }))
  };
}

function buildWorkspaceBrowserSessionScope(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

function buildRunBrowserSessionScope(workspaceId: string, runId: string): string {
  return `workspace:${workspaceId}:run:${runId}`;
}

function isResumableRunStatus(status: string | undefined): boolean {
  return status === "paused_handoff";
}

async function readLatestProviderCredential(
  db: InfiniteOsDb,
  workspaceId: string,
  provider: string
): Promise<{
  sourceId: string;
  credentialId: string;
  credentialKind: string;
  payload: Record<string, unknown>;
} | null> {
  const row = await db.one<ProviderCredentialRow>(
    `
      select
        s.id as source_id,
        cc.id as credential_id,
        cc.credential_kind,
        cc.encrypted_payload
      from sources s
      join connection_credentials cc
        on cc.workspace_id = s.workspace_id
       and cc.source_id = s.id
       and cc.revoked_at is null
      where s.workspace_id = $1
        and s.provider = $2
        and s.status in ('connected', 'degraded')
      order by s.connected_at desc nulls last, cc.created_at desc
      limit 1
    `,
    [workspaceId, provider]
  );
  if (!row) {
    return null;
  }

  return {
    sourceId: row.source_id,
    credentialId: row.credential_id,
    credentialKind: row.credential_kind,
    payload: readCredentialPayload(row.encrypted_payload)
  };
}

async function readLatestProviderOauthState(
  db: InfiniteOsDb,
  workspaceId: string,
  provider: string
): Promise<{
  oauthAppId: string;
  oauthTokenId: string;
  appPayload: Record<string, unknown>;
  tokenPayload: Record<string, unknown>;
} | null> {
  const row = await db.one<ProviderOauthStateRow>(
    `
      select
        oa.id as oauth_app_id,
        ot.id as oauth_token_id,
        oa.encrypted_payload as encrypted_app_payload,
        ot.encrypted_payload as encrypted_token_payload
      from oauth_tokens ot
      left join oauth_apps oa
        on oa.workspace_id = ot.workspace_id
       and oa.provider = ot.provider
       and oa.revoked_at is null
      where ot.workspace_id = $1
        and ot.provider = $2
        and ot.revoked_at is null
      order by ot.last_rotated_at desc nulls last, ot.created_at desc
      limit 1
    `,
    [workspaceId, provider]
  );
  if (!row) {
    return null;
  }

  const tokenPayload = readCredentialPayload(row.encrypted_token_payload);
  const snapshotAppPayload = isRecord(tokenPayload.oauthApp) ? tokenPayload.oauthApp : null;
  const appPayload = snapshotAppPayload
    ?? (row.encrypted_app_payload ? readCredentialPayload(row.encrypted_app_payload) : null);

  return {
    oauthAppId: row.oauth_app_id ?? `oauth_app_snapshot:${row.oauth_token_id}`,
    oauthTokenId: row.oauth_token_id,
    appPayload: appPayload ?? {},
    tokenPayload
  };
}

function readCredentialPayload(encryptedPayload: string): Record<string, unknown> {
  return decryptCredentialPayload<Record<string, unknown>>(encryptedPayload, requiredEncryptionKey());
}

function requiredEncryptionKey(): string {
  const key = process.env.GROWTH_OS_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("GROWTH_OS_ENCRYPTION_KEY is required to read live setup credentials");
  }
  return key;
}

function legacyOauthRefs(sourceId: string, credentialId: string) {
  return {
    oauthAppId: `source:${sourceId}`,
    oauthTokenId: credentialId
  };
}

function firstHandoff(run: OnboardingResult["runs"][SetupProviderId] | undefined) {
  if (!run) {
    return undefined;
  }
  for (const phase of Object.values(run.phases)) {
    if (phase.status === "needs_human" && phase.handoff?.url) {
      return phase.handoff;
    }
  }
  return undefined;
}

function detachedHandoffHelperPath(): string | null {
  const currentPath = fileURLToPath(import.meta.url);
  if (!currentPath.endsWith(".js")) {
    return null;
  }
  const candidate = fileURLToPath(new URL("./browser/handoff-launcher.js", import.meta.url));
  return existsSync(candidate) ? candidate : null;
}

function openUrlInSystemBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? { binary: "open", args: [url] }
      : process.platform === "win32"
        ? { binary: "cmd", args: ["/c", "start", "", url] }
        : { binary: "xdg-open", args: [url] };

  try {
    const child = spawn(command.binary, command.args, {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {
    // Best effort only; callers still receive a resumable handoff state and explicit URL.
  }
}

function sanitizeHandoff(
  value: unknown,
  fallback?: {
    runId?: string;
    provider?: string;
    browserProfile?: string;
    providerState?: SetupBrowserHandoffRef;
  }
): PersistedSetupHandoff | null {
  if (!isRecord(value)) {
    return null;
  }

  const providerCandidate = stringValue(value.provider) ?? fallback?.provider;
  const runId = stringValue(value.runId) ?? fallback?.runId;
  if (!isSetupProviderId(providerCandidate) || !runId) {
    return null;
  }
  const provider: SetupProviderId = providerCandidate;

  const resume = stringRecord(value.resume);
  const browser = compactRecord({
    profileRef:
      stringValue(isRecord(value.browser) ? value.browser.profileRef : undefined) ??
      fallback?.providerState?.profileRef ??
      fallback?.browserProfile,
    handoffUrl:
      stringValue(isRecord(value.browser) ? value.browser.handoffUrl : undefined) ??
      fallback?.providerState?.handoffUrl ??
      stringValue(value.url),
    resumeNonce:
      stringValue(isRecord(value.browser) ? value.browser.resumeNonce : undefined) ??
      stringValue(isRecord(value.resume) ? value.resume.resumeNonce : undefined) ??
      fallback?.providerState?.resumeNonce,
    lastUrl:
      stringValue(isRecord(value.browser) ? value.browser.lastUrl : undefined) ??
      stringValue(isRecord(value.resume) ? value.resume.lastKnownUrl : undefined) ??
      fallback?.providerState?.lastUrl ??
      fallback?.providerState?.handoffUrl ??
      stringValue(value.url),
    sessionKey: browserSessionKeyForProvider(
      stringValue(isRecord(value.browser) ? value.browser.sessionKey : undefined) ??
        stringValue(isRecord(value.resume) ? value.resume.sessionKey : undefined) ??
        fallback?.providerState?.sessionKey,
      provider
    )
  }) as SetupBrowserHandoffRef;

  const sanitized: PersistedSetupHandoff = {
    provider,
    runId,
    kind: value.kind === "window_open" || value.kind === "open_url" ? value.kind : undefined,
    url: stringValue(value.url) ?? browser.handoffUrl ?? browser.lastUrl,
    instructions: stringValue(value.instructions),
    reason: stringValue(value.reason),
    ...(resume ? { resume } : {}),
    ...(Object.keys(browser).length > 0 ? { browser } : {})
  };

  return sanitized;
}

function normalizeInstallState(value: unknown): "installed" | "not_installed" | "unknown" {
  if (value === "installed" || value === "not_installed" || value === "unknown") {
    return value;
  }
  return "unknown";
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, candidate]) => candidate !== undefined));
}

function withHandoffUrl(
  browser: SetupBrowserHandoffRef | undefined,
  handoffUrl: string | undefined
): SetupBrowserHandoffRef | undefined {
  if (!browser && !handoffUrl) {
    return undefined;
  }
  return compactRecord({
    ...(browser ?? {}),
    handoffUrl: handoffUrl ?? browser?.handoffUrl
  }) as SetupBrowserHandoffRef;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const record = Object.fromEntries(
    Object.entries(value)
      .filter(([, candidate]) => typeof candidate === "string" && candidate.length > 0)
      .map(([key, candidate]) => [key, candidate as string])
  );
  return Object.keys(record).length > 0 ? record : undefined;
}

function providerStateBrowser(
  phaseState: unknown,
  provider: string | undefined
): SetupBrowserHandoffRef | undefined {
  if (!isSetupProviderId(provider) || !isRecord(phaseState) || !isRecord(phaseState.providers)) {
    return undefined;
  }

  const providerState = phaseState.providers[provider];
  if (!isRecord(providerState) || !isRecord(providerState.browser)) {
    return undefined;
  }

  return compactRecord({
    profileRef: stringValue(providerState.browser.profileRef),
    handoffUrl: stringValue(providerState.browser.handoffUrl),
    resumeNonce: stringValue(providerState.browser.resumeNonce),
    lastUrl: stringValue(providerState.browser.lastUrl),
    sessionKey: stringValue(providerState.browser.sessionKey)
  }) as SetupBrowserHandoffRef;
}

function providerStatePublicArtifacts(
  phaseState: unknown,
  provider: string | undefined
): SetupProviderPublicArtifacts | undefined {
  if (!isSetupProviderId(provider) || !isRecord(phaseState) || !isRecord(phaseState.providers)) {
    return undefined;
  }

  const providerState = phaseState.providers[provider];
  if (!isRecord(providerState) || !isRecord(providerState.publicArtifacts)) {
    return undefined;
  }

  return compactRecord({
    measurementId: stringValue(providerState.publicArtifacts.measurementId) ?? null,
    propertyId: stringValue(providerState.publicArtifacts.propertyId) ?? null,
    projectId: stringValue(providerState.publicArtifacts.projectId) ?? null,
    projectKey: stringValue(providerState.publicArtifacts.projectKey) ?? null,
    apiHost: stringValue(providerState.publicArtifacts.apiHost) ?? null,
    pixelId: stringValue(providerState.publicArtifacts.pixelId) ?? null,
    eventTagIds: stringRecord(providerState.publicArtifacts.eventTagIds) ?? null
  }) as SetupProviderPublicArtifacts;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizePersistedBrowserUrl(value: unknown): string | undefined {
  const candidate = stringValue(value);
  if (!candidate) {
    return undefined;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function displayHandoffUrl(value: string): string {
  const candidate = stringValue(value);
  if (!candidate) {
    return value;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return value;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return value;
  }
}

function isExpiredTimestamp(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const expiresAt = Date.parse(value);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSetupProviderId(value: string | undefined): value is SetupProviderId {
  return value === "ga4" || value === "posthog" || value === "x";
}
