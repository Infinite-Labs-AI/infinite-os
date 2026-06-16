import {
  ga4ConnectSourceFromSetup,
  type SetupConnectSourceActionInput
} from "@infinite-os/connectors";
import type {
  ApplyResult,
  InstallPlan,
  WorkspaceInstallArtifacts
} from "infinite-tag";
import type { ActionEnvelope, SessionContext } from "@infinite-os/runtime";

import type {
  DetectionState,
  PhaseResult,
  SetupBrowserHandoffRef,
  SetupProviderPublicArtifacts,
  SetupSecretRefs,
  SetupVerificationState
} from "../types.js";

const GA4_ADMIN_API_BASE_URL = "https://analyticsadmin.googleapis.com/v1beta";
const GA4_DATA_API_BASE_URL = "https://analyticsdata.googleapis.com/v1beta";

export const GA4_SETUP_SCOPES = [
  "https://www.googleapis.com/auth/analytics.edit",
  "https://www.googleapis.com/auth/analytics.readonly"
] as const;

export interface Ga4AuthorizedSession {
  refs: Required<Pick<SetupSecretRefs, "oauthAppId" | "oauthTokenId">>;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  browser?: SetupBrowserHandoffRef;
}

export type Ga4AuthResolution =
  | { kind: "authorized"; session: Ga4AuthorizedSession }
  | {
      kind: "needs_human";
      reason: "google_login" | "google_2fa" | "google_tos";
      handoffUrl?: string;
      instructions?: string;
      browser?: SetupBrowserHandoffRef;
      resume?: Record<string, unknown>;
    };

export interface Ga4AccountProperty {
  propertyId: string;
  displayName?: string;
}

export interface Ga4AccountSummary {
  accountId: string;
  displayName?: string;
  properties: Ga4AccountProperty[];
}

export interface Ga4WebDataStream {
  measurementId: string;
  defaultUri?: string | null;
}

export interface Ga4ProvisionAccountTicketInput {
  displayName: string;
  regionCode?: string;
  redirectUri: string;
}

export interface Ga4ProvisionAccountTicketResult {
  accountTicketId: string;
  handoffUrl?: string;
}

export interface Ga4Dependencies {
  authorize(): Promise<Ga4AuthResolution>;
  listAccountSummaries(session: Ga4AuthorizedSession): Promise<Ga4AccountSummary[]>;
  listWebDataStreams(session: Ga4AuthorizedSession, propertyId: string): Promise<Ga4WebDataStream[]>;
  createProperty(
    session: Ga4AuthorizedSession,
    input: { accountId: string; displayName: string; timeZone: string }
  ): Promise<{ propertyId: string }>;
  createWebDataStream(
    session: Ga4AuthorizedSession,
    input: { propertyId: string; displayName: string; defaultUri: string }
  ): Promise<Ga4WebDataStream>;
  provisionAccountTicket?(
    session: Ga4AuthorizedSession,
    input: Ga4ProvisionAccountTicketInput
  ): Promise<Ga4ProvisionAccountTicketResult>;
}

/** One existing GA4 property the founder could connect, with site-match context. */
export interface Ga4PropertyCandidate {
  accountId: string;
  accountName?: string;
  propertyId: string;
  displayName?: string;
  /** A representative web data stream (the site-matching one if present, else the first). */
  stream?: Ga4WebDataStream;
  /** True when a web stream's host matches the founder's site (lenient: ignores www/protocol). */
  matchesSite: boolean;
}

/** What the founder chose when detection was ambiguous. */
export type Ga4PropertySelection =
  | {
      kind: "use_property";
      accountId: string;
      propertyId: string;
      displayName?: string;
      stream?: Ga4WebDataStream;
    }
  | { kind: "create_property"; accountId: string }
  | { kind: "create_account" };

export interface Ga4SelectPropertyInput {
  websiteUrl?: string;
  candidates: Ga4PropertyCandidate[];
  accounts: Array<{ accountId: string; accountName?: string }>;
}

/**
 * Resolves which GA4 property to use when detection is ambiguous (no single
 * site-matching property). The live provisioner backs this with the founder
 * prompter; omit it for a deterministic, never-silently-wrong default.
 */
export type Ga4PropertySelector = (
  input: Ga4SelectPropertyInput
) => Promise<Ga4PropertySelection>;

export interface Ga4DetectInput {
  websiteUrl?: string;
  selectProperty?: Ga4PropertySelector;
}

