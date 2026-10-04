import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

// End-to-end through the BUILT CLI binary (npx/global-install parity), exercising all
// five providers on the multi-page static fixture. Requires a fresh build.
const here = dirname(fileURLToPath(import.meta.url))
const builtCli = join(here, "../dist/src/cli.js")
const fixtureRoot = join(here, "../test/fixtures")
const PAGES = ["index.html", "about.html", "privacy/index.html"]

const tempRoots: string[] = []

function copyFixture(name: string): string {
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-e2e-${name}-`))
  const target = join(targetRoot, name)
  tempRoots.push(targetRoot)
  cpSync(join(fixtureRoot, name), target, { recursive: true })
  return target
}

function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>()
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolutePath = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(absolutePath)
        continue
      }
      snapshot.set(relative(root, absolutePath), readFileSync(absolutePath, "utf8"))
    }
  }
  walk(root)
  return snapshot
}

function runBuiltCli(args: string[]): void {
  // An empty artifacts dir keeps a bare install from discovering the dev's real
  // ~/.infinite/artifacts. Non-git temp dir ⇒ the dirty-tree gate never fires.
  const emptyArtifactsDir = mkdtempSync(join(tmpdir(), "instrument-e2e-artifacts-"))
  tempRoots.push(emptyArtifactsDir)
  execFileSync(process.execPath, [builtCli, ...args], {
    encoding: "utf8",
    env: { ...process.env, INFINITE_ARTIFACTS_DIR: emptyArtifactsDir }
  })
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("built CLI e2e — multipage, all five providers", () => {
  it("wires every page with all five providers, then uninstall restores byte-exact", () => {
    if (!existsSync(builtCli)) {
      throw new Error(
        `Build the package before running this test — missing ${builtCli}. Run: pnpm -C packages/instrument run build`
      )
    }

    const root = copyFixture("static-html-multipage")
    const before = snapshotTree(root)

    runBuiltCli([
      "install",
      "--root", root,
      "--workspace", "ws_e2e_pixel",
      "--infinite-site-source-key", "site_public_e2e",
      "--infinite-production-host", "example.com",
      "--infinite-static-proxy", "vercel",
      "--infinite-consent-mode", "required",
      "--ga4-measurement-id", "G-E2E12345",
      "--posthog-project-key", "phc_e2e0123456789",
      "--posthog-api-host", "https://us.i.posthog.com",
      "--x-pixel-id", "o1abc",
      "--x-event-tag-id", "tw-e2e-1",
      "--meta-pixel-id", "1234567890123456",
      "--yes"
    ])

    // Every page carries all five providers.
    for (const page of PAGES) {
      const html = readFileSync(join(root, page), "utf8")
      // shared runtime — present on EVERY page, self-contained and source-bound
      expect(html).toContain("data-infinite-runtime")
      expect(html).toContain("site_public_e2e")
      expect(html).toContain("/infinite/ledger")
      expect(html).not.toContain("app.ultima.inc")
      expect(html).not.toMatch(/\/tracking\/|\/sdk\//)
      // ga4 / posthog / x
      expect(html).toContain("G-E2E12345")
      expect(html).toContain("phc_e2e0123456789")
      expect(html).toContain("o1abc")
      // meta — id was given, so it is present
      expect(html).toContain("connect.facebook.net/en_US/fbevents.js")
      expect(html).toContain("1234567890123456")
      // exactly one managed block per page
      expect(html.match(/infinite:start/g)).toHaveLength(1)
    }

    // Manifest records all five providers.
    const manifest = JSON.parse(readFileSync(join(root, ".infinite/install.json"), "utf8"))
    expect(manifest.providers.sort()).toEqual(["ga4", "infinite", "meta", "posthog", "x"])

    // Uninstall restores the tree byte-for-byte.
    runBuiltCli(["uninstall", "--root", root, "--yes"])
    const after = snapshotTree(root)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [path, content] of before) {
      expect(after.get(path)).toBe(content)
    }
    expect(existsSync(join(root, ".infinite"))).toBe(false)
  })

  it("omits the Meta pixel on every page when no --meta-pixel-id is passed", () => {
    if (!existsSync(builtCli)) {
      throw new Error(`Build the package before running this test — missing ${builtCli}.`)
    }

    const root = copyFixture("static-html-multipage")
    runBuiltCli([
      "install",
      "--root", root,
      "--workspace", "ws_e2e_pixel",
      "--ga4-measurement-id", "G-E2E12345",
      "--yes"
    ])

    for (const page of PAGES) {
      const html = readFileSync(join(root, page), "utf8")
      // 0.6.0: GA4 installs natively; with no Infinite source there is NO Infinite runtime at all
      // (the dormant mirror runtime is gone with mirror mode).
      expect(html).not.toContain("data-infinite-runtime")
      expect(html).toContain("G-E2E12345")
      expect(html).not.toContain("site_public")
      // meta absent — no pixel id given
      expect(html).not.toContain("fbevents.js")
    }
  })
})
