import { execFileSync, spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(packageRoot, "../..")
const npm11 = ["--yes", "npm@11.19.0"]
const receiptValidator = resolve(repoRoot, "scripts/ci/validate-infinite-tag-pack.mjs")

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
}

/**
 * The tarball's exact file list, DERIVED from the source tree instead of pinned to a count (which
 * every wizard lane would otherwise conflict on): for each non-test `src/**\/*.ts`, its `dist/src`
 * `.js` and `.d.ts` (tsconfig.build.json excludes only `src/**\/*.test.ts`, and sourcemaps are off);
 * every file under `contracts/`; and the three root files npm adds (package.json, README.md, LICENSE).
 * Confirmed against the 154-file receipt before the wizard build (74 modules × 2 + 3 contracts + 3).
 * A stray directory, a leaked test, a sourcemap or a missing contract all break set equality.
 */
function expectedPackPaths(): string[] {
  const modules = filesUnder(join(packageRoot, "src")).filter(
    (path) => path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts")
  )
  return [
    ...modules.flatMap((path) => [`dist/src/${path.replace(/\.ts$/, ".js")}`, `dist/src/${path.replace(/\.ts$/, ".d.ts")}`]),
    ...filesUnder(join(packageRoot, "contracts")).map((path) => `contracts/${path}`),
    "LICENSE",
    "README.md",
    "package.json"
  ].sort()
}

function runNpm11(args: string[], cwd: string): string {
  return execFileSync("npx", [...npm11, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" }
  })
}

describe("npm 11 package tarball", () => {
  it("validates the real receipt (exactly the derived file list) and runs the installed bin", () => {
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
      // Set equality against the derived list (see expectedPackPaths), not a pinned count: the guard
      // against an accidental directory stays, with no per-lane number to conflict on.
      expect(receipt[0]?.files.map((file) => file.path).sort()).toEqual(expectedPackPaths())

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
      expect(existsSync(join(extracted, "package/contracts/tag-wizard-v1/bridge-verbs.fixtures.json"))).toBe(true)
      expect(existsSync(join(extracted, "package/contracts/host-deny-v1.json"))).toBe(true)
      expect(existsSync(join(extracted, "package/contracts/host-class-v1.json"))).toBe(true)
      // The PostHog-derived wizard code ships PostHog's MIT notice in the packed LICENSE.
      const packedLicense = readFileSync(join(extracted, "package/LICENSE"), "utf8")
      expect(packedLicense).toContain("Copyright (c) 2025 PostHog")
      expect(packedLicense).toContain("Permission is hereby granted")

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
      writeFileSync(join(consumer, "index.html"), "<html><head><script>if(window.fbq)fbq('track','Lead')</script></head></html>")
      const env = { ...process.env, INFINITE_ARTIFACTS_DIR: join(tempRoot, "empty-artifacts") }
      const check = spawnSync(installedBin, ["harness", "--check", "--json", "--root", consumer], {cwd:consumer,encoding:"utf8",env})
      expect(check.status, check.stderr).toBe(0)
      expect(JSON.parse(check.stdout).providers.find((row: {provider:string}) => row.provider === "meta").state).not.toBe("adopted")
      const verify = spawnSync(installedBin, ["harness", "--verify-only", "--json", "--url", "https://example.com", "--root", consumer], {cwd:consumer,encoding:"utf8",env})
      expect(verify.status, verify.stderr).toBe(1)
      expect(JSON.parse(verify.stdout).failure.code).toBe("INF_VERIFY_INCOMPLETE")

    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }, 120_000)
})
