import {
  xConnectSourceFromSetup,
  type SetupConnectSourceActionInput
} from "@infinite-os/connectors";
import type { ActionEnvelope, SessionContext } from "@infinite-os/runtime";

import type {
  DetectionState,
  PhaseResult,
  SetupBrowserHandoffRef,
  SetupProviderPublicArtifacts,
  SetupSecretRefs,
  SetupVerificationState
} from "../types.js";

export interface XDeveloperSession {
  refs: Required<Pick<SetupSecretRefs, "connectionCredentialId">>;
  bearerToken?: string;
  username?: string;
  userId?: string;
}

export type XDeveloperAccess =
  | { kind: "available"; session: XDeveloperSession }
  | {
      kind: "needs_human";
      reason: "missing_developer_app" | "missing_api_key_secret" | "billing" | "x_login";
      handoffUrl?: string;
      instructions?: string;
    };

export interface XResolvedUser {
  userId: string;
  username: string;
}

export interface XAdsContext {
  hasAdsAccount: boolean;
  billingEnabled: boolean;
  paymentCardAdded?: boolean;
  adsAccountId?: string;
}

export interface XPixelArtifacts {
  pixelId?: string;
  eventTagIds?: Record<string, string>;
  adsAccountId?: string;
}

export interface XDependencies {
  authorizeDeveloperAccess(): Promise<XDeveloperAccess>;
  resolveUser(session: XDeveloperSession): Promise<XResolvedUser | null>;
  detectAdsContext(session: XDeveloperSession | null): Promise<XAdsContext | null>;
  detectPixel(input: { websiteUrl?: string }): Promise<XPixelArtifacts | null>;
  buildHandoff?(stage: XHandoffStage): Promise<SetupBrowserHandoffRef | undefined>;
}

export interface XContractInput {
  websiteUrl?: string;
}

export interface XContractOutcome {
  result: PhaseResult;
  state: DetectionState;
  publicArtifacts?: SetupProviderPublicArtifacts;
  secretRefs?: SetupSecretRefs;
  browser?: SetupBrowserHandoffRef;
  verification?: SetupVerificationState;
  connectSourceInput?: SetupConnectSourceActionInput;
}

export type XHandoffStage =
  | "developer_portal"
  | "developer_credentials"
  | "developer_billing"
  | "x_login"
  | "ads_account"
  | "payment_card"
  | "pixel_setup";

export interface XStoredCredentials {
  refs: Required<Pick<SetupSecretRefs, "connectionCredentialId">>;
  apiKey?: string;
  apiSecret?: string;
  bearerToken?: string;
  username?: string;
  userId?: string;
}

export interface XCredentialsStore {
  load(): Promise<XStoredCredentials | null>;
  save?(credentials: XStoredCredentials): Promise<void>;
}

export type XBearerTokenGrant =
  | { kind: "ok"; bearerToken: string }
  | {
      kind: "needs_human";
      reason: "billing" | "x_login";
      handoffUrl?: string;
      instructions?: string;
    };

export interface XDeveloperApiClient {
  mintBearerToken(input: { apiKey: string; apiSecret: string }): Promise<XBearerTokenGrant>;
}

export type XUserLookupResult =
  | { kind: "resolved"; user: XResolvedUser }
  | { kind: "not_found" }
  | {
      kind: "needs_human";
      reason: "billing" | "x_login";
      handoffUrl?: string;
      instructions?: string;
    };

export interface XUsersClient {
  lookupAuthenticatedUser?(input: { bearerToken: string }): Promise<XUserLookupResult>;
  lookupByUsername(input: { bearerToken: string; username: string }): Promise<XUserLookupResult>;
  lookupById(input: { bearerToken: string; userId: string }): Promise<XUserLookupResult>;
}

export interface XAdsState {
  hasAdsAccount?: boolean;
  adsAccountId?: string;
  billingEnabled?: boolean;
  paymentCardAdded?: boolean;
  pixelId?: string;
  eventTagIds?: Record<string, string>;
}

export interface XAdsClient {
  detectState(input: { session?: XDeveloperSession | null; websiteUrl?: string }): Promise<XAdsState | null>;
}

export interface XBrowserHandoffPlanner {
  forStage(stage: XHandoffStage): Promise<SetupBrowserHandoffRef | undefined> | SetupBrowserHandoffRef | undefined;
}

export interface XLiveDependenciesOptions {
  credentials: XCredentialsStore;
  developerApi: XDeveloperApiClient;
  users: XUsersClient;
  ads?: XAdsClient;
  handoff?: XBrowserHandoffPlanner;
}

interface SetupActionContext {
  workspaceId: string;
  actions: {
    execute(id: string, input: unknown, ctx: SessionContext): Promise<ActionEnvelope>;
  };
}

