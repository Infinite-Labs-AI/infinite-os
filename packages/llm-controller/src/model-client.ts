import {
  readInfiniteOsAuthState,
  readInfiniteOsModelSelection,
  writeInfiniteOsAuthRecord,
  type InfiniteOsAuthRecord,
  type InfiniteOsModelProvider
} from "@infinite-os/config";
import type {
  InfiniteOsModelClient,
  InfiniteOsToolSchema,
  ModelRequest,
  ModelResponse,
  ModelToolCall
} from "./index.js";
import {
  DEFAULT_CODEX_BASE_URL,
  refreshCodexAuth,
  reloadFreshlyRefreshedCodexImport,
  resolveCodexRuntimeCredentials
} from "./model-auth/codex-auth.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const CLAUDE_CODE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // gitleaks:allow — Claude Code public OAuth client id
const DEFAULT_CLAUDE_REFRESH_URLS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token"
];
const CLAUDE_COMMON_BETAS = [
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14"
];
const CLAUDE_OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20"
];
const CLAUDE_CODE_VERSION_FALLBACK = "2.1.74";
// Claude-Code OAuth completions are no longer supported (Anthropic ToS): there is
// no first-party broker to route OAuth-bearer chat through. Steer users to an API key.
const CLAUDE_OAUTH_UNSUPPORTED_MESSAGE =
  "Claude via OAuth (Claude Code setup-token/reuse credentials) is no longer supported. Set `ANTHROPIC_API_KEY` to use Claude, or run `codex login` to use Codex.";

export interface CreateConfiguredModelClientOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

type ModelStreamCallback = (delta: string) => Promise<void> | void;

interface ModelStreamCallbacks {
  onMessageDelta?: ModelStreamCallback;
  onReasoningDelta?: ModelStreamCallback;
}

export function createConfiguredModelClient(
  options: CreateConfiguredModelClientOptions = {}
): InfiniteOsModelClient {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return {
    modelMetadata() {
      const selection = readInfiniteOsModelSelection(env);
      if (!selection.provider || !selection.model) {
        return {};
      }
      return {
        provider: selection.provider,
        model: selection.model,
        authSource: authSource(selection.provider, env)
      };
    },
    async complete(request) {
      const selection = readInfiniteOsModelSelection(env);
      if (!selection.provider || !selection.model) {
        return unconfiguredModelResponse();
      }
      return completeForProvider(selection.provider, selection.model, request, env, fetchImpl);
    }
  };
}

