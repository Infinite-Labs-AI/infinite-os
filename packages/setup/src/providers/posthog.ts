import {
  posthogConnectSourceFromSetup,
  type SetupConnectSourceActionInput
} from "@infinite-os/connectors";
import type { ActionEnvelope, SessionContext } from "@infinite-os/runtime";
import { derivePostHogPublicApiHost } from "./posthog-live.js";

import type {
  DetectionState,
  PhaseResult,
  SetupBrowserHandoffRef,
  SetupProviderPublicArtifacts,
  SetupSecretRefs,
  SetupVerificationState
} from "../types.js";

export type PostHogNeedsHumanReason =
  | "posthog_signup"
  | "posthog_email_verification"
  | "posthog_sso"
  | "posthog_2fa"
  | "posthog_manual_key";

export interface PostHogOAuthSession {
  refs: Required<Pick<SetupSecretRefs, "oauthAppId" | "oauthTokenId">>;
  apiHost: string;
  publicApiHost?: string;
  accessToken?: string;
  organizationIdHint?: string;
  projectIdHint?: string;
}

export interface PostHogCredentialSession {
  refs?: Required<Pick<SetupSecretRefs, "connectionCredentialId">>;
  apiHost: string;
  publicApiHost?: string;
  personalApiKey?: string;
  organizationIdHint?: string;
  projectIdHint?: string;
}

export interface PostHogTransportRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface PostHogTransportResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type PostHogTransport = (
  url: string,
  init?: PostHogTransportRequest
) => Promise<PostHogTransportResponse>;

export interface PostHogBrowserSession {
  apiHost: string;
  publicApiHost?: string;
  browser: SetupBrowserHandoffRef;
  transport: PostHogTransport;
  organizationIdHint?: string;
  projectIdHint?: string;
}

export type PostHogAuthorizedSession =
  | PostHogOAuthSession
  | PostHogCredentialSession
  | PostHogBrowserSession;

export interface PostHogHumanHandoffRequest {
  reason: PostHogNeedsHumanReason;
  handoffUrl?: string;
  instructions: string;
}

export interface PostHogHumanHandoffResult extends PostHogHumanHandoffRequest {
  browser?: SetupBrowserHandoffRef;
  lastKnownUrl?: string;
}

export interface PostHogAccessDiscovery {
  oauth?: PostHogOAuthSession;
  credential?: PostHogCredentialSession;
  browser?: PostHogBrowserSession;
  needsHuman?: PostHogHumanHandoffResult;
}

export interface PostHogOrganization {
  orgId: string;
  name?: string;
}

export interface PostHogProject {
  projectId: string;
  name?: string;
  projectKey: string;
  apiHost?: string;
  completedSnippetOnboarding?: boolean;
  ingestedEvent?: boolean;
}

export interface PostHogDependencies {
  discoverAccess(): Promise<PostHogAccessDiscovery>;
  listOrganizations(session: PostHogAuthorizedSession): Promise<PostHogOrganization[]>;
  listProjects(session: PostHogAuthorizedSession, orgId: string): Promise<PostHogProject[]>;
  createProject(
    session: PostHogAuthorizedSession,
    input: { orgId: string; name: string }
  ): Promise<Pick<PostHogProject, "projectId" | "projectKey" | "apiHost">>;
  beginHumanHandoff?(input: PostHogHumanHandoffRequest): Promise<PostHogHumanHandoffResult>;
}

export interface PostHogContractInput {
  projectName: string;
}

export interface PostHogContractOutcome {
  result: PhaseResult;
  state: DetectionState;
  publicArtifacts?: SetupProviderPublicArtifacts;
  secretRefs?: SetupSecretRefs;
  browser?: SetupBrowserHandoffRef;
  verification?: SetupVerificationState;
  connectSourceInput?: SetupConnectSourceActionInput;
  syncDefaults?: {
    mode: "incremental";
    refreshWindowDays?: number;
  };
}

interface SetupActionContext {
  workspaceId: string;
  actions: {
    execute(id: string, input: unknown, ctx: SessionContext): Promise<ActionEnvelope>;
  };
}

