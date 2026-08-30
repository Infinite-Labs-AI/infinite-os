import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
const ptyDriver = "python3";
const desktopCapabilities = [
  "status.v1",
  "turn.ndjson.v1",
  "confirm.v1",
  "contacts.import.v1"
];

// The bundle is an artifact of `pnpm -r build` + `pnpm --filter infinite-os build:bundle`; without
// the workspace dist present (@infinite-os/* resolve to dist/) it cannot be produced. Skip rather
// than fail in environments where the prerequisite build has not run.
const workspaceBuilt = existsSync(
  join(cliRoot, "..", "..", "packages", "core", "dist", "index.js")
);
const hasPtyDriver =
  spawnSync(ptyDriver, ["--version"], { encoding: "utf8" }).status === 0;

const pythonPtyDriver = String.raw`
import errno
import os
import pty
import selectors
import sys

cmd = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(cmd[0], cmd, os.environ)

selector = selectors.DefaultSelector()
selector.register(sys.stdin, selectors.EVENT_READ, "stdin")
selector.register(fd, selectors.EVENT_READ, "pty")
status = None
stdin_open = True
pty_open = True

while True:
    try:
        finished_pid, maybe_status = os.waitpid(pid, os.WNOHANG)
        if finished_pid == pid:
            status = maybe_status
            break
    except ChildProcessError:
        break

    for key, _ in selector.select(0.05):
        if key.data == "stdin":
            try:
                data = os.read(sys.stdin.fileno(), 4096)
            except OSError:
                data = b""
            if data:
                os.write(fd, data)
            elif stdin_open:
                stdin_open = False
                selector.unregister(sys.stdin)
        else:
            try:
                data = os.read(fd, 4096)
            except OSError as error:
                if error.errno not in (errno.EIO, errno.EBADF):
                    raise
                data = b""
            if data:
                os.write(sys.stdout.fileno(), data)
            elif pty_open:
                pty_open = False
                selector.unregister(fd)

while True:
    try:
        data = os.read(fd, 4096)
    except OSError as error:
        if error.errno in (errno.EIO, errno.EBADF):
            break
        raise
    if not data:
        break
    os.write(sys.stdout.fileno(), data)

try:
    os.close(fd)
except OSError:
    pass

if status is None:
    status = os.waitpid(pid, 0)[1]
if os.WIFEXITED(status):
    sys.exit(os.WEXITSTATUS(status))
if os.WIFSIGNALED(status):
    sys.exit(128 + os.WTERMSIG(status))
sys.exit(1)
`;

function buildBundle(): void {
  const build = spawnSync(process.execPath, [bundleScript], {
    cwd: cliRoot,
    encoding: "utf8",
    timeout: 120_000
  });
  expect(build.status, build.stderr).toBe(0);
  expect(existsSync(bundlePath)).toBe(true);
}

function writeDesktopState(growthHome: string, state: string): void {
  const bridgeDirectory = join(growthHome, "desktop-cmdl");
  mkdirSync(bridgeDirectory, { recursive: true, mode: 0o700 });
  chmodSync(bridgeDirectory, 0o700);
  writeFileSync(join(bridgeDirectory, "state.json"), JSON.stringify({ state }));
}

function writeDesktopBridge(growthHome: string, url: string): void {
  const bridgeDirectory = join(growthHome, "desktop-cmdl");
  mkdirSync(bridgeDirectory, { recursive: true, mode: 0o700 });
  chmodSync(bridgeDirectory, 0o700);
  const descriptorPath = join(bridgeDirectory, "bridge.json");
  writeFileSync(
    descriptorPath,
    JSON.stringify({
      schemaVersion: 1,
      service: "infinite-desktop-cmdl",
      protocol: { min: 1, max: 1 },
      capabilities: desktopCapabilities,
      url,
      pid: process.pid,
      bootId: "boot-bundle-process",
      desktopVersion: "0.3.20",
      runtime: { variant: "prod", stateLabel: "Infinite" },
      token: "owner-only-token",
      startedAt: "2026-08-30T12:00:00.000Z"
    }),
    { mode: 0o600 }
  );
  chmodSync(descriptorPath, 0o600);
}