async function completeForProvider(
  provider: InfiniteOsModelProvider,
  model: string,
  request: ModelRequest,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<ModelResponse> {
  if (provider === "codex") {
    return completeWithCodex(request, model, env, fetchImpl);
  }
  if (provider === "claude") {
    return completeWithClaude(request, model, env, fetchImpl);
  }
  return unsupportedProviderResponse(provider);
}

function unconfiguredModelResponse(): ModelResponse {
  return {
    message:
      "Infinite OS chat is ready, but no model client is configured. Run `infinite setup` or `infinite model use <provider> <model>` and configure auth before model-backed synthesis."
  };
}

function unsupportedProviderResponse(provider: InfiniteOsModelProvider): ModelResponse {
  return {
    message: `Infinite OS model provider ${provider} is not supported in this runtime pass.`
  };
}

async function completeWithCodex(
  request: ModelRequest,
  model: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<ModelResponse> {
  const credentials = await resolveCodexRuntimeCredentials({ env, fetch: fetchImpl });
  if (!credentials?.token) {
    return { message: "Codex model auth is not configured. Run `codex login` to sign in (from a terminal: `infinite setup` or `infinite codex login`)." };
  }
  const baseUrl = env.GROWTH_OS_CODEX_BASE_URL ?? DEFAULT_CODEX_BASE_URL;
  const responseUrl = `${baseUrl.replace(/\/$/, "")}/responses`;
  const responseBody = JSON.stringify({
    model,
    store: false,
    stream: true,
    instructions: request.systemPrompt,
    input: codexInput(request),
    tools: request.tools.map(codexTool)
  });
  let response = await fetchImpl(responseUrl, bearerRequest(credentials.token, responseBody));
  let appliedToken = credentials.token;
  if (response.status === 401 && credentials.auth?.refreshToken) {
    const refreshed = await refreshCodexAuth(credentials.auth, env, fetchImpl);
    if (refreshed?.token) {
      appliedToken = refreshed.token;
      response = await fetchImpl(responseUrl, bearerRequest(refreshed.token, responseBody));
    }
  }
  if (response.status === 401) {
    // Refresh failed or wasn't possible. The user may have re-authenticated the
    // upstream `codex` CLI out of band (refreshing ~/.codex). Re-import it if it
    // now carries a DIFFERENT, still-live token, persist it, and retry once before
    // giving up. Pass the LAST applied token (the refreshed one, if any) as the
    // dedupe guard so a just-refreshed store record is never clobbered.
    const reimported = reloadFreshlyRefreshedCodexImport(env, appliedToken);
    if (reimported?.token) {
      response = await fetchImpl(responseUrl, bearerRequest(reimported.token, responseBody));
    }
  }
  if (response.status === 401) {
    return codexReloginResponse();
  }
  const json = await responseJson(response, "Codex Responses API", request);
  return parseCodexResponse(json);
}

function codexReloginResponse(): ModelResponse {
  return {
    message:
      "Codex model auth expired and could not be refreshed. Run `codex login` to re-authenticate (from a terminal: `infinite codex login`), then retry."
  };
}

function claudeReloginResponse(): ModelResponse {
  return {
    message:
      "Claude model auth expired or is invalid and could not be refreshed. Run `infinite auth login claude --mode reuse` or `infinite auth login claude --mode setup-token`, then retry."
  };
}

async function completeWithClaude(
  request: ModelRequest,
  model: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<ModelResponse> {
  const discoveredClaudeAuth = resolveClaudeAuthRecord(env);
  const discoveredBearerToken = discoveredClaudeAuth?.token ?? env.CLAUDE_CODE_OAUTH_TOKEN ?? env.ANTHROPIC_TOKEN;
  const bearerToken = discoveredBearerToken;
  const apiKey = env.ANTHROPIC_API_KEY;
  // Claude-Code OAuth bearer credentials can no longer be used for completions
  // (Anthropic ToS — no first-party broker). When an OAuth-shaped bearer is the
  // only credential available, point the user at ANTHROPIC_API_KEY instead of
  // attempting a request that would be rejected.
  if (!apiKey && isClaudeCodeOauthToken(discoveredBearerToken)) {
    return {
      message: CLAUDE_OAUTH_UNSUPPORTED_MESSAGE
    };
  }
  if (!bearerToken && !apiKey) {
    return {
      message:
        "Claude model auth is not configured. Run `infinite setup`, `infinite auth login claude --mode reuse`, or `infinite auth login claude --mode setup-token`."
    };
  }
  const baseUrl = env.GROWTH_OS_CLAUDE_BASE_URL ?? "https://api.anthropic.com/v1";
  const messagesUrl = `${baseUrl.replace(/\/$/, "")}/messages`;
  const headers: Record<string, string> = {
    ...(bearerToken
      ? {
          authorization: `Bearer ${bearerToken}`,
          "anthropic-beta": [...CLAUDE_COMMON_BETAS, ...CLAUDE_OAUTH_BETAS].join(","),
          "user-agent": `claude-cli/${claudeCodeVersion()} (external, cli)`,
          "x-app": "cli"
        }
      : { "x-api-key": String(apiKey) }),
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  };
  const body = JSON.stringify({
    model,
    max_tokens: 2048,
    stream: true,
    system: request.systemPrompt,
    messages: [{ role: "user", content: claudeUserContent(request) }],
    tools: request.tools.map(claudeTool)
  });
  let response = await fetchImpl(messagesUrl, {
    method: "POST",
    headers,
    body
  });
  if (response.status === 401 && discoveredClaudeAuth?.refreshToken) {
    const refreshed = await refreshProviderToken("claude", discoveredClaudeAuth, env, fetchImpl);
    if (refreshed?.token) {
      response = await fetchImpl(messagesUrl, {
        method: "POST",
        headers: {
          ...headers,
          authorization: `Bearer ${refreshed.token}`
        },
        body
      });
    }
  }
  if (response.status === 401) {
    return claudeReloginResponse();
  }
  const json = await responseJson(response, "Claude Messages API", request);
  return parseClaudeResponse(json);
}

function authRecord(provider: InfiniteOsModelProvider, env: NodeJS.ProcessEnv) {
  return readInfiniteOsAuthState(env).providers[provider];
}

function resolveClaudeAuthRecord(env: NodeJS.ProcessEnv): InfiniteOsAuthRecord | undefined {
  const stored = authRecord("claude", env);
  const discovered = discoveredClaudeRuntimeAuth(env);
  if (!stored) {
    return discovered;
  }
  if (
    stored.source === "macos-keychain" ||
    stored.source === "claude-code-credentials-file"
  ) {
    return discovered ?? stored;
  }
  return stored;
}

function discoveredClaudeRuntimeAuth(env: NodeJS.ProcessEnv): InfiniteOsAuthRecord | undefined {
  const fromKeychain = readClaudeCodeCredentialsFromKeychain(env);
  if (fromKeychain) {
    return {
      provider: "claude",
      source: fromKeychain.source,
      authMode: "reuse",
      token: fromKeychain.token,
      refreshToken: fromKeychain.refreshToken,
      expiresAt: fromKeychain.expiresAt
    };
  }
  const fromFile = readClaudeCodeCredentialsFile(env);
  if (fromFile) {
    return {
      provider: "claude",
      source: fromFile.source,
      authMode: "reuse",
      token: fromFile.token,
      refreshToken: fromFile.refreshToken,
      expiresAt: fromFile.expiresAt
    };
  }
  return undefined;
}

function readClaudeCodeCredentialsFromKeychain(env: NodeJS.ProcessEnv): {
  source: string;
  token?: string;
  refreshToken?: string;
  expiresAt?: string;
} | undefined {
  const hasIsolatedHome = Boolean(env.HOME && process.env.HOME && env.HOME !== process.env.HOME);
  if (process.platform !== "darwin" || hasIsolatedHome) {
    return undefined;
  }
  const result = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    const tokens = tokensFromClaudeRecord(parsed);
    if (!tokens.token && !tokens.refreshToken) {
      return undefined;
    }
    return {
      source: "macos-keychain",
      ...tokens
    };
  } catch {
    return undefined;
  }
}

function readClaudeCodeCredentialsFile(env: NodeJS.ProcessEnv): {
  source: string;
  token?: string;
  refreshToken?: string;
  expiresAt?: string;
} | undefined {
  const home = env.HOME;
  const credentialsPath = home ? join(home, ".claude", ".credentials.json") : undefined;
  if (!credentialsPath || !existsSync(credentialsPath)) {
    return undefined;
  }
  const parsed = JSON.parse(readFileSync(credentialsPath, "utf8")) as Record<string, unknown>;
  const tokens = tokensFromClaudeRecord(parsed);
  if (!tokens.token && !tokens.refreshToken) {
    return undefined;
  }
  return {
    source: "claude-code-credentials-file",
    ...tokens
  };
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

let cachedClaudeCodeVersion: string | undefined;

function claudeCodeVersion(): string {
  if (cachedClaudeCodeVersion) {
    return cachedClaudeCodeVersion;
  }
  cachedClaudeCodeVersion = CLAUDE_CODE_VERSION_FALLBACK;
  return cachedClaudeCodeVersion;
}

function authSource(provider: InfiniteOsModelProvider, env: NodeJS.ProcessEnv): string | undefined {
  const record = authRecord(provider, env);
  if (record?.source) {
    return record.source;
  }
  if (provider === "codex" && env.OPENAI_API_KEY) {
    return "openai-api-key";
  }
  if (provider === "claude" && (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_TOKEN)) {
    return "claude-bearer-env";
  }
  if (provider === "claude" && env.ANTHROPIC_API_KEY) {
    return "anthropic-api-key";
  }
  return undefined;
}

function isClaudeCodeOauthToken(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value.startsWith("sk-ant-oat") || value.startsWith("cc-") || value.startsWith("eyJ");
}

function bearerRequest(token: string, body: string): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...codexCloudflareHeaders(token)
    },
    body
  };
}

