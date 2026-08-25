import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface EmbeddedGa4OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface ResolveEmbeddedGa4OAuthClientOptions {
  env: {
    GROWTH_OS_GA4_OAUTH_CLIENT_ID?: string;
    GROWTH_OS_GA4_OAUTH_CLIENT_SECRET?: string;
  };
  /** Reads a release-injected (gitignored) client config; returns null if absent. */
  readReleaseConfig: () => EmbeddedGa4OAuthClient | null;
}

export function resolveEmbeddedGa4OAuthClient(
  options: ResolveEmbeddedGa4OAuthClientOptions
): EmbeddedGa4OAuthClient | null {
  const envId = options.env.GROWTH_OS_GA4_OAUTH_CLIENT_ID?.trim();
  const envSecret = options.env.GROWTH_OS_GA4_OAUTH_CLIENT_SECRET?.trim();
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret };
  }
  const release = options.readReleaseConfig();
  if (release?.clientId && release?.clientSecret) {
    return { clientId: release.clientId, clientSecret: release.clientSecret };
  }
  return null;
}

/**
 * Reads a release-injected GA4 OAuth client config from a gitignored JSON file.
 * The file path comes from GROWTH_OS_GA4_OAUTH_CLIENT_FILE env var, or defaults
 * to ~/.infinite/app/ga4-oauth-client.json (alongside the distribution).
 * Returns null on missing file or parse error — never throws.
 */
export function readReleaseGa4OAuthClient(): EmbeddedGa4OAuthClient | null {
  const filePath =
    process.env.GROWTH_OS_GA4_OAUTH_CLIENT_FILE ??
    join(homedir(), ".infinite", "app", "ga4-oauth-client.json");
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "clientId" in parsed &&
      "clientSecret" in parsed &&
      typeof (parsed as Record<string, unknown>).clientId === "string" &&
      typeof (parsed as Record<string, unknown>).clientSecret === "string"
    ) {
      return {
        clientId: (parsed as Record<string, string>).clientId,
        clientSecret: (parsed as Record<string, string>).clientSecret
      };
    }
    return null;
  } catch {
    return null;
  }
}