export async function detectXContract(
  deps: XDependencies,
  input: XContractInput = {}
): Promise<XContractOutcome> {
  const access = await deps.authorizeDeveloperAccess();
  const pixel = await deps.detectPixel({ websiteUrl: input.websiteUrl });

  if (access.kind === "needs_human") {
    const publicArtifacts = buildXPublicArtifacts(pixel, undefined);
    const browser = await buildHandoffRef(deps, developerStageForReason(access.reason), access.handoffUrl);
    return {
      result: humanResult(
        browser?.handoffUrl ?? access.handoffUrl,
        access.instructions ??
          "Set up X developer access, billing, and API credentials before resuming."
      ),
      state: {
        accountExists: false,
        assetExists: Boolean(pixel?.pixelId),
        assetId: pixel?.pixelId,
        installId: pixel?.pixelId,
        assets: {
          adsAccountId: pixel?.adsAccountId
        }
      },
      publicArtifacts,
      browser
    };
  }

  const user = await deps.resolveUser(access.session);
  const ads = await deps.detectAdsContext(access.session);
  const publicArtifacts = buildXPublicArtifacts(pixel, ads);
  const resolvedUser = user ?? resolveUserFromSession(access.session);

  return {
    result: {
      status: "ok",
      detail: pixel?.pixelId
        ? "Detected X developer auth and an existing pixel."
        : "Detected X developer auth."
    },
    state: {
      accountExists: Boolean(access.session.bearerToken || resolvedUser?.userId || ads?.hasAdsAccount),
      assetExists: Boolean(pixel?.pixelId),
      assetId: pixel?.pixelId,
      installId: pixel?.pixelId,
      assets: {
        userId: resolvedUser?.userId ?? access.session.userId,
        username: resolvedUser?.username ?? access.session.username,
        hasAdsAccount: ads?.hasAdsAccount ?? false,
        billingEnabled: ads?.billingEnabled ?? false,
        paymentCardAdded: ads?.paymentCardAdded ?? ads?.billingEnabled ?? false,
        adsAccountId: publicArtifacts?.adsAccountId ?? null
      }
    },
    publicArtifacts,
    secretRefs: access.session.refs,
    connectSourceInput:
      access.session.bearerToken && (resolvedUser?.userId ?? access.session.userId) && (resolvedUser?.username ?? access.session.username)
        ? xConnectSourceFromSetup({
            bearerToken: access.session.bearerToken,
            userId: resolvedUser?.userId ?? access.session.userId ?? "",
            username: resolvedUser?.username ?? access.session.username ?? ""
          })
        : undefined
  };
}

export async function setupXContract(
  deps: XDependencies,
  detected: XContractOutcome,
  _input: XContractInput = {}
): Promise<XContractOutcome> {
  if (detected.result.status === "needs_human") {
    return detected;
  }

  if (detected.state.assetExists && detected.publicArtifacts?.pixelId) {
    return {
      result: { status: "ok", detail: "X pixel already exists." },
      state: detected.state,
      publicArtifacts: detected.publicArtifacts,
      secretRefs: detected.secretRefs,
      browser: detected.browser
    };
  }

  const hasAdsAccount = Boolean(detected.state.assets?.hasAdsAccount);
  const paymentCardAdded = Boolean(detected.state.assets?.paymentCardAdded ?? detected.state.assets?.billingEnabled);
  const adsAccountId = asString(detected.state.assets?.adsAccountId);

  if (!hasAdsAccount) {
    const browser = await buildHandoffRef(deps, "ads_account", "https://ads.x.com/");
    return {
      result: humanResult(
        browser?.handoffUrl ?? "https://ads.x.com/",
        "Create or connect an X ads account before the pixel can be created."
      ),
      state: detected.state,
      publicArtifacts: detected.publicArtifacts,
      secretRefs: detected.secretRefs,
      browser
    };
  }

  if (!paymentCardAdded) {
    const browser = await buildHandoffRef(deps, "payment_card", "https://ads.x.com/");
    return {
      result: humanResult(
        browser?.handoffUrl ?? "https://ads.x.com/",
        "Add a payment card to the X ads account before using Events Manager."
      ),
      state: detected.state,
      publicArtifacts: detected.publicArtifacts,
      secretRefs: detected.secretRefs,
      browser
    };
  }

  const eventsManagerUrl = adsAccountId
    ? `https://ads.x.com/conversion_events/${adsAccountId}/events_manager`
    : "https://ads.x.com/";
  const browser = await buildHandoffRef(deps, "pixel_setup", eventsManagerUrl);
  return {
    result: humanResult(
      browser?.handoffUrl ?? eventsManagerUrl,
      "Create the X pixel and event tags in Events Manager, then resume setup."
    ),
    state: detected.state,
    publicArtifacts: detected.publicArtifacts,
    secretRefs: detected.secretRefs,
    browser,
    connectSourceInput: detected.connectSourceInput
  };
}