// Headers required to avoid Cloudflare 403s on chatgpt.com/backend-api/codex.
// The Cloudflare layer in front of the Codex endpoint whitelists a small set of
// first-party originators (codex_cli_rs, codex_vscode, …); requests from
// non-residential IPs (VPS / server-hosted agents) that don't advertise an
// allowed originator are served a 403 (`cf-mitigated: challenge`) regardless of
// auth correctness. We pin `originator: codex_cli_rs` to match the upstream
// codex-rs CLI, set a codex_cli_rs-shaped User-Agent, and surface
// `ChatGPT-Account-ID` (canonical casing) from the OAuth JWT's
// `chatgpt_account_id` claim. These values are matched to the upstream codex
// CLI's request headers; the `(Hermes Agent)` UA suffix is a fixed wire value
// and must not be changed without re-verifying against the codex backend.
function codexCloudflareHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
    originator: "codex_cli_rs"
  };
  const accountId = chatgptAccountIdFromToken(token);
  if (accountId) {
    headers["ChatGPT-Account-ID"] = accountId;
  }
  return headers;
}

// Extract the `chatgpt_account_id` claim from the Codex OAuth access token (a
// JWT). Malformed/non-JWT tokens are tolerated — we drop the header rather than
// throw, so a bad token still surfaces as a 401 instead of a crash.
function chatgptAccountIdFromToken(token: string): string | undefined {
  if (typeof token !== "string" || !token.trim()) {
    return undefined;
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64url").toString("utf8");
    const claims = JSON.parse(decoded) as Record<string, unknown>;
    const auth = isRecord(claims["https://api.openai.com/auth"])
      ? (claims["https://api.openai.com/auth"] as Record<string, unknown>)
      : undefined;
    const accountId = auth ? auth.chatgpt_account_id : undefined;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}

async function refreshProviderToken(
  provider: InfiniteOsModelProvider,
  auth: InfiniteOsAuthRecord,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<InfiniteOsAuthRecord | null> {
  if (!auth.refreshToken) {
    return null;
  }
  const refreshUrls =
    provider === "codex"
      ? [env.GROWTH_OS_CODEX_REFRESH_URL].filter((url): url is string => Boolean(url))
      : env.GROWTH_OS_CLAUDE_REFRESH_URL
        ? [env.GROWTH_OS_CLAUDE_REFRESH_URL]
        : DEFAULT_CLAUDE_REFRESH_URLS;
  for (const refreshUrl of refreshUrls) {
    const response = await fetchImpl(refreshUrl, providerRefreshRequest(provider, auth.refreshToken, Boolean(env.GROWTH_OS_CLAUDE_REFRESH_URL)));
    if (!response.ok) {
      continue;
    }
    const refreshed = persistRefreshedProviderToken(provider, auth, await response.json().catch(() => ({})), env);
    if (refreshed) {
      return refreshed;
    }
  }
  return null;
}

function providerRefreshRequest(
  provider: InfiniteOsModelProvider,
  refreshToken: string,
  useJsonOverride: boolean
): RequestInit {
  if (provider === "claude" && !useJsonOverride) {
    return {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "claude-cli/unknown (external, cli)"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLAUDE_CODE_OAUTH_CLIENT_ID
      }).toString()
    };
  }
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      provider
    })
  };
}