async function createStatusServer(ready: () => boolean): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer((request, response) => {
    if (
      request.method === "GET" &&
      request.url === "/v1/status" &&
      request.headers.authorization === "Bearer owner-only-token"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          service: "infinite-desktop-cmdl",
          bootId: "boot-bundle-process",
          protocol: { min: 1, max: 1 },
          capabilities: desktopCapabilities,
          ready: ready(),
          contextRevision: "ctx-bundle-process",
          workspace: { id: "workspace_123", name: "Acme" },
          ...(ready()
            ? {}
            : {
                error: {
                  code: "desktop_not_ready",
                  message: "Infinite Desktop Cmd+L is not ready."
                }
              })
        })
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("status server did not bind to a TCP port");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function createFakeDesktopFixture(): {
  root: string;
  userHome: string;
  growthHome: string;
  fakeBin: string;
  openLogPath: string;
  markerPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "infinite-cli-bundle-process-"));
  const userHome = join(root, "user");
  const growthHome = join(userHome, ".growth-os");
  const appPath = join(userHome, "Applications", "Infinite.app");
  const fakeBin = join(root, "bin");
  const openLogPath = join(root, "open.log");
  const markerPath = join(appPath, "installed.marker");
  mkdirSync(appPath, { recursive: true });
  mkdirSync(growthHome, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(markerPath, "installed\n");
  const openPath = join(fakeBin, "open");
  writeFileSync(
    openPath,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(openLogPath)}\nexit 0\n`
  );
  chmodSync(openPath, 0o755);
  return { root, userHome, growthHome, fakeBin, openLogPath, markerPath };
}

function spawnBundlePty(
  fixture: ReturnType<typeof createFakeDesktopFixture>
): {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => string;
  isClosed: () => boolean;
} {
  const chunks: string[] = [];
  let didClose = false;
  const child = spawn(
    ptyDriver,
    ["-c", pythonPtyDriver, process.execPath, bundlePath],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        GROWTH_OS_HOME: fixture.growthHome,
        HOME: fixture.userHome,
        INFINITE_RENDER_SURFACE: "raw",
        PATH: `${fixture.fakeBin}:${process.env.PATH ?? ""}`
      },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveClose) => {
    child.on("close", (code, signal) => {
      didClose = true;
      resolveClose({ code, signal });
    });
  });
  return {
    child,
    closed,
    output: () => chunks.join(""),
    isClosed: () => didClose
  };
}

async function waitUntil(
  predicate: () => boolean,
  describeWait: () => string,
  timeoutMs = 5_000
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${describeWait()}`);
}

describe.runIf(workspaceBuilt)("CLI single-file bundle", () => {
  it("builds infinite.mjs via the build:bundle script", () => {
    buildBundle();
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

describe.runIf(workspaceBuilt && process.platform === "darwin" && hasPtyDriver)(
  "CLI bundle onboarding process",
  () => {
    it("keeps the process alive across delayed onboarding polls and reaches the ready shell", async () => {
      buildBundle();
      let bridgeReady = false;
      const fixture = createFakeDesktopFixture();
      const statusServer = await createStatusServer(() => bridgeReady);
      writeDesktopBridge(fixture.growthHome, statusServer.url);
      const run = spawnBundlePty(fixture);

      try {
        await waitUntil(
          () => run.output().includes("Waiting for Infinite") || run.isClosed(),
          () => run.output()
        );
        expect(run.output()).toContain("Waiting for Infinite");
        expect(run.isClosed()).toBe(false);

        await delay(1_100);
        expect(run.isClosed()).toBe(false);

        bridgeReady = true;
        writeDesktopState(fixture.growthHome, "ready");
        await waitUntil(
          () => run.output().includes("Infinite is ready") || run.isClosed(),
          () => run.output()
        );
        expect(run.output()).toContain("Infinite is ready");
        run.child.stdin.write("/exit\r");
        const result = await run.closed;
        expect(result).toEqual({ code: 0, signal: null });
        expect(readFileSync(fixture.openLogPath, "utf8")).toContain(
          "infinite://onboarding"
        );
      } finally {
        if (!run.isClosed()) run.child.kill("SIGTERM");
        await closeServer(statusServer.server);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, 20_000);

    it("maps Ctrl-C during onboarding wait to exit 130 and leaves the installed app fixture untouched", async () => {
      const fixture = createFakeDesktopFixture();
      const statusServer = await createStatusServer(() => false);
      writeDesktopBridge(fixture.growthHome, statusServer.url);
      const run = spawnBundlePty(fixture);

      try {
        await waitUntil(
          () => run.output().includes("Waiting for Infinite") || run.isClosed(),
          () => run.output()
        );
        expect(run.output()).toContain("Waiting for Infinite");
        expect(run.isClosed()).toBe(false);
        run.child.stdin.write("\x03");
        const result = await run.closed;
        expect(result).toEqual({ code: 130, signal: null });
        expect(existsSync(fixture.markerPath)).toBe(true);
        expect(readFileSync(fixture.openLogPath, "utf8")).toContain(
          "infinite://onboarding"
        );
      } finally {
        if (!run.isClosed()) run.child.kill("SIGTERM");
        await closeServer(statusServer.server);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, 20_000);
  }
);
