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
    await logCodexRefreshFailure(response);
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

// Last-resort recovery when a stored refresh fails: the user may have
// re-authenticated the upstream `codex` CLI out of band, which rewrites
// ~/.codex/auth.json with a fresh token. Re-read that file UNCONDITIONALLY
// (resolveCodexRuntimeCredentials only consults it when the store is empty), and
// if it now carries a DIFFERENT token than the one that just failed, persist it
// into the Infinite OS store and return it so the caller can retry. Returns null
// when ~/.codex is absent, tokenless, or unchanged.
export function reloadFreshlyRefreshedCodexImport(
  env: NodeJS.ProcessEnv,
  previousToken?: string
): InfiniteOsAuthRecord | null {
  const imported = codexImportCandidate(env);
  if (!imported?.token) {
    return null;
  }
  if (previousToken && imported.token === previousToken) {
    return null;
  }
  // Don't adopt an already-expired ~/.codex token: a stale ~/.codex (older than
  // the store) must not clobber a newer record with a dead token. Opaque
  // (non-JWT) tokens have no readable exp — adopt them and let the server judge.
  const importedExpiresAt = codexTokenExpiryMs(imported.token);
  if (importedExpiresAt !== undefined && importedExpiresAt <= Date.now()) {
    return null;
  }
  const record: InfiniteOsAuthRecord = {
    provider: "codex",
    source: imported.path,
    authMode: imported.authMode ?? "codex-cli-import",
    token: imported.token,
    refreshToken: imported.refreshToken,
    expiresAt: imported.expiresAt
  };
  writeInfiniteOsAuthRecord(record, env);
  return record;
}

// Surface (never swallow) a non-2xx from the OAuth token endpoint so a failed
// refresh is debuggable instead of a silent dead-end. Logs ONLY the HTTP status
// and the OAuth `error` / `error_description` fields — never the refresh_token,
// access_token, or request body (data-safety: error codes, not secrets).
async function logCodexRefreshFailure(response: Response): Promise<void> {
  let detail = "";
  try {
    const json = (await response.json()) as Record<string, unknown>;
    detail = [stringValue(json.error), stringValue(json.error_description)]
      .filter(Boolean)
      .join(": ");
  } catch {
    detail = "";
  }
  console.warn(
    `[codex-auth] token refresh failed: ${response.status}${detail ? ` ${detail}` : ""}`
  );
}

function shouldRefreshCodexToken(auth: InfiniteOsAuthRecord): boolean {
  const expiresAtMs = codexExpiresAtMs(auth);
  if (expiresAtMs === undefined) {
    return false;
  }
  return expiresAtMs - Date.now() <= CODEX_REFRESH_SKEW_MS;
}

// Resolve the access-token expiry in epoch-ms. Prefer the stored ISO `expiresAt`,
// but the upstream `codex` CLI writes `last_refresh` (not `expires_at`) into
// ~/.codex/auth.json, so an imported record usually has no string expiry. Fall
// back to the access-token JWT's `exp` claim so pre-emptive refresh still fires
// for imported credentials instead of waiting for a 401.
function codexExpiresAtMs(auth: InfiniteOsAuthRecord): number | undefined {
  const stored = auth.expiresAt ? Date.parse(auth.expiresAt) : Number.NaN;
  if (Number.isFinite(stored)) {
    return stored;
  }
  return codexTokenExpiryMs(auth.token);
}

// Decode the `exp` claim (seconds since epoch) from a Codex OAuth access token (a
// JWT). Non-JWT/opaque tokens are tolerated — return undefined so the caller
// falls back to reactive (401-driven) refresh rather than throwing.
function codexTokenExpiryMs(token: string | undefined): number | undefined {
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
    const exp = claims.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
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