function persistRefreshedProviderToken(
  provider: InfiniteOsModelProvider,
  auth: InfiniteOsAuthRecord,
  json: unknown,
  env: NodeJS.ProcessEnv
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
      auth.expiresAt
  };
  writeInfiniteOsAuthRecord(refreshed, env);
  return refreshed;
}

function codexTool(tool: InfiniteOsToolSchema): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: `${tool.title}: ${tool.summary}`,
    parameters: tool.inputSchema
  };
}

function claudeTool(tool: InfiniteOsToolSchema): Record<string, unknown> {
  return {
    name: tool.name,
    description: `${tool.title}: ${tool.summary}`,
    input_schema: tool.inputSchema
  };
}

function codexInput(request: ModelRequest): Array<Record<string, unknown>> {
  const input = [
    {
      role: "user",
      content: request.userMessage
    }
  ];
  if (request.toolResults.length) {
    const digest = toolResultDigest(request.toolResults);
    input.push({
      role: "user",
      content: [
        "Infinite OS result digest:",
        digest,
        "",
        "Infinite OS typed action results:",
        JSON.stringify(request.toolResults)
      ].join("\n")
    });
  }
  return input;
}

function claudeUserContent(request: ModelRequest): string {
  if (!request.toolResults.length) {
    return request.userMessage;
  }
  const digest = toolResultDigest(request.toolResults);
  return [
    request.userMessage,
    "",
    "Infinite OS result digest:",
    digest,
    "",
    "Infinite OS typed action results:",
    JSON.stringify(request.toolResults)
  ].join("\n");
}

function toolResultDigest(toolResults: ModelRequest["toolResults"]): string {
  const lines = toolResults.map((result, index) => {
    const prefix = `${index + 1}. ${result.name}`;
    const payload = result.result;
    if (!isRecord(payload)) {
      return `${prefix}: result returned.`;
    }
    const status = stringValue(payload.status) ?? "unknown";
    if (status === "requires_confirmation") {
      return `${prefix}: requires confirmation before execution.`;
    }
    if (status === "error") {
      const errorPayload = objectRecord(payload, "error");
      const error = errorPayload ? stringValue(errorPayload.message) ?? stringValue(errorPayload.code) : undefined;
      return `${prefix}: error${error ? ` (${error})` : ""}.`;
    }
    const data = objectRecord(payload, "data");
    const caveatsRaw = (payload as Record<string, unknown>)["caveats"];
    const caveats = Array.isArray(caveatsRaw)
      ? caveatsRaw.filter((value: unknown): value is string => typeof value === "string").slice(0, 2)
      : [];
    const summary = summarizeActionData(result.name, data);
    const caveatText = caveats.length ? ` Caveats: ${caveats.join(", ")}.` : "";
    return `${prefix}: ${summary}${caveatText}`;
  });
  return lines.join("\n");
}

