import {
  readInfiniteOsAuthState,
  writeInfiniteOsAuthRecord,
  type InfiniteOsAuthRecord
} from "@infinite-os/config";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_CODEX_REFRESH_URL = "https://auth.openai.com/oauth/token";

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REFRESH_SKEW_MS = 120_000;

export interface CodexRuntimeCredentials {
  token: string;
  auth?: InfiniteOsAuthRecord;
  source: string;
  authMode?: string;
}

export interface ResolveCodexRuntimeCredentialsOptions {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  forceRefresh?: boolean;
}

export async function resolveCodexRuntimeCredentials(
  options: ResolveCodexRuntimeCredentialsOptions
): Promise<CodexRuntimeCredentials | null> {
  const auth = readInfiniteOsAuthState(options.env).providers.codex;
  if (auth?.token) {
    if (auth.refreshToken && (options.forceRefresh || shouldRefreshCodexToken(auth))) {
      const refreshed = await refreshCodexAuth(auth, options.env, options.fetch);
      if (refreshed?.token) {
        return {
          token: refreshed.token,
          auth: refreshed,
          source: refreshed.source,
          authMode: refreshed.authMode
        };
      }
    }
    return {
      token: auth.token,
      auth,
      source: auth.source,
      authMode: auth.authMode
    };
  }
  if (options.env.OPENAI_API_KEY) {
    return {
      token: options.env.OPENAI_API_KEY,
      source: "openai-api-key-dev-fallback",
      authMode: "api-key"
    };
  }
  const imported = codexImportCandidate(options.env);
  if (imported?.token) {
    return {
      token: imported.token,
      auth: imported.refreshToken
        ? {
            provider: "codex",
            source: imported.path,
            authMode: imported.authMode ?? "import",
            token: imported.token,
            refreshToken: imported.refreshToken,
            expiresAt: imported.expiresAt
          }
        : undefined,
      source: imported.path,
      authMode: imported.authMode
    };
  }
  return null;
}

export async function refreshCodexAuth(
  auth: InfiniteOsAuthRecord,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<InfiniteOsAuthRecord | null> {
  if (!auth.refreshToken) {
    return null;
  }
  const refreshUrl = env.GROWTH_OS_CODEX_REFRESH_URL ?? DEFAULT_CODEX_REFRESH_URL;
  const response = await fetchImpl(refreshUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
      client_id: CODEX_OAUTH_CLIENT_ID
    }).toString()
  });
  if (!response.ok) {
    return null;
  }
  const json = (await response.json()) as Record<string, unknown>;
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
    expiresAt: stringValue(json.expires_at) ?? stringValue(json.expiresAt) ?? auth.expiresAt
  };
  writeInfiniteOsAuthRecord(refreshed, env);
  return refreshed;
}

function shouldRefreshCodexToken(auth: InfiniteOsAuthRecord): boolean {
  const expiresAt = auth.expiresAt ? Date.parse(auth.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAt)) {
    return false;
  }
  return expiresAt - Date.now() <= CODEX_REFRESH_SKEW_MS;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function codexImportCandidate(
  env: NodeJS.ProcessEnv
): ({ path: string } & { token?: string; refreshToken?: string; expiresAt?: string; authMode?: string }) | null {
  const home = env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir();
  const candidates = [
    ...(env.CODEX_HOME ? [join(env.CODEX_HOME, "auth.json")] : []),
    join(home, ".codex", "auth.json")
  ];
  const source = candidates.find((path) => existsSync(path));
  if (!source) {
    return null;
  }
  return {
    path: source,
    ...readCodexTokens(source)
  };
}

function readCodexTokens(path: string): { token?: string; refreshToken?: string; expiresAt?: string; authMode?: string } {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const tokens = (parsed.tokens ?? parsed) as Record<string, unknown>;
  return {
    token: stringValue(tokens.access_token) ?? stringValue(tokens.accessToken) ?? stringValue(tokens.token),
    refreshToken: stringValue(tokens.refresh_token) ?? stringValue(tokens.refreshToken) ?? stringValue(tokens.refresh),
    expiresAt: stringValue(tokens.expires_at) ?? stringValue(tokens.expiresAt),
    authMode: stringValue(parsed.auth_mode) ?? stringValue(parsed.authMode)
  };
}
