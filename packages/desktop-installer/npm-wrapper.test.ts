import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const binPath = join(packageRoot, "bin/infinite-os.mjs");

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, signal: null })),
  spawn: vi.fn()
}));

interface InstallerResult {
  status: number | null;
  signal: NodeJS.Signals | null;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

type DepOverrides = Partial<{
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  errorIsTTY: boolean;
  runInstaller: (args: string[], options: unknown) => InstallerResult;
  runEmbeddedCli: (paths: {
    executable: string;
    cli: string;
  }) => Promise<ChildResult>;
  isRegularFile: (path: string) => boolean;
  isExecutableFile: (path: string) => boolean;
  writeErr: (text: string) => void;
}>;

function deps(overrides: DepOverrides = {}) {
  return {
    env: overrides.env ?? {},
    platform: overrides.platform ?? "darwin",
    inputIsTTY: overrides.inputIsTTY ?? true,
    outputIsTTY: overrides.outputIsTTY ?? true,
    errorIsTTY: overrides.errorIsTTY ?? true,
    runInstaller:
      overrides.runInstaller ?? (() => ({ status: 0, signal: null })),
    runEmbeddedCli:
      overrides.runEmbeddedCli ?? (async () => ({ code: 0, signal: null })),
    isRegularFile: overrides.isRegularFile ?? (() => true),
    isExecutableFile: overrides.isExecutableFile ?? (() => true),
    writeErr: overrides.writeErr ?? (() => {})
  };
}

async function loadWrapperModule() {
  const exit = vi.spyOn(process, "exit").mockImplementation(((
    code?: string | number | null
  ) => {
    throw new Error(`unexpected process.exit(${String(code)}) during import`);
  }) as typeof process.exit);
  try {
    return await import(
      `${pathToFileURL(realpathSync(binPath)).href}?test=${Date.now()}`
    );
  } finally {
    exit.mockRestore();
  }
}

describe("infinite-os npm wrapper handoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports an import-safe main without running the installer through a symlinked bin import", async () => {
    const imported = await loadWrapperModule();

    expect(imported.main).toEqual(expect.any(Function));
  });

  it("starts the embedded CLI only after the installer has returned zero", async () => {
    const { main } = await loadWrapperModule();
    const calls: string[] = [];

    const code = await main(
      [],
      deps({
        runInstaller: () => {
          calls.push("installer-exited");
          return { status: 0, signal: null };
        },
        runEmbeddedCli: async () => {
          calls.push("cli-started");
          return { code: 0, signal: null };
        }
      })
    );

    expect(code).toBe(0);
    expect(calls).toEqual(["installer-exited", "cli-started"]);
  });

  it.each([
    [
      "installer failure",
      { runInstaller: () => ({ status: 1, signal: null }) }
    ],
    ["no-open", { args: ["--no-open"] }],
    ["help", { args: ["--help"] }],
    ["stdin pipe", { inputIsTTY: false }],
    ["stdout pipe", { outputIsTTY: false }],
    ["stderr pipe", { errorIsTTY: false }],
    ["non-darwin", { platform: "linux" as NodeJS.Platform }]
  ])("does not start CLI: %s", async (_label, scenario) => {
    const { main } = await loadWrapperModule();
    const start = vi.fn(async () => ({ code: 0, signal: null }));

    await main(
      "args" in scenario ? (scenario.args ?? []) : [],
      deps({
        ...scenario,
        runEmbeddedCli: start
      })
    );

    expect(start).not.toHaveBeenCalled();
  });

  it("sets installer interactivity from the original TTY snapshot", async () => {
    const { main } = await loadWrapperModule();
    let observedEnv: NodeJS.ProcessEnv | undefined;

    await main(
      [],
      deps({
        inputIsTTY: true,
        outputIsTTY: true,
        errorIsTTY: true,
        runInstaller: (_args, options) => {
          observedEnv = (options as { env: NodeJS.ProcessEnv }).env;
          return { status: 0, signal: null };
        }
      })
    );

    expect(observedEnv).toMatchObject({
      INFINITE_INSTALL_SOURCE: "npm",
      INFINITE_INSTALL_INTERACTIVE: "1"
    });
  });

  it("marks the installer non-interactive when any original stream is not a TTY", async () => {
    const { main } = await loadWrapperModule();
    let observedEnv: NodeJS.ProcessEnv | undefined;

    await main(
      [],
      deps({
        inputIsTTY: true,
        outputIsTTY: false,
        errorIsTTY: true,
        runInstaller: (_args, options) => {
          observedEnv = (options as { env: NodeJS.ProcessEnv }).env;
          return { status: 0, signal: null };
        }
      })
    );

    expect(observedEnv?.INFINITE_INSTALL_INTERACTIVE).toBe("0");
  });

  it("resolves the app directory from the last Bash-compatible --app-dir PATH", () => {
    return loadWrapperModule().then(({ resolveAppDirectory }) => {
      expect(
        resolveAppDirectory(
          [
            "--app-dir",
            "/Users/x/Apps With Spaces",
            "--app-dir",
            "/Applications Alt"
          ],
          {}
        )
      ).toBe("/Applications Alt");
    });
  });

