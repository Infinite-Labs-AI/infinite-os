/**
 * FIX 2: Rollback test for uninstallInstallation.
 *
 * Isolated in its own file because vi.mock is hoisted to the top of the module
 * and needs a module-scoped counter that would conflict with other tests.
 *
 * Scenario: removeManagedFile succeeds on the first call (deletes clientComponentPath)
 * then throws on the second call (analyticsModulePath). The uninstall rollback must
 * restore the entrypoint and the first managed file to their post-apply state.
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"

import { applyInstallation } from "./apply.js"
import { inspectWorkspace } from "./inspect.js"
import { planInstallation } from "./plan.js"
import { uninstallInstallation } from "./uninstall.js"
import type { WorkspaceInstallArtifacts } from "./types.js"

// vi.mock is hoisted before imports; the factory closure captures a counter
// that is reset inside each test via the exported setter below.
let removeManagedFileCallCount = 0

vi.mock("./frameworks/managed-files.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./frameworks/managed-files.js")>()
  return {
    ...original,
    removeManagedFile(
      root: string,
      relativePath: string,
      dryRun: boolean
    ): ReturnType<typeof original.removeManagedFile> {
      removeManagedFileCallCount += 1
      if (removeManagedFileCallCount === 2) {
        throw new Error("Simulated mid-uninstall failure on second managed file removal")
      }
      return original.removeManagedFile(root, relativePath, dryRun)
    }
  }
})

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-uninstall-rollback-${name}-`))
  const target = join(targetRoot, name)
  tempRoots.push(targetRoot)
  cpSync(source, target, { recursive: true })
  return target
}

function applyFixture(root: string, artifacts: WorkspaceInstallArtifacts): void {
  const plan = planInstallation({
    root,
    inspect: inspectWorkspace(root),
    workspaceId: "ws_test",
    artifacts
  })
  applyInstallation({
    root,
    workspaceId: "ws_test",
    plan
  })
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("uninstallInstallation — FIX 2: rollback on mid-uninstall throw", () => {
  it("restores entrypoint and first managed file when second managed file removal throws", () => {
    const root = copyFixture("next-app-router-basic")
    applyFixture(root, {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" }
    })

    // Snapshot post-apply state — this is what rollback must restore
    const layoutAfterApply = readFileSync(join(root, "app/layout.tsx"), "utf8")
    const clientAfterApply = readFileSync(join(root, "lib/infinite-analytics-client.tsx"), "utf8")
    const analyticsAfterApply = readFileSync(join(root, "lib/infinite-analytics.ts"), "utf8")

    // Reset counter so the mock throws on the 2nd removeManagedFile call during uninstall
    // (call 1 = clientComponentPath deletion succeeds; call 2 = analyticsModulePath throws)
    removeManagedFileCallCount = 0

    expect(() => uninstallInstallation({ root })).toThrow(
      /Simulated mid-uninstall failure/
    )

    // The first managed file was deleted then restored by rollback
    expect(existsSync(join(root, "lib/infinite-analytics-client.tsx"))).toBe(true)
    expect(readFileSync(join(root, "lib/infinite-analytics-client.tsx"), "utf8")).toBe(
      clientAfterApply
    )

    // The entrypoint must be restored to post-apply state (wiring re-injected)
    expect(readFileSync(join(root, "app/layout.tsx"), "utf8")).toBe(layoutAfterApply)

    // The analytics module was never touched (throw happened before its removal)
    expect(readFileSync(join(root, "lib/infinite-analytics.ts"), "utf8")).toBe(analyticsAfterApply)

    // Manifest must still be present (rollback restored it)
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(true)
  })
})
