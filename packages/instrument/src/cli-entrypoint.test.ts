import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// Regression guard for the npx/.bin-symlink entrypoint bug: npx invokes the binary
// through node_modules/.bin/<name>, a symlink to dist/src/cli.js, so process.argv[1]
// is the symlink path and NOT this module's real path. The old endsWith() guard failed
// there and the CLI silently no-op'd (exit 0, no output, no file changes). This spawns
// the BUILT bin both ways and asserts it actually runs.
const here = dirname(fileURLToPath(import.meta.url))
const builtCli = join(here, "../dist/src/cli.js")

describe("cli entrypoint", () => {
  it("runs when invoked through a bin symlink (npx), not just the real path", () => {
    if (!existsSync(builtCli)) {
      throw new Error(
        `Build the package before running this test — missing ${builtCli}. Run: pnpm -C packages/instrument run build`
      )
    }

    const binDir = mkdtempSync(join(tmpdir(), "infinite-tag-bin-"))
    const link = join(binDir, "infinite-tag")
    symlinkSync(builtCli, link)

    const viaSymlink = execFileSync(process.execPath, [link, "help"], { encoding: "utf8" })
    expect(viaSymlink).toContain("Usage: infinite-tag")

    const viaRealPath = execFileSync(process.execPath, [builtCli, "help"], { encoding: "utf8" })
    expect(viaRealPath).toContain("Usage: infinite-tag")
  })
})