export interface Ga4SetupInput {
  projectName: string;
  websiteUrl: string;
  timeZone?: string;
  accountRegionCode?: string;
  oauthRedirectUri?: string;
  /** Founder-facing progress notes (e.g. "creating the property…"); optional for headless callers. */
  note?: (message: string) => void;
}

export interface Ga4ContractOutcome {
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

export interface Ga4LiveOAuthClient {
  authorize(input: { scopes: readonly string[] }): Promise<Ga4AuthResolution>;
}

export interface Ga4AdminApiClient {
  listAccountSummaries(session: Ga4AuthorizedSession): Promise<Ga4AccountSummary[]>;
  listWebDataStreams(session: Ga4AuthorizedSession, propertyId: string): Promise<Ga4WebDataStream[]>;
  createProperty(
    session: Ga4AuthorizedSession,
    input: { accountId: string; displayName: string; timeZone: string }
  ): Promise<{ propertyId: string }>;
  createWebDataStream(
    session: Ga4AuthorizedSession,
    input: { propertyId: string; displayName: string; defaultUri: string }
  ): Promise<Ga4WebDataStream>;
  provisionAccountTicket?(
    session: Ga4AuthorizedSession,
    input: Ga4ProvisionAccountTicketInput
  ): Promise<Ga4ProvisionAccountTicketResult>;
}

export interface Ga4LiveDependenciesOptions {
  oauth: Ga4LiveOAuthClient;
  admin: Ga4AdminApiClient;
}

type Ga4FetchLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<Pick<Response, "ok" | "status" | "text" | "json">>;

export interface Ga4AdminApiClientOptions {
  fetch?: Ga4FetchLike;
  adminApiBaseUrl?: string;
  termsOfServiceUrl?: string | ((input: { accountTicketId: string; redirectUri: string }) => string | undefined);
}

export function createGa4LiveDependencies(
  options: Ga4LiveDependenciesOptions
): Ga4Dependencies {
  return {
    authorize() {
      return options.oauth.authorize({ scopes: GA4_SETUP_SCOPES });
    },
    listAccountSummaries(session) {
      return options.admin.listAccountSummaries(session);
    },
    listWebDataStreams(session, propertyId) {
      return options.admin.listWebDataStreams(session, propertyId);
    },
    createProperty(session, input) {
      return options.admin.createProperty(session, input);
    },
    createWebDataStream(session, input) {
      return options.admin.createWebDataStream(session, input);
    },
    provisionAccountTicket: options.admin.provisionAccountTicket
      ? (session, input) => options.admin.provisionAccountTicket!(session, input)
      : undefined
  };
}

export function createGa4AdminApiClient(
  options: Ga4AdminApiClientOptions = {}
): Ga4AdminApiClient {
  const fetchImpl = options.fetch ?? defaultFetch();
  const adminApiBaseUrl = stripTrailingSlash(options.adminApiBaseUrl ?? GA4_ADMIN_API_BASE_URL);

  return {
    async listAccountSummaries(session) {
      const accountSummaries = await paginate(
        async (pageToken) =>
          requestJson<{
            accountSummaries?: Array<{
              account?: string;
              displayName?: string;
              propertySummaries?: Array<{ property?: string; displayName?: string }>;
            }>;
            nextPageToken?: string;
          }>(fetchImpl, session, `${adminApiBaseUrl}/accountSummaries`, {
            method: "GET",
            query: pageToken ? { pageToken } : undefined
          }),
        (payload) => payload.nextPageToken,
        (payload) =>
          (payload.accountSummaries ?? [])
            .map((summary) => {
              const accountId = asString(summary.account);
              if (!accountId) {
                return undefined;
              }

              return {
                accountId,
                displayName: asString(summary.displayName),
                properties: (summary.propertySummaries ?? [])
                  .map((property) => {
                    const propertyId = asString(property.property);
                    if (!propertyId) {
                      return undefined;
                    }
                    return {
                      propertyId,
                      displayName: asString(property.displayName)
                    };
                  })
                  .filter(isDefined)
              } satisfies Ga4AccountSummary;
            })
            .filter(isDefined)
      );

      return accountSummaries;
    },
    async listWebDataStreams(session, propertyId) {
      return paginate(
        async (pageToken) =>
          requestJson<{
            dataStreams?: Array<{
              type?: string;
              webStreamData?: { measurementId?: string; defaultUri?: string | null };
            }>;
            nextPageToken?: string;
          }>(fetchImpl, session, `${adminApiBaseUrl}/${propertyId}/dataStreams`, {
            method: "GET",
            query: pageToken ? { pageToken } : undefined
          }),
        (payload) => payload.nextPageToken,
        (payload) =>
          (payload.dataStreams ?? [])
            .map((stream) => {
              const measurementId = asString(stream.webStreamData?.measurementId);
              const isWebStream = stream.type === "WEB_DATA_STREAM" || measurementId;
              if (!isWebStream || !measurementId) {
                return undefined;
              }
              return {
                measurementId,
                defaultUri: asNullableString(stream.webStreamData?.defaultUri)
              } satisfies Ga4WebDataStream;
            })
            .filter(isDefined)
      );
    },
    async createProperty(session, input) {
      const payload = await requestJson<{
        name?: string;
      }>(fetchImpl, session, `${adminApiBaseUrl}/properties`, {
        method: "POST",
        body: {
          parent: input.accountId,
          displayName: input.displayName,
          timeZone: input.timeZone
        }
      });
      const propertyId = asString(payload.name);
      if (!propertyId) {
        throw new Error("GA4 properties.create did not return a property resource name.");
      }
      return { propertyId };
    },
    async createWebDataStream(session, input) {
      const payload = await requestJson<{
        webStreamData?: { measurementId?: string; defaultUri?: string | null };
      }>(fetchImpl, session, `${adminApiBaseUrl}/${input.propertyId}/dataStreams`, {
        method: "POST",
        body: {
          type: "WEB_DATA_STREAM",
          displayName: input.displayName,
          webStreamData: {
            defaultUri: input.defaultUri
          }
        }
      });
      const measurementId = asString(payload.webStreamData?.measurementId);
      if (!measurementId) {
        throw new Error("GA4 properties.dataStreams.create did not return a measurement ID.");
      }
      return {
        measurementId,
        defaultUri: asNullableString(payload.webStreamData?.defaultUri)
      };
    },
    async provisionAccountTicket(session, input) {
      const payload = await requestJson<{ accountTicketId?: string }>(
        fetchImpl,
        session,
        `${adminApiBaseUrl}/accounts:provisionAccountTicket`,
        {
          method: "POST",
          body: {
            account: compactRecord({
              displayName: input.displayName,
              regionCode: input.regionCode
            }),
            redirectUri: input.redirectUri
          }
        }
      );
      const accountTicketId = asString(payload.accountTicketId);
      if (!accountTicketId) {
        throw new Error("GA4 accounts.provisionAccountTicket did not return an account ticket ID.");
      }
      return {
        accountTicketId,
        handoffUrl: resolveTermsOfServiceUrl(options.termsOfServiceUrl, {
          accountTicketId,
          redirectUri: input.redirectUri
        })
      };
    }
  };
}

export async function detectGa4Contract(
  deps: Ga4Dependencies,
  input: Ga4DetectInput = {}
): Promise<Ga4ContractOutcome> {
  const auth = await deps.authorize();
  if (auth.kind === "needs_human") {
    return {
      result: humanResult(
        "open_url",
        auth.handoffUrl,
        auth.instructions ?? "Log in to Google Analytics and complete any 2FA prompts.",
        {
          reason: auth.reason,
          resume: auth.resume
        }
      ),
      state: { accountExists: false, assetExists: false },
      browser: withHandoffUrl(auth.browser, auth.handoffUrl)
    };
  }

  const secretRefs = auth.session.refs;
  const accountSummaries = await deps.listAccountSummaries(auth.session);
  if (accountSummaries.length === 0) {
    return {
      result: { status: "ok", detail: "No Google Analytics account detected yet." },
      state: { accountExists: false, assetExists: false },
      secretRefs,
      browser: auth.session.browser
    };
  }

  const siteHost = normalizeHost(input.websiteUrl);
  const accounts = accountSummaries.map((account) => ({
    accountId: account.accountId,
    accountName: account.displayName
  }));
  const fallbackAccountId = accounts[0]?.accountId;

  // Resolve streams concurrently — one Google login can span dozens of properties,
  // and we need every property's streams to know which (if any) match the site.
  const pairs = accountSummaries.flatMap((account) =>
    account.properties.map((property) => ({ account, property }))
  );
  const candidates: Ga4PropertyCandidate[] = await Promise.all(
    pairs.map(async ({ account, property }) => {
      const streams = await deps.listWebDataStreams(auth.session, property.propertyId);
      const matchedStream = findMatchingStream(streams, siteHost);
      return {
        accountId: account.accountId,
        accountName: account.displayName,
        propertyId: property.propertyId,
        displayName: property.displayName,
        // Representative stream: the site match when present, else the property's first
        // stream — reused only when the founder explicitly picks this property.
        stream: matchedStream ?? streams[0],
        matchesSite: Boolean(matchedStream)
      } satisfies Ga4PropertyCandidate;
    })
  );

  if (candidates.length === 0) {
    return {
      result: { status: "ok", detail: "Detected a Google Analytics account but no property yet." },
      state: {
        accountExists: true,
        assetExists: false,
        assets: { accountId: fallbackAccountId }
      },
      secretRefs,
      browser: auth.session.browser
    };
  }

  const matched = candidates.filter((candidate) => candidate.matchesSite);
  let selection: Ga4PropertySelection;
  if (input.selectProperty) {
    // Always let the founder choose when they already have properties — even on a single
    // clean match — so "select another property" and "create a new one" stay visible. The
    // selector offers the site-matching property first, which is the prompter's default.
    selection = await input.selectProperty({ websiteUrl: input.websiteUrl, candidates, accounts });
  } else if (matched.length > 0) {
    // Headless/no-prompter: a genuine host match is safe to auto-select.
    selection = useProperty(matched[0]!);
  } else {
    // Headless and nothing matches: never silently connect a non-matching property —
    // create a fresh one for the site instead.
    selection = { kind: "create_property", accountId: fallbackAccountId ?? candidates[0]!.accountId };
  }

  return buildGa4DetectionOutcome(selection, auth.session, secretRefs);
}

function useProperty(candidate: Ga4PropertyCandidate): Ga4PropertySelection {
  return {
    kind: "use_property",
    accountId: candidate.accountId,
    propertyId: candidate.propertyId,
    displayName: candidate.displayName,
    stream: candidate.stream
  };
}

function buildGa4DetectionOutcome(
  selection: Ga4PropertySelection,
  session: Ga4AuthorizedSession,
  secretRefs: Ga4AuthorizedSession["refs"]
): Ga4ContractOutcome {
  if (selection.kind === "create_account") {
    // Don't hand off to the browser here: the SETUP phase owns account creation,
    // so it can pre-stage the account via provisionAccountTicket and reduce the
    // browser step to just the Terms-of-Service click (Google requires a human
    // for that). `requestedNewAccount` (not accountExists:false) keeps the
    // "account detected" signal truthful for everything else.
    return {
      result: {
        status: "ok",
        detail: "You chose to create a new Google Analytics account — setup will start that next."
      },
      state: { accountExists: true, assetExists: false, requestedNewAccount: true },
      secretRefs,
      browser: session.browser
    };
  }

  if (selection.kind === "create_property") {
    // Hand off to setup, which creates the property + web data stream under this account.
    return {
      result: {
        status: "ok",
        detail: "Infinite will create a new GA4 property and web data stream for your site."
      },
      state: {
        accountExists: true,
        assetExists: false,
        assets: { accountId: selection.accountId }
      },
      secretRefs,
      browser: session.browser
    };
  }

  if (selection.stream?.measurementId) {
    return {
      result: { status: "ok", detail: "Using your selected GA4 property and web data stream." },
      state: {
        accountExists: true,
        assetExists: true,
        assetId: selection.propertyId,
        installId: selection.stream.measurementId,
        assets: {
          accountId: selection.accountId,
          propertyId: selection.propertyId,
          defaultUri: selection.stream.defaultUri ?? null
        }
      },
      publicArtifacts: buildGa4PublicArtifacts(selection.propertyId, selection.stream),
      secretRefs,
      browser: session.browser,
      connectSourceInput: buildConnectSourceInput(session, selection.propertyId),
      syncDefaults: { mode: "incremental", refreshWindowDays: 7 }
    };
  }

  // Existing property with no web stream → setup adds one for the site (reuses the
  // selected property via state.assetId; setup skips createProperty when it is set).
  return {
    result: {
      status: "ok",
      detail: "Using your selected GA4 property; Infinite will add a web data stream for your site."
    },
    state: {
      accountExists: true,
      assetExists: false,
      assetId: selection.propertyId,
      assets: { accountId: selection.accountId, propertyId: selection.propertyId }
    },
    secretRefs,
    browser: session.browser
  };
}

export async function setupGa4Contract(
  deps: Ga4Dependencies,
  detected: Ga4ContractOutcome,
  input: Ga4SetupInput
): Promise<Ga4ContractOutcome> {
  if (detected.result.status === "needs_human") {
    return detected;
  }

  const auth = await deps.authorize();
  if (auth.kind === "needs_human") {
    return {
      result: humanResult(
        "open_url",
        auth.handoffUrl,
        auth.instructions ?? "Log in to Google Analytics and complete any 2FA prompts.",
        {
          reason: auth.reason,
          resume: auth.resume
        }
      ),
      state: detected.state,
      publicArtifacts: detected.publicArtifacts,
      secretRefs: detected.secretRefs,
      browser: withHandoffUrl(auth.browser, auth.handoffUrl),
      connectSourceInput: detected.connectSourceInput,
      syncDefaults: detected.syncDefaults
    };
  }

  const secretRefs = auth.session.refs;
  if (!detected.state.accountExists || detected.state.requestedNewAccount) {
    if (deps.provisionAccountTicket && input.oauthRedirectUri) {
      const ticket = await deps.provisionAccountTicket(auth.session, {
        displayName: input.projectName,
        regionCode: input.accountRegionCode,
        redirectUri: input.oauthRedirectUri
      });
      const handoffUrl = ticket.handoffUrl ?? "https://analytics.google.com/analytics/web/";
      return {
        result: humanResult(
          "open_url",
          handoffUrl,
          `Accept the Google Analytics Terms of Service to finish creating the ${
            detected.state.requestedNewAccount ? "new" : "first"
          } account.`,
          {
            reason: "google_tos",
            resume: {
              step: "provision_account_ticket",
              accountTicketId: ticket.accountTicketId,
              redirectUri: input.oauthRedirectUri
            }
          }
        ),
        state: detected.state,
        secretRefs,
        browser: withHandoffUrl(auth.session.browser, handoffUrl),
        connectSourceInput: detected.connectSourceInput,
        syncDefaults: detected.syncDefaults
      };
    }

    if (detected.state.requestedNewAccount) {
      // No ticket machinery available — exactly the legacy manual handoff that
      // detect used to return for a picker create-account choice.
      return {
        result: humanResult(
          "open_url",
          "https://analytics.google.com/analytics/web/",
          "Create a new Google Analytics account at analytics.google.com, then resume setup to pick its property.",
          { reason: "google_tos" }
        ),
        state: detected.state,
        secretRefs,
        browser: withHandoffUrl(auth.session.browser, "https://analytics.google.com/analytics/web/"),
        connectSourceInput: detected.connectSourceInput,
        syncDefaults: detected.syncDefaults
      };
    }

    return {
      result: humanResult(
        "open_url",
        "https://analytics.google.com/analytics/web/",
        "Accept the Google Analytics Terms of Service to create the first account."
      ),
      state: detected.state,
      secretRefs,
      browser: withHandoffUrl(auth.session.browser, "https://analytics.google.com/analytics/web/"),
      connectSourceInput: detected.connectSourceInput,
      syncDefaults: detected.syncDefaults
    };
  }

  const websiteOrigin = normalizeOrigin(input.websiteUrl);
  if (!websiteOrigin) {
    return {
      result: { status: "blocked", detail: "GA4 setup needs a valid website URL." },
      state: detected.state,
      publicArtifacts: detected.publicArtifacts,
      secretRefs,
      browser: auth.session.browser,
      connectSourceInput: detected.connectSourceInput,
      syncDefaults: detected.syncDefaults
    };
  }

  if (detected.state.assetExists && detected.state.installId && detected.publicArtifacts) {
    return {
      result: { status: "ok", detail: "GA4 property and web data stream already exist." },
      state: detected.state,
      publicArtifacts: detected.publicArtifacts,
      secretRefs,
      browser: auth.session.browser,
      connectSourceInput: buildConnectSourceInput(
        auth.session,
        asString(detected.publicArtifacts.propertyId) ?? detected.state.assetId
      ),
      syncDefaults: detected.syncDefaults
    };
  }

  const accountId = asString(detected.state.assets?.accountId);
  if (!accountId) {
    return {
      result: { status: "blocked", detail: "GA4 setup could not determine which account to use." },
      state: detected.state,
      publicArtifacts: detected.publicArtifacts,
      secretRefs,
      browser: auth.session.browser,
      connectSourceInput: detected.connectSourceInput,
      syncDefaults: detected.syncDefaults
    };
  }

  let propertyId = detected.state.assetId;
  if (!propertyId) {
    input.note?.(`GA4: creating the Google Analytics 4 property "${input.projectName}"…`);
    propertyId = (
      await deps.createProperty(auth.session, {
        accountId,
        displayName: input.projectName,
        timeZone: input.timeZone ?? "Etc/UTC"
      })
    ).propertyId;
    input.note?.(`GA4: property created — "${input.projectName}" (${propertyId}).`);
  }

  const stream = await deps.createWebDataStream(auth.session, {
    propertyId,
    displayName: `${input.projectName} Web Stream`,
    defaultUri: websiteOrigin
  });
  // Only promise the end-of-setup npx command when a Measurement ID exists —
  // without one, setup has nothing installable to print.
  input.note?.(
    stream.measurementId
      ? `GA4: web stream ready — Measurement ID ${stream.measurementId}. ` +
          "Next: install the tag in your website's repo (setup prints the exact npx command at the end)."
      : "GA4: web stream ready — the Measurement ID is still pending from Google. " +
          "Next: re-run `infinite setup` to capture it once it appears."
  );

  return {
    result: { status: "ok", detail: "Created the GA4 property and web data stream." },
    state: {
      accountExists: true,
      assetExists: true,
      assetId: propertyId,
      installId: stream.measurementId,
      assets: {
        accountId,
        propertyId,
        defaultUri: stream.defaultUri ?? websiteOrigin
      }
    },
    publicArtifacts: buildGa4PublicArtifacts(propertyId, stream),
    secretRefs,
    browser: auth.session.browser,
    connectSourceInput: buildConnectSourceInput(auth.session, propertyId),
    syncDefaults: { mode: "incremental", refreshWindowDays: 7 }
  };
}

export async function connectGa4Contract(
  ctx: SetupActionContext,
  detected: Ga4ContractOutcome,
  state: DetectionState
): Promise<Ga4ContractOutcome> {
  if (!detected.connectSourceInput) {
    return {
      result: {
        status: "blocked",
        detail: "GA4 connect requires an OAuth access token from the current setup session."
      },
      state,
      publicArtifacts: detected.publicArtifacts,
      secretRefs: detected.secretRefs,
      browser: detected.browser,
      syncDefaults: detected.syncDefaults
    };
  }

  const envelope = await ctx.actions.execute(
    state.sourceId ? "reconnect_source" : "connect_source",
    state.sourceId
      ? {
          sourceId: state.sourceId,
          credentialKind: detected.connectSourceInput.credentialKind,
          credentialPayload: detected.connectSourceInput.credentialPayload,
          oauthTokenId: detected.connectSourceInput.oauthTokenId
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
      detail: "Connected the GA4 source through the analytical engine.",
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
      installStatus: detected.publicArtifacts?.measurementId ? "pending" : "pending",
      queryabilityStatus: queryabilityStatusFromSourceVerification({
        connectionTest: connected.connectionTest
      }),
      lastCheckedAt: new Date().toISOString()
    },
    connectSourceInput: detected.connectSourceInput,
    syncDefaults: detected.syncDefaults
  };
}

export async function syncGa4Contract(
  ctx: SetupActionContext,
  detected: Ga4ContractOutcome,
  state: DetectionState
): Promise<Ga4ContractOutcome> {
  if (!state.sourceId) {
    return {
      result: { status: "blocked", detail: "GA4 sync requires a connected source." },
      state,
      publicArtifacts: detected.publicArtifacts,
      secretRefs: detected.secretRefs,
      browser: detected.browser,
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
      detail: "Queued the first GA4 sync through the worker flow.",
      data: {
        jobId: queued.jobId,
        mode: syncDefaults.mode,
        refreshWindowDays: syncDefaults.refreshWindowDays
      }
    },
    state,
    publicArtifacts: detected.publicArtifacts,
    secretRefs: detected.secretRefs,
    browser: detected.browser,
    verification: carryVerification(detected, state),
    connectSourceInput: detected.connectSourceInput,
    syncDefaults
  };
}

export interface Ga4ImplementInput {
  measurementId: string;
  repoRoot: string;
  workspaceId: string;
  /**
   * Founder confirmation gate. Called only after every guard passes (plan is
   * auto-applyable, repo clean, confidence high enough) and immediately before any
   * file is written. Returning false aborts the install before touching the repo.
   */
  confirm?: (plan: InstallPlan) => Promise<boolean>;
}

export interface Ga4ImplementDependencies {
  planInstallation: (opts: {
    root: string;
    workspaceId?: string;
    artifacts: WorkspaceInstallArtifacts;
  }) => InstallPlan;
  applyInstallation: (opts: {
    root: string;
    workspaceId: string;
    plan: InstallPlan;
    allowDirty?: boolean;
  }) => ApplyResult;
}

export async function implementGa4Contract(
  input: Ga4ImplementInput,
  deps: Ga4ImplementDependencies
): Promise<Ga4ContractOutcome> {
  const state: DetectionState = {
    accountExists: true,
    assetExists: true,
    installId: input.measurementId
  };

  if (!input.measurementId) {
    return {
      result: {
        status: "skipped",
        detail: "No GA4 Measurement ID available — run setup before installing the tag."
      },
      state: { accountExists: false, assetExists: false }
    };
  }

  const artifacts: WorkspaceInstallArtifacts = {
    ga4: { measurementId: input.measurementId }
  };
  const plan = deps.planInstallation({
    root: input.repoRoot,
    workspaceId: input.workspaceId,
    artifacts
  });

  if (plan.blockers.length > 0) {
    return {
      result: {
        status: "blocked",
        detail: `Could not install the GA4 tag: ${plan.blockers.join(" ")}`
      },
      state,
      verification: implementVerification("failed")
    };
  }

  if (plan.applyMode !== "supported") {
    const firstInstruction = plan.instructions[0];
    const detail = firstInstruction
      ? `Manual GA4 tag install required: ${firstInstruction.description}`
      : `Manual GA4 tag install required for ${plan.framework}.`;
    return {
      result: { status: "needs_human", detail },
      state,
      verification: implementVerification("pending")
    };
  }

  if (plan.repoStatus === "dirty") {
    return {
      result: {
        status: "blocked",
        detail:
          "Your app repo has uncommitted changes. Commit or stash them, then re-run the GA4 tag install."
      },
      state,
      verification: implementVerification("failed")
    };
  }

  if (plan.confidence < 0.75) {
    return {
      result: {
        status: "needs_human",
        detail: `Not confident enough to auto-install the GA4 tag for ${plan.framework}. Install it manually.`
      },
      state,
      verification: implementVerification("pending")
    };
  }

  if (input.confirm && !(await input.confirm(plan))) {
    return {
      result: {
        status: "skipped",
        detail: "GA4 tag install skipped — no files were changed."
      },
      state,
      verification: implementVerification("pending")
    };
  }

  let result: ApplyResult;
  try {
    result = deps.applyInstallation({
      root: input.repoRoot,
      workspaceId: input.workspaceId,
      plan
    });
  } catch (error) {
    return {
      result: {
        status: "blocked",
        detail: `GA4 tag install could not be applied: ${
          error instanceof Error ? error.message : String(error)
        }`
      },
      state,
      verification: implementVerification("failed")
    };
  }

  return {
    result: {
      status: "ok",
      detail:
        result.changedFiles.length > 0
          ? `Installed the GA4 tag (${result.changedFiles.join(", ")}).`
          : "GA4 tag already in place — no files changed.",
      data: {
        changedFiles: result.changedFiles,
        manifestPath: result.manifestPath,
        warnings: result.warnings
      },
      ...(result.warnings.length > 0 ? { caveats: result.warnings } : {})
    },
    state,
    verification: implementVerification("verified")
  };
}

/** Repo-change preview shown to the founder before any GA4 tag file is written. */
export interface Ga4InstallPlanSummary {
  framework: string;
  appRoot: string;
  packageManager: string;
  files: string[];
}

/**
 * High-level entry point for installing the GA4 tag into the founder's site repo.
 * Resolves the infinite-tag tooling and runs the guarded install, surfacing
 * a plan summary to `confirm` so the caller can show the founder exactly what will
 * change before anything is written.
 */
export async function installGa4Tag(input: {
  measurementId: string;
  repoRoot: string;
  workspaceId: string;
  confirm?: (summary: Ga4InstallPlanSummary) => Promise<boolean>;
}): Promise<Ga4ContractOutcome> {
  const { planInstallation, applyInstallation } = await import("infinite-tag");
  return implementGa4Contract(
    {
      measurementId: input.measurementId,
      repoRoot: input.repoRoot,
      workspaceId: input.workspaceId,
      ...(input.confirm
        ? {
            confirm: (plan: InstallPlan) =>
              input.confirm!({
                framework: plan.framework,
                appRoot: plan.appRoot,
                packageManager: plan.packageManager,
                files: plan.files
              })
          }
        : {})
    },
    { planInstallation, applyInstallation }
  );
}

function implementVerification(
  installStatus: SetupVerificationState["installStatus"]
): SetupVerificationState {
  return {
    installStatus,
    queryabilityStatus: "pending",
    lastCheckedAt: new Date().toISOString()
  };
}

function buildGa4PublicArtifacts(
  propertyId: string,
  stream?: Ga4WebDataStream
): SetupProviderPublicArtifacts {
  return {
    propertyId,
    measurementId: stream?.measurementId ?? null,
    defaultUri: stream?.defaultUri ?? null
  };
}

/** The web stream whose host matches the founder's site, if any (no silent fallback). */
function findMatchingStream(
  streams: Ga4WebDataStream[],
  siteHost: string | null
): Ga4WebDataStream | undefined {
  if (!siteHost) {
    return undefined;
  }
  return streams.find((stream) => normalizeHost(stream.defaultUri) === siteHost);
}

function normalizeOrigin(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Lenient host comparison key: lowercases, strips a leading `www.` and any trailing
 * FQDN dot, ignores protocol/port. GA4 web-stream defaultUri values sometimes carry a
 * trailing dot (`https://acme.test.`) that would otherwise defeat the match.
 */
function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const candidate = raw.includes("://") ? raw : `https://${raw}`;
  try {
    return new URL(candidate).hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, "");
  } catch {
    return null;
  }
}

