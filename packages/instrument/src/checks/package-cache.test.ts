import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { npmrcPathValue, stablePackageCache } from "./package-cache.js"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs() })

it.each([
  ["/cache/store # comment", "/cache/store"], ["/cache/store ; comment", "/cache/store"],
  ['"/cache/hash # literal" # comment', "/cache/hash # literal"], ["'/cache/semi ; literal' ; comment", "/cache/semi ; literal"],
  ["/cache/escaped\\#part", "/cache/escaped#part"]
])("parses the public store path %s without treating comments as path bytes", (source, expected) => {
  expect(npmrcPathValue(source)).toBe(expected)
})

it("queries the same configured pnpm store and passes it explicitly without unrelated environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "r6-cache-")); roots.push(root)
  const store = join(root, "cache # literal")
  writeFileSync(join(root, ".npmrc"), `store-dir="${store}" # comment\n`)
  vi.stubEnv("npm_config_store_dir", "")
  vi.stubEnv("NPM_TOKEN", "fixture-value-not-for-child")
  const cache = await stablePackageCache({ manager: "pnpm", root, appRoot: root, deny: { paths: [], prefixes: [] }, spawn: async (_command, args, options) => {
    expect(args).toEqual(["store", "path", "--store-dir", store])
    expect(options.network).toBe(false)
    expect(options.env).not.toHaveProperty("NPM_TOKEN")
    return { exitCode: 0, stdout: `${store}/v10\n`, stderr: "", signal: null, timedOut: false, aborted: false, sandboxed: true, pid: 1, home: "/tmp/fixture", stdoutTruncated: false, stderrTruncated: false }
  } })
  expect(cache.args).toEqual(["--store-dir", store])
})
