import { execFileSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(packageRoot, "../..")
const npm11 = ["--yes", "npm@11.19.0"]
const receiptValidator = resolve(repoRoot, "scripts/ci/validate-infinite-tag-pack.mjs")

function runNpm11(args: string[], cwd: string): string {
  return execFileSync("npx", [...npm11, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" }
  })
}

describe("npm 11 package tarball", () => {
  it("validates the real 112-file receipt and runs the installed bin", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "infinite-tag-tarball-"))

    try {
      const tempPackage = join(tempRoot, "packages/instrument")
      mkdirSync(dirname(tempPackage), { recursive: true })
      cpSync(packageRoot, tempPackage, {
        recursive: true,
        filter: (source) => source !== join(packageRoot, "dist") && !source.endsWith(".tgz")
      })
      cpSync(join(repoRoot, "tsconfig.base.json"), join(tempRoot, "tsconfig.base.json"))
      symlinkSync(join(repoRoot, "node_modules"), join(tempRoot, "node_modules"), "dir")

      const tarballsDir = join(tempRoot, "tarballs")
      mkdirSync(tarballsDir)
      const receiptText = runNpm11(
        ["pack", "--json", "--pack-destination", tarballsDir],
        tempPackage
      )
      const receiptPath = join(tempRoot, "receipt.json")
      writeFileSync(receiptPath, receiptText)
      const receipt = JSON.parse(receiptText) as Array<{
        files: Array<{ path: string }>
        filename: string
      }>
      expect(receipt).toHaveLength(1)
      expect(receipt[0]?.files).toHaveLength(112)

      const tarballName = execFileSync(process.execPath, [receiptValidator, receiptPath], {
        encoding: "utf8"
      }).trim()
      expect(tarballName).toBe(receipt[0]?.filename)
      const tarball = join(tarballsDir, tarballName)
      expect(existsSync(tarball)).toBe(true)

      const extracted = join(tempRoot, "extracted")
      mkdirSync(extracted)
      execFileSync("tar", ["-xzf", tarball, "-C", extracted])
      const packedManifest = JSON.parse(
        readFileSync(join(extracted, "package/package.json"), "utf8")
      ) as { bin?: Record<string, string> }
      expect(packedManifest.bin).toEqual({ "infinite-tag": "dist/src/cli.js" })
      expect(readFileSync(join(extracted, "package/dist/src/cli.js"), "utf8")).toMatch(
        /^#!\/usr\/bin\/env node/
      )
      expect(
        existsSync(join(extracted, "package/contracts/browser-collect-v1.schema.json"))
      ).toBe(true)
      expect(
        existsSync(join(extracted, "package/contracts/browser-collect-v1.fixture.json"))
      ).toBe(true)

      const consumer = join(tempRoot, "consumer")
      mkdirSync(consumer)
      writeFileSync(join(consumer, "package.json"), '{"name":"consumer","private":true}\n')
      runNpm11(["install", "--ignore-scripts", tarball], consumer)

      const installedManifest = JSON.parse(
        readFileSync(join(consumer, "node_modules/infinite-tag/package.json"), "utf8")
      ) as { bin?: Record<string, string> }
      expect(installedManifest.bin).toEqual({ "infinite-tag": "dist/src/cli.js" })

      const installedBin = join(consumer, "node_modules/.bin/infinite-tag")
      expect(existsSync(installedBin)).toBe(true)
      expect(execFileSync(installedBin, ["help"], { cwd: consumer, encoding: "utf8" })).toContain(
        "Usage: infinite-tag"
      )
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }, 120_000)
})
