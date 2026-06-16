import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  NoActiveProjectError,
  clearActiveProjectId,
  clearDefaultProjectId,
  markMigrationNoticeShown,
  readDefaultProjectId,
  readMigrationNoticeShown,
  writeDefaultProjectId,
  infiniteOsAuthPath,
  infiniteOsHome,
  infiniteOsStatePath,
  loadInfiniteOsConfig,
  parseDotEnv,
  parseSimpleYaml,
  readActiveProjectId,
  readInfiniteOsAuthState,
  readInfiniteOsModelSelection,
  writeActiveProjectId,
  writeInfiniteOsAuthRecord,
  writeInfiniteOsModelSelection
} from "../src/index.js";

describe("Infinite OS config loading", () => {
  it("parses dotenv and simple yaml files", () => {
    expect(parseDotEnv("DATABASE_URL=postgres://x\nNAME='value'\n")).toEqual({
      DATABASE_URL: "postgres://x",
      NAME: "value"
    });
    expect(parseSimpleYaml("workspace_root: /tmp/example\napp_port: 3001\n")).toEqual({
      workspace_root: "/tmp/example",
      app_port: "3001"
    });
  });

  it("loads config with process env taking precedence over local files", ({ task }) => {
    const root = join("/tmp", `growth-os-config-${task.id}`);
    mkdirSync(join(root, ".growth-os"), { recursive: true });
    writeFileSync(
      join(root, ".growth-os", "config.yml"),
      "runtime_mode: network\napp_port: 3001\n"
    );
    writeFileSync(
      join(root, ".growth-os", ".env"),
      [
        "DATABASE_URL=postgres://file",
        "GROWTH_OS_ENCRYPTION_KEY=file-key",
        "GROWTH_OS_READ_TOKEN=file-read",
        "GROWTH_OS_OPERATOR_TOKEN=file-operator"
      ].join("\n")
    );

    const config = loadInfiniteOsConfig({
      workspaceRoot: root,
      env: {
        DATABASE_URL: "postgres://process",
        GROWTH_OS_OPERATOR_TOKEN: "process-operator"
      }
    });

    expect(config.databaseUrl).toBe("postgres://process");
    expect(config.operatorToken).toBe("process-operator");
    expect(config.readToken).toBe("file-read");
    expect(config.appPort).toBe(3001);
  });

  it("rejects connector secrets in .growth-os/.env", ({ task }) => {
    const root = join("/tmp", `growth-os-config-bad-${task.id}`);
    mkdirSync(join(root, ".growth-os"), { recursive: true });
    writeFileSync(
      join(root, ".growth-os", ".env"),
      "POSTHOG_API_KEY=should-not-live-here\n"
    );

    expect(() =>
      loadInfiniteOsConfig({
        workspaceRoot: root,
        env: {
          DATABASE_URL: "postgres://process",
          GROWTH_OS_ENCRYPTION_KEY: "key"
        }
      })
    ).toThrow(/deployment secrets/);
  });

  it("rejects user-level model auth keys in project .growth-os/config.yml", ({ task }) => {
    const root = join("/tmp", `growth-os-config-user-level-${task.id}`);
    mkdirSync(join(root, ".growth-os"), { recursive: true });
    writeFileSync(
      join(root, ".growth-os", "config.yml"),
      "runtime_mode: local\nmodel_provider: claude\n"
    );

    expect(() =>
      loadInfiniteOsConfig({
        workspaceRoot: root,
        env: {
          DATABASE_URL: "postgres://process",
          GROWTH_OS_ENCRYPTION_KEY: "key"
        }
      })
    ).toThrow(/belongs in user-level GROWTH_OS_HOME state/);

    writeFileSync(
      join(root, ".growth-os", "config.yml"),
      "runtime_mode: local\nANTHROPIC_API_KEY: sk-ant-secret\n"
    );

    expect(() =>
      loadInfiniteOsConfig({
        workspaceRoot: root,
        env: {
          DATABASE_URL: "postgres://process",
          GROWTH_OS_ENCRYPTION_KEY: "key"
        }
      })
    ).toThrow(/belongs in user-level GROWTH_OS_HOME state/);
  });

  it("requires distinct read and operator tokens in network mode", () => {
    expect(() =>
      loadInfiniteOsConfig({
        env: {
          DATABASE_URL: "postgres://process",
          GROWTH_OS_ENCRYPTION_KEY: "key",
          GROWTH_OS_RUNTIME_MODE: "network",
          GROWTH_OS_READ_TOKEN: "same",
          GROWTH_OS_OPERATOR_TOKEN: "same"
        }
      })
    ).toThrow(/must differ/);
  });

  it("keeps model auth and selection state in user-level GROWTH_OS_HOME", ({ task }) => {
    const growthHome = join("/tmp", `growth-os-user-home-${task.id}`);
    const env = { GROWTH_OS_HOME: growthHome };

    expect(infiniteOsHome(env)).toBe(growthHome);
    expect(infiniteOsAuthPath(env)).toBe(join(growthHome, "auth.json"));

    const result = writeInfiniteOsModelSelection(
      { provider: "codex", model: "gpt-5.4" },
      env
    );

    expect(result.path).toBe(join(growthHome, "config.yml"));
    expect(readFileSync(result.path, "utf8")).toContain("model_provider: codex");
    expect(readInfiniteOsModelSelection(env)).toEqual({
      provider: "codex",
      model: "gpt-5.4"
    });
  });

  it("falls back to HOME when GROWTH_OS_HOME is not set", ({ task }) => {
    const home = join("/tmp", `growth-os-home-fallback-${task.id}`);
    const env = { HOME: home };

    expect(infiniteOsHome(env)).toBe(join(home, ".growth-os"));
    expect(infiniteOsAuthPath(env)).toBe(join(home, ".growth-os", "auth.json"));

    const result = writeInfiniteOsModelSelection(
      { provider: "claude", model: "claude-sonnet-4-5" },
      env
    );

    expect(result.path).toBe(join(home, ".growth-os", "config.yml"));
    expect(readInfiniteOsModelSelection(env)).toEqual({
      provider: "claude",
      model: "claude-sonnet-4-5"
    });
  });

  it("allows explicit process model overrides without mutating user-level config", ({ task }) => {
    const growthHome = join("/tmp", `growth-os-user-home-override-${task.id}`);
    const env = { GROWTH_OS_HOME: growthHome };

    const result = writeInfiniteOsModelSelection(
      { provider: "codex", model: "gpt-5.4" },
      env
    );
    const overridden = readInfiniteOsModelSelection({
      ...env,
      GROWTH_OS_MODEL_PROVIDER: "claude",
      GROWTH_OS_MODEL_NAME: "claude-sonnet-4-5"
    });

    expect(overridden).toEqual({
      provider: "claude",
      model: "claude-sonnet-4-5"
    });
    expect(readFileSync(result.path, "utf8")).toContain("model_provider: codex");
  });

  it("stores login-backed auth records in user-level auth.json with private permissions", ({ task }) => {
    const growthHome = join("/tmp", `growth-os-auth-home-${task.id}`);
    const env = { GROWTH_OS_HOME: growthHome };

    const result = writeInfiniteOsAuthRecord(
      {
        provider: "codex",
        source: "codex-cli",
        authMode: "device-code",
        token: "secret-token",
        refreshToken: "secret-refresh",
        expiresAt: "2026-06-03T12:00:00.000Z"
      },
      env
    );

    expect(result.path).toBe(join(growthHome, "auth.json"));
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(readInfiniteOsAuthState(env)).toMatchObject({
      providers: {
        codex: {
          provider: "codex",
          source: "codex-cli",
          authMode: "device-code",
          token: "secret-token",
          refreshToken: "secret-refresh"
        }
      }
    });
  });
});

