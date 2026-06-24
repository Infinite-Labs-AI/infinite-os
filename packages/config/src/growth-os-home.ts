import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type InfiniteOsModelProvider = "codex" | "claude";

export interface InfiniteOsModelSelection {
  provider?: InfiniteOsModelProvider;
  model?: string;
}

export interface InfiniteOsAuthRecord {
  provider: InfiniteOsModelProvider;
  source: string;
  authMode: string;
  token?: string;
  refreshToken?: string;
  expiresAt?: string;
  importedAt?: string;
}

export interface InfiniteOsAuthState {
  // Known MODEL providers (codex/claude) are typed; arbitrary sibling keys are
  // carried opaquely so the engine never clobbers records it does not own — e.g.
  // the desktop's `supabase` session written to the same ~/.growth-os/auth.json.
  // The `& Record<string, unknown>` collapses to InfiniteOsAuthRecord|undefined
  // for the known keys (named or computed by InfiniteOsModelProvider) and yields
  // `unknown` for everything else.
  providers: Partial<Record<InfiniteOsModelProvider, InfiniteOsAuthRecord>> & Record<string, unknown>;
  updatedAt?: string;
}

export function infiniteOsHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GROWTH_OS_HOME && env.GROWTH_OS_HOME.trim() !== "") {
    return resolve(env.GROWTH_OS_HOME);
  }
  const home = env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir();
  return resolve(home, ".growth-os");
}

export function infiniteOsAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(infiniteOsHome(env), "auth.json");
}

export function infiniteOsUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(infiniteOsHome(env), "config.yml");
}

export function readInfiniteOsModelSelection(env: NodeJS.ProcessEnv = process.env): InfiniteOsModelSelection {
  const envProvider = env.GROWTH_OS_MODEL_PROVIDER;
  const envModel = env.GROWTH_OS_MODEL_NAME;
  if ((envProvider === "codex" || envProvider === "claude") && envModel) {
    return {
      provider: envProvider,
      model: envModel
    };
  }

  const path = infiniteOsUserConfigPath(env);
  if (!existsSync(path)) {
    return {};
  }
  const values = parseUserConfigYaml(readFileSync(path, "utf8"));
  const provider = values.model_provider;
  return {
    provider: provider === "codex" || provider === "claude" ? provider : undefined,
    model: values.model_name
  };
}

function parseUserConfigYaml(input: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of input.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    if (!withoutComment.trim() || /^\s/.test(withoutComment)) {
      continue;
    }
    const separator = withoutComment.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = withoutComment.slice(0, separator).trim();
    let value = withoutComment.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function writeInfiniteOsModelSelection(
  selection: Required<InfiniteOsModelSelection>,
  env: NodeJS.ProcessEnv = process.env
): { ok: true; path: string; provider: InfiniteOsModelProvider; model: string } {
  const home = infiniteOsHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = infiniteOsUserConfigPath(env);
  writeFileSync(path, `model_provider: ${selection.provider}\nmodel_name: ${selection.model}\n`, {
    mode: 0o600
  });
  chmodSync(path, 0o600);
  return { ok: true, path, provider: selection.provider, model: selection.model };
}

export function readInfiniteOsAuthSummary(env: NodeJS.ProcessEnv = process.env): {
  authPath: string;
  hasInfiniteOsAuth: boolean;
  providers: Array<{
    provider: InfiniteOsModelProvider;
    source: string;
    authMode: string;
    expiresAt: string | null;
    hasToken: boolean;
    hasRefreshToken: boolean;
  }>;
} {
  const authPath = infiniteOsAuthPath(env);
  const state = readInfiniteOsAuthState(env);
  return {
    authPath,
    hasInfiniteOsAuth: existsSync(authPath),
    // Only surface the known MODEL providers — opaque passthrough siblings (e.g.
    // a desktop `supabase` record) must never leak into model-auth status.
    providers: (["codex", "claude"] as const)
      .map((provider) => state.providers[provider])
      .filter((record): record is InfiniteOsAuthRecord => Boolean(record))
      .map((record) => ({
        provider: record.provider,
        source: record.source,
        authMode: record.authMode,
        expiresAt: record.expiresAt ?? null,
        hasToken: Boolean(record.token),
        hasRefreshToken: Boolean(record.refreshToken)
      }))
  };
}

export function readInfiniteOsAuthState(env: NodeJS.ProcessEnv = process.env): InfiniteOsAuthState {
  const path = infiniteOsAuthPath(env);
  if (!existsSync(path)) {
    return { providers: {} };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<InfiniteOsAuthState>;
  return sanitizeAuthState(parsed);
}

export function writeInfiniteOsAuthRecord(
  record: InfiniteOsAuthRecord,
  env: NodeJS.ProcessEnv = process.env
): { ok: true; path: string; provider: InfiniteOsModelProvider; source: string; authMode: string } {
  const home = infiniteOsHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = infiniteOsAuthPath(env);
  const state = readInfiniteOsAuthState(env);
  const next: InfiniteOsAuthState = {
    providers: {
      ...state.providers,
      [record.provider]: {
        ...record,
        importedAt: record.importedAt ?? new Date().toISOString()
      }
    },
    updatedAt: new Date().toISOString()
  };
  writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return {
    ok: true,
    path,
    provider: record.provider,
    source: record.source,
    authMode: record.authMode
  };
}

function sanitizeAuthState(input: Partial<InfiniteOsAuthState>): InfiniteOsAuthState {
  // Preserve EVERY provider key untouched (opaque passthrough) so the engine
  // never clobbers records it does not own — e.g. the desktop's `supabase`
  // session in the same ~/.growth-os/auth.json (the writer lives in the closed
  // desktop repo). Only the known MODEL providers (codex/claude) are
  // re-sanitized into the typed InfiniteOsAuthRecord shape; a missing or
  // malformed codex/claude record is dropped (not passed through).
  const rawProviders = (input.providers ?? {}) as Record<string, unknown>;
  const providers: Record<string, unknown> = { ...rawProviders };
  for (const provider of ["codex", "claude"] as const) {
    const record = rawProviders[provider];
    if (!isModelAuthRecord(record, provider)) {
      delete providers[provider];
      continue;
    }
    providers[provider] = {
      provider,
      source: String(record.source ?? "unknown"),
      authMode: String(record.authMode ?? "unknown"),
      token: typeof record.token === "string" ? record.token : undefined,
      refreshToken: typeof record.refreshToken === "string" ? record.refreshToken : undefined,
      expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : undefined,
      importedAt: typeof record.importedAt === "string" ? record.importedAt : undefined
    };
  }
  return {
    providers: providers as InfiniteOsAuthState["providers"],
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : undefined
  };
}

function isModelAuthRecord(
  value: unknown,
  provider: InfiniteOsModelProvider
): value is InfiniteOsAuthRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { provider?: unknown }).provider === provider
  );
}