export async function detectPostHogContract(
  deps: PostHogDependencies,
  input: PostHogContractInput
): Promise<PostHogContractOutcome> {
  const discovered = await deps.discoverAccess();
  const session = pickAccess(discovered);
  if (!session) {
    return humanOutcome(
      await resolveHumanHandoff(
        deps,
        discovered.needsHuman ?? {
          reason: "posthog_manual_key",
          handoffUrl: "https://us.posthog.com/settings/user-api-keys",
          instructions: "Log in to PostHog and create either an OAuth grant or a personal API key."
        }
      ),
      { accountExists: false, assetExists: false }
    );
  }

  let organizations: PostHogOrganization[];
  try {
    organizations = await deps.listOrganizations(session);
  } catch (error) {
    if (session.kind === "browser") {
      return humanOutcome(
        await resolveHumanHandoff(deps, {
          reason: "posthog_manual_key",
          handoffUrl: buildUserApiKeyUrl(session.apiHost),
          instructions:
            "Infinite could not reuse the saved PostHog browser session automatically. Open the PostHog API key page in that same session, create a scoped personal API key, then resume setup and paste/import it through the encrypted credential flow.",
          browser: session.browser,
          lastKnownUrl: session.browser.lastUrl ?? session.browser.handoffUrl
        }),
        { accountExists: true, assetExists: false }
      );
    }
    throw new Error(`PostHog access discovery failed before organization lookup: ${safePostHogErrorMessage(error)}`);
  }
  const secretRefs = refsFromSession(session);
  if (organizations.length === 0) {
    return {
      result: { status: "ok", detail: "No PostHog organization detected yet." },
      state: { accountExists: false, assetExists: false },
      secretRefs
    };
  }

  const chosenOrg = pickOrganization(organizations, session.organizationIdHint);
  let projects: PostHogProject[];
  try {
    projects = await deps.listProjects(session, chosenOrg.orgId);
  } catch (error) {
    if (session.kind === "browser") {
      return humanOutcome(
        await resolveHumanHandoff(deps, {
          reason: "posthog_manual_key",
          handoffUrl: buildUserApiKeyUrl(session.apiHost),
          instructions:
            "Infinite could not list PostHog projects from the saved browser session. Open the PostHog API key page in that same session, create a scoped personal API key, then resume setup and paste/import it through the encrypted credential flow.",
          browser: session.browser,
          lastKnownUrl: session.browser.lastUrl ?? session.browser.handoffUrl
        }),
        {
          accountExists: true,
          assetExists: false,
          assets: {
            organizationId: chosenOrg.orgId,
            authKind: session.kind
          }
        }
      );
    }
    throw new Error(`PostHog access discovery failed before project lookup: ${safePostHogErrorMessage(error)}`);
  }
  const chosenProject = pickProject(projects, input.projectName, session.projectIdHint);
  if (!chosenProject) {
    return {
      result: { status: "ok", detail: "Detected a PostHog organization without a project yet." },
      state: {
        accountExists: true,
        assetExists: false,
        assets: {
          organizationId: chosenOrg.orgId,
          authKind: session.kind
        }
      },
      secretRefs
    };
  }

  const installState = inferInstallState(chosenProject);
const current: PostHogContractOutcome = {
    result: { status: "ok", detail: "Detected an existing PostHog project." },
    state: {
      accountExists: true,
      assetExists: true,
      assetId: chosenProject.projectId,
      installId: chosenProject.projectKey,
      tagInstalled: installState === "installed",
      tagFiring: Boolean(chosenProject.ingestedEvent),
      assets: {
        organizationId: chosenOrg.orgId,
        installState,
        authKind: session.kind
      }
    },
    publicArtifacts: {
      projectId: chosenProject.projectId,
      projectKey: chosenProject.projectKey,
      apiHost: resolvePublicApiHost(chosenProject.apiHost, session.publicApiHost, session.apiHost)
    },
    secretRefs,
    connectSourceInput: buildConnectInput(chosenProject.projectId, session.apiHost, session),
    syncDefaults: { mode: "incremental", refreshWindowDays: 7 }
  };
  if (!current.connectSourceInput) {
    return humanOutcome(
      await resolveHumanHandoff(deps, {
        reason: "posthog_manual_key",
        handoffUrl: buildUserApiKeyUrl(session.apiHost),
        instructions: posthogManualKeyInstructions(),
        ...("browser" in session ? {
          browser: session.browser,
          lastKnownUrl: session.browser.lastUrl ?? session.browser.handoffUrl
        } : {})
      }),
      current.state,
      current
    );
  }
  return current;
}

