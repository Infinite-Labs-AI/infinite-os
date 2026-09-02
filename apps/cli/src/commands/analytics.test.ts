import { describe, expect, it, vi } from "vitest";
import type { HarnessArgs, HarnessIo, VerificationBackend } from "infinite-tag";

import {
  ANALYTICS_USAGE,
  BRIDGE_BACKEND_NOTICE,
  DESKTOP_TOO_OLD_NOTICE,
  NO_CLOUD_SESSION_NOTICE,
  chooseBackend,
  extractApiTokenEnvFlag,
  runAnalyticsCommand,
  type ResolvedBridge,
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
      // The real parser rejects anything it does not know — including our CLI-only flag.
      const ours = argv.find((token) => token.startsWith("--api-token-env"));
      if (ours) throw new Error(`Unknown argument: ${ours}. Run infinite-tag help for usage.`);
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
    DesktopBridgeBackend: class implements VerificationBackend {
      name: string;
      lanes: VerificationBackend["lanes"] = ["ga4"];
      constructor(options: { bridgeUrl: string; token: string }) {
        this.name = `bridge:${options.bridgeUrl}:${options.token}`;
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

/** A running Desktop: the descriptor carries the loopback url, the LOCAL bearer, and the verbs. */
function fakeBridge(
  options: { workspaceId?: string; capabilities?: string[] } = {}
): ResolvedBridge {
  return {
    client: {
      status: async () => ({
        service: "infinite-desktop-cmdl" as const,
        bootId: "b",
        protocol: { min: 1, max: 1 },
        capabilities: [],
        ready: true,
        contextRevision: "r",
        workspace: { id: options.workspaceId ?? "proj_engine01", name: "Site" }
      })
    },
    descriptor: {
      url: "http://127.0.0.1:54321",
      token: "bridge_tok",
      capabilities: options.capabilities ?? ["status.v1", "analytics.verify.v1"]
    }
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
      resolveBridge: () => fakeBridge({ workspaceId: "ws_desktop" })
    });
    expect(code).toBe(0);
    expect(captured.runs[0].args).toMatchObject({ mode: "check", workspaceId: "ws_desktop" });
    expect(io.err_).toContain("Workspace ws_desktop (Desktop's active workspace).");
  });

  it("verifies through the Desktop bridge by default — the CLI never holds a cloud token", async () => {
    const captured: Captured = { runs: [], loaded: 0 };
    const io = fakeIo();
    // A stale token in the environment must NOT be used: the running app wins, silently and safely.
    const code = await runAnalyticsCommand(["--check"], { INFINITE_API_TOKEN: "tok_1" }, {
      io,
      loadTag: async () => fakeTag(captured),
      resolveBridge: () => fakeBridge()
    });
    expect(code).toBe(0);
    expect(captured.runs[0].backends).toEqual(["bridge:http://127.0.0.1:54321:bridge_tok"]);
    expect(io.err_).toContain(BRIDGE_BACKEND_NOTICE);
  });

  it("a Desktop too old to carry analytics.verify.v1 says UPDATE, not 'open the app'", async () => {
    const captured: Captured = { runs: [], loaded: 0 };
    const io = fakeIo();
    await runAnalyticsCommand(["--check"], {}, {
      io,
      loadTag: async () => fakeTag(captured),
      resolveBridge: () => fakeBridge({ capabilities: ["status.v1", "turn.ndjson.v1"] })
    });
    expect(captured.runs[0].backends).toEqual(["none"]);
    expect(io.err_).toContain(DESKTOP_TOO_OLD_NOTICE);
  });

  it("the Desktop's workspace.id is the engine project id and becomes engineProjectId in the cloud backend", async () => {
    // The bridge's /v1/status `workspace.id` is `authority.snapshot.engineProjectId` (desktop
    // cmdl-brain-service.ts) — the `proj_…` id artifacts are keyed by, not a cloud UUID.
    const captured: Captured = { runs: [], loaded: 0 };
    await runAnalyticsCommand(["--check", "--api-token-env"], { INFINITE_API_TOKEN: "tok_1" }, {
      io: fakeIo(),
      loadTag: async () => fakeTag(captured),
      // An app that cannot verify — so the escape hatch is the one that answers.
      resolveBridge: () => fakeBridge({ workspaceId: "proj_engine01", capabilities: ["status.v1"] })
    });
    expect(captured.runs[0].args.workspaceId).toBe("proj_engine01");
    expect(captured.runs[0].backends).toEqual(["cloud:https://api.ultima.inc:proj_engine01:token-ok"]);
  });

  it("an explicit --workspace wins over the Desktop — which still answers the verification", async () => {
    const captured: Captured = { runs: [], loaded: 0 };
    const io = fakeIo();
    const status = vi.fn(fakeBridge().client.status);
    await runAnalyticsCommand(["--check", "--workspace", "ws_flag"], {}, {
      io,
      loadTag: async () => fakeTag(captured),
      resolveBridge: () => ({ ...fakeBridge(), client: { status } })
    });
    expect(captured.runs[0].args.workspaceId).toBe("ws_flag");
    // The flag settles the workspace WITHOUT a round trip, but the app still reads the receipts.
    expect(status).not.toHaveBeenCalled();
    expect(captured.runs[0].backends).toEqual(["bridge:http://127.0.0.1:54321:bridge_tok"]);
  });

  it("non-interactive apply without --conversions or --no-mark exits 2 with INF_ARGS_CONVERSIONS_REQUIRED", async () => {
    const captured: Captured = { runs: [], loaded: 0 };
    const io = fakeIo(false);
    const code = await runAnalyticsCommand(["--yes"], {}, { io, loadTag: async () => fakeTag(captured), resolveBridge: () => null });
    expect(code).toBe(2);
    expect(io.err_.some((line) => line.startsWith("inf-error: INF_ARGS_CONVERSIONS_REQUIRED"))).toBe(true);
    expect(captured.runs).toHaveLength(0);
  });

  it("with no Desktop: NoneBackend and 'open the app' — a bare env token is never used implicitly", async () => {
    const captured: Captured = { runs: [], loaded: 0 };
    const io = fakeIo();
    await runAnalyticsCommand(["--check", "--workspace", "ws_1"], {}, { io, loadTag: async () => fakeTag(captured), resolveBridge: () => null });
    expect(captured.runs[0].backends).toEqual(["none"]);
    expect(io.err_).toContain(NO_CLOUD_SESSION_NOTICE);

    const implicitIo = fakeIo();
    await runAnalyticsCommand(
      ["--check", "--workspace", "ws_1"],
      { INFINITE_API_TOKEN: "tok_1" },
      { io: implicitIo, loadTag: async () => fakeTag(captured), resolveBridge: () => null }
    );
    expect(captured.runs[1].backends).toEqual(["none"]);
    expect(implicitIo.err_).toContain(NO_CLOUD_SESSION_NOTICE);
  });

  it("--api-token-env opts into the cloud escape hatch, honours INFINITE_API_ORIGIN, and never reaches the harness parser", async () => {
    const captured: Captured = { runs: [], loaded: 0 };
    const cloudIo = fakeIo();
    await runAnalyticsCommand(
      ["--check", "--workspace", "ws_1", "--api-token-env"],
      { INFINITE_API_TOKEN: "tok_1", INFINITE_API_ORIGIN: "https://api.infinite.fast/" },
      { io: cloudIo, loadTag: async () => fakeTag(captured), resolveBridge: () => null }
    );
    expect(captured.runs[0].backends).toEqual(["cloud:https://api.infinite.fast:ws_1:token-ok"]);
    expect(captured.runs[0].args.mode).toBe("check");
    expect(cloudIo.err_).toContain("Verifying through the cloud at https://api.infinite.fast for workspace ws_1.");

    // A named variable, and the `=` form.
    const namedIo = fakeIo();
    await runAnalyticsCommand(
      ["--check", "--workspace", "ws_1", "--api-token-env", "CI_INFINITE_TOKEN"],
      { CI_INFINITE_TOKEN: "tok_1" },
      { io: namedIo, loadTag: async () => fakeTag(captured), resolveBridge: () => null }
    );
    expect(captured.runs[1].backends).toEqual(["cloud:https://api.ultima.inc:ws_1:token-ok"]);
    await runAnalyticsCommand(
      ["--check", "--workspace", "ws_1", "--api-token-env=CI_INFINITE_TOKEN"],
      { CI_INFINITE_TOKEN: "tok_1" },
      { io: fakeIo(), loadTag: async () => fakeTag(captured), resolveBridge: () => null }
    );
    expect(captured.runs[2].backends).toEqual(["cloud:https://api.ultima.inc:ws_1:token-ok"]);
  });

  it("extractApiTokenEnvFlag: bare, named, =form, absent — and it never swallows the next FLAG", () => {
    expect(extractApiTokenEnvFlag(["--check"])).toEqual({ rest: ["--check"], envVar: null });
    expect(extractApiTokenEnvFlag(["--api-token-env", "--check"])).toEqual({ rest: ["--check"], envVar: "INFINITE_API_TOKEN" });
    expect(extractApiTokenEnvFlag(["--api-token-env", "MY_VAR", "--check"])).toEqual({ rest: ["--check"], envVar: "MY_VAR" });
    expect(extractApiTokenEnvFlag(["--api-token-env=MY_VAR"])).toEqual({ rest: [], envVar: "MY_VAR" });
    expect(extractApiTokenEnvFlag(["--api-token-env="])).toEqual({ rest: [], envVar: "INFINITE_API_TOKEN" });
  });

  it("a named-but-empty variable, and a token without a workspace, both fall back to NoneBackend honestly", () => {
    const captured: Captured = { runs: [], loaded: 0 };
    const noWorkspace = chooseBackend({
      tag: fakeTag(captured),
      env: { INFINITE_API_TOKEN: "tok_1" },
      bridge: null,
      apiTokenEnvVar: "INFINITE_API_TOKEN",
      workspaceId: undefined
    });
    expect(noWorkspace.backend.name).toBe("none");
    expect(noWorkspace.notice).toContain("pass --workspace");

    const empty = chooseBackend({
      tag: fakeTag(captured),
      env: {},
      bridge: null,
      apiTokenEnvVar: "CI_INFINITE_TOKEN",
      workspaceId: "ws_1"
    });
    expect(empty.backend.name).toBe("none");
    expect(empty.notice).toContain("CI_INFINITE_TOKEN");
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