function summarizeActionData(name: string, data: Record<string, unknown> | undefined): string {
  if (!data) {
    return "completed.";
  }
  const rows = Array.isArray(data.rows) ? data.rows.filter(isRecord) : [];
  if (name === "run_metric_query" && rows.length > 0) {
    const scalar = rows[0];
    const requestedMetric = stringValue(data.metric);
    if (requestedMetric) {
      const metricValue = scalarMetricValue(scalar, requestedMetric);
      if (metricValue !== undefined) {
        return `metric ${requestedMetric}: ${metricValue}.`;
      }
    }
    const metrics = Object.entries(scalar)
      .map(([metric, value]) => [metric, scalarMetricValue(scalar, metric)] as const)
      .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string");
    if (metrics.length === 1) {
      const [metric, value] = metrics[0];
      return `metric ${metric}: ${value}.`;
    }
  }
  if (name === "run_breakdown_query" && rows.length > 0) {
    const metric = stringValue(data.metric);
    const topRows = rows.slice(0, 3).map((row, index) => describeBreakdownRow(row, index, metric));
    const pattern = breakdownPatternHint(rows, metric);
    const lead =
      metric === "x_public_engagement" && rows.some((row) => stringValue(row.body_text) || stringValue(row.post_url) || stringValue(row.x_post_id))
        ? "top X posts by engagement"
        : metric
          ? `${metric} ranked rows`
          : "top breakdown rows";
    return `${lead}: ${topRows.join(" | ")}.${pattern ? ` Pattern: ${pattern}.` : ""}`;
  }
  if (name === "explain_answer") {
    const authority = stringValue(data.sourceAuthority);
    return authority ? `authority: ${authority}.` : "authority explained.";
  }
  if (name === "list_metrics" && Array.isArray(data.metrics)) {
    const metricIds = data.metrics
      .filter(isRecord)
      .map((metric) => stringValue(metric.id))
      .filter((value): value is string => Boolean(value))
      .slice(0, 5);
    if (metricIds.length) {
      return `metrics available: ${metricIds.join(", ")}.`;
    }
  }
  if (name === "describe_metric" && isRecord(data.metric)) {
    const metric = data.metric;
    const id = stringValue(metric.id);
    const sourceView = stringValue(metric.source_view);
    const timeColumn = stringValue(metric.default_time_column);
    const dimensions = Array.isArray(metric.allowed_dimensions)
      ? metric.allowed_dimensions.filter((value: unknown): value is string => typeof value === "string").slice(0, 8)
      : [];
    if (id) {
      return `metric ${id}${sourceView ? ` from ${sourceView}` : ""}${timeColumn ? `; time ${timeColumn}` : ""}${dimensions.length ? `; dimensions ${dimensions.join(", ")}` : ""}.`;
    }
  }
  if (name === "describe_queryable_view" && isRecord(data.view)) {
    const view = data.view;
    const id = stringValue(view.id) ?? stringValue(view.view_name);
    const grain = stringValue(view.row_grain);
    const timeColumn = stringValue(view.default_time_column);
    const dimensions = Array.isArray(view.allowed_dimensions)
      ? view.allowed_dimensions.filter((value: unknown): value is string => typeof value === "string").slice(0, 8)
      : [];
    if (id) {
      return `view ${id}${grain ? `; grain ${grain}` : ""}${timeColumn ? `; time ${timeColumn}` : ""}${dimensions.length ? `; dimensions ${dimensions.join(", ")}` : ""}.`;
    }
  }
  if (name === "list_sources" && Array.isArray(data.sources)) {
    let hasSyncedEvidence = false;
    const sources = data.sources
      .filter(isRecord)
      .slice(0, 5)
      .map((source) => {
        const provider = stringValue(source.provider) ?? "unknown";
        const status = stringValue(source.status) ?? "unknown";
        const connectionName = stringValue(source.connection_name) ?? stringValue(source.connectionName);
        const lastSyncedAt = stringValue(source.last_synced_at) ?? stringValue(source.lastSyncedAt);
        if (lastSyncedAt) {
          hasSyncedEvidence = true;
        }
        const label = connectionName ? `${provider} (${connectionName})` : provider;
        return `${label} status=${status}${lastSyncedAt ? ` last_synced_at=${lastSyncedAt}` : ""}`;
      });
    if (sources.length) {
      return `connected sources: ${sources.join(" | ")}.${hasSyncedEvidence ? " Do not say never synced when last_synced_at or sync runs are present." : ""}`;
    }
  }
  if (name === "get_recent_sync_runs" && Array.isArray(data.syncRuns)) {
    let hasSyncEvidence = false;
    const syncRuns = data.syncRuns
      .filter(isRecord)
      .slice(0, 5)
      .map((run, index) => {
        const status = stringValue(run.status) ?? "unknown";
        const sourceId = stringValue(run.source_id) ?? stringValue(run.sourceId);
        const finishedAt = stringValue(run.finished_at) ?? stringValue(run.finishedAt);
        const loaded = scoreValueText(run.records_loaded) ?? scoreValueText(run.recordsLoaded);
        if (sourceId || finishedAt || loaded) {
          hasSyncEvidence = true;
        }
        const parts = [
          `#${index + 1}`,
          sourceId,
          status,
          finishedAt ? `finished_at=${finishedAt}` : undefined,
          loaded ? `records_loaded=${loaded}` : undefined
        ].filter((value): value is string => Boolean(value));
        return parts.join(" ");
      });
    if (syncRuns.length) {
      return `recent sync runs: ${syncRuns.join(" | ")}.${hasSyncEvidence ? " Do not say never synced when last_synced_at or sync runs are present." : ""}`;
    }
  }
  return "completed.";
}

function describeBreakdownRow(row: Record<string, unknown>, index: number, metric?: string): string {
  const rank = `#${index + 1}`;
  const score = preferredBreakdownScore(row, metric);
  const scoreText = score ? `${score[0]}=${score[1]}` : "value";
  const label = breakdownRowLabel(row);
  if (!label) {
    return `${rank} ${scoreText}`;
  }
  return `${rank} ${scoreText} ${truncate(label, 80)}`;
}

