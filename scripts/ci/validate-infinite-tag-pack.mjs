#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { posix } from "node:path"

const EXPECTED_NAME = "infinite-tag"
const EXPECTED_VERSION = "0.6.2"
const EXPECTED_FILENAME = "infinite-tag-0.6.2.tgz"
const MIN_FILES = 50
const MAX_FILES = 80
const MIN_PACKED_SIZE = 40_000
const MAX_PACKED_SIZE = 150_000
const MIN_UNPACKED_SIZE = 200_000
const MAX_UNPACKED_SIZE = 500_000
const REQUIRED_FILES = [
  "LICENSE",
  "README.md",
  "contracts/browser-collect-v1.fixture.json",
  "contracts/browser-collect-v1.schema.json",
  "contracts/server-lane-v1.vectors.json",
  "package.json"
]

function reject(message) {
  throw new Error(message)
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(`${label} must be an object`)
  }
  return value
}

function requireBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    reject(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
}

function requireSafeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    reject(`${label} must be a safe non-negative integer`)
  }
}

function validatePath(path) {
  const rendered = JSON.stringify(path)
  if (typeof path !== "string" || path === "") reject(`Invalid pack path ${rendered}`)
  if (/\p{Cc}/u.test(path)) {
    reject(`Invalid pack path ${rendered}: control characters are forbidden`)
  }
  if (path.includes("\\")) reject(`Invalid pack path ${rendered}: backslashes are forbidden`)
  if (posix.isAbsolute(path)) reject(`Invalid pack path ${rendered}: absolute paths are forbidden`)

  const components = path.split("/")
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    reject(`Invalid pack path ${rendered}: empty, dot, and traversal components are forbidden`)
  }
  if (posix.normalize(path) !== path) {
    reject(`Invalid pack path ${rendered}: normalized path differs from raw path`)
  }

  const allowed =
    (path.startsWith("dist/src/") && path.length > "dist/src/".length) ||
    path === "package.json" ||
    path === "README.md" ||
    path === "LICENSE" ||
    path === "contracts/browser-collect-v1.schema.json" ||
    path === "contracts/browser-collect-v1.fixture.json" ||
    path === "contracts/server-lane-v1.vectors.json"
  if (!allowed) reject(`Unexpected pack file ${rendered}`)
}

function validateReceipt(parsed) {
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    reject("npm pack receipt must contain exactly one package")
  }
  const entry = requireObject(parsed[0], "npm pack receipt entry")

  if (entry.name !== EXPECTED_NAME) reject(`Unexpected package name: ${JSON.stringify(entry.name)}`)
  if (entry.version !== EXPECTED_VERSION) {
    reject(`Unexpected package version: ${JSON.stringify(entry.version)}`)
  }
  if (entry.id !== `${EXPECTED_NAME}@${EXPECTED_VERSION}`) {
    reject(`Unexpected package id: ${JSON.stringify(entry.id)}`)
  }
  if (entry.filename !== EXPECTED_FILENAME) {
    reject(`Unexpected tarball filename: ${JSON.stringify(entry.filename)}`)
  }
  requireBoundedInteger(entry.size, MIN_PACKED_SIZE, MAX_PACKED_SIZE, "packed size")
  requireBoundedInteger(
    entry.unpackedSize,
    MIN_UNPACKED_SIZE,
    MAX_UNPACKED_SIZE,
    "unpacked size"
  )
  if (!Array.isArray(entry.files)) reject("npm pack receipt files must be an array")
  requireBoundedInteger(entry.files.length, MIN_FILES, MAX_FILES, "file count")

  const paths = new Set()
  let computedUnpackedSize = 0
  for (const [index, rawFile] of entry.files.entries()) {
    const file = requireObject(rawFile, `npm pack file ${index}`)
    validatePath(file.path)
    if (paths.has(file.path)) reject(`Invalid pack path ${JSON.stringify(file.path)}: duplicate`)
    paths.add(file.path)
    requireSafeNonNegativeInteger(file.size, `size for ${JSON.stringify(file.path)}`)
    const nextUnpackedSize = computedUnpackedSize + file.size
    if (!Number.isSafeInteger(nextUnpackedSize)) reject("aggregate file size overflows")
    computedUnpackedSize = nextUnpackedSize
  }
  requireBoundedInteger(
    computedUnpackedSize,
    MIN_UNPACKED_SIZE,
    MAX_UNPACKED_SIZE,
    "computed unpacked size"
  )
  if (entry.unpackedSize !== computedUnpackedSize) {
    reject(
      `Declared unpacked size ${entry.unpackedSize} does not equal computed unpacked size ` +
        `${computedUnpackedSize}`
    )
  }
  for (const required of REQUIRED_FILES) {
    if (!paths.has(required)) reject(`Required pack file is missing: ${JSON.stringify(required)}`)
  }

  process.stderr.write(
    `Validated npm pack receipt: ${entry.name}@${entry.version}, ${entry.files.length} files, ` +
      `${entry.size} packed bytes, ${entry.unpackedSize} unpacked bytes\n`
  )
  process.stdout.write(`${entry.filename}\n`)
}

if (process.argv.length !== 3) {
  process.stderr.write(`Usage: ${process.argv[1]} <npm-pack-receipt.json>\n`)
  process.exitCode = 2
} else {
  try {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(process.argv[2], "utf8"))
    } catch {
      reject("npm pack receipt must be valid JSON")
    }
    validateReceipt(parsed)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
