#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL_COMMAND = "npx infinite-os@latest";

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function childExitCode(result) {
  if (typeof result?.code === "number") return result.code;
  if (typeof result?.status === "number") return result.status;
  if (result?.signal) return signalExitCode(result.signal);
  return 1;
}

function defaultWriteErr(text) {
  process.stderr.write(text);
}

function defaultIsRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultIsExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveAppDirectory(args, env) {
  let appDirectory = env.INFINITE_APPLICATIONS_DIR || "/Applications";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--app-dir" && index + 1 < args.length) {
      appDirectory = args[index + 1];
      index += 1;
    }
  }
  return appDirectory;
}

export function shouldStartEmbeddedCli({
  args,
  platform,
  inputIsTTY,
  outputIsTTY,
  errorIsTTY,
  installerStatus
}) {
  const help = args.some((value) => value === "-h" || value === "--help");
  return (
    platform === "darwin" &&
    installerStatus === 0 &&
    inputIsTTY &&
    outputIsTTY &&
    errorIsTTY &&
    !help &&
    !args.includes("--no-open")
  );
}

function embeddedCliPaths(appDirectory) {
  const app = join(appDirectory, "Infinite.app");
  return {
    executable: join(app, "Contents", "MacOS", "Infinite"),
    cli: join(app, "Contents", "Resources", "cli", "infinite.mjs")
  };
}

export async function runEmbeddedCli(paths, deps = {}) {
  const childSpawn = deps.spawn ?? spawn;
  const childEnv = {
    ...(deps.env ?? process.env),
    ELECTRON_RUN_AS_NODE: "1"
  };

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = childSpawn(paths.executable, [paths.cli], {
        env: childEnv,
        stdio: "inherit"
      });
    } catch (error) {
      finish({ code: 1, signal: null, error });
      return;
    }

    child.on("error", (error) => finish({ code: 1, signal: null, error }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

export async function main(args = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const inputIsTTY = deps.inputIsTTY ?? Boolean(process.stdin.isTTY);
  const outputIsTTY = deps.outputIsTTY ?? Boolean(process.stdout.isTTY);
  const errorIsTTY = deps.errorIsTTY ?? Boolean(process.stderr.isTTY);
  const callerInteractive = inputIsTTY && outputIsTTY && errorIsTTY;
  const writeErr = deps.writeErr ?? defaultWriteErr;
  const runInstaller =
    deps.runInstaller ??
    ((installerArgs, options) => {
      const scriptPath = fileURLToPath(
        new URL("../install.sh", import.meta.url)
      );
      const script = readFileSync(scriptPath, "utf8");
      return spawnSync("/bin/bash", ["-s", "--", ...installerArgs], {
        input: script,
        stdio: ["pipe", "inherit", "inherit"],
        encoding: "utf8",
        env: options.env
      });
    });

  let installerResult;
  try {
    installerResult = runInstaller(args, {
      env: {
        ...env,
        INFINITE_INSTALL_SOURCE: "npm",
        INFINITE_INSTALL_INTERACTIVE: callerInteractive ? "1" : "0"
      }
    });
  } catch (error) {
    writeErr(
      `infinite-os: could not run the installer: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }

  if (installerResult?.error) {
    writeErr(
      `infinite-os: could not run the installer: ${installerResult.error.message}\n`
    );
    return 1;
  }

  const installerStatus = childExitCode(installerResult);
  if (
    !shouldStartEmbeddedCli({
      args,
      platform: deps.platform ?? process.platform,
      inputIsTTY,
      outputIsTTY,
      errorIsTTY,
      installerStatus
    })
  ) {
    return installerStatus;
  }

  const paths = embeddedCliPaths(resolveAppDirectory(args, env));
  const isRegularFile = deps.isRegularFile ?? defaultIsRegularFile;
  const isExecutableFile = deps.isExecutableFile ?? defaultIsExecutableFile;

  if (
    !isRegularFile(paths.executable) ||
    !isRegularFile(paths.cli) ||
    !isExecutableFile(paths.executable)
  ) {
    writeErr(
      `infinite-os: Infinite Desktop CLI was not found in the installed app.\nRun \`${INSTALL_COMMAND}\` to reinstall Infinite Desktop.\n`
    );
    return 1;
  }

  const startCli =
    deps.runEmbeddedCli ?? ((cliPaths) => runEmbeddedCli(cliPaths));
  const cliResult = await startCli(paths, { args: [] });
  return childExitCode(cliResult);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const code = await main();
  process.exit(code);
}