export async function setupPostHogContract(
  deps: PostHogDependencies,
  detected: PostHogContractOutcome,
  input: PostHogContractInput
): Promise<PostHogContractOutcome> {
  if (detected.result.status === "needs_human") {
    return detected;
  }

  const discovered = await deps.discoverAccess();
  const session = pickAccess(discovered);
  if (!session) {
    return humanOutcome(
      await resolveHumanHandoff(
        deps,
        discovered.needsHuman ?? {
          reason: "posthog_manual_key",
          handoffUrl: "https://us.posthog.com/settings/user-api-keys",
          instructions: "Log in to PostHog and create either an OAuth grant or a personal API key."
        }
      ),
      detected.state,
      detected
    );
  }

  const secretRefs = refsFromSession(session);
  if (!detected.state.accountExists) {
    return humanOutcome(
      await resolveHumanHandoff(deps, {
        reason: "posthog_signup",
        handoffUrl: buildSignupUrl(session.apiHost),
        instructions: "Create or join a PostHog organization before creating the project.",
        ...("browser" in session ? {
          browser: session.browser,
          lastKnownUrl: session.browser.lastUrl ?? session.browser.handoffUrl
        } : {})
      }),
      detected.state,
      {
        ...detected,
        secretRefs
      }
    );
  }

  if (detected.state.assetExists && detected.publicArtifacts) {
    if (!detected.connectSourceInput) {
      return humanOutcome(
        await resolveHumanHandoff(deps, {
          reason: "posthog_manual_key",
          handoffUrl: buildUserApiKeyUrl(session.apiHost),
          instructions: posthogManualKeyInstructions(),
          ...("browser" in session ? {
            browser: session.browser,
            lastKnownUrl: session.browser.lastUrl ?? session.browser.handoffUrl
          } : {})
        }),
        detected.state,
        {
          ...detected,
          secretRefs
        }
      );
    }
    return {
      result: { status: "ok", detail: "PostHog project already exists." },
      state: detected.state,
      publicArtifacts: detected.publicArtifacts,
      secretRefs
    };
  }

  const orgId = asString(detected.state.assets?.organizationId);
  if (!orgId) {
    return {
      result: { status: "blocked", detail: "PostHog setup could not determine which organization to use." },
      state: detected.state,
      publicArtifacts: detected.publicArtifacts,
      secretRefs
    };
  }

  let created: Pick<PostHogProject, "projectId" | "projectKey" | "apiHost">;
  try {
    created = await deps.createProject(session, { orgId, name: input.projectName });
  } catch {
    if (session.kind === "browser") {
      return humanOutcome(
        await resolveHumanHandoff(deps, {
          reason: "posthog_manual_key",
          handoffUrl: buildUserApiKeyUrl(session.apiHost),
          instructions:
            "Infinite could not finish creating the PostHog project from the saved browser session. Open the PostHog API key page in that same session, create a scoped personal API key, then resume setup and paste/import it through the encrypted credential flow.",
          browser: session.browser,
          lastKnownUrl: session.browser.lastUrl ?? session.browser.handoffUrl
        }),
        detected.state,
        {
          ...detected,
          secretRefs
        }
      );
    }
    throw new Error("PostHog project creation failed.");
  }
  const current: PostHogContractOutcome = {
    result: { status: "ok", detail: "Created the PostHog project." },
    state: {
      accountExists: true,
      assetExists: true,
      assetId: created.projectId,
      installId: created.projectKey,
      assets: {
        organizationId: orgId,
        installState: "unknown",
        authKind: session.kind
      }
    },
    publicArtifacts: {
      projectId: created.projectId,
      projectKey: created.projectKey,
      apiHost: resolvePublicApiHost(created.apiHost, session.publicApiHost, session.apiHost)
    },
    secretRefs,
    connectSourceInput: buildConnectInput(created.projectId, session.apiHost, session),
    syncDefaults: { mode: "incremental", refreshWindowDays: 7 }
  };
  if (!current.connectSourceInput) {
    return humanOutcome(
        await resolveHumanHandoff(deps, {
          reason: "posthog_manual_key",
          handoffUrl: buildUserApiKeyUrl(session.apiHost),
          instructions: posthogManualKeyInstructions(),
          ...("browser" in session ? {
            browser: session.browser,
            lastKnownUrl: session.browser.lastUrl ?? session.browser.handoffUrl
          } : {})
      }),
      current.state,
      current
    );
  }
  return current;
}

