import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type InfiniteOsRuntimeMode = "local" | "network";

export interface InfiniteOsConfig {
  workspaceRoot: string;
  runtimeMode: InfiniteOsRuntimeMode;
  databaseUrl: string;
  encryptionKey: string;
  readToken?: string;
  operatorToken?: string;
  appHost: string;
  appPort: number;
}

const DEPLOYMENT_SECRET_KEYS = new Set([
  "DATABASE_URL",
  "GROWTH_OS_ENCRYPTION_KEY",
  "GROWTH_OS_READ_TOKEN",
  "GROWTH_OS_OPERATOR_TOKEN",
  "GROWTH_OS_APP_HOST",
  "GROWTH_OS_APP_PORT",
  "GROWTH_OS_WORKSPACE_ROOT",
  "GROWTH_OS_RUNTIME_MODE"
]);

const USER_LEVEL_MODEL_AUTH_KEYS = new Set([
  "model_provider",
  "model_name",
  "auth_provider",
  "auth_mode",
  "GROWTH_OS_MODEL_PROVIDER",
  "GROWTH_OS_MODEL_NAME",
  "GROWTH_OS_HOME",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN"
]);

export function parseDotEnv(input: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
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

export function parseSimpleYaml(input: string): Record<string, string> {
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

export function loadInfiniteOsConfig(options: {
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
} = {}): InfiniteOsConfig {
  const env = options.env ?? process.env;
  const workspaceRoot = resolve(
    env.GROWTH_OS_WORKSPACE_ROOT ??
      options.workspaceRoot ??
      env.PWD ??
      process.cwd()
  );
  const growthDir = join(workspaceRoot, ".growth-os");
  const envFile = join(growthDir, ".env");
  const configFile = join(growthDir, "config.yml");

  const fileEnv = existsSync(envFile) ? parseDotEnv(readFileSync(envFile, "utf8")) : {};
  assertDeploymentEnvOnly(fileEnv, envFile);
  const fileConfig = existsSync(configFile)
    ? parseSimpleYaml(readFileSync(configFile, "utf8"))
    : {};
  assertNoUserLevelModelAuthKeys(fileConfig, configFile);

  const merged: Record<string, string | undefined> = {
    appHost: "127.0.0.1",
    appPort: "3000",
    runtimeMode: "local",
    ...normalizeConfigKeys(fileConfig),
    ...fileEnv,
    ...env
  };

  const runtimeMode = normalizeRuntimeMode(merged.GROWTH_OS_RUNTIME_MODE);
  const databaseUrl = requireString(merged.DATABASE_URL, "DATABASE_URL");
  const encryptionKey = requireString(
    merged.GROWTH_OS_ENCRYPTION_KEY,
    "GROWTH_OS_ENCRYPTION_KEY"
  );
  const readToken = merged.GROWTH_OS_READ_TOKEN;
  const operatorToken = merged.GROWTH_OS_OPERATOR_TOKEN;

  if (runtimeMode === "network") {
    requireString(readToken, "GROWTH_OS_READ_TOKEN");
    requireString(operatorToken, "GROWTH_OS_OPERATOR_TOKEN");
  }
  if (readToken && operatorToken && readToken === operatorToken) {
    throw new Error("GROWTH_OS_READ_TOKEN must differ from GROWTH_OS_OPERATOR_TOKEN");
  }

  return {
    workspaceRoot,
    runtimeMode,
    databaseUrl,
    encryptionKey,
    readToken,
    operatorToken,
    appHost: String(merged.GROWTH_OS_APP_HOST ?? merged.appHost ?? "127.0.0.1"),
    appPort: Number(merged.GROWTH_OS_APP_PORT ?? merged.appPort ?? 3000)
  };
}

function normalizeConfigKeys(values: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    switch (key) {
      case "workspace_root":
        normalized.GROWTH_OS_WORKSPACE_ROOT = value;
        break;
      case "runtime_mode":
        normalized.GROWTH_OS_RUNTIME_MODE = value;
        break;
      case "app_host":
        normalized.GROWTH_OS_APP_HOST = value;
        break;
      case "app_port":
        normalized.GROWTH_OS_APP_PORT = value;
        break;
      default:
        normalized[key] = value;
    }
  }
  return normalized;
}

function assertDeploymentEnvOnly(values: Record<string, string>, path: string): void {
  for (const key of Object.keys(values)) {
    if (!DEPLOYMENT_SECRET_KEYS.has(key)) {
      throw new Error(
        `${path} may only contain Infinite OS deployment secrets; found ${key}`
      );
    }
  }
}

function assertNoUserLevelModelAuthKeys(values: Record<string, string>, path: string): void {
  for (const key of Object.keys(values)) {
    if (USER_LEVEL_MODEL_AUTH_KEYS.has(key)) {
      throw new Error(
        `${path} is project-local runtime config; ${key} belongs in user-level GROWTH_OS_HOME state`
      );
    }
  }
}

function normalizeRuntimeMode(value: unknown): InfiniteOsRuntimeMode {
  if (value === "network") {
    return "network";
  }
  return "local";
}

function requireString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} is required`);
  }
  return value;
}

export * from "./growth-os-home.js";
export * from "./workspace-id.js";
export * from "./active-project.js";
