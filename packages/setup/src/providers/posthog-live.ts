import { randomUUID } from "node:crypto";

import type { BrowserSessionRef } from "../browser/session-store.js";
import type { SetupBrowserHandoffRef } from "../types.js";
import type {
  PostHogAccessDiscovery,
  PostHogAuthorizedSession,
  PostHogBrowserSession,
  PostHogCredentialSession,
  PostHogDependencies,
  PostHogHumanHandoffRequest,
  PostHogHumanHandoffResult,
  PostHogNeedsHumanReason,
  PostHogOAuthSession,
  PostHogOrganization,
  PostHogProject,
  PostHogTransport,
  PostHogTransportRequest,
  PostHogTransportResponse
} from "./posthog.js";

const ALLOWED_POSTHOG_BROWSER_HOSTS = new Set([
  "app.posthog.com",
  "us.posthog.com",
  "eu.posthog.com"
]);

export interface PostHogApiClient {
  listOrganizations(session: PostHogAuthorizedSession): Promise<PostHogOrganization[]>;
  listProjects(session: PostHogAuthorizedSession, orgId: string): Promise<PostHogProject[]>;
  createProject(
    session: PostHogAuthorizedSession,
    input: { orgId: string; name: string }
  ): Promise<Pick<PostHogProject, "projectId" | "projectKey" | "apiHost">>;
  /**
   * Creates a PostHog personal API key through the authenticated session and returns
   * its secret value (phx_...). PostHog only reveals the value in this creation
   * response, so the caller must store it immediately.
   */
  createPersonalApiKey(
    session: PostHogAuthorizedSession,
    input?: { label?: string }
  ): Promise<string>;
}

export type PostHogResolvedAccess =
  | { kind: "oauth"; session: PostHogOAuthSession }
  | { kind: "credential"; session: PostHogCredentialSession }
  | { kind: "browser"; session: PostHogBrowserSession }
  | (PostHogHumanHandoffRequest & {
      kind: "needs_human";
      browser?: SetupBrowserHandoffRef;
      lastKnownUrl?: string;
    });

export interface PostHogAccessResolver {
  resolve(): Promise<PostHogResolvedAccess>;
}

export interface PostHogBrowserHandoffPlanner {
  plan(input: PostHogHumanHandoffRequest): Promise<PostHogHumanHandoffResult>;
}

export interface PostHogBrowserHandoffPlannerOptions {
  profileRef?: string;
  createResumeNonce?: () => string;
  load?: () => Promise<BrowserSessionRef | null>;
}

export interface CreatePostHogApiClientOptions {
  transport?: PostHogTransport;
}

export interface CreatePostHogLiveDependenciesOptions {
  access: PostHogAccessResolver;
  api?: Pick<PostHogApiClient, "listOrganizations" | "listProjects" | "createProject">;
  transport?: PostHogTransport;
  handoff?: PostHogBrowserHandoffPlanner;
}

export function createPostHogApiClient(
  options: CreatePostHogApiClientOptions = {}
): PostHogApiClient {
  const transport = options.transport ?? defaultTransport;

  return {
    async listOrganizations(session) {
      const payload = await requestJson(
        transportForSession(session, transport),
        buildUrl(normalizePostHogApiHost(session.apiHost), "/api/organizations/"),
        authRequest(session)
      );
      return unwrapList(payload).map((item) => ({
        orgId: String(item.id),
        name: asOptionalString(item.name)
      }));
    },
    async listProjects(session, orgId) {
      const payload = await requestJson(
        transportForSession(session, transport),
        buildUrl(normalizePostHogApiHost(session.apiHost), `/api/organizations/${encodeURIComponent(orgId)}/projects/`),
        authRequest(session)
      );
      const publicApiHost = resolvePublicApiHost(session);
      return unwrapList(payload).map((item) => ({
        projectId: String(item.id),
        name: asOptionalString(item.name),
        projectKey: requireString(item.api_token, "project.api_token"),
        apiHost: publicApiHost,
        completedSnippetOnboarding: asOptionalBoolean(item.completed_snippet_onboarding),
        ingestedEvent: asOptionalBoolean(item.ingested_event)
      }));
    },
    async createProject(session, input) {
      const payload = ensureRecord(await requestJson(
        transportForSession(session, transport),
        buildUrl(normalizePostHogApiHost(session.apiHost), `/api/organizations/${encodeURIComponent(input.orgId)}/projects/`),
        {
          ...authRequest(session),
          method: "POST",
          headers: {
            ...authRequest(session).headers,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: input.name })
        }
      ));
      return {
        projectId: String(requireStringOrNumber(payload.id, "project.id")),
        projectKey: requireString(payload.api_token, "project.api_token"),
        apiHost: resolvePublicApiHost(session)
      };
    },
    async createPersonalApiKey(session, input = {}) {
      const payload = ensureRecord(await requestJson(
        transportForSession(session, transport),
        buildUrl(normalizePostHogApiHost(session.apiHost), "/api/personal_api_keys/"),
        {
          ...authRequest(session),
          method: "POST",
          headers: {
            ...authRequest(session).headers,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ label: input.label ?? "Infinite", scopes: ["*"] })
        }
      ));
      const value = requireString(payload.value, "personal_api_key.value");
      if (!isPostHogPersonalApiKey(value)) {
        throw new Error("PostHog returned a personal API key value that does not start with phx_");
      }
      return value;
    }
  };
}

