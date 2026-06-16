import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { applyInstallation } from "./apply.js"
import { inspectWorkspace } from "./inspect.js"
import { planInstallation } from "./plan.js"
import { verifyInstallation } from "./verify.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-verify-${name}-`))
  const target = join(targetRoot, name)
  tempRoots.push(targetRoot)
  cpSync(source, target, { recursive: true })
  return target
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

function installViteFixture(root: string): void {
  const inspect = inspectWorkspace(root)
  const plan = planInstallation({
    root,
    inspect,
    workspaceId: "ws_test",
    artifacts: {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" }
    }
  })

  applyInstallation({
    root,
    workspaceId: "ws_test",
    plan
  })
}

describe("verifyInstallation", () => {
  it("verifies manifest-backed managed files after a supported install", () => {
    const root = copyFixture("vite-react-basic")
    installViteFixture(root)

    const result = verifyInstallation({ root })

    expect(result.buildOk).toBe(true)
    expect(result.routeChecks[0]).toContain("Manifest loaded for vite-react")
    expect(result.routeChecks.join("\n")).toContain("Verified")
    expect(result.routeChecks.join("\n")).not.toContain("drifted")
    expect(result.beaconChecks).toEqual([
      "ga4: manifest-backed wiring is present in the managed install files.",
      "posthog: manifest-backed wiring is present in the managed install files."
    ])
  })

  it("refuses a tampered manifest whose files escape the workspace root", () => {
    const root = copyFixture("vite-react-basic")
    installViteFixture(root)

    const manifestPath = join(root, ".infinite/install.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: string[] }
    manifest.files = [...manifest.files, "../outside.txt"]
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    expect(() => verifyInstallation({ root })).toThrow(/escapes the workspace root/)
  })

  it("refuses a tampered manifest whose appRoot escapes the workspace root", () => {
    const root = copyFixture("vite-react-basic")
    installViteFixture(root)

    const manifestPath = join(root, ".infinite/install.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { appRoot: string }
    manifest.appRoot = "../../elsewhere"
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    expect(() => verifyInstallation({ root })).toThrow(/escapes the workspace root/)
  })

  it("fails verification when a managed file drifts from the manifest", () => {
    const root = copyFixture("vite-react-basic")
    installViteFixture(root)

    const analyticsPath = join(root, "src/lib/infinite-analytics.ts")
    writeFileSync(analyticsPath, `${readFileSync(analyticsPath, "utf8")}\n// drifted after install\n`)

    const result = verifyInstallation({ root })

    expect(result.buildOk).toBe(false)
    expect(result.routeChecks).toContain(
      "Managed file content drifted from manifest: src/lib/infinite-analytics.ts"
    )
  })
})
