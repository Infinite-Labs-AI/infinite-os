import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { mirrorMachineHomeEnv } from "./mirror-machine-home-env.js";

function parseDotEnv(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return result;
}

describe("mirrorMachineHomeEnv", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes the 4 keys into the machine-home .env with 0600 perms", () => {
    const projectGrowthDir = join(tmpDir, "project", ".growth-os");
    const machineHome = join(tmpDir, "machine-home");
    mkdirSync(projectGrowthDir, { recursive: true });

    mirrorMachineHomeEnv(
      projectGrowthDir,
      {
        DATABASE_URL: "postgres://localhost/test",
        GROWTH_OS_ENCRYPTION_KEY: "key123",
        GROWTH_OS_READ_TOKEN: "read-tok",
        GROWTH_OS_OPERATOR_TOKEN: "op-tok"
      },
      { GROWTH_OS_HOME: machineHome }
    );

    const envPath = join(machineHome, ".env");
    expect(existsSync(envPath)).toBe(true);

    const mode = statSync(envPath).mode & 0o777;
    expect(mode).toBe(0o600);

    const parsed = parseDotEnv(readFileSync(envPath, "utf8"));
    expect(parsed.DATABASE_URL).toBe("postgres://localhost/test");
    expect(parsed.GROWTH_OS_ENCRYPTION_KEY).toBe("key123");
    expect(parsed.GROWTH_OS_READ_TOKEN).toBe("read-tok");
    expect(parsed.GROWTH_OS_OPERATOR_TOKEN).toBe("op-tok");
  });

  it("preserves unrelated keys already in the machine-home .env", () => {
    const projectGrowthDir = join(tmpDir, "project", ".growth-os");
    const machineHome = join(tmpDir, "machine-home");
    mkdirSync(projectGrowthDir, { recursive: true });
    mkdirSync(machineHome, { recursive: true });
    writeFileSync(
      join(machineHome, ".env"),
      "UNRELATED_KEY=keep-me\nGROWTH_OS_READ_TOKEN=old-token\n",
      { mode: 0o600 }
    );

    mirrorMachineHomeEnv(
      projectGrowthDir,
      {
        DATABASE_URL: "postgres://localhost/test",
        GROWTH_OS_ENCRYPTION_KEY: "key123",
        GROWTH_OS_READ_TOKEN: "new-token",
        GROWTH_OS_OPERATOR_TOKEN: "op-tok"
      },
      { GROWTH_OS_HOME: machineHome }
    );

    const parsed = parseDotEnv(readFileSync(join(machineHome, ".env"), "utf8"));
    // Unrelated key must survive.
    expect(parsed.UNRELATED_KEY).toBe("keep-me");
    // The 4 mirror keys must be updated.
    expect(parsed.GROWTH_OS_READ_TOKEN).toBe("new-token");
    expect(parsed.DATABASE_URL).toBe("postgres://localhost/test");
  });

  it("is a no-op when project growthDir and machine home resolve to the same path", () => {
    const sharedDir = join(tmpDir, "shared");
    mkdirSync(sharedDir, { recursive: true });

    // Should not throw and should not create a .env
    mirrorMachineHomeEnv(
      sharedDir,
      { DATABASE_URL: "postgres://localhost/test" },
      { GROWTH_OS_HOME: sharedDir }
    );

    expect(existsSync(join(sharedDir, ".env"))).toBe(false);
  });

  it("creates the machine-home directory if it does not exist", () => {
    const projectGrowthDir = join(tmpDir, "proj", ".growth-os");
    const machineHome = join(tmpDir, "nonexistent", "machine-home");
    mkdirSync(projectGrowthDir, { recursive: true });

    mirrorMachineHomeEnv(
      projectGrowthDir,
      { DATABASE_URL: "postgres://localhost/test", GROWTH_OS_ENCRYPTION_KEY: "k" },
      { GROWTH_OS_HOME: machineHome }
    );

    expect(existsSync(join(machineHome, ".env"))).toBe(true);
  });

  // FIX A1: conflict guard tests
  it("throws when DATABASE_URL already exists in machine-home .env with a different value", () => {
    const projectGrowthDir = join(tmpDir, "project", ".growth-os");
    const machineHome = join(tmpDir, "machine-home");
    mkdirSync(projectGrowthDir, { recursive: true });
    mkdirSync(machineHome, { recursive: true });
    writeFileSync(
      join(machineHome, ".env"),
      "DATABASE_URL=postgres://localhost/original-db\nGROWTH_OS_ENCRYPTION_KEY=original-key\n",
      { mode: 0o600 }
    );

    expect(() =>
      mirrorMachineHomeEnv(
        projectGrowthDir,
        {
          DATABASE_URL: "postgres://localhost/different-db",
          GROWTH_OS_ENCRYPTION_KEY: "original-key",
          GROWTH_OS_READ_TOKEN: "tok",
          GROWTH_OS_OPERATOR_TOKEN: "op"
        },
        { GROWTH_OS_HOME: machineHome }
      )
    ).toThrow(/conflict on DATABASE_URL/);
  });

  it("throws when GROWTH_OS_ENCRYPTION_KEY already exists with a different value", () => {
    const projectGrowthDir = join(tmpDir, "project", ".growth-os");
    const machineHome = join(tmpDir, "machine-home");
    mkdirSync(projectGrowthDir, { recursive: true });
    mkdirSync(machineHome, { recursive: true });
    writeFileSync(
      join(machineHome, ".env"),
      "DATABASE_URL=postgres://localhost/db\nGROWTH_OS_ENCRYPTION_KEY=original-key\n",
      { mode: 0o600 }
    );

    expect(() =>
      mirrorMachineHomeEnv(
        projectGrowthDir,
        {
          DATABASE_URL: "postgres://localhost/db",
          GROWTH_OS_ENCRYPTION_KEY: "different-key"
        },
        { GROWTH_OS_HOME: machineHome }
      )
    ).toThrow(/conflict on GROWTH_OS_ENCRYPTION_KEY/);
  });

  it("does not throw when DATABASE_URL matches the existing machine-home value", () => {
    const projectGrowthDir = join(tmpDir, "project", ".growth-os");
    const machineHome = join(tmpDir, "machine-home");
    mkdirSync(projectGrowthDir, { recursive: true });
    mkdirSync(machineHome, { recursive: true });
    writeFileSync(
      join(machineHome, ".env"),
      "DATABASE_URL=postgres://localhost/same-db\n",
      { mode: 0o600 }
    );

    expect(() =>
      mirrorMachineHomeEnv(
        projectGrowthDir,
        { DATABASE_URL: "postgres://localhost/same-db" },
        { GROWTH_OS_HOME: machineHome }
      )
    ).not.toThrow();
  });

  // FIX A3: host-reachability filter tests
  it("does NOT mirror DATABASE_URL when the host is a docker-internal service name", () => {
    const projectGrowthDir = join(tmpDir, "project", ".growth-os");
    const machineHome = join(tmpDir, "machine-home");
    mkdirSync(projectGrowthDir, { recursive: true });

    mirrorMachineHomeEnv(
      projectGrowthDir,
      {
        DATABASE_URL: "postgres://growth_os:secret@postgres:5432/growth_os",
        GROWTH_OS_ENCRYPTION_KEY: "enc-key",
        GROWTH_OS_READ_TOKEN: "read-tok",
        GROWTH_OS_OPERATOR_TOKEN: "op-tok"
      },
      { GROWTH_OS_HOME: machineHome }
    );

    const parsed = parseDotEnv(readFileSync(join(machineHome, ".env"), "utf8"));
    // DATABASE_URL with docker-internal host must be withheld.
    expect(parsed.DATABASE_URL).toBeUndefined();
    // Tokens and encryption key must still be mirrored.
    expect(parsed.GROWTH_OS_ENCRYPTION_KEY).toBe("enc-key");
    expect(parsed.GROWTH_OS_READ_TOKEN).toBe("read-tok");
    expect(parsed.GROWTH_OS_OPERATOR_TOKEN).toBe("op-tok");
  });

  it("mirrors DATABASE_URL when the host is localhost", () => {
    const projectGrowthDir = join(tmpDir, "project", ".growth-os");
    const machineHome = join(tmpDir, "machine-home");
    mkdirSync(projectGrowthDir, { recursive: true });

    mirrorMachineHomeEnv(
      projectGrowthDir,
      {
        DATABASE_URL: "postgres://growth_os:secret@localhost:5432/growth_os",
        GROWTH_OS_ENCRYPTION_KEY: "enc-key"
      },
      { GROWTH_OS_HOME: machineHome }
    );

    const parsed = parseDotEnv(readFileSync(join(machineHome, ".env"), "utf8"));
    expect(parsed.DATABASE_URL).toBe("postgres://growth_os:secret@localhost:5432/growth_os");
  });

  // FIX A2: atomic write — no .tmp file left behind
  it("leaves no .tmp file behind after a successful write", () => {
    const projectGrowthDir = join(tmpDir, "project", ".growth-os");
    const machineHome = join(tmpDir, "machine-home");
    mkdirSync(projectGrowthDir, { recursive: true });

    mirrorMachineHomeEnv(
      projectGrowthDir,
      { DATABASE_URL: "postgres://localhost/test", GROWTH_OS_ENCRYPTION_KEY: "k" },
      { GROWTH_OS_HOME: machineHome }
    );

    const tmpFiles = readdirSync(machineHome).filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toEqual([]);
  });
});
