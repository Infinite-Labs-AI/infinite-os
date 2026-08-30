#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function fail(message) {
  process.stderr.write(`infinite-os: ${message}\n`);
  process.exit(1);
}

const installerArgs = process.argv.slice(2);
const helpOnly = installerArgs.some((argument) => argument === "-h" || argument === "--help");

if (process.platform !== "darwin" && !helpOnly) {
  fail(`Infinite is a macOS-only app. This installer does not support ${process.platform}.`);
}

let script;
try {
  script = readFileSync(fileURLToPath(new URL("../install.sh", import.meta.url)), "utf8");
} catch (error) {
  fail(`could not read the bundled installer: ${error instanceof Error ? error.message : String(error)}`);
}

const result = spawnSync("/bin/bash", ["-s", "--", ...installerArgs], {
  input: script,
  stdio: ["pipe", "inherit", "inherit"],
  encoding: "utf8",
  env: { ...process.env, INFINITE_INSTALL_SOURCE: "npm" },
});

if (result.error) {
  fail(`could not run the installer: ${result.error.message}`);
}
process.exit(result.status ?? 1);