export async function connectPostHogContract(
  ctx: SetupActionContext,
  detected: PostHogContractOutcome,
  state: DetectionState
): Promise<PostHogContractOutcome> {
  if (!detected.connectSourceInput) {
    return {
      result: {
        status: "blocked",
        detail: "PostHog connect requires either an OAuth access token or a personal API key."
      },
      state,
      publicArtifacts: detected.publicArtifacts,
      secretRefs: detected.secretRefs,
      syncDefaults: detected.syncDefaults
    };
  }

  const envelope = await ctx.actions.execute(
    state.sourceId ? "reconnect_source" : "connect_source",
    state.sourceId
      ? {
          sourceId: state.sourceId,
          credentialKind: detected.connectSourceInput.credentialKind,
          credentialPayload: detected.connectSourceInput.credentialPayload
        }
      : detected.connectSourceInput,
    actionContext(ctx.workspaceId)
  );
  const connected = connectedSourceFromEnvelope(envelope);
  const nextState: DetectionState = {
    ...state,
    sourceId: connected.sourceId,
    credentialValid: connected.connectionTest?.ok ?? true
  };
  return {
    result: {
      status: "ok",
      detail: "Connected the PostHog source through the analytical engine.",
      data: {
        sourceId: connected.sourceId,
        connectionTest: connected.connectionTest,
        initialSync: connected.initialSync
      }
    },
    state: nextState,
    publicArtifacts: detected.publicArtifacts,
    secretRefs: detected.secretRefs,
    verification: {
      installStatus: state.tagInstalled && state.tagFiring ? "verified" : "pending",
      queryabilityStatus: queryabilityStatusFromSourceVerification({
        connectionTest: connected.connectionTest
      }),
      lastCheckedAt: new Date().toISOString()
    },
    connectSourceInput: detected.connectSourceInput,
    syncDefaults: detected.syncDefaults
  };
}

export async function syncPostHogContract(
  ctx: SetupActionContext,
  detected: PostHogContractOutcome,
  state: DetectionState
): Promise<PostHogContractOutcome> {
  if (!state.sourceId) {
    return {
      result: { status: "blocked", detail: "PostHog sync requires a connected source." },
      state,
      publicArtifacts: detected.publicArtifacts,
      secretRefs: detected.secretRefs,
      syncDefaults: detected.syncDefaults
    };
  }
  const syncDefaults = detected.syncDefaults ?? { mode: "incremental" as const, refreshWindowDays: 7 };
  const envelope = await ctx.actions.execute(
    "start_source_sync",
    {
      sourceId: state.sourceId,
      mode: syncDefaults.mode,
      refreshWindowDays: syncDefaults.refreshWindowDays
    },
    actionContext(ctx.workspaceId)
  );
  const queued = queuedSourceSyncFromEnvelope(envelope);
  return {
    result: {
      status: "ok",
      detail: "Queued the first PostHog sync through the worker flow.",
      data: {
        jobId: queued.jobId,
        mode: syncDefaults.mode,
        refreshWindowDays: syncDefaults.refreshWindowDays
      }
    },
    state,
    publicArtifacts: detected.publicArtifacts,
    secretRefs: detected.secretRefs,
    verification: carryVerification(state),
    connectSourceInput: detected.connectSourceInput,
    syncDefaults
  };
}

