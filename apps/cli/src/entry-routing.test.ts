import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "./index.js";

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

function forceTty(value: boolean): () => void {
  const targets: Array<NodeJS.ReadStream | NodeJS.WriteStream> = [process.stdin, process.stdout];
  const originals = targets.map((target) => Object.getOwnPropertyDescriptor(target, "isTTY"));
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
  env: Record<string, string> = {}
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
  const fetchSpy = vi.fn(async (_input: string | URL | Request) => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
  const priorExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    await runCli(args, { GROWTH_OS_HOME: growthHome, ...env });
    return {
      stdout: stdoutWrites.join(""),
      stderr: stderrWrites.join(""),
      code: typeof process.exitCode === "number" ? process.exitCode : 0,
      sentToBridge: fetchSpy.mock.calls.some(([url]) => String(url).includes("/v1/")),
      sentTurn: fetchSpy.mock.calls.some(([url]) => String(url).endsWith("/v1/turn"))
    };
  } finally {
    process.exitCode = priorExitCode;
    vi.unstubAllGlobals();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    rmSync(growthHome, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("canonical entry routing (§6.6)", () => {
  it("a reserved command prints local guidance and does NOT become a turn", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("darwin");
    try {
      const { stdout, code, sentToBridge } = await runCliCaptured(["sources"]);
      expect(stdout).toContain("Use: infinite local sources");
      expect(sentToBridge).toBe(false);
      expect(code).not.toBe(0);
    } finally {
      restorePlatform();
      restoreTty();
    }
  });

  it("a reserved command keeps its arguments in the local guidance", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("darwin");
    try {
      const { stdout, code, sentToBridge } = await runCliCaptured(["setup", "resume", "r123"]);
      expect(stdout).toContain("Use: infinite local setup resume r123");
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
      const { code, stderr, sentToBridge } = await runCliCaptured(["--project", "x", "hello"]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("infinite local");
      expect(sentToBridge).toBe(false);
    } finally {
      restorePlatform();
      restoreTty();
    }
  });

  it("product help prints the product surface, not the raw engine", async () => {
    const { stdout, code, sentToBridge } = await runCliCaptured(["help"]);
    expect(stdout).toContain("infinite local");
    expect(stdout).not.toContain("docker");
    expect(stdout).not.toContain("Connect data:");
    expect(code).toBe(0);
    expect(sentToBridge).toBe(false);
  });

  it("--help is a product-help alias", async () => {
    const { stdout, code } = await runCliCaptured(["--help"]);
    expect(stdout).toContain("infinite local");
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
        { GROWTH_OS_WORKSPACE_ID: "proj_test", GROWTH_OS_CLI_NONINTERACTIVE: "1" }
      );
      expect(code).not.toBe(0);
      expect(stdout).toContain("infinite local");
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
        { GROWTH_OS_WORKSPACE_ID: "proj_test", GROWTH_OS_CLI_NONINTERACTIVE: "1" }
      );
      expect(code).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain("infinite local");
      expect(stdout).not.toContain("Infinite is not set up yet.");
      expect(sentTurn).toBe(false);
    } finally {
      restorePlatform();
      restoreTty();
    }
  });

  // `resolveMode` returns "local" for TWO different reasons — the explicit
  // `GROWTH_OS_DEFAULT_TARGET=local` opt-in AND a non-mac host. Only the
  // former may open the local product session. A bare `infinite` on a non-mac
  // host with no opt-in must exit non-zero with guidance — the same contract
  // as the one-shot path above — never a silent local session.
  it("non-mac bare `infinite` with no explicit opt-in exits non-zero with guidance, never a local session", async () => {
    const restoreTty = forceTty(false);
    const restorePlatform = forcePlatform("linux");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-entry-baremode-"));
    try {
      const { stdout, stderr, code, sentTurn } = await runCliCaptured([], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_CLI_NONINTERACTIVE: "1"
      });
      expect(code).not.toBe(0);
      expect(stderr).toContain("macOS-only");
      expect(stderr).toContain("infinite local");
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

  it("non-mac bare `infinite` with GROWTH_OS_DEFAULT_TARGET=local keeps the local session escape hatch", async () => {
    const restoreTty = forceTty(false);
    const restorePlatform = forcePlatform("linux");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "growth-os-entry-barelocal-"));
    try {
      const { stdout, code } = await runCliCaptured([], {
        GROWTH_OS_WORKSPACE_ROOT: workspaceRoot,
        GROWTH_OS_DEFAULT_TARGET: "local",
        GROWTH_OS_CLI_NONINTERACTIVE: "1"
      });
      // The explicit opt-in reaches today's local interactive session: in
      // noninteractive mode its readiness preflight prints setup guidance and
      // returns cleanly — proof `interactiveSession` ran.
      expect(stdout).toContain("Infinite is not set up yet.");
      expect(code).toBe(0);
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
      expect(stdout).toContain("infinite local update");
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

  it("an explicit config local target keeps the local one-shot escape hatch", async () => {
    const restoreTty = forceTty(true);
    const restorePlatform = forcePlatform("darwin");
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-entry-config-local-"));
    const fetchSpy = vi.fn(async (_input: string | URL | Request) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      // The explicit opt-in reaches the LOCAL pipeline (here: it dies on the
      // local active-project guard — proof it never touched the bridge).
      await expect(
        runCli(["hello", "there"], {
          GROWTH_OS_HOME: growthHome,
          GROWTH_OS_DEFAULT_TARGET: "local",
          GROWTH_OS_CLI_NONINTERACTIVE: "1"
        })
      ).rejects.toThrow(/active project/i);
      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("/v1/"))).toBe(false);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      vi.unstubAllGlobals();
      restorePlatform();
      restoreTty();
      rmSync(growthHome, { recursive: true, force: true });
    }
  });
});
