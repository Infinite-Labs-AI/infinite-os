import { describe, expect, it } from "vitest";
import type { HarnessArgs, HarnessIo, VerificationBackend } from "infinite-tag";

import {
  ANALYTICS_USAGE,
  NO_CLOUD_SESSION_NOTICE,
  chooseBackend,
  runAnalyticsCommand,
  type TagHarnessModule
} from "./analytics.js";

interface Captured {
  runs: Array<{ args: HarnessArgs; backends: string[] }>;
  loaded: number;
}

function baseArgs(overrides: Partial<HarnessArgs> = {}): HarnessArgs {
  return {
    mode: "apply",
    adoptExisting: true,
    noMark: false,
    serverLane: false,
    yes: false,
    allowDirty: false,
    json: false,
    brief: false,
    xEventTagIds: [],
    infiniteProductionHosts: [],
    ...overrides
  };
}

function fakeBackend(name: string): VerificationBackend {
  return { name, lanes: ["ga4"], verify: async () => ({}) };
}

function fakeTag(captured: Captured, options: { failure?: { code: string; message: string } } = {}): TagHarnessModule {
  return {
    parseHarnessArgs(argv) {
      if (argv.includes("--bogus")) throw new Error("Unknown argument: --bogus. Run infinite-tag help for usage.");
      const args = baseArgs();
      for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === "--check") args.mode = "check";
        if (token === "--plan") args.mode = "plan";
        if (token === "--no-mark") args.noMark = true;
        if (token === "--yes") args.yes = true;
        if (token === "--workspace") args.workspaceId = argv[index + 1];
        if (token === "--conversions") args.conversions = argv[index + 1];
      }
      return args;
    },
    conversionsArgumentError(args, interactive) {
      if (args.mode !== "apply" || args.noMark || args.conversions !== undefined || interactive) return null;
      return "Non-interactive run: pass --conversions <file> or --no-mark.";
    },
    infErrorLine: (code, message) => `inf-error: ${code} — ${message}`,
    isInteractiveTerminal: () => false,
    terminalIo: (interactive) => ({ interactive, out: () => {}, err: () => {}, confirm: async () => false }),
    async runHarness(args, _io, deps) {
      captured.runs.push({ args, backends: (deps?.backends ?? []).map((backend) => backend.name) });
      return { exitCode: options.failure ? 1 : 0, report: { failure: options.failure ?? null } };
    },
    NoneBackend: class implements VerificationBackend {
      name = "none";
      lanes: VerificationBackend["lanes"] = ["ga4"];
      async verify() {
        return {};
      }
    },
    InfiniteCloudBackend: class implements VerificationBackend {
      name: string;
      lanes: VerificationBackend["lanes"] = ["ga4"];
      constructor(options: { origin: string; token: string; engineProjectId: string }) {
        this.name = `cloud:${options.origin}:${options.engineProjectId}:${options.token === "tok_1" ? "token-ok" : "token-bad"}`;
      }
      async verify() {
        return {};
      }
    },
    EXIT_ARGS: 2,
    EXIT_FAILED: 1,
    EXIT_OK: 0
  };
}

function fakeIo(interactive = false): HarnessIo & { out_: string[]; err_: string[] } {
  const out_: string[] = [];
  const err_: string[] = [];
  return {
    interactive,
    out_,
    err_,
    out: (line) => {
      out_.push(line);
    },
    err: (line) => {
      err_.push(line);
    },
    confirm: async () => false
  };
}

