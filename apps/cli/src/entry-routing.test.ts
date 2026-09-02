import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ANALYTICS_ONBOARDING_PROMPT, runCli, runInteractiveEntry } from "./index.js";
import type { OnboardingDeps } from "./desktop/onboarding.js";

// ── §6.6 canonical entry routing (Phase 3) ───────────────────────────────────
// The `infinite` entry dispatch, in order: (1) normalize aliases + detect
// explicit `local`; (2) product help/version + Desktop-oriented `update`;
// (3) reserved local-command interception + top-level `--project` rejection;
// (4) live-bridge probe; (5) ready bridge serves TTY AND non-TTY turns;
// (6) interactive mac with no bridge → onboarding; (7) non-TTY/non-mac with no
// bridge → exit non-zero with guidance; (8) NEVER fall through to local unless
// `local` was explicit.

interface CapturedRun {
  stdout: string;
  stderr: string;
  /** process.exitCode observed after the run (0 when left unset). */
  code: number;
  /** true when any Desktop bridge endpoint (`/v1/*`) was contacted. */
  sentToBridge: boolean;
  /** true when a `/v1/turn` was sent (the message became a turn). */
  sentTurn: boolean;
}

interface RunCliCapturedOptions {
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

const UNSUPPORTED_PRODUCT_PLATFORM =
  "Infinite Desktop and its Terminal companion require an Apple-silicon Mac with macOS 12 or newer. No command was run.\n";
const DESKTOP_SERVICE = "infinite-desktop-cmdl";
const DESKTOP_CAPABILITIES = [
  "status.v1",
  "turn.ndjson.v1",
  "confirm.v1",
  "contacts.import.v1"
];
const mutableFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");

function forceTty(value: boolean): () => void {
  const targets: Array<NodeJS.ReadStream | NodeJS.WriteStream> = [
    process.stdin,
    process.stdout
  ];
  const originals = targets.map((target) =>
    Object.getOwnPropertyDescriptor(target, "isTTY")
  );
  for (const target of targets) {
    Object.defineProperty(target, "isTTY", { configurable: true, value });
  }
  return () => {
    targets.forEach((target, index) => {
      const original = originals[index];
      if (original) {
        Object.defineProperty(target, "isTTY", original);
      } else {
        delete (target as { isTTY?: boolean }).isTTY;
      }
    });
  };
}

function forcePlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value });
  return () => {
    if (original) {
      Object.defineProperty(process, "platform", original);
    }
  };
}

async function runCliCaptured(
  args: string[],
  env: Record<string, string> = {},
  options: RunCliCapturedOptions = {}
): Promise<CapturedRun> {
  const growthHome = mkdtempSync(join(tmpdir(), "growth-os-entry-routing-"));
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    });
  const fetchSpy = vi.fn(
    options.fetchImpl ??
      (async (_input: string | URL | Request) =>
      new Response("{}", { status: 200 })
      )
  );
  vi.stubGlobal("fetch", fetchSpy);
  const priorExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    await runCli(args, { GROWTH_OS_HOME: growthHome, ...env });
    return {
      stdout: stdoutWrites.join(""),
      stderr: stderrWrites.join(""),
      code: typeof process.exitCode === "number" ? process.exitCode : 0,
      sentToBridge: fetchSpy.mock.calls.some(([url]) =>
        String(url).includes("/v1/")
      ),
      sentTurn: fetchSpy.mock.calls.some(([url]) =>
        String(url).endsWith("/v1/turn")
      )
    };
  } finally {
    process.exitCode = priorExitCode;
    vi.unstubAllGlobals();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    rmSync(growthHome, { recursive: true, force: true });
  }
}

function createCanonicalDesktopHome() {
  const root = mkdtempSync(join(tmpdir(), "growth-os-contacts-routing-"));
  const userHome = join(root, "user");
  const growthHome = join(userHome, ".growth-os");
  mkdirSync(growthHome, { recursive: true });
  return {
    root,
    userHome,
    growthHome,
    env: { HOME: userHome, GROWTH_OS_HOME: growthHome }
  };
}

function createFakeDesktopApp(userHome: string): string {
  const appPath = join(userHome, "Applications", "Infinite.app");
  mkdirSync(appPath, { recursive: true });
  return appPath;
}