  it("ignores invented --app-dir=PATH syntax", async () => {
    const { resolveAppDirectory } = await loadWrapperModule();
    expect(resolveAppDirectory(["--app-dir=/tmp/nope"], {})).toBe(
      "/Applications"
    );
  });

  it("uses INFINITE_APPLICATIONS_DIR when --app-dir is absent", async () => {
    const { resolveAppDirectory } = await loadWrapperModule();
    expect(
      resolveAppDirectory([], { INFINITE_APPLICATIONS_DIR: "/Users/x/Apps" })
    ).toBe("/Users/x/Apps");
  });

  it("computes the executable and CLI paths without splitting directories that contain spaces", async () => {
    const { main } = await loadWrapperModule();
    const started = vi.fn(async () => ({ code: 0, signal: null }));

    await main(
      ["--app-dir", "/Users/x/Apps With Spaces"],
      deps({ runEmbeddedCli: started })
    );

    expect(started).toHaveBeenCalledWith(
      {
        executable:
          "/Users/x/Apps With Spaces/Infinite.app/Contents/MacOS/Infinite",
        cli: "/Users/x/Apps With Spaces/Infinite.app/Contents/Resources/cli/infinite.mjs"
      },
      { args: [] }
    );
  });

  it("does not forward installer args to the embedded CLI", async () => {
    const { main } = await loadWrapperModule();
    const childArgs: string[][] = [];

    await main(
      ["--app-dir", "/Users/x/Apps"],
      deps({
        runEmbeddedCli: async (_paths, options) => {
          childArgs.push((options as { args: string[] }).args);
          return { code: 0, signal: null };
        }
      })
    );

    expect(childArgs).toEqual([[]]);
  });

  it("prints canonical npx recovery and skips the CLI when the embedded executable is missing", async () => {
    const { main } = await loadWrapperModule();
    const errors: string[] = [];
    const start = vi.fn(async () => ({ code: 0, signal: null }));

    const code = await main(
      [],
      deps({
        isRegularFile: (path) => !path.endsWith("/Contents/MacOS/Infinite"),
        runEmbeddedCli: start,
        writeErr: (text) => errors.push(text)
      })
    );

    expect(code).toBe(1);
    expect(start).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("Run `npx infinite-os@latest`");
    expect(errors.join("")).not.toMatch(/docker|self-host|infinite local/i);
  });

  it("requires the embedded executable to be runnable", async () => {
    const { main } = await loadWrapperModule();
    const start = vi.fn(async () => ({ code: 0, signal: null }));

    const code = await main(
      [],
      deps({
        isExecutableFile: () => false,
        runEmbeddedCli: start
      })
    );

    expect(code).toBe(1);
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: 7, signal: null }, 7],
    [{ code: null, signal: "SIGINT" as NodeJS.Signals }, 130],
    [{ code: null, signal: "SIGTERM" as NodeJS.Signals }, 143],
    [{ code: null, signal: "SIGHUP" as NodeJS.Signals }, 1],
    [{ code: null, signal: null }, 1]
  ])(
    "maps embedded CLI result %j to process exit code %i",
    async (result, expected) => {
      const { main } = await loadWrapperModule();
      await expect(
        main([], deps({ runEmbeddedCli: async () => result }))
      ).resolves.toBe(expected);
    }
  );

  it("spawns the app executable with only the CLI script argument and ELECTRON_RUN_AS_NODE", async () => {
    const { runEmbeddedCli } = await loadWrapperModule();
    const tempRoot = mkdtempSync(join(tmpdir(), "infinite-wrapper-"));
    try {
      const executable = join(tempRoot, "Infinite.app/Contents/MacOS/Infinite");
      const cli = join(
        tempRoot,
        "Infinite.app/Contents/Resources/cli/infinite.mjs"
      );
      mkdirSync(join(tempRoot, "Infinite.app/Contents/MacOS"), {
        recursive: true
      });
      mkdirSync(join(tempRoot, "Infinite.app/Contents/Resources/cli"), {
        recursive: true
      });
      writeFileSync(executable, "");
      writeFileSync(cli, "");
      const spawn = vi.fn(() => {
        const child = new EventEmitter();
        process.nextTick(() => child.emit("close", 0, null));
        return child;
      });

      await runEmbeddedCli(
        { executable, cli },
        {
          env: { EXISTING: "1" },
          spawn
        }
      );

      expect(spawn).toHaveBeenCalledWith(executable, [cli], {
        env: { EXISTING: "1", ELECTRON_RUN_AS_NODE: "1" },
        stdio: "inherit"
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("shouldStartEmbeddedCli", () => {
  it("requires Darwin, installer success, all original TTY streams, non-help, and no --no-open", async () => {
    const { shouldStartEmbeddedCli } = await loadWrapperModule();

    expect(
      shouldStartEmbeddedCli({
        args: [],
        platform: "darwin",
        inputIsTTY: true,
        outputIsTTY: true,
        errorIsTTY: true,
        installerStatus: 0
      })
    ).toBe(true);

    expect(
      shouldStartEmbeddedCli({
        args: ["--no-open"],
        platform: "darwin",
        inputIsTTY: true,
        outputIsTTY: true,
        errorIsTTY: true,
        installerStatus: 0
      })
    ).toBe(false);
  });
});