function pickAccess(
  discovered: PostHogAccessDiscovery
): (
  | (PostHogOAuthSession & { kind: "oauth" })
  | (PostHogCredentialSession & { kind: "credential" })
  | (PostHogBrowserSession & { kind: "browser" })
) | null {
  if (discovered.oauth) {
    return { kind: "oauth", ...discovered.oauth };
  }
  if (discovered.credential) {
    return { kind: "credential", ...discovered.credential };
  }
  if (discovered.browser) {
    return { kind: "browser", ...discovered.browser };
  }
  return null;
}

function inferInstallState(project: PostHogProject): "installed" | "not_installed" | "unknown" {
  if (project.completedSnippetOnboarding || project.ingestedEvent) {
    return "installed";
  }
  return "not_installed";
}

function pickOrganization(
  organizations: PostHogOrganization[],
  orgIdHint?: string
): PostHogOrganization {
  return organizations.find((organization) => organization.orgId === orgIdHint) ?? organizations[0]!;
}

function pickProject(
  projects: PostHogProject[],
  projectName: string,
  projectIdHint?: string
): PostHogProject | undefined {
  return (
    projects.find((project) => project.projectId === projectIdHint) ??
    projects.find((project) => project.name?.trim().toLowerCase() === projectName.trim().toLowerCase()) ??
    projects[0]
  );
}