export async function connectXContract(
  ctx: SetupActionContext,
  detected: XContractOutcome,
  state: DetectionState
): Promise<XContractOutcome> {
  if (!detected.connectSourceInput) {
    return {
      result: {
        status: "blocked",
        detail: "X connect requires a bearer token plus a resolved user identity."
      },
      state,
      publicArtifacts: detected.publicArtifacts,
      secretRefs: detected.secretRefs,
      browser: detected.browser
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
      detail: "Connected the X source through the analytical engine.",
      data: {
        sourceId: connected.sourceId,
        connectionTest: connected.connectionTest,
        initialSync: connected.initialSync
      }
    },
    state: nextState,
    publicArtifacts: detected.publicArtifacts,
    secretRefs: detected.secretRefs,
    browser: detected.browser,
    verification: {
      installStatus: state.tagInstalled && state.tagFiring ? "verified" : "pending",
      queryabilityStatus: queryabilityStatusFromSourceVerification({
        connectionTest: connected.connectionTest
      }),
      lastCheckedAt: new Date().toISOString()
    },
    connectSourceInput: detected.connectSourceInput
  };
}

export async function syncXContract(
  _ctx: SetupActionContext,
  detected: XContractOutcome,
  state: DetectionState
): Promise<XContractOutcome> {
  return {
    result: {
      status: "skipped",
      detail: "X sync is queued by connect_source only when the ingest path is explicitly enabled."
    },
    state,
    publicArtifacts: detected.publicArtifacts,
    secretRefs: detected.secretRefs,
    browser: detected.browser,
    verification: carryVerification(state),
    connectSourceInput: detected.connectSourceInput
  };
}

export function createXLiveDependencies(options: XLiveDependenciesOptions): XDependencies {
  const persistCredentials = options.credentials.save
    ? async (credentials: XStoredCredentials): Promise<void> => {
        await options.credentials.save?.(credentials);
      }
    : undefined;

  return {
    async authorizeDeveloperAccess() {
      const stored = await options.credentials.load();
      if (!stored) {
        return {
          kind: "needs_human",
          reason: "missing_developer_app",
          handoffUrl: "https://developer.x.com/",
          instructions:
            "Log in to the X Developer portal, create a developer app, and capture either the API key + secret or a ready-made bearer token before resuming."
        };
      }

      const next = normalizeStoredCredentials(stored);
      let changed = false;

      if (!next.bearerToken) {
        if (!next.apiKey || !next.apiSecret) {
          return {
            kind: "needs_human",
            reason: "missing_api_key_secret",
            handoffUrl: "https://developer.x.com/",
            instructions:
              "Open the X developer app, copy the API key and API secret (or paste a bearer token), then resume setup."
          };
        }

        const minted = await options.developerApi.mintBearerToken({
          apiKey: next.apiKey,
          apiSecret: next.apiSecret
        });
        if (minted.kind === "needs_human") {
          return {
            kind: "needs_human",
            reason: minted.reason,
            handoffUrl: minted.handoffUrl,
            instructions:
              minted.instructions ??
              "Finish the X developer billing or login steps before a bearer token can be minted."
          };
        }

        next.bearerToken = minted.bearerToken;
        changed = true;
      }

      if (next.bearerToken) {
        const resolved = await resolveIdentity(options.users, {
          bearerToken: next.bearerToken,
          username: next.username,
          userId: next.userId
        });
        if (resolved.kind === "needs_human") {
          return {
            kind: "needs_human",
            reason: resolved.reason,
            handoffUrl: resolved.handoffUrl,
            instructions:
              resolved.instructions ??
              "Log in to X and finish any developer billing or access prompts before setup can continue."
          };
        }
        if (resolved.kind === "resolved") {
          if (next.userId !== resolved.user.userId || next.username !== resolved.user.username) {
            next.userId = resolved.user.userId;
            next.username = resolved.user.username;
            changed = true;
          }
        }
      }

      if (changed) {
        await persistCredentials?.(next);
      }

      return {
        kind: "available",
        session: {
          refs: next.refs,
          bearerToken: next.bearerToken,
          username: next.username,
          userId: next.userId
        }
      };
    },
    async resolveUser(session) {
      const resolved = resolveUserFromSession(session);
      if (resolved) {
        return resolved;
      }
      if (!session.bearerToken) {
        return null;
      }
      const lookup = await resolveIdentity(options.users, session);
      return lookup.kind === "resolved" ? lookup.user : null;
    },
    async detectAdsContext(session) {
      const detected = await options.ads?.detectState({ session });
      if (!detected) {
        return null;
      }
      const paymentCardAdded = detected.paymentCardAdded ?? detected.billingEnabled ?? false;
      return {
        hasAdsAccount: detected.hasAdsAccount ?? Boolean(detected.adsAccountId),
        billingEnabled: paymentCardAdded,
        paymentCardAdded,
        adsAccountId: detected.adsAccountId
      };
    },
    async detectPixel(input) {
      const detected = await options.ads?.detectState({ websiteUrl: input.websiteUrl });
      if (!detected || (!detected.pixelId && !detected.adsAccountId)) {
        return null;
      }
      return {
        pixelId: detected.pixelId,
        eventTagIds: detected.eventTagIds,
        adsAccountId: detected.adsAccountId
      };
    },
    async buildHandoff(stage) {
      return await options.handoff?.forStage(stage);
    }
  };
}

