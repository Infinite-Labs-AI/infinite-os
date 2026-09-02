import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { uninstallInstallation } from "../uninstall.js"

import { parseHarnessArgs } from "./args.js"
import { PROPOSED_CONVERSIONS_RELATIVE_PATH } from "./marking.js"
import { runHarness, type HarnessIo } from "./run.js"

const tempRoots: string[] = []
const here = dirname(fileURLToPath(import.meta.url))
const PAGE = `<!doctype html>\n<html>\n<head></head>\n<body>\n<a href="/signup">Start</a>\n</body>\n</html>\n`

function copyFixture(name: string): string {
  const targetRoot = mkdtempSync(join(tmpdir(), `harness-uninstall-${name}-`))
  tempRoots.push(targetRoot)
  const target = join(targetRoot, name)
  cpSync(join(here, "../../test/fixtures", name), target, { recursive: true })
  return target
}
function write(root: string, relativePath: string, contents: string): void {
  mkdirSync(dirname(join(root, relativePath)), { recursive: true })
  writeFileSync(join(root, relativePath), contents)
}
const quiet: HarnessIo = { interactive: false, out: () => {}, err: () => {}, confirm: async () => false }
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

describe("uninstall reverses the harness too", () => {
  it("dry run lists the marks and outputs; --yes unmarks, removes .infinite/* and the .gitignore block", async () => {
    const root = copyFixture("static-html-basic")
    write(root, "index.html", PAGE)
    write(root, ".gitignore", "node_modules\n")
    await runHarness(parseHarnessArgs(["--plan", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1"]), quiet, { discover: () => null })
    await runHarness(parseHarnessArgs(["--apply", "--yes", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1", "--conversions", PROPOSED_CONVERSIONS_RELATIVE_PATH]), quiet, { discover: () => null })
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain("data-analytics-cta-id")
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain("G-NEW00001")

    const preview = uninstallInstallation({ root, dryRun: true })
    expect(preview.restoredFiles).toContain("index.html")
    expect(preview.restoredFiles).toContain(".gitignore")
    expect(preview.removedFiles).toContain(".infinite/REPORT.md")
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain("data-analytics-cta-id")

    const result = uninstallInstallation({ root, dryRun: false, allowDirty: true })
    expect(result.warnings).toEqual([])
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe(PAGE)
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules\n")
    expect(existsSync(join(root, ".infinite"))).toBe(false)
  })

  it("with no managed install, a --plan run's outputs still come off", async () => {
    const root = copyFixture("static-html-basic")
    write(root, "index.html", PAGE)
    await runHarness(parseHarnessArgs(["--plan", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1"]), quiet, { discover: () => null })
    expect(existsSync(join(root, PROPOSED_CONVERSIONS_RELATIVE_PATH))).toBe(true)
    const result = uninstallInstallation({ root, dryRun: false, allowDirty: true })
    expect(result.manifestPath).toBeNull()
    expect(result.removedFiles).toContain(PROPOSED_CONVERSIONS_RELATIVE_PATH)
    expect(existsSync(join(root, ".infinite"))).toBe(false)
    expect(existsSync(join(root, ".gitignore"))).toBe(false)
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe(PAGE)
  })
})
