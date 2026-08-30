#!/usr/bin/env node

import { readFileSync } from "node:fs";

const EXPECTED_PATHS = [
  "LICENSE",
  "README.md",
  "bin/infinite-os.mjs",
  "install.sh",
  "package.json",
];

function reject(message) {
  throw new Error(message);
}

function validate(receipt) {
  if (!Array.isArray(receipt) || receipt.length !== 1) {
    reject("npm pack receipt must contain exactly one package");
  }
  const entry = receipt[0];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) reject("invalid receipt entry");
  if (entry.name !== "infinite-os" || entry.version !== "1.0.0" || entry.id !== "infinite-os@1.0.0") {
    reject(`unexpected package identity: ${JSON.stringify(entry.id)}`);
  }
  if (entry.filename !== "infinite-os-1.0.0.tgz") reject("unexpected tarball filename");
  if (!Array.isArray(entry.files)) reject("receipt files must be an array");

  const paths = entry.files.map((file) => file?.path);
  if (JSON.stringify(paths) !== JSON.stringify(EXPECTED_PATHS)) {
    reject(`unexpected tarball files: ${JSON.stringify(paths)}`);
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 3_000 || entry.size > 20_000) {
    reject(`packed size out of bounds: ${JSON.stringify(entry.size)}`);
  }
  if (!Number.isSafeInteger(entry.unpackedSize) || entry.unpackedSize < 8_000 || entry.unpackedSize > 40_000) {
    reject(`unpacked size out of bounds: ${JSON.stringify(entry.unpackedSize)}`);
  }
  const bin = entry.files.find((file) => file.path === "bin/infinite-os.mjs");
  const installer = entry.files.find((file) => file.path === "install.sh");
  if (bin?.mode !== 0o755 || installer?.mode !== 0o755) reject("package entrypoints must be executable");

  process.stderr.write(
    `Validated ${entry.id}: ${entry.files.length} reviewed files, ${entry.size} packed bytes\n`,
  );
  process.stdout.write(`${entry.filename}\n`);
}

if (process.argv.length !== 3) {
  process.stderr.write(`Usage: ${process.argv[1]} <npm-pack-receipt.json>\n`);
  process.exitCode = 2;
} else {
  try {
    validate(JSON.parse(readFileSync(process.argv[2], "utf8")));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
