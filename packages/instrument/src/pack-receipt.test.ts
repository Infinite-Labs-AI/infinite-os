import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// Resolve the validator from THIS file's location, not process.cwd(), so the suite runs identically
// from the repo root (CI) and from the package dir (`pnpm --filter infinite-tag test`).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const validator = join(repoRoot, "scripts/ci/validate-infinite-tag-pack.mjs")
// LF4 close round 2 (P1-2): the file-count case reads the ceiling from the validator itself, so re-basing MAX_FILES can
// never leave this case under the limit (at 711 the old fixed 681 files passed the count and failed on the size instead).
const MAX_FILES = Number(/^const MAX_FILES = (\d+)$/m.exec(readFileSync(validator, "utf8"))?.[1])

interface PackFile {
  path: string
  size: number
  mode: number
}

interface PackReceipt {
  id: string
  name: string
  version: string
  size: number
  unpackedSize: number
  shasum: string
  integrity: string
  filename: string
  files: PackFile[]
}

function validReceipt(overrides: Partial<PackReceipt> = {}): PackReceipt[] {
  const required = [
    "LICENSE",
    "README.md",
    "contracts/browser-collect-v1.fixture.json",
    "contracts/browser-collect-v1.schema.json",
    "contracts/server-lane-v1.vectors.json",
    "contracts/host-class-v1.fixture.json",
    "contracts/host-deny-v1.json",
    "contracts/tag-wizard-v1/bridge-descriptor.example.json",
    "contracts/tag-wizard-v1/bridge-verbs.fixtures.json",
    "contracts/tag-wizard-v1/claims.schema.json",
    "contracts/tag-wizard-v1/receipts.fixtures.json",
    "contracts/tag-wizard-v1/report-v2.example.json",
    "contracts/tag-wizard-v1/review.schema.json",
    "contracts/tag-wizard-v1/run-state.example.json",
    "contracts/tag-wizard-v1/test-run.fixtures.json",
    "package.json"
  ]
  const paths = [
    ...required,
    ...Array.from({ length: 71 }, (_, index) => `dist/src/generated-${index}.js`)
  ]
  const files = paths.map((path) => ({ path, size: 1, mode: 0o644 }))
  files[0]!.size = 257_751 - (files.length - 1)
  return [
    {
      id: "infinite-tag@0.12.2",
      name: "infinite-tag",
      version: "0.12.2",
      size: 63_166,
      unpackedSize: 257_751,
      shasum: "47c19e69c6161cc327540d3cc83ed218085cdaf6",
      integrity: "sha512-test",
      filename: "infinite-tag-0.12.2.tgz",
      files,
      ...overrides
    }
  ]
}

function runValidator(receipt: unknown, raw = false) {
  const root = mkdtempSync(join(tmpdir(), "infinite-tag-pack-receipt-"))
  try {
    const receiptPath = join(root, "receipt.json")
    writeFileSync(receiptPath, raw ? String(receipt) : JSON.stringify(receipt))
    return spawnSync(process.execPath, [validator, receiptPath], { encoding: "utf8" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("npm 11 pack receipt validator", () => {
  it("accepts the expected synthetic 87-file receipt", () => {
    const result = runValidator(validReceipt())

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("infinite-tag-0.12.2.tgz")
    expect(result.stderr).toContain("87 files")
  })

  it("requires every wizard contract file (a missing one fails the pack)", () => {
    const receipt = validReceipt()
    const index = receipt[0]!.files.findIndex((file) => file.path === "contracts/tag-wizard-v1/review.schema.json")
    receipt[0]!.files[index] = { path: "dist/src/stand-in.js", size: 1, mode: 0o644 }

    const result = runValidator(receipt)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("contracts/tag-wizard-v1/review.schema.json")
  })

  it.each([
    ["unexpected contract", "contracts/unexpected.json"],
    ["traversal", "dist/src/../unexpected.js"],
    ["absolute", "/dist/src/unexpected.js"],
    ["C0 control character", "dist/src/\u0001unexpected.js"],
  ])("rejects an %s path", (_label, path) => {
    const receipt = validReceipt()
    receipt[0]!.files[5] = { path, size: 1, mode: 0o644 }

    const result = runValidator(receipt)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(JSON.stringify(path))
  })

  it("rejects duplicate paths", () => {
    const receipt = validReceipt()
    receipt[0]!.files.push({ ...receipt[0]!.files[5]! })

    const result = runValidator(receipt)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("duplicate")
  })

  it("rejects a declared unpacked size that differs from the exact file-size sum", () => {
    const result = runValidator(validReceipt({ unpackedSize: 257_750 }))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("does not equal computed unpacked size")
  })
})