function scalarMetricValue(row: Record<string, unknown>, metric: string): string | undefined {
  return scoreValueText(row[metric]);
}

function scoreValueText(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    return /^-?\d+(?:\.\d+)?$/.test(trimmed) ? trimmed : undefined;
  }
  return undefined;
}

function preferredBreakdownScore(
  row: Record<string, unknown>,
  metric?: string
): readonly [string, string] | undefined {
  if (metric) {
    const metricValue = scalarMetricValue(row, metric);
    if (metricValue !== undefined) {
      return [metric, metricValue] as const;
    }
  }
  return Object.entries(row)
    .filter(([key]) => !isBreakdownLabelKey(key) && !isBreakdownIdentifierKey(key))
    .map(([key, value]) => [key, scoreValueText(value)] as const)
    .find((entry): entry is readonly [string, string] => typeof entry[1] === "string");
}

function breakdownPatternHint(rows: Record<string, unknown>[], metric?: string): string | undefined {
  if (rows.length < 2) {
    return undefined;
  }
  const winner = preferredBreakdownScore(rows[0], metric);
  const runnerUp = preferredBreakdownScore(rows[1], metric);
  if (!winner?.[1] || !runnerUp?.[1]) {
    return undefined;
  }
  const winnerValue = Number(winner[1]);
  const runnerUpValue = Number(runnerUp[1]);
  if (!Number.isFinite(winnerValue) || !Number.isFinite(runnerUpValue) || winnerValue <= 0 || runnerUpValue <= 0) {
    return undefined;
  }
  if (winnerValue >= runnerUpValue * 2) {
    return "winner is clearly ahead of the next row";
  }
  return "top rows are relatively close";
}

function breakdownRowLabel(row: Record<string, unknown>): string | undefined {
  const publishedHour = stringLikeValue(row.published_hour_utc);
  const publishedWeekday = stringLikeValue(row.published_weekday_utc);
  if (publishedHour || publishedWeekday) {
    const parts = [
      publishedHour ? `hour ${publishedHour.padStart(2, "0")} UTC` : undefined,
      publishedWeekday ? weekdayLabel(publishedWeekday) : undefined
    ].filter((value): value is string => Boolean(value));
    if (parts.length > 0) {
      return parts.join(" / ");
    }
  }
  const provider = stringValue(row.provider);
  const currency = stringValue(row.currency);
  if (provider || currency) {
    return [provider, currency].filter(Boolean).join(" / ");
  }

  const utmSource = stringValue(row.utm_source);
  const utmMedium = stringValue(row.utm_medium);
  const utmCampaign = stringValue(row.utm_campaign);
  if (utmSource || utmMedium || utmCampaign) {
    return [utmSource, utmMedium, utmCampaign].filter(Boolean).join(" / ");
  }

  const country = stringValue(row.country);
  const landingPage = stringValue(row.landing_page);
  if (country || landingPage) {
    return [country, landingPage].filter(Boolean).join(" / ");
  }

  const contentType = stringValue(row.content_type);
  const mentionedHandle = stringValue(row.mentioned_handle);
  if (contentType || mentionedHandle) {
    return [contentType, mentionedHandle ? `@${mentionedHandle}` : undefined].filter(Boolean).join(" / ");
  }

  return stringValue(row.body_text) ?? stringValue(row.post_url) ?? stringValue(row.x_post_id);
}

function stringLikeValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return stringValue(value);
}

function weekdayLabel(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return `day ${value}`;
  }
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][parsed] ?? `day ${value}`;
}

function isBreakdownLabelKey(key: string): boolean {
  return [
    "provider",
    "currency",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "country",
    "landing_page",
    "content_type",
    "mentioned_handle",
    "body_text",
    "post_url"
  ].includes(key);
}

function isBreakdownIdentifierKey(key: string): boolean {
  return /(^|_)(id|external_id)$/.test(key) || key === "x_post_id";
}

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