export function isPostHogPersonalApiKey(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("phx_") && trimmed.length > "phx_".length && !/\s/.test(trimmed);
}

export function createPostHogBrowserHandoffPlanner(
  options: PostHogBrowserHandoffPlannerOptions = {}
): PostHogBrowserHandoffPlanner {
  return {
    async plan(input) {
      const existing = await options.load?.();
      const profileRef = existing?.profileRef ?? options.profileRef ?? defaultProfileRef(input.reason);
      const resumeNonce = existing?.resumeNonce ?? options.createResumeNonce?.() ?? randomUUID();
      return {
        reason: input.reason,
        handoffUrl: input.handoffUrl,
        instructions: input.instructions,
        browser: {
          profileRef,
          resumeNonce,
          handoffUrl: input.handoffUrl
        },
        lastKnownUrl: existing?.lastUrl
      };
    }
  };
}

export function createPostHogLiveDependencies(
  options: CreatePostHogLiveDependenciesOptions
): PostHogDependencies {
  const api = options.api ?? createPostHogApiClient({ transport: options.transport });

  return {
    async discoverAccess(): Promise<PostHogAccessDiscovery> {
      const resolved = await options.access.resolve();
      if (resolved.kind === "oauth") {
        return { oauth: resolved.session };
      }
      if (resolved.kind === "credential") {
        return { credential: resolved.session };
      }
      if (resolved.kind === "browser") {
        return { browser: resolved.session };
      }
      const needsHuman = await planHandoff(options.handoff, resolved);
      return { needsHuman };
    },
    listOrganizations(session) {
      return api.listOrganizations(session);
    },
    listProjects(session, orgId) {
      return api.listProjects(session, orgId);
    },
    createProject(session, input) {
      return api.createProject(session, input);
    },
    async beginHumanHandoff(input) {
      return planHandoff(options.handoff, input);
    }
  };
}

export function normalizePostHogApiHost(apiHost: string): string {
  const host = new URL(apiHost);
  if (host.hostname === "us.i.posthog.com") {
    host.hostname = "us.posthog.com";
  } else if (host.hostname === "eu.i.posthog.com") {
    host.hostname = "eu.posthog.com";
  }
  return host.origin;
}

export function derivePostHogPublicApiHost(apiHost: string): string {
  const host = new URL(apiHost);
  if (host.hostname === "us.i.posthog.com" || host.hostname === "eu.i.posthog.com") {
    return host.origin;
  }
  if (host.hostname === "app.posthog.com" || host.hostname === "us.posthog.com") {
    host.hostname = "us.i.posthog.com";
    return host.origin;
  }
  if (host.hostname === "eu.posthog.com") {
    host.hostname = "eu.i.posthog.com";
    return host.origin;
  }
  return host.origin;
}

export function sanitizePostHogBrowserUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !ALLOWED_POSTHOG_BROWSER_HOSTS.has(parsed.hostname)) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function resolvePublicApiHost(
  session: Pick<PostHogOAuthSession | PostHogCredentialSession, "apiHost" | "publicApiHost">
): string {
  return session.publicApiHost ?? derivePostHogPublicApiHost(normalizePostHogApiHost(session.apiHost));
}

async function requestJson(
  transport: PostHogTransport,
  url: string,
  init: PostHogTransportRequest
): Promise<Record<string, unknown> | Array<Record<string, unknown>>> {
  const response = await transport(url, init);
  const payload = await readPostHogResponsePayload(response);
  if (!response.ok) {
    throw new Error(posthogApiFailureMessage(response.status, url, init.method ?? "GET", payload));
  }
  if (!isRecord(payload) && !Array.isArray(payload)) {
    throw new Error(`PostHog API returned a non-JSON-object payload from ${safePostHogRequestTarget(url)}`);
  }
  return payload as Record<string, unknown> | Array<Record<string, unknown>>;
}