describe("infinite analytics", () => {
  it("prints usage for --help without loading the tag", async () => {
    const captured: Captured = { runs: [], loaded: 0 };
    const io = fakeIo();
    const code = await runAnalyticsCommand(["--help"], {}, {
      io,
      loadTag: async () => {
        captured.loaded += 1;
        return fakeTag(captured);
      }
    });
    expect(code).toBe(0);
    expect(io.out_.join("\n")).toBe(ANALYTICS_USAGE);
    expect(captured.loaded).toBe(0);
  });

  it("passes --check through and takes the workspace from the Desktop's active workspace", async () => {
    const captured: Captured = { runs: [], loaded: 0 };
    const io = fakeIo();
    const code = await runAnalyticsCommand(["--check"], {}, {
      io,
      loadTag: async () => fakeTag(captured),
      resolveBridge: () => ({
        client: {
          status: async () => ({
            service: "infinite-desktop-cmdl",
            bootId: "b",
            protocol: { min: 1, max: 1 },
            capabilities: [],
            ready: true,
            contextRevision: "r",
            workspace: { id: "ws_desktop", name: "Site" }
          })
        }
      })
    });
    expect(code).toBe(0);
    expect(captured.runs[0].args).toMatchObject({ mode: "check", workspaceId: "ws_desktop" });
    expect(io.err_).toContain("Workspace ws_desktop (Desktop's active workspace).");
  });

  it("an explicit --workspace wins over the Desktop", async () => {
    const captured: Captured = { runs: [], loaded: 0 };
    await runAnalyticsCommand(["--check", "--workspace", "ws_flag"], {}, {
      io: fakeIo(),
      loadTag: async () => fakeTag(captured),
      resolveBridge: () => {
        throw new Error("must not be consulted");
      }
    });
    expect(captured.runs[0].args.workspaceId).toBe("ws_flag");
  });

  it("non-interactive apply without --conversions or --no-mark exits 2 with INF_ARGS_CONVERSIONS_REQUIRED", async () => {
    const captured: Captured = { runs: [], loaded: 0 };
    const io = fakeIo(false);
    const code = await runAnalyticsCommand(["--yes"], {}, { io, loadTag: async () => fakeTag(captured), resolveBridge: () => null });
    expect(code).toBe(2);
    expect(io.err_.some((line) => line.startsWith("inf-error: INF_ARGS_CONVERSIONS_REQUIRED"))).toBe(true);
    expect(captured.runs).toHaveLength(0);
  });

  it("uses NoneBackend and says so when there is no cloud session; the cloud backend when INFINITE_API_TOKEN is set", async () => {
    const captured: Captured = { runs: [], loaded: 0 };
    const io = fakeIo();
    await runAnalyticsCommand(["--check", "--workspace", "ws_1"], {}, { io, loadTag: async () => fakeTag(captured), resolveBridge: () => null });
    expect(captured.runs[0].backends).toEqual(["none"]);
    expect(io.err_).toContain(NO_CLOUD_SESSION_NOTICE);

    const cloudIo = fakeIo();
    await runAnalyticsCommand(
      ["--check", "--workspace", "ws_1"],
      { INFINITE_API_TOKEN: "tok_1", INFINITE_API_ORIGIN: "https://api.infinite.fast/" },
      { io: cloudIo, loadTag: async () => fakeTag(captured), resolveBridge: () => null }
    );
    expect(captured.runs[1].backends).toEqual(["cloud:https://api.infinite.fast:ws_1:token-ok"]);
    expect(cloudIo.err_).toContain("Verifying through the cloud at https://api.infinite.fast for workspace ws_1.");
  });

  it("a token without a workspace still falls back to NoneBackend and asks for --workspace", () => {
    const captured: Captured = { runs: [], loaded: 0 };
    const { backend, notice } = chooseBackend(fakeTag(captured), { INFINITE_API_TOKEN: "tok_1" }, undefined);
    expect(backend.name).toBe("none");
    expect(notice).toContain("pass --workspace");
  });

  it("maps a harness failure to exit 1 and an inf-error line; unknown flags to exit 2", async () => {
    const captured: Captured = { runs: [], loaded: 0 };
    const io = fakeIo();
    const code = await runAnalyticsCommand(["--check"], {}, {
      io,
      loadTag: async () => fakeTag(captured, { failure: { code: "INF_DETECT_NO_FRAMEWORK", message: "Could not identify a web app in this repo." } }),
      resolveBridge: () => null
    });
    expect(code).toBe(1);
    expect(io.err_.at(-1)).toBe("inf-error: INF_DETECT_NO_FRAMEWORK — Could not identify a web app in this repo.");

    const argsIo = fakeIo();
    expect(await runAnalyticsCommand(["--bogus"], {}, { io: argsIo, loadTag: async () => fakeTag(captured), resolveBridge: () => null })).toBe(2);
    expect(argsIo.err_[0]).toContain("Unknown argument: --bogus");
    expect(fakeBackend("x").name).toBe("x");
  });
});