async function responseJson(
  response: Response,
  provider: string,
  streamCallbacks: ModelStreamCallbacks = {}
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${provider} request failed with status ${response.status}: ${text}`);
  }
  if (response.body && isEventStreamResponse(response)) {
    return provider.startsWith("Claude")
      ? parseClaudeEventStreamFromBody(response.body, streamCallbacks)
      : parseCodexEventStreamFromBody(response.body, streamCallbacks);
  }
  const text = await response.text();
  if (text.trim().startsWith("event:") || text.includes("response.completed")) {
    return provider.startsWith("Claude")
      ? parseClaudeEventStreamText(text, streamCallbacks)
      : parseCodexEventStreamText(text, streamCallbacks);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
}

interface CodexEventStreamState {
  outputText: string;
  outputItems: Array<Record<string, unknown>>;
  usage: unknown;
}

async function parseCodexEventStreamFromBody(
  body: ReadableStream<Uint8Array>,
  callbacks: ModelStreamCallbacks
): Promise<Record<string, unknown>> {
  const state: CodexEventStreamState = { outputText: "", outputItems: [], usage: undefined };
  await consumeEventStreamBody(body, (chunk) => consumeCodexEventStreamChunk(chunk, state, callbacks));
  return codexEventStreamResult(state);
}

async function parseCodexEventStreamText(
  text: string,
  callbacks: ModelStreamCallbacks
): Promise<Record<string, unknown>> {
  const state: CodexEventStreamState = { outputText: "", outputItems: [], usage: undefined };
  await consumeEventStreamText(text, (chunk) => consumeCodexEventStreamChunk(chunk, state, callbacks));
  return codexEventStreamResult(state);
}

async function consumeCodexEventStreamChunk(
  chunk: string,
  state: CodexEventStreamState,
  callbacks: ModelStreamCallbacks
): Promise<void> {
  const dataLine = eventStreamData(chunk);
  if (!dataLine || dataLine === "[DONE]") {
    return;
  }
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(dataLine) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = stringValue(event.type);
  if (type === "response.output_text.delta") {
    const delta = stringValue(event.delta) ?? "";
    state.outputText += delta;
    await emitModelStreamDelta(callbacks.onMessageDelta, delta);
    return;
  }
  if (type === "response.output_text.done") {
    state.outputText = stringValue(event.text) ?? state.outputText;
    return;
  }
  if (type?.includes("reasoning") && type.endsWith(".delta")) {
    await emitModelStreamDelta(callbacks.onReasoningDelta, stringValue(event.delta) ?? stringValue(event.text) ?? "");
    return;
  }
  if (type === "response.output_item.done" && isRecord(event.item) && event.item.type === "function_call") {
    state.outputItems.push(event.item);
    return;
  }
  if (type === "response.completed" && isRecord(event.response)) {
    state.usage = event.response.usage;
  }
}

function codexEventStreamResult(state: CodexEventStreamState): Record<string, unknown> {
  return {
    output_text: state.outputText,
    output: state.outputItems,
    usage: state.usage
  };
}

interface ClaudeBlockState {
  type: "text" | "tool_use";
  id?: string;
  name?: string;
  text: string;
  inputJson: string;
}

interface ClaudeEventStreamState {
  blocks: Map<number, ClaudeBlockState>;
  usage: unknown;
}

async function parseClaudeEventStreamFromBody(
  body: ReadableStream<Uint8Array>,
  callbacks: ModelStreamCallbacks
): Promise<Record<string, unknown>> {
  const state: ClaudeEventStreamState = { blocks: new Map(), usage: undefined };
  await consumeEventStreamBody(body, (chunk) => consumeClaudeEventStreamChunk(chunk, state, callbacks));
  return claudeEventStreamResult(state);
}

async function parseClaudeEventStreamText(
  text: string,
  callbacks: ModelStreamCallbacks
): Promise<Record<string, unknown>> {
  const state: ClaudeEventStreamState = { blocks: new Map(), usage: undefined };
  await consumeEventStreamText(text, (chunk) => consumeClaudeEventStreamChunk(chunk, state, callbacks));
  return claudeEventStreamResult(state);
}

async function consumeClaudeEventStreamChunk(
  chunk: string,
  state: ClaudeEventStreamState,
  callbacks: ModelStreamCallbacks
): Promise<void> {
  const dataLine = eventStreamData(chunk);
  if (!dataLine || dataLine === "[DONE]") {
    return;
  }
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(dataLine) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = stringValue(event.type);
  const index = numberValue(event.index) ?? 0;
  if (type === "content_block_start" && isRecord(event.content_block)) {
    const block = event.content_block;
    const blockType = block.type === "tool_use" ? "tool_use" : "text";
    const text = stringValue(block.text) ?? "";
    state.blocks.set(index, {
      type: blockType,
      id: stringValue(block.id),
      name: stringValue(block.name),
      text,
      inputJson: ""
    });
    if (blockType === "text") {
      await emitModelStreamDelta(callbacks.onMessageDelta, text);
    }
    return;
  }
  if (type === "content_block_delta" && isRecord(event.delta)) {
    const delta = event.delta;
    const block = state.blocks.get(index) ?? { type: "text" as const, text: "", inputJson: "" };
    if (delta.type === "text_delta") {
      const text = stringValue(delta.text) ?? "";
      block.text += text;
      state.blocks.set(index, block);
      await emitModelStreamDelta(callbacks.onMessageDelta, text);
      return;
    }
    if (delta.type === "thinking_delta" || delta.type === "signature_delta") {
      await emitModelStreamDelta(callbacks.onReasoningDelta, stringValue(delta.thinking) ?? stringValue(delta.text) ?? "");
      return;
    }
    if (delta.type === "input_json_delta") {
      block.type = "tool_use";
      block.inputJson += stringValue(delta.partial_json) ?? "";
      state.blocks.set(index, block);
      return;
    }
  }
  if (type === "message_delta" && isRecord(event.delta)) {
    state.usage = event.delta.usage ?? state.usage;
  }
}

function claudeEventStreamResult(state: ClaudeEventStreamState): Record<string, unknown> {
  const content = [...state.blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) =>
      block.type === "tool_use"
        ? {
            type: "tool_use",
            id: block.id ?? block.name ?? "tool",
            name: block.name ?? "tool",
            input: parseJsonObject(block.inputJson || "{}")
          }
        : { type: "text", text: block.text }
    );
  return { content, usage: state.usage };
}

async function consumeEventStreamBody(
  body: ReadableStream<Uint8Array>,
  consume: (chunk: string) => Promise<void>
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    buffer = await consumeCompleteEventChunks(buffer, consume);
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    await consume(buffer);
  }
}

async function consumeEventStreamText(text: string, consume: (chunk: string) => Promise<void>): Promise<void> {
  for (const chunk of text.split(/\r?\n\r?\n+/)) {
    if (chunk.trim()) {
      await consume(chunk);
    }
  }
}

async function consumeCompleteEventChunks(
  buffer: string,
  consume: (chunk: string) => Promise<void>
): Promise<string> {
  let next = buffer;
  let match = /\r?\n\r?\n/.exec(next);
  while (match) {
    const chunk = next.slice(0, match.index);
    next = next.slice(match.index + match[0].length);
    if (chunk.trim()) {
      await consume(chunk);
    }
    match = /\r?\n\r?\n/.exec(next);
  }
  return next;
}

function eventStreamData(chunk: string): string | undefined {
  const data = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  return data.length ? data.join("\n") : undefined;
}

async function emitModelStreamDelta(callback: ModelStreamCallback | undefined, delta: string): Promise<void> {
  if (!delta || !callback) {
    return;
  }
  try {
    await callback(delta);
  } catch {
    // Streaming callbacks are display-only and must not fail model synthesis.
  }
}

function parseCodexResponse(json: Record<string, unknown>): ModelResponse {
  const output = Array.isArray(json.output) ? json.output : [];
  const usage = usageFromCodex(json.usage);
  const toolCalls: ModelToolCall[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "function_call") {
      continue;
    }
    const name = stringValue(item.name);
    if (!name) {
      continue;
    }
    toolCalls.push({
      id: stringValue(item.call_id) ?? stringValue(item.id) ?? name,
      name,
      input: parseJsonObject(stringValue(item.arguments) ?? "{}")
    });
  }
  if (toolCalls.length) {
    return { toolCalls, usage };
  }
  return {
    message: stringValue(json.output_text) ?? textFromOutput(output),
    usage
  };
}

function parseClaudeResponse(json: Record<string, unknown>): ModelResponse {
  const content = Array.isArray(json.content) ? json.content : [];
  const usage = usageFromClaude(json.usage);
  const toolCalls: ModelToolCall[] = [];
  const text: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "tool_use") {
      const name = stringValue(block.name);
      if (name) {
        toolCalls.push({
          id: stringValue(block.id) ?? name,
          name,
          input: block.input ?? {}
        });
      }
    }
    if (block.type === "text") {
      const value = stringValue(block.text);
      if (value) {
        text.push(value);
      }
    }
  }
  if (toolCalls.length) {
    return { toolCalls, usage };
  }
  return { message: text.join("\n"), usage };
}

function usageFromCodex(value: unknown): ModelResponse["usage"] {
  if (!isRecord(value)) {
    return undefined;
  }
  return compactUsage({
    promptTokens: numberValue(value.input_tokens) ?? numberValue(value.prompt_tokens),
    completionTokens: numberValue(value.output_tokens) ?? numberValue(value.completion_tokens)
  });
}

function usageFromClaude(value: unknown): ModelResponse["usage"] {
  if (!isRecord(value)) {
    return undefined;
  }
  return compactUsage({
    promptTokens: numberValue(value.input_tokens),
    completionTokens: numberValue(value.output_tokens)
  });
}

function compactUsage(usage: NonNullable<ModelResponse["usage"]>): ModelResponse["usage"] {
  if (!usage.promptTokens && !usage.completionTokens) {
    return undefined;
  }
  return usage;
}

function textFromOutput(output: unknown[]): string | undefined {
  const text: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const block of content) {
      if (isRecord(block)) {
        const value = stringValue(block.text) ?? stringValue(block.output_text);
        if (value) {
          text.push(value);
        }
      }
    }
  }
  return text.length ? text.join("\n") : undefined;
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function objectRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function expiresAtFromSeconds(value: unknown): string | undefined {
  const seconds = numberValue(value);
  if (seconds === undefined) {
    return undefined;
  }
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function expiresAtFromMilliseconds(value: unknown): string | undefined {
  const milliseconds = numberValue(value);
  if (milliseconds === undefined) {
    return undefined;
  }
  return new Date(milliseconds).toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