function createFakeOpen(root: string, exitStatus = 0) {
  const bin = join(root, "bin");
  const logPath = join(root, "open.log");
  const openPath = join(bin, "open");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    openPath,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(logPath)}\nexit ${exitStatus}\n`
  );
  chmodSync(openPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  return {
    logPath,
    restore: () => {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  };
}

function writeDesktopBridge(
  growthHome: string,
  overrides: Record<string, unknown> = {}
): void {
  const bridgeDirectory = join(growthHome, "desktop-cmdl");
  const descriptorPath = join(bridgeDirectory, "bridge.json");
  mkdirSync(bridgeDirectory, { recursive: true, mode: 0o700 });
  chmodSync(bridgeDirectory, 0o700);
  writeFileSync(
    descriptorPath,
    JSON.stringify({
      schemaVersion: 1,
      service: DESKTOP_SERVICE,
      protocol: { min: 1, max: 1 },
      capabilities: DESKTOP_CAPABILITIES,
      url: "http://127.0.0.1:54321",
      pid: 12345,
      bootId: "boot-contacts-routing",
      desktopVersion: "0.3.15",
      runtime: { variant: "prod", stateLabel: "Infinite" },
      token: "owner-only-bearer-token",
      startedAt: "2026-08-30T12:00:00.000Z",
      ...overrides
    }),
    { mode: 0o600 }
  );
  chmodSync(descriptorPath, 0o600);
}

function writeDesktopState(growthHome: string, state: string): void {
  const bridgeDirectory = join(growthHome, "desktop-cmdl");
  mkdirSync(bridgeDirectory, { recursive: true, mode: 0o700 });
  chmodSync(bridgeDirectory, 0o700);
  writeFileSync(join(bridgeDirectory, "state.json"), JSON.stringify({ state }));
}

function desktopStatusResponse(
  ready: boolean,
  bootId = "boot-contacts-routing"
): Response {
  return new Response(
    JSON.stringify({
      service: DESKTOP_SERVICE,
      bootId,
      protocol: { min: 1, max: 1 },
      capabilities: DESKTOP_CAPABILITIES,
      ready,
      contextRevision: "ctx-contacts-routing",
      workspace: { id: "workspace_123", name: "Acme" }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

async function readyDesktopFetch(
  bootId: string,
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const url = String(input);
  if (url.endsWith("/v1/status")) {
    return desktopStatusResponse(true, bootId);
  }
  if (url.endsWith("/v1/turn")) {
    const request = JSON.parse(String(init?.body ?? "{}")) as {
      requestId?: string;
    };
    return new Response(
      `${JSON.stringify({
        protocolVersion: 1,
        requestId: request.requestId,
        sequence: 1,
        kind: "done",
        data: {
          message: "answer from Desktop",
          actionCalls: []
        }
      })}\n`,
      {
        status: 200,
        headers: { "content-type": "application/x-ndjson" }
      }
    );
  }
  return new Response("{}", {
    status: 404,
    headers: { "content-type": "application/json" }
  });
}

function assertNoCustomerFallbackCopy(text: string): void {
  expect(text).not.toMatch(/trial|infinite local|local engine|Docker|self[- ]host/i);
}

const NOT_READY_STATES = [
  ["missing", null],
  ["signed_out", "signed_out"],
  ["no_provider", "no_provider"],
  ["no_workspace", "no_workspace"],
  ["subscription_required", "subscription_required"]
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("canonical entry routing (§6.6)", () => {
  it("a reserved command prints Desktop guidance and does NOT become a turn", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("darwin");
    try {
      const { stdout, code, sentToBridge } = await runCliCaptured(["sources"]);
      expect(stdout).toContain("Infinite Desktop");
      expect(stdout).not.toMatch(
        /infinite local|docker|self-host|local engine/i
      );
      expect(sentToBridge).toBe(false);
      expect(code).not.toBe(0);
    } finally {
      restorePlatform();
      restoreTty();
    }
  });

  it("a reserved command keeps its arguments in the Desktop guidance", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("darwin");
    try {
      const { stdout, code, sentToBridge } = await runCliCaptured([
        "setup",
        "resume",
        "r123"
      ]);
      expect(stdout).toContain("setup resume r123");
      expect(stdout).toContain("Infinite Desktop");
      expect(sentToBridge).toBe(false);
      expect(code).not.toBe(0);
    } finally {
      restorePlatform();
      restoreTty();
    }
  });

  it("rejects a top-level --project", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("darwin");
    try {
      const { code, stderr, sentToBridge } = await runCliCaptured([
        "--project",
        "x",
        "hello"
      ]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("Desktop's active workspace");
      expect(stderr).not.toMatch(
        /infinite local|docker|self-host|local engine/i
      );
      expect(sentToBridge).toBe(false);
    } finally {
      restorePlatform();
      restoreTty();
    }
  });

  it("product help prints the product surface, not the raw engine", async () => {
    const { stdout, code, sentToBridge } = await runCliCaptured(["help"]);
    expect(stdout).toContain("⌘L");
    expect(stdout).toContain("infinite://onboarding");
    expect(stdout).not.toContain("docker");
    expect(stdout).not.toContain("Connect data:");
    expect(code).toBe(0);
    expect(sentToBridge).toBe(false);
  });

  it("--help is a product-help alias", async () => {
    const { stdout, code } = await runCliCaptured(["--help"]);
    expect(stdout).toContain("npx infinite-os@latest");
    expect(stdout).not.toContain("Connect data:");
    expect(code).toBe(0);
  });

  it("version prints and exits clean", async () => {
    const { stdout, code, sentToBridge } = await runCliCaptured(["version"]);
    expect(stdout).toContain("Infinite OS");
    expect(code).toBe(0);
    expect(sentToBridge).toBe(false);
  });

  // The critical Phase-3 fix: Phase 2 left `routeOneShotMessage` degrading an
  // `onboarding` verdict to a LOCAL chat turn. A non-TTY one-shot with no live
  // bridge must now exit non-zero with guidance — never a local product turn.
  it("non-TTY one-shot with no live bridge exits non-zero with guidance, never local chat", async () => {
    const restoreTty = forceTty(false);
    const restorePlatform = forcePlatform("darwin");
    try {
      const { stdout, code, sentTurn } = await runCliCaptured(
        ["How", "much", "revenue", "this", "month?"],
        {
          GROWTH_OS_WORKSPACE_ID: "proj_test",
          GROWTH_OS_CLI_NONINTERACTIVE: "1"
        }
      );
      expect(code).not.toBe(0);
      expect(stdout).toContain("infinite://onboarding");
      expect(stdout).toContain("npx infinite-os@latest");
      // No silent local product turn: local chat's setup guidance never renders.
      expect(stdout).not.toContain("Infinite is not set up yet.");
      expect(sentTurn).toBe(false);
    } finally {
      restorePlatform();
      restoreTty();
    }
  });

  it("non-mac one-shot with no live bridge exits non-zero with guidance, never local chat", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("linux");
    try {
      const { stdout, stderr, code, sentTurn } = await runCliCaptured(
        ["How", "much", "revenue", "this", "month?"],
        {
          GROWTH_OS_WORKSPACE_ID: "proj_test",
          GROWTH_OS_CLI_NONINTERACTIVE: "1"
        }
      );
      expect(code).not.toBe(0);
      expect(`${stdout}${stderr}`).toBe(UNSUPPORTED_PRODUCT_PLATFORM);
      expect(stdout).not.toContain("Infinite is not set up yet.");
      expect(sentTurn).toBe(false);
    } finally {
      restorePlatform();
      restoreTty();
    }
  });

  // Top-level product routing is Desktop-only. A configured local default is
  // intentionally ignored here; only the explicit `infinite local` namespace
  // may enter the developer engine lane.
  it("non-mac bare `infinite` with no explicit opt-in exits non-zero with guidance, never a local session", async () => {
    const restoreTty = forceTty(false);
    const restorePlatform = forcePlatform("linux");
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "growth-os-entry-baremode-")
    );
    try {
      const { stdout, stderr, code, sentTurn } = await runCliCaptured([], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_CLI_NONINTERACTIVE: "1"
      });
      expect(code).not.toBe(0);
      expect(stderr).toBe(UNSUPPORTED_PRODUCT_PLATFORM);
      // The local session must never open: in noninteractive mode its
      // readiness preflight would have rendered the local setup guidance.
      expect(stdout).not.toContain("Infinite is not set up yet.");
      expect(sentTurn).toBe(false);
    } finally {
      restorePlatform();
      restoreTty();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("non-mac bare `infinite` with GROWTH_OS_DEFAULT_TARGET=local remains unsupported", async () => {
    const restoreTty = forceTty(false);
    const restorePlatform = forcePlatform("linux");
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "growth-os-entry-barelocal-")
    );
    try {
      const { stdout, stderr, code, sentTurn } = await runCliCaptured([], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_DEFAULT_TARGET: "local",
        GROWTH_OS_CLI_NONINTERACTIVE: "1"
      });
      expect(code).not.toBe(0);
      expect(stderr).toBe(UNSUPPORTED_PRODUCT_PLATFORM);
      expect(stdout).not.toContain("Infinite is not set up yet.");
      expect(sentTurn).toBe(false);
    } finally {
      restorePlatform();
      restoreTty();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  // ── Task 3.2: engine commands live ONLY under `infinite local` ─────────────
  // (`infinite local setup` running the real wizard is proven in index.test.ts:
  //  "prints parseable JSON for local setup --json".)

  it("product update points at Desktop updating, not the git stack", async () => {
    const nonGitRoot = mkdtempSync(join(tmpdir(), "growth-os-product-update-"));
    try {
      const { stdout, code, sentToBridge } = await runCliCaptured(["update"], {
        GROWTH_OS_WORKSPACE_ROOT: nonGitRoot
      });
      expect(stdout).toMatch(/Infinite.*update/i);
      expect(stdout).toContain("Infinite Desktop");
      expect(stdout).toContain("⌘L");
      expect(stdout).not.toMatch(
        /infinite local|docker|self-host|local engine/i
      );
      // Never the git/local-stack updater: none of its envelope fields render.
      expect(stdout).not.toContain("not_a_git_install");
      expect(stdout).not.toContain("pulled");
      expect(code).toBe(0);
      expect(sentToBridge).toBe(false);
    } finally {
      rmSync(nonGitRoot, { recursive: true, force: true });
    }
  });

  it("infinite local update keeps the git-stack behavior", async () => {
    const nonGitRoot = mkdtempSync(join(tmpdir(), "growth-os-local-update-"));
    try {
      // Same non-git root: the LOCAL lane reaches runUpdateCommand, whose
      // git-install probe reports this isn't a git install — proof the git
      // updater (not the Desktop shim text) handled it.
      const { stdout, code } = await runCliCaptured(["local", "update"], {
        GROWTH_OS_WORKSPACE_ROOT: nonGitRoot
      });
      expect(stdout).toContain("git install");
      expect(stdout).not.toContain("Infinite Desktop");
      expect(code).toBe(0);
    } finally {
      rmSync(nonGitRoot, { recursive: true, force: true });
    }
  });

  it("infinite local help prints the full engine surface", async () => {
    const { stdout, code } = await runCliCaptured(["local", "help"], {
      GROWTH_OS_WORKSPACE_ID: "proj_test",
      GROWTH_OS_CLI_NONINTERACTIVE: "1"
    });
    expect(stdout).toContain("Connect data:");
    expect(stdout).toContain("sources");
    expect(code).toBe(0);
  });

  it("a config local target cannot route a product one-shot into the local pipeline", async () => {
    const restoreTty = forceTty(false);
    const restorePlatform = forcePlatform("darwin");
    const growthHome = mkdtempSync(
      join(tmpdir(), "growth-os-entry-config-local-")
    );
    try {
      const { stdout, code, sentTurn } = await runCliCaptured(
        ["hello", "there"],
        {
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_DEFAULT_TARGET: "local",
          GROWTH_OS_CLI_NONINTERACTIVE: "1"
        }
      );
      expect(code).not.toBe(0);
      expect(stdout).not.toContain("Infinite is not set up yet.");
      expect(sentTurn).toBe(false);
    } finally {
      restorePlatform();
      restoreTty();
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it.each(NOT_READY_STATES)(
    "a product one-shot with live bridge ready but %s state exits with onboarding guidance, not a Desktop turn",
    async (_label, state) => {
      const restoreTty = forceTty(false);
      const restorePlatform = forcePlatform("darwin");
      const home = createCanonicalDesktopHome();
      createFakeDesktopApp(home.userHome);
      const bootId = `boot-one-shot-${_label}`;
      writeDesktopBridge(home.growthHome, { bootId });
      if (state) writeDesktopState(home.growthHome, state);
      try {
        const { stdout, code, sentTurn } = await runCliCaptured(
          ["hello", "Desktop"],
          home.env,
          {
            fetchImpl: (input, init) => readyDesktopFetch(bootId, input, init)
          }
        );

        expect(code).not.toBe(0);
        expect(stdout).toContain("infinite://onboarding");
        expect(stdout).toContain("npx infinite-os@latest");
        expect(stdout).not.toContain("answer from Desktop");
        expect(sentTurn).toBe(false);
        assertNoCustomerFallbackCopy(stdout);
      } finally {
        restorePlatform();
        restoreTty();
        rmSync(home.root, { recursive: true, force: true });
      }
    }
  );

  it("a real SIGINT during interactive onboarding exits 130 without local or bridge dispatch", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("darwin");
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdoutWrites.push(String(chunk));
        return true;
      });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    const fetchSpy = vi.fn(
      async (_input: string | URL | Request) =>
        new Response("{}", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const priorExitCode = process.exitCode;
    process.exitCode = 0;
    let emitted = false;
    const deps: OnboardingDeps = {
      resolveAppPath: () => "/Applications/Infinite.app",
      launch: () => undefined,
      readState: () => "booting",
      liveBridgeReady: () => false,
      pollMs: 1,
      timeoutMs: 60_000,
      sleep: async () => {
        if (!emitted) {
          emitted = true;
          process.emit("SIGINT");
        }
      }
    };
    try {
      await runInteractiveEntry(
        { HOME: "/Users/x", GROWTH_OS_HOME: "/Users/x/.growth-os" },
        deps
      );
      expect(process.exitCode).toBe(130);
      expect(stdoutWrites.join("")).not.toContain(
        "Infinite is not set up yet."
      );
      expect(`${stdoutWrites.join("")}${stderrWrites.join("")}`).not.toMatch(
        /infinite local|docker|self-host|local engine/i
      );
      expect(
        fetchSpy.mock.calls.some(([url]) => String(url).endsWith("/v1/turn"))
      ).toBe(false);
    } finally {
      process.exitCode = priorExitCode;
      vi.unstubAllGlobals();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      restorePlatform();
      restoreTty();
    }
  });
});

// ── `infinite analytics` interception ────────────────────────────────────────
// The `infinite` CLI is fully paid: help prints without Desktop, and every
// other invocation (--check included) goes through the SAME readiness gate as
// product turns and `contacts sync` — a non-ready Desktop prints the standard
// onboarding guidance and the repo is never touched.
describe("analytics command interception", () => {
  function makeSiteRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "growth-os-analytics-site-"));
    writeFileSync(join(root, "index.html"), "<!doctype html><html><head></head><body><a href=\"/go\">Go</a></body></html>\n");
    return root;
  }

  it("`infinite analytics --help` prints usage without contacting Desktop", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("darwin");
    try {
      const { stdout, code, sentToBridge } = await runCliCaptured(["analytics", "--help"]);
      expect(stdout).toContain("Usage: infinite analytics");
      expect(sentToBridge).toBe(false);
      expect(code).toBe(0);
    } finally {
      restorePlatform();
      restoreTty();
    }
  });

  it.each(NOT_READY_STATES)(
    "`infinite analytics --plan` with live bridge but %s state prints onboarding guidance and touches nothing",
    async (_label, state) => {
      const restoreTty = forceTty(false);
      const restorePlatform = forcePlatform("darwin");
      const home = createCanonicalDesktopHome();
      createFakeDesktopApp(home.userHome);
      const site = makeSiteRepo();
      const bootId = `boot-analytics-${_label}`;
      writeDesktopBridge(home.growthHome, { bootId });
      if (state) writeDesktopState(home.growthHome, state);
      try {
        const { stdout, stderr, code } = await runCliCaptured(
          ["analytics", "--plan", "--root", site, "--ga4-measurement-id", "G-GATE0001", "--workspace", "proj_gate"],
          home.env,
          { fetchImpl: (input, init) => readyDesktopFetch(bootId, input, init) }
        );
        expect(code).not.toBe(0);
        expect(stdout).toContain("infinite://onboarding");
        expect(stdout).toContain("npx infinite-os@latest");
        expect(`${stdout}${stderr}`).not.toContain("Infinite analytics harness");
        expect(existsSync(join(site, ".infinite"))).toBe(false);
        expect(existsSync(join(site, ".gitignore"))).toBe(false);
        assertNoCustomerFallbackCopy(`${stdout}${stderr}`);
      } finally {
        restorePlatform();
        restoreTty();
        rmSync(home.root, { recursive: true, force: true });
        rmSync(site, { recursive: true, force: true });
      }
    }
  );

  it.each(NOT_READY_STATES)(
    "`infinite analytics --check` is ungated: with %s state it prints the state table and ends with the onboarding prompt",
    async (_label, state) => {
      const restoreTty = forceTty(false);
      const restorePlatform = forcePlatform("darwin");
      const home = createCanonicalDesktopHome();
      createFakeDesktopApp(home.userHome);
      const site = makeSiteRepo();
      const bootId = `boot-analytics-check-${_label}`;
      writeDesktopBridge(home.growthHome, { bootId });
      if (state) writeDesktopState(home.growthHome, state);
      try {
        const { stdout, stderr, code, sentTurn } = await runCliCaptured(
          ["analytics", "--check", "--root", site, "--ga4-measurement-id", "G-GATE0001"],
          { ...home.env, INFINITE_ARTIFACTS_DIR: join(site, "no-artifacts") },
          { fetchImpl: (input, init) => readyDesktopFetch(bootId, input, init) }
        );
        expect(code).toBe(0);
        expect(stdout).toContain("Infinite analytics harness");
        expect(stdout).toContain("server_lane");
        expect(stdout.trimEnd().endsWith(ANALYTICS_ONBOARDING_PROMPT)).toBe(true);
        expect(stdout).toContain("infinite://onboarding");
        expect(sentTurn).toBe(false);
        expect(existsSync(join(site, ".infinite"))).toBe(false);
        assertNoCustomerFallbackCopy(`${stdout}${stderr}`);
      } finally {
        restorePlatform();
        restoreTty();
        rmSync(home.root, { recursive: true, force: true });
        rmSync(site, { recursive: true, force: true });
      }
    }
  );

  it("`infinite analytics --check` with a live ready bridge runs the harness", async () => {
    const restoreTty = forceTty(false);
    const restorePlatform = forcePlatform("darwin");
    const home = createCanonicalDesktopHome();
    const site = makeSiteRepo();
    const bootId = "boot-analytics-ready";
    writeDesktopBridge(home.growthHome, { bootId });
    writeDesktopState(home.growthHome, "ready");
    try {
      const { stdout, code } = await runCliCaptured(
        ["analytics", "--check", "--root", site, "--ga4-measurement-id", "G-GATE0001"],
        { ...home.env, INFINITE_ARTIFACTS_DIR: join(site, "no-artifacts") },
        { fetchImpl: (input, init) => readyDesktopFetch(bootId, input, init) }
      );
      expect(stdout).toContain("Infinite analytics harness");
      expect(stdout).toContain("server_lane");
      expect(stdout).not.toContain(ANALYTICS_ONBOARDING_PROMPT);
      expect(code).toBe(0);
    } finally {
      restorePlatform();
      restoreTty();
      rmSync(home.root, { recursive: true, force: true });
      rmSync(site, { recursive: true, force: true });
    }
  });
});

// ── `infinite contacts` interception (contacts-cli-sync design, Phase 2) ─────
// The word "contacts" must never fall through to a chat turn, and the sync
// flow's first gates (desktop running, capability) run before ANY bridge data
// call.
describe("contacts command interception", () => {
  it("bare `infinite contacts` prints usage and never becomes a turn", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("darwin");
    try {
      const { stdout, code, sentToBridge } = await runCliCaptured(["contacts"]);
      expect(stdout).toContain("Usage: infinite contacts sync");
      expect(sentToBridge).toBe(false);
      expect(code).not.toBe(0);
    } finally {
      restorePlatform();
      restoreTty();
    }
  });

  it("`infinite contacts sync` with a live ready bridge reaches the contacts flow", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("darwin");
    const home = createCanonicalDesktopHome();
    const bootId = "boot-contacts-ready";
    writeDesktopBridge(home.growthHome, { bootId });
    writeDesktopState(home.growthHome, "ready");
    const statusRequests: string[] = [];
    try {
      const { stdout, stderr, code, sentTurn } = await runCliCaptured(
        ["contacts", "sync"],
        home.env,
        {
          fetchImpl: async (input) => {
            const url = String(input);
            if (url.endsWith("/v1/status")) {
              statusRequests.push(url);
              return desktopStatusResponse(true, bootId);
            }
            return new Response("{}", { status: 200 });
          }
        }
      );

      expect(statusRequests.length).toBeGreaterThan(0);
      expect(stdout).toContain("no Supabase URL + service role key found");
      expect(stderr).not.toContain("Open the Infinite app first");
      expect(sentTurn).toBe(false);
      expect(code).not.toBe(0);
      assertNoCustomerFallbackCopy(`${stdout}${stderr}`);
    } finally {
      restorePlatform();
      restoreTty();
      rmSync(home.root, { recursive: true, force: true });
    }
  });

  it.each(NOT_READY_STATES)(
    "`infinite contacts sync` with live bridge ready but %s state exits before contacts",
    async (_label, state) => {
      const restoreTty = forceTty(false);
      const restorePlatform = forcePlatform("darwin");
      const home = createCanonicalDesktopHome();
      createFakeDesktopApp(home.userHome);
      const bootId = `boot-contacts-${_label}`;
      writeDesktopBridge(home.growthHome, { bootId });
      if (state) writeDesktopState(home.growthHome, state);
      try {
        const { stdout, stderr, code, sentTurn } = await runCliCaptured(
          ["contacts", "sync"],
          home.env,
          {
            fetchImpl: (input, init) => readyDesktopFetch(bootId, input, init)
          }
        );

        expect(code).not.toBe(0);
        expect(stdout).toContain("infinite://onboarding");
        expect(stdout).toContain("npx infinite-os@latest");
        expect(stderr).not.toContain("infinite contacts sync is interactive");
        expect(stdout).not.toContain("no Supabase URL + service role key found");
        expect(sentTurn).toBe(false);
        assertNoCustomerFallbackCopy(`${stdout}${stderr}`);
      } finally {
        restorePlatform();
        restoreTty();
        rmSync(home.root, { recursive: true, force: true });
      }
    }
  );

  it("`infinite contacts sync` on an interactive Mac launches onboarding and calls contacts only after Desktop is ready", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("darwin");
    const home = createCanonicalDesktopHome();
    createFakeDesktopApp(home.userHome);
    const bootId = "boot-contacts-onboarding";
    writeDesktopBridge(home.growthHome, { bootId });
    writeDesktopState(home.growthHome, "ready");
    const fakeOpen = createFakeOpen(home.root);
    let statusRequests = 0;
    try {
      const { stdout, stderr, code, sentTurn } = await runCliCaptured(
        ["contacts", "sync"],
        home.env,
        {
          fetchImpl: async (input) => {
            if (String(input).endsWith("/v1/status")) {
              statusRequests += 1;
              return desktopStatusResponse(statusRequests > 1, bootId);
            }
            return new Response("{}", { status: 200 });
          }
        }
      );

      expect(statusRequests).toBeGreaterThanOrEqual(2);
      expect(existsSync(fakeOpen.logPath)).toBe(true);
      expect(readFileSync(fakeOpen.logPath, "utf8")).toContain(
        "infinite://onboarding"
      );
      expect(stdout).toContain("Complete setup in the app");
      expect(stdout.indexOf("Complete setup in the app")).toBeLessThan(
        stdout.indexOf("no Supabase URL + service role key found")
      );
      expect(stderr).not.toContain("Open the Infinite app first");
      expect(sentTurn).toBe(false);
      expect(code).not.toBe(0);
      assertNoCustomerFallbackCopy(`${stdout}${stderr}`);
    } finally {
      fakeOpen.restore();
      restorePlatform();
      restoreTty();
      rmSync(home.root, { recursive: true, force: true });
    }
  });

  it("`infinite contacts sync` with a missing app prints npx recovery instead of contacts bridge advice", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("darwin");
    const home = createCanonicalDesktopHome();
    const realExistsSync = mutableFs.existsSync;
    const existsSpy = vi
      .spyOn(mutableFs, "existsSync")
      .mockImplementation((path) => {
        if (String(path) === "/Applications/Infinite.app") return false;
        return realExistsSync(path);
      });
    syncBuiltinESMExports();
    try {
      const { stdout, stderr, code, sentToBridge, sentTurn } =
        await runCliCaptured(["contacts", "sync"], home.env);

      expect(stdout).toContain("Infinite Desktop is missing or moved.");
      expect(stdout).toContain("npx infinite-os@latest");
      expect(stdout).toContain("infinite://onboarding");
      expect(stderr).not.toContain("Open the Infinite app first");
      expect(stdout).not.toContain("no Supabase URL + service role key found");
      expect(sentToBridge).toBe(false);
      expect(sentTurn).toBe(false);
      expect(code).not.toBe(0);
      assertNoCustomerFallbackCopy(`${stdout}${stderr}`);
    } finally {
      existsSpy.mockRestore();
      syncBuiltinESMExports();
      restorePlatform();
      restoreTty();
      rmSync(home.root, { recursive: true, force: true });
    }
  });

  it("`infinite contacts sync` surfaces Desktop launch failure instead of silently swallowing onboarding errors", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("darwin");
    const home = createCanonicalDesktopHome();
    createFakeDesktopApp(home.userHome);
    const fakeOpen = createFakeOpen(home.root, 1);
    try {
      const { stdout, stderr, code, sentToBridge, sentTurn } =
        await runCliCaptured(["contacts", "sync"], home.env);

      expect(existsSync(fakeOpen.logPath)).toBe(true);
      expect(stdout).toContain("Could not open infinite://onboarding");
      expect(stdout).toContain("open 'infinite://onboarding'");
      expect(stdout).not.toContain("no Supabase URL + service role key found");
      expect(stderr).not.toContain("Open the Infinite app first");
      expect(sentToBridge).toBe(false);
      expect(sentTurn).toBe(false);
      expect(code).not.toBe(0);
      assertNoCustomerFallbackCopy(`${stdout}${stderr}`);
    } finally {
      fakeOpen.restore();
      restorePlatform();
      restoreTty();
      rmSync(home.root, { recursive: true, force: true });
    }
  });

  it("`infinite contacts sync` treats stale ready state with a dead bridge as onboarding recovery, not ready contacts", async () => {
    const restoreTty = forceTty(false);
    const restorePlatform = forcePlatform("darwin");
    const home = createCanonicalDesktopHome();
    createFakeDesktopApp(home.userHome);
    writeDesktopState(home.growthHome, "ready");
    try {
      const { stdout, stderr, code, sentToBridge, sentTurn } =
        await runCliCaptured(["contacts", "sync"], home.env);

      expect(stdout).toContain("infinite://onboarding");
      expect(stdout).toContain("npx infinite-os@latest");
      expect(stdout).not.toContain("no Supabase URL + service role key found");
      expect(stderr).not.toContain("Open the Infinite app first");
      expect(sentToBridge).toBe(false);
      expect(sentTurn).toBe(false);
      expect(code).not.toBe(0);
      assertNoCustomerFallbackCopy(`${stdout}${stderr}`);
    } finally {
      restorePlatform();
      restoreTty();
      rmSync(home.root, { recursive: true, force: true });
    }
  });

  it("`infinite contacts sync` from a non-TTY does not open the GUI and exits with URI plus npx recovery", async () => {
    const restoreTty = forceTty(false);
    const restorePlatform = forcePlatform("darwin");
    const home = createCanonicalDesktopHome();
    createFakeDesktopApp(home.userHome);
    const fakeOpen = createFakeOpen(home.root);
    try {
      const { stdout, stderr, code, sentToBridge, sentTurn } =
        await runCliCaptured(["contacts", "sync"], home.env);

      expect(stdout).toContain("infinite://onboarding");
      expect(stdout).toContain("npx infinite-os@latest");
      expect(existsSync(fakeOpen.logPath)).toBe(false);
      expect(stderr).not.toContain("Open the Infinite app first");
      expect(stdout).not.toContain("no Supabase URL + service role key found");
      expect(sentToBridge).toBe(false);
      expect(sentTurn).toBe(false);
      expect(code).not.toBe(0);
      assertNoCustomerFallbackCopy(`${stdout}${stderr}`);
    } finally {
      fakeOpen.restore();
      restorePlatform();
      restoreTty();
      rmSync(home.root, { recursive: true, force: true });
    }
  });

  it("`infinite contacts sync` on non-mac uses the product unsupported guidance", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("linux");
    const home = createCanonicalDesktopHome();
    try {
      const { stdout, stderr, code, sentToBridge, sentTurn } =
        await runCliCaptured(["contacts", "sync"], home.env);

      expect(`${stdout}${stderr}`).toBe(UNSUPPORTED_PRODUCT_PLATFORM);
      expect(sentToBridge).toBe(false);
      expect(sentTurn).toBe(false);
      expect(code).not.toBe(0);
      assertNoCustomerFallbackCopy(`${stdout}${stderr}`);
    } finally {
      restorePlatform();
      restoreTty();
      rmSync(home.root, { recursive: true, force: true });
    }
  });
});