function humanResult(
  kind: "window_open" | "open_url",
  url: string | undefined,
  instructions: string,
  data?: Record<string, unknown>
): PhaseResult {
  return {
    status: "needs_human",
    detail: instructions,
    handoff: { kind, url, instructions },
    data
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return asString(value);
}

function buildConnectSourceInput(
  session: Ga4AuthorizedSession,
  propertyId: string | undefined
): SetupConnectSourceActionInput | undefined {
  if (!session.accessToken || !propertyId) {
    return undefined;
  }

  return ga4ConnectSourceFromSetup({
    propertyId,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
    apiBaseUrl: GA4_DATA_API_BASE_URL,
    oauthTokenId: session.refs.oauthTokenId
  });
}

function withHandoffUrl(
  browser: SetupBrowserHandoffRef | undefined,
  handoffUrl: string | undefined
): SetupBrowserHandoffRef | undefined {
  if (!browser && !handoffUrl) {
    return undefined;
  }
  return {
    ...(browser ?? {}),
    handoffUrl: handoffUrl ?? browser?.handoffUrl
  };
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

function actionContext(workspaceId: string): SessionContext {
  return {
    workspaceId,
    authority: "operator",
    surface: "worker",
    actorId: "setup_onboarding",
    sessionId: `setup:${workspaceId}`
  };
}

function carryVerification(
  detected: Ga4ContractOutcome,
  state: DetectionState
): SetupVerificationState {
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

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function compactRecord<T extends Record<string, string | undefined>>(value: T): Record<string, string> {
  const entries = Object.entries(value).filter(([, item]) => typeof item === "string" && item.length > 0);
  return Object.fromEntries(entries) as Record<string, string>;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function defaultFetch(): Ga4FetchLike {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("GA4 live Admin API support requires a fetch implementation.");
  }
  return globalThis.fetch.bind(globalThis) as Ga4FetchLike;
}

async function paginate<TPayload, TItem>(
  request: (pageToken: string | undefined) => Promise<TPayload>,
  nextPageTokenOf: (payload: TPayload) => string | undefined,
  itemsOf: (payload: TPayload) => TItem[]
): Promise<TItem[]> {
  const items: TItem[] = [];
  let pageToken: string | undefined;

  do {
    const payload = await request(pageToken);
    items.push(...itemsOf(payload));
    pageToken = asString(nextPageTokenOf(payload));
  } while (pageToken);

  return items;
}

async function requestJson<T>(
  fetchImpl: Ga4FetchLike,
  session: Ga4AuthorizedSession,
  url: string,
  options: {
    method: "GET" | "POST";
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  }
): Promise<T> {
  const accessToken = asString(session.accessToken);
  if (!accessToken) {
    throw new Error("GA4 live Admin API calls require an access token from the current OAuth session.");
  }

  const requestUrl = new URL(url);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    requestUrl.searchParams.set(key, value);
  }

  const response = await fetchImpl(requestUrl, {
    method: options.method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `GA4 Admin API ${options.method} ${requestUrl.toString()} failed with ${response.status}: ${detail}`
    );
  }

  return response.json() as Promise<T>;
}

function resolveTermsOfServiceUrl(
  input: Ga4AdminApiClientOptions["termsOfServiceUrl"],
  context: { accountTicketId: string; redirectUri: string }
): string | undefined {
  if (typeof input === "function") {
    return input(context);
  }
  if (typeof input === "string" && input.length > 0) {
    return input;
  }
  return undefined;
}
