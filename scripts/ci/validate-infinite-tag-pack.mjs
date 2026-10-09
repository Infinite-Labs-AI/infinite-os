#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { posix } from "node:path"

const EXPECTED_NAME = "infinite-tag"
const EXPECTED_VERSION = "0.12.2"
const EXPECTED_FILENAME = "infinite-tag-0.12.2.tgz"
// SUPPLY-CHAIN TRIPWIRE BOUNDS, not a budget. They exist to catch a tarball that suddenly contains
// something it should not — a node_modules tree, a stray build directory, a leaked archive — which
// shows up as an order-of-magnitude jump, never as a few percent. They are NOT a size target: the
// package is expected to grow as infinite-tag grows, and the ceilings are re-based when it does.
//
// Measured after the Vite index.html-injection pivot (npm 11 pack of packages/instrument): 116 files
// (the new frameworks/managed-html.ts adds a .js + .d.ts). The unpacked figure crossed the previous
// 800,000 ceiling once #16/#17/#18/#19 landed on main, which is what turned CI red — not any one PR.
//
// Re-based to ~1.5x the measured size, matching how these moved together before
// (150k→250k packed and 500k→800k unpacked in one commit): enough headroom for the next few
// features, still one to two orders of magnitude below anything an accidental directory would add.
//
// MAX_FILES has moved on its own schedule (80 → 110 → 130 → 170) because it measures a different
// accident — a whole directory getting included. The setup checks (src/setup-checks/) add eight
// published modules, .js + .d.ts each: 130 → 146 measured, so the ceiling goes to 170 to keep the
// same ~1.15x headroom for source growth rather than sitting on the measurement.
//
// Wizard build (lane I1, 2026-10-02): re-measured on the integrated tarball (npm pack of
// packages/instrument at the integration head): 587 files, 1,090,001 bytes packed, 3,911,018 bytes
// unpacked. F0's provisional ceilings (560 / 1,300,000 / 4,200,000) are re-based to measured x1.15:
// 675 files (587 x 1.15 = 675.05), 1,254,000 packed (1,253,501 rounded up), 4,498,000 unpacked
// (4,497,671 rounded up). Packed went DOWN from F0's guess; files and unpacked went up.
//
// Offline E2E (lane I1b, 2026-10-02): the fixes it forced add one module (src/wizard/item-t0, .js +
// .d.ts). Re-measured: 589 files, 1,094,403 bytes packed, 3,924,183 bytes unpacked; tightened to measured
// x1.15: 678 files (677.35 rounded up), 1,259,000 packed (1,258,564 rounded up), 4,513,000 unpacked
// (4,512,811 rounded up). The E2E itself (test/wizard/, the fixture site) is never packed.
//
// I1 fix round (2026-10-02): the job-table S checks (src/checks/job-static, .js + .d.ts) add one module.
// Re-measured: 591 files, 1,119,017 bytes packed, 4,012,232 bytes unpacked; tightened to measured x1.15:
// 680 files (679.65 rounded up), 1,287,000 packed (1,286,870 rounded up), 4,615,000 unpacked (4,614,067
// rounded up).
//
// Live-fix 4 round 1 (2026-10-04): the live-run fixes since (the T0 page model in src/t0/inline-scripts, the
// wizard's _fbc capture edit, the GA4 realtime contract, the triage's code reads) crossed the packed ceiling.
// Re-measured: 618 files, 1,287,308 bytes packed, 4,603,511 bytes unpacked; re-based to measured x1.15: 711 files
// (710.7 rounded up), 1,481,000 packed (1,480,404 rounded up), 5,295,000 unpacked (5,294,038 rounded up).
//
// Commerce rebuild (2026-10-08): the event inventory, the commerce checks, the one outcome helper with its Stripe and
// lead recipes, the owner hand-off, the server-conversion briefs and the shop-event proof crossed the packed and
// unpacked ceilings. Re-measured: 706 files, 1,529,978 bytes packed, 5,470,245 bytes unpacked; re-based to measured
// x1.15: 812 files (811.9 rounded up), 1,760,000 packed (1,759,474.7 rounded up), 6,291,000 unpacked (6,290,781.75
// rounded up).
const MIN_FILES = 50
const MAX_FILES = 812
const MIN_PACKED_SIZE = 40_000
const MAX_PACKED_SIZE = 1_760_000
const MIN_UNPACKED_SIZE = 200_000
const MAX_UNPACKED_SIZE = 6_291_000
// The wizard's public contracts (1bu-1 vendors them and pins their sha256). Listed exactly, so a stray
// file under contracts/ still fails the pack.
const TAG_WIZARD_CONTRACT_FILES = [
  "contracts/host-class-v1.fixture.json",
  "contracts/host-deny-v1.json",
  "contracts/tag-wizard-v1/bridge-descriptor.example.json",
  "contracts/tag-wizard-v1/bridge-verbs.fixtures.json",
  "contracts/tag-wizard-v1/claims.schema.json",
  "contracts/tag-wizard-v1/receipts.fixtures.json",
  "contracts/tag-wizard-v1/report-v2.example.json",
  "contracts/tag-wizard-v1/review.schema.json",
  "contracts/tag-wizard-v1/run-state.example.json",
  "contracts/tag-wizard-v1/test-run.fixtures.json"
]
const REQUIRED_FILES = [
  "LICENSE",
  "README.md",
  "contracts/browser-collect-v1.fixture.json",
  "contracts/browser-collect-v1.schema.json",
  "contracts/server-lane-v1.vectors.json",
  ...TAG_WIZARD_CONTRACT_FILES,
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
    path === "contracts/server-lane-v1.vectors.json" ||
    TAG_WIZARD_CONTRACT_FILES.includes(path)
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