function buildXPublicArtifacts(
  pixel: XPixelArtifacts | null,
  ads: XAdsContext | null | undefined
): SetupProviderPublicArtifacts | undefined {
  const adsAccountId = pixel?.adsAccountId ?? ads?.adsAccountId ?? null;
  if (!pixel?.pixelId && !adsAccountId) {
    return undefined;
  }
  return {
    pixelId: pixel?.pixelId ?? null,
    eventTagIds: pixel?.eventTagIds ?? null,
    adsAccountId
  };
}

async function buildHandoffRef(
  deps: Pick<XDependencies, "buildHandoff">,
  stage: XHandoffStage,
  fallbackUrl?: string
): Promise<SetupBrowserHandoffRef | undefined> {
  const handoff = await deps.buildHandoff?.(stage);
  if (!handoff && !fallbackUrl) {
    return undefined;
  }
  return {
    ...handoff,
    handoffUrl: handoff?.handoffUrl ?? fallbackUrl
  };
}

function developerStageForReason(
  reason: Extract<XDeveloperAccess, { kind: "needs_human" }>["reason"]
): XHandoffStage {
  switch (reason) {
    case "missing_developer_app":
      return "developer_portal";
    case "missing_api_key_secret":
      return "developer_credentials";
    case "billing":
      return "developer_billing";
    case "x_login":
      return "x_login";
    default:
      return "developer_portal";
  }
}

async function resolveIdentity(
  users: XUsersClient,
  session: Pick<XDeveloperSession, "bearerToken" | "username" | "userId">
): Promise<XUserLookupResult> {
  const bearerToken = asString(session.bearerToken);
  if (!bearerToken) {
    return { kind: "not_found" };
  }

  if (users.lookupAuthenticatedUser) {
    const authenticated = await users.lookupAuthenticatedUser({ bearerToken });
    if (authenticated.kind !== "not_found") {
      return authenticated.kind === "resolved"
        ? { kind: "resolved", user: normalizeResolvedUser(authenticated.user) }
        : authenticated;
    }
  }

  const username = normalizeUsername(session.username);
  if (username) {
    const byUsername = await users.lookupByUsername({ bearerToken, username });
    if (byUsername.kind !== "not_found") {
      return byUsername.kind === "resolved"
        ? { kind: "resolved", user: normalizeResolvedUser(byUsername.user) }
        : byUsername;
    }
  }

  const userId = asString(session.userId);
  if (userId) {
    const byId = await users.lookupById({ bearerToken, userId });
    if (byId.kind !== "not_found") {
      return byId.kind === "resolved"
        ? { kind: "resolved", user: normalizeResolvedUser(byId.user) }
        : byId;
    }
  }

  return { kind: "not_found" };
}

function normalizeStoredCredentials(credentials: XStoredCredentials): XStoredCredentials {
  return {
    ...credentials,
    bearerToken: asString(credentials.bearerToken),
    apiKey: asString(credentials.apiKey),
    apiSecret: asString(credentials.apiSecret),
    username: normalizeUsername(credentials.username),
    userId: asString(credentials.userId)
  };
}

function resolveUserFromSession(session: Pick<XDeveloperSession, "username" | "userId">): XResolvedUser | null {
  const username = normalizeUsername(session.username);
  const userId = asString(session.userId);
  return username && userId ? { userId, username } : null;
}

function normalizeResolvedUser(user: XResolvedUser): XResolvedUser {
  return {
    userId: user.userId,
    username: normalizeUsername(user.username) ?? user.username
  };
}

function humanResult(url: string | undefined, instructions: string): PhaseResult {
  return {
    status: "needs_human",
    detail: instructions,
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

function normalizeUsername(value: unknown): string | undefined {
  const username = asString(value);
  return username ? username.replace(/^@/, "") : undefined;
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
