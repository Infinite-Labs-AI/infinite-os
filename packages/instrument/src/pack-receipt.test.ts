import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// Resolve the validator from THIS file's location, not process.cwd(), so the suite runs identically
// from the repo root (CI) and from the package dir (`pnpm --filter infinite-tag test`).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const validator = join(repoRoot, "scripts/ci/validate-infinite-tag-pack.mjs")

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
    "package.json"
  ]
  const paths = [
    ...required,
    ...Array.from({ length: 72 }, (_, index) => `dist/src/generated-${index}.js`)
  ]
  const files = paths.map((path) => ({ path, size: 1, mode: 0o644 }))
  files[0]!.size = 257_751 - (files.length - 1)
  return [
    {
      id: "infinite-tag@0.8.0",
      name: "infinite-tag",
      version: "0.8.0",
      size: 63_166,
      unpackedSize: 257_751,
      shasum: "47c19e69c6161cc327540d3cc83ed218085cdaf6",
      integrity: "sha512-test",
      filename: "infinite-tag-0.8.0.tgz",
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
  it("accepts the expected synthetic 78-file receipt", () => {
    const result = runValidator(validReceipt())

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("infinite-tag-0.8.0.tgz")
    expect(result.stderr).toContain("78 files")
  })

  it.each([
    ["unexpected contract", "contracts/unexpected.json"],
    ["traversal", "dist/src/../unexpected.js"],
    ["backslash", "dist\\src\\unexpected.js"],
    ["absolute", "/dist/src/unexpected.js"],
    ["C0 control character", "dist/src/\u0001unexpected.js"],
    ["C1 control character", "dist/src/\u0085unexpected.js"]
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

  it.each([
    ["name", { name: "not-infinite-tag" }, "package name"],
    ["version", { version: "0.3.0" }, "package version"],
    ["filename", { filename: "other.tgz" }, "tarball filename"]
  ])("rejects the wrong package %s", (_label, overrides, expectedError) => {
    const result = runValidator(validReceipt(overrides))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(expectedError)
  })

  it.each([
    [
      "file count",
      {
        files: Array.from({ length: 131 }, (_, index) => ({
          path: `dist/src/${index}.js`,
          size: 1,
          mode: 0o644
        }))
      },
      "file count"
    ],
    ["packed size", { size: 10_000_000 }, "packed size"],
    ["unpacked size", { unpackedSize: 10_000_000 }, "unpacked size"]
  ])("rejects excessive %s", (_label, overrides, expectedError) => {
    const result = runValidator(validReceipt(overrides))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(expectedError)
  })

  it("rejects a declared unpacked size that differs from the exact file-size sum", () => {
    const result = runValidator(validReceipt({ unpackedSize: 257_750 }))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("does not equal computed unpacked size")
  })

  it("rejects the reviewer's bounded declaration with a 61x500000 computed sum", () => {
    const receipt = validReceipt()
    receipt[0]!.unpackedSize = 200_000
    for (const file of receipt[0]!.files) file.size = 500_000

    const result = runValidator(receipt)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("computed unpacked size")
  })

  it.each([
    ["non-integer", 1.5],
    ["negative", -1],
    ["overflow", Number.MAX_SAFE_INTEGER + 1]
  ])("rejects a %s file size", (_label, size) => {
    const receipt = validReceipt()
    receipt[0]!.files[0]!.size = size

    const result = runValidator(receipt)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("safe non-negative integer")
  })

  it("rejects safe individual sizes whose aggregate overflows", () => {
    const receipt = validReceipt()
    receipt[0]!.files[0]!.size = Number.MAX_SAFE_INTEGER
    receipt[0]!.files[1]!.size = Number.MAX_SAFE_INTEGER

    const result = runValidator(receipt)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("aggregate file size overflows")
  })

  it("rejects malformed JSON", () => {
    const result = runValidator("{not-json", true)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("valid JSON")
  })
})