describe("active project pointer", () => {
  it("round-trips activeProjectId through state.json", () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-state-"));
    const env = { GROWTH_OS_HOME: growthHome } as NodeJS.ProcessEnv;
    expect(readActiveProjectId(env)).toBeUndefined();
    writeActiveProjectId("proj_abc123", env);
    expect(readActiveProjectId(env)).toBe("proj_abc123");
    expect(infiniteOsStatePath(env)).toBe(join(growthHome, "state.json"));
    clearActiveProjectId(env);
    expect(readActiveProjectId(env)).toBeUndefined();
  });

  it("returns undefined (never throws) on corrupt state.json", () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-state-corrupt-"));
    const env = { GROWTH_OS_HOME: growthHome } as NodeJS.ProcessEnv;
    mkdirSync(growthHome, { recursive: true });
    writeFileSync(join(growthHome, "state.json"), "{ not json");
    expect(readActiveProjectId(env)).toBeUndefined();
  });

  it("NoActiveProjectError is throwable and identifiable", () => {
    const err = new NoActiveProjectError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NoActiveProjectError");
  });
});

describe("default project + merge-preserving state writes", () => {
  function freshEnv(prefix: string): NodeJS.ProcessEnv {
    const growthHome = mkdtempSync(join(tmpdir(), prefix));
    return { GROWTH_OS_HOME: growthHome } as NodeJS.ProcessEnv;
  }

  it("round-trips defaultProjectId through state.json", () => {
    const env = freshEnv("growth-os-default-");
    expect(readDefaultProjectId(env)).toBeUndefined();
    writeDefaultProjectId("proj_default1", env);
    expect(readDefaultProjectId(env)).toBe("proj_default1");
    clearDefaultProjectId(env);
    expect(readDefaultProjectId(env)).toBeUndefined();
  });

  it("writeActiveProjectId preserves an existing defaultProjectId (no clobber)", () => {
    const env = freshEnv("growth-os-merge-");
    writeDefaultProjectId("proj_default", env);
    writeActiveProjectId("proj_active", env);
    expect(readActiveProjectId(env)).toBe("proj_active");
    expect(readDefaultProjectId(env)).toBe("proj_default");
    // The reverse direction also preserves the sibling key.
    writeDefaultProjectId("proj_default2", env);
    expect(readActiveProjectId(env)).toBe("proj_active");
    expect(readDefaultProjectId(env)).toBe("proj_default2");
  });

  it("clearActiveProjectId keeps defaultProjectId and vice-versa", () => {
    const env = freshEnv("growth-os-clear-");
    writeActiveProjectId("proj_active", env);
    writeDefaultProjectId("proj_default", env);
    clearActiveProjectId(env);
    expect(readActiveProjectId(env)).toBeUndefined();
    expect(readDefaultProjectId(env)).toBe("proj_default");
    clearDefaultProjectId(env);
    expect(readDefaultProjectId(env)).toBeUndefined();
    expect(readActiveProjectId(env)).toBeUndefined();
  });

  it("tolerates a legacy activeProjectId and does NOT auto-promote it to a default", () => {
    const env = freshEnv("growth-os-legacy-");
    const home = env.GROWTH_OS_HOME as string;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "state.json"), JSON.stringify({ activeProjectId: "proj_legacy" }));
    expect(readActiveProjectId(env)).toBe("proj_legacy");
    expect(readDefaultProjectId(env)).toBeUndefined();
  });

  it("migration-notice latch is one-shot and preserves sibling keys", () => {
    const env = freshEnv("growth-os-latch-");
    writeActiveProjectId("proj_legacy", env);
    expect(readMigrationNoticeShown(env)).toBe(false);
    markMigrationNoticeShown(env);
    expect(readMigrationNoticeShown(env)).toBe(true);
    // The latch write must not have clobbered the active pointer.
    expect(readActiveProjectId(env)).toBe("proj_legacy");
  });
});
