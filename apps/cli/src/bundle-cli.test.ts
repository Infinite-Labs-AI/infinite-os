import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Verifies the single-file CLI bundle the desktop app ships (RUNTIME CONTRACT: the installed
// `infinite` command runs `node <resourcesPath>/cli/infinite.mjs "$@"`). Builds the bundle from the
// build:bundle script, then spawns it under plain Node exactly as the desktop would.
const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, ".."); // apps/cli
const bundleScript = join(cliRoot, "scripts", "bundle-cli.mjs");
const bundlePath = join(cliRoot, "dist", "bundle", "infinite.mjs");
const buildInfoPath = join(cliRoot, "dist", "bundle", "BUILD_INFO.json");
const migrationsDirPath = join(cliRoot, "dist", "bundle", "migrations");
const repoRoot = join(cliRoot, "..", "..");

// The bundle is an artifact of `pnpm -r build` + `pnpm --filter infinite-os build:bundle`; without
// the workspace dist present (@infinite-os/* resolve to dist/) it cannot be produced. Skip rather
// than fail in environments where the prerequisite build has not run.
const workspaceBuilt = existsSync(
  join(cliRoot, "..", "..", "packages", "core", "dist", "index.js")
);

describe.runIf(workspaceBuilt)("CLI single-file bundle", () => {
  it("builds infinite.mjs via the build:bundle script", () => {
    const build = spawnSync(process.execPath, [bundleScript], {
      cwd: cliRoot,
      encoding: "utf8",
      timeout: 120_000
    });
    expect(build.status, build.stderr).toBe(0);
    expect(existsSync(bundlePath)).toBe(true);
  }, 120_000);

  it("ships the migrations sidecar next to the bundle", () => {
    // `infinite setup runtime --mode external_postgres|supabase` → runRuntimeMigrations →
    // runMigrations → loadMigrations() reads the .sql files at run time via readdirSync, resolving
    // migrationsDir()'s `join(<bundleDir>, "migrations")` candidate. Without this sidecar the
    // advertised subcommand hard-crashes with ENOENT on a machine with no engine checkout. Mirror the
    // daemon bundle (apps/app/scripts/bundle.mjs).
    expect(existsSync(migrationsDirPath)).toBe(true);
    const sql = readdirSync(migrationsDirPath).filter((f) =>
      f.endsWith(".sql")
    );
    expect(sql.length).toBeGreaterThan(0);
  }, 120_000);

  it("stamps the root engine source version into BUILD_INFO.json", () => {
    const rootVersion = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8")
    ).version;
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8")) as {
      engineVersion?: string;
    };
    expect(buildInfo.engineVersion).toBe(rootVersion);
  });

  it("reports stamped version and commit after relocation outside the repository", () => {
    const relocated = mkdtempSync(join(tmpdir(), "infinite-cli-relocated-"));
    try {
      cpSync(bundlePath, join(relocated, "infinite.mjs"));
      cpSync(buildInfoPath, join(relocated, "BUILD_INFO.json"));
      if (existsSync(migrationsDirPath)) {
        cpSync(migrationsDirPath, join(relocated, "migrations"), {
          recursive: true
        });
      }
      const bundledNodeModules = join(
        cliRoot,
        "dist",
        "bundle",
        "node_modules"
      );
      if (existsSync(bundledNodeModules)) {
        cpSync(bundledNodeModules, join(relocated, "node_modules"), {
          recursive: true
        });
      }
      const rootVersion = JSON.parse(
        readFileSync(join(repoRoot, "package.json"), "utf8")
      ).version as string;
      const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8")) as {
        engineCommit: string;
        engineDirty: boolean;
      };
      const run = spawnSync(
        process.execPath,
        [join(relocated, "infinite.mjs"), "--version"],
        {
          cwd: relocated,
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            GROWTH_OS_CODE_VERSION: "ffffffffffffffffffffffffffffffffffffffff"
          }
        }
      );
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe(
        `Infinite OS ${rootVersion} (${buildInfo.engineCommit.slice(0, 7)}${
          buildInfo.engineDirty ? "-dirty" : ""
        })`
      );
    } finally {
      rmSync(relocated, { recursive: true, force: true });
    }
  }, 60_000);

  it("the shipped sidecar is loadable by loadMigrations() — the exact runtime path", async () => {
    // Reproduces the original ENOENT regression. At runtime, `infinite setup runtime` →
    // runRuntimeMigrations → runMigrations → loadMigrations() calls readdirSync on
    // migrationsDir()'s `join(<bundleDir>, "migrations")` candidate. Point loadMigrations() at the
    // bundle's sidecar dir exactly as the resolved candidate would, and assert it reads real .sql
    // migrations instead of throwing "ENOENT: no such file or directory, scandir".
    const { loadMigrations } = await import("@infinite-os/db");
    const migrations = loadMigrations(migrationsDirPath);
    expect(migrations.length).toBeGreaterThan(0);
    expect(
      migrations.every((m) => m.id.endsWith(".sql") && m.sql.length > 0)
    ).toBe(true);
  }, 120_000);

  it("runs under plain Node and prints the PRODUCT help surface for --help", () => {
    const run = spawnSync(process.execPath, [bundlePath, "--help"], {
      encoding: "utf8",
      timeout: 60_000,
      // Match the desktop's non-TTY invocation.
      stdio: ["ignore", "pipe", "pipe"]
    });
    expect(run.status, run.stderr).toBe(0);
    // Top-level help is the Desktop product surface, never the raw engine list.
    expect(run.stdout).toContain('infinite "message"');
    expect(run.stdout).toContain("npx infinite-os@latest");
    expect(run.stdout).toContain("infinite://onboarding");
    expect(run.stdout).not.toMatch(
      /trial|infinite local|docker|self-host|local engine/i
    );
    expect(run.stdout).not.toContain("Connect data:");
  }, 60_000);

  it("keeps the developer engine reachable only when local is explicit", () => {
    const run = spawnSync(process.execPath, [bundlePath, "local", "help"], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Connect data:");
    expect(run.stdout).toContain("infinite local connect x");
  }, 60_000);

  it("a non-TTY one-shot exits with product guidance for the host platform, never a crash or local turn", () => {
    const run = spawnSync(process.execPath, [bundlePath, "ping-no-project"], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      // Point config discovery at an empty dir so this never touches a real user's setup.
      env: { ...process.env, HOME: join(cliRoot, "dist", "bundle") }
    });
    // §6.6 step 7: a product one-shot with no live Desktop bridge must exit
    // non-zero with Desktop onboarding/recovery guidance on macOS. On Linux CI,
    // the same real bundled child must take the product unsupported-platform
    // route instead of trying to simulate macOS.
    // What must never happen is an unhandled throw, a module-resolution failure
    // (e.g. a missing sidecar), a bare stack trace — or a silent local turn.
    const combined = `${run.stdout}${run.stderr}`;
    expect(run.signal).toBeNull(); // not killed / no segfault
    expect(run.status).not.toBe(0);
    if (process.platform === "darwin") {
      expect(combined).toContain("npx infinite-os@latest");
      expect(combined).toContain("infinite://onboarding");
    } else {
      expect(combined).toContain("Apple-silicon Mac with macOS 12 or newer");
      expect(combined).toContain("No command was run.");
    }
    expect(combined).not.toMatch(
      /trial|infinite local|docker|self-host|local engine/i
    );
    expect(combined).not.toMatch(/Cannot find (module|package)|Error \[ERR_/);
    expect(combined).not.toMatch(/^\s+at .+\(.*:\d+:\d+\)/m); // no raw stack trace
  }, 60_000);
});