function humanResult(
  url: string | undefined,
  instructions: string,
  data?: Record<string, unknown>
): PhaseResult {
  return {
    status: "needs_human",
    detail: instructions,
    ...(data ? { data } : {}),
    handoff: {
      kind: "open_url",
      url,
      instructions
    }
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function connectedSourceFromEnvelope(envelope: ActionEnvelope) {
  if (!envelope.ok || !isRecord(envelope.data) || !isRecord(envelope.data.source) || !asString(envelope.data.source.id)) {
    throw new Error("connect_source did not return a source payload");
  }
  return {
    sourceId: asString(envelope.data.source.id)!,
    connectionTest: isRecord(envelope.data.connectionTest)
      ? ({ ...envelope.data.connectionTest, ok: envelope.data.connectionTest.ok === true } as Record<string, unknown> & { ok?: boolean })
      : undefined,
    initialSync: isRecord(envelope.data.initialSync) ? envelope.data.initialSync : undefined
  };
}

function queuedSourceSyncFromEnvelope(envelope: ActionEnvelope) {
  if (!envelope.ok || !isRecord(envelope.data) || !isRecord(envelope.data.job)) {
    throw new Error("start_source_sync did not return a job payload");
  }
  return {
    jobId: asString(envelope.data.job.id)
  };
}

function queryabilityStatusFromSourceVerification(input: {
  connectionTest?: { ok?: boolean } | null;
  syncStatus?: "succeeded" | "failed" | null;
}): SetupVerificationState["queryabilityStatus"] {
  if (input.connectionTest?.ok === true || input.syncStatus === "succeeded") {
    return "verified";
  }
  if (input.connectionTest?.ok === false || input.syncStatus === "failed") {
    return "failed";
  }
  return "pending";
}

function buildConnectInput(
  projectId: string,
  apiHost: string,
  session:
    | (PostHogOAuthSession & { kind: "oauth" })
    | (PostHogCredentialSession & { kind: "credential" })
    | (PostHogBrowserSession & { kind: "browser" })
): SetupConnectSourceActionInput | undefined {
  if (session.kind === "oauth" && session.accessToken) {
    return posthogConnectSourceFromSetup({
      projectId,
      apiHost,
      accessToken: session.accessToken
    });
  }
  if (session.kind === "credential" && session.personalApiKey) {
    return posthogConnectSourceFromSetup({
      projectId,
      apiHost,
      personalApiKey: session.personalApiKey
    });
  }
  return undefined;
}

function buildSignupUrl(apiHost: string): string {
  return new URL("/signup", apiHost.endsWith("/") ? apiHost : `${apiHost}/`).toString();
}

function buildUserApiKeyUrl(apiHost: string): string {
  return new URL("/settings/user-api-keys", apiHost.endsWith("/") ? apiHost : `${apiHost}/`).toString();
}

function posthogManualKeyInstructions(): string {
  return "Create a scoped PostHog personal API key for this project. Infinite still cannot read the key from the browser, so resume setup and paste/import it through the encrypted credential flow.";
}

function resolvePublicApiHost(
  projectApiHost: string | undefined,
  sessionPublicApiHost: string | undefined,
  sessionApiHost: string
): string {
  return projectApiHost ?? sessionPublicApiHost ?? derivePostHogPublicApiHost(sessionApiHost);
}

async function resolveHumanHandoff(
  deps: PostHogDependencies,
  input: PostHogHumanHandoffRequest | PostHogHumanHandoffResult
): Promise<PostHogHumanHandoffResult> {
  if ("browser" in input || "lastKnownUrl" in input) {
    return {
      reason: input.reason,
      handoffUrl: input.handoffUrl,
      instructions: input.instructions,
      browser: "browser" in input ? input.browser : undefined,
      lastKnownUrl: "lastKnownUrl" in input ? input.lastKnownUrl : undefined
    };
  }
  if (deps.beginHumanHandoff) {
    return deps.beginHumanHandoff({
      reason: input.reason,
      handoffUrl: input.handoffUrl,
      instructions: input.instructions
    });
  }
  return {
    reason: input.reason,
    handoffUrl: input.handoffUrl,
    instructions: input.instructions,
    browser: "browser" in input ? input.browser : undefined,
    lastKnownUrl: "lastKnownUrl" in input ? input.lastKnownUrl : undefined
  };
}

function humanOutcome(
  handoff: PostHogHumanHandoffResult,
  state: DetectionState,
  current: Partial<PostHogContractOutcome> = {}
): PostHogContractOutcome {
  const automation = posthogAutomationState(handoff.reason);
  const resume = {
    status: automation.status,
    phase: automation.phase,
    step: handoff.reason,
    ...(handoff.browser?.profileRef ? { profileRef: handoff.browser.profileRef } : {}),
    ...(handoff.browser?.resumeNonce ? { resumeNonce: handoff.browser.resumeNonce } : {}),
    ...(handoff.browser?.sessionKey ? { sessionKey: handoff.browser.sessionKey } : {}),
    ...(handoff.lastKnownUrl ? { lastKnownUrl: handoff.lastKnownUrl } : {})
  };
  const data = Object.keys(resume).length > 0
    ? {
        reason: handoff.reason,
        resume
      }
    : {
        reason: handoff.reason
      };

  return {
    result: humanResult(handoff.handoffUrl, handoff.instructions, data),
    state,
    publicArtifacts: current.publicArtifacts,
    secretRefs: current.secretRefs,
    browser: handoff.browser,
    verification: current.verification,
    connectSourceInput: current.connectSourceInput,
    syncDefaults: current.syncDefaults
  };
}

function posthogAutomationState(reason: PostHogNeedsHumanReason): {
  status: "pending_auth" | "pending_account_setup";
  phase: "account_setup" | "credential_setup";
} {
  if (reason === "posthog_manual_key") {
    return {
      status: "pending_auth",
      phase: "credential_setup"
    };
  }

  return {
    status: "pending_account_setup",
    phase: "account_setup"
  };
}

function actionContext(workspaceId: string): SessionContext {
  return {
    workspaceId,
    authority: "operator",
    surface: "worker",
    actorId: "setup_onboarding",
    sessionId: `setup:${workspaceId}`
  };
}

function carryVerification(state: DetectionState): SetupVerificationState {
  return {
    installStatus: state.tagInstalled && state.tagFiring ? "verified" : "pending",
    queryabilityStatus: queryabilityStatusFromSourceVerification({
      connectionTest: state.credentialValid === undefined ? null : { ok: Boolean(state.credentialValid) }
    }),
    lastCheckedAt: new Date().toISOString()
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePostHogErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/phx_[A-Za-z0-9_-]+/g, "phx_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]*[A-Za-z0-9_~+/=-]/gi, "Bearer [redacted]");
}

function refsFromSession(
  session:
    | (PostHogOAuthSession & { kind: "oauth" })
    | (PostHogCredentialSession & { kind: "credential" })
    | (PostHogBrowserSession & { kind: "browser" })
): SetupSecretRefs | undefined {
  return "refs" in session ? session.refs : undefined;
}

export * from "./posthog-live.js";