async function readPostHogResponsePayload(response: PostHogTransportResponse): Promise<unknown> {
  try {
    const raw = await response.text();
    if (raw.trim() === "") {
      return {};
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  } catch {
    try {
      return await response.json();
    } catch (error) {
      return `unreadable response body (${error instanceof Error ? error.message : String(error)})`;
    }
  }
}

function posthogApiFailureMessage(
  status: number,
  url: string,
  method: string,
  payload: unknown
): string {
  const detail = safePostHogText(typeof payload === "string" ? payload : JSON.stringify(payload));
  const hint = posthogApiFailureHint(status, detail);
  return [
    `PostHog API request failed (${status} ${method} ${safePostHogRequestTarget(url)}): ${detail}`,
    hint ? `Hint: ${hint}` : undefined
  ].filter(Boolean).join(" ");
}

function posthogApiFailureHint(status: number, detail: string): string | undefined {
  const normalized = detail.toLowerCase();
  if (status === 403 || normalized.includes("scope") || normalized.includes("permission") || normalized.includes("forbidden")) {
    return "Create a personal API key with organization/project read access, or all organization/project access, then resume setup again.";
  }
  if (status === 401 || normalized.includes("authentication") || normalized.includes("credentials")) {
    return "Check that the value is a PostHog personal API key starting with phx_, not a project key starting with phc_, and that the PostHog host matches the workspace region, for example https://eu.posthog.com or https://us.posthog.com.";
  }
  if (status === 404) {
    return "Check that the PostHog host matches the browser region, for example https://eu.posthog.com or https://us.posthog.com.";
  }
  return undefined;
}

function safePostHogRequestTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return safePostHogText(url);
  }
}

function safePostHogText(value: string): string {
  return value
    .replace(/phx_[A-Za-z0-9_-]+/g, "phx_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]*[A-Za-z0-9_~+/=-]/gi, "Bearer [redacted]");
}

function unwrapList(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
  if (Array.isArray(payload)) {
    return payload;
  }
  const results = payload.results;
  if (Array.isArray(results)) {
    return results.filter(isRecord);
  }
  throw new Error("PostHog API payload did not contain a results array");
}

function ensureRecord(
  payload: Record<string, unknown> | Array<Record<string, unknown>>
): Record<string, unknown> {
  if (isRecord(payload)) {
    return payload;
  }
  throw new Error("PostHog API returned a list payload where an object payload was expected");
}

function authRequest(
  session: PostHogAuthorizedSession
): PostHogTransportRequest {
  if ("transport" in session) {
    return {
      method: "GET",
      headers: {}
    };
  }
  return {
    method: "GET",
    headers: {
      Authorization: `Bearer ${posthogAuthToken(session)}`
    }
  };
}

async function planHandoff(
  planner: PostHogBrowserHandoffPlanner | undefined,
  input: PostHogHumanHandoffRequest & { browser?: SetupBrowserHandoffRef; lastKnownUrl?: string }
): Promise<PostHogHumanHandoffResult> {
  if (planner) {
    return planner.plan(input);
  }
  return {
    reason: input.reason,
    handoffUrl: input.handoffUrl,
    instructions: input.instructions,
    browser: input.browser,
    lastKnownUrl: input.lastKnownUrl
  };
}

function buildUrl(origin: string, path: string): string {
  return new URL(path, ensureTrailingSlash(origin)).toString();
}

function ensureTrailingSlash(origin: string): string {
  return origin.endsWith("/") ? origin : `${origin}/`;
}

function defaultProfileRef(reason: PostHogNeedsHumanReason): string {
  return `posthog-${reason.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

function posthogAuthToken(
  session: PostHogOAuthSession | PostHogCredentialSession
): string {
  if ("accessToken" in session && typeof session.accessToken === "string" && session.accessToken.trim() !== "") {
    return session.accessToken;
  }
  if ("personalApiKey" in session && typeof session.personalApiKey === "string" && session.personalApiKey.trim() !== "") {
    return session.personalApiKey;
  }
  throw new Error("PostHog live access requires an access token or personal API key");
}

function transportForSession(
  session: PostHogAuthorizedSession,
  fallback: PostHogTransport
): PostHogTransport {
  if (!("transport" in session)) {
    return fallback;
  }
  return async (url, init) => {
    const safeUrl = sanitizePostHogBrowserUrl(url);
    if (!safeUrl) {
      throw new Error(
        `PostHog browser-authenticated requests must target official PostHog origins over HTTPS (received ${url})`
      );
    }
    return session.transport(url, init);
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`Missing PostHog field: ${label}`);
}

function requireStringOrNumber(value: unknown, label: string): string | number {
  if ((typeof value === "string" && value.length > 0) || typeof value === "number") {
    return value;
  }
  throw new Error(`Missing PostHog field: ${label}`);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function defaultTransport(
  url: string,
  init?: PostHogTransportRequest
): Promise<PostHogTransportResponse> {
  const response = await fetch(url, init);
  let textPromise: Promise<string> | undefined;
  const readText = () => {
    textPromise ??= response.text();
    return textPromise;
  };
  return {
    ok: response.ok,
    status: response.status,
    json: async () => JSON.parse(await readText()) as unknown,
    text: readText
  };
}
