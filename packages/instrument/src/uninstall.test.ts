import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { applyInstallation } from "./apply.js"
import { inspectWorkspace } from "./inspect.js"
import { planInstallation } from "./plan.js"
import { uninstallInstallation } from "./uninstall.js"
import type { WorkspaceInstallArtifacts } from "./types.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-uninstall-${name}-`))
  const target = join(targetRoot, name)
  tempRoots.push(targetRoot)
  cpSync(source, target, { recursive: true })
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

function expectTreeEquals(root: string, expected: Map<string, string>): void {
  const actual = snapshotTree(root)
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort())
  for (const [path, content] of expected) {
    expect(actual.get(path)).toBe(content)
  }
}

function gitRun(root: string, args: string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null"
    }
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  }
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

const roundTripCases: Array<{ fixture: string; artifacts: WorkspaceInstallArtifacts }> = [
  {
    fixture: "static-html-basic",
    artifacts: {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" },
      x: { pixelId: "tw-pixel-123", eventTagIds: ["tw-event-1"] }
    }
  },
  {
    fixture: "vite-react-basic",
    artifacts: {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" }
    }
  },
  {
    fixture: "next-app-router-basic",
    artifacts: {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" }
    }
  },
  {
    fixture: "next-pages-router-basic",
    artifacts: {
      ga4: { measurementId: "G-TEST123" },
      x: { pixelId: "tw-pixel-123", eventTagIds: ["tw-event-1"] }
    }
  }
]

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("uninstallInstallation", () => {
  for (const { fixture, artifacts } of roundTripCases) {
    it(`restores a byte-identical tree after apply then uninstall for ${fixture}`, () => {
      const root = copyFixture(fixture)
      const before = snapshotTree(root)

      applyFixture(root, artifacts)
      uninstallInstallation({ root })

      expectTreeEquals(root, before)
      expect(existsSync(join(root, ".infinite"))).toBe(false)
    })
  }

  it("reports a dry-run plan without touching the tree or manifest", () => {
    const root = copyFixture("next-app-router-basic")
    applyFixture(root, {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" }
    })
    const afterApply = snapshotTree(root)

    const result = uninstallInstallation({ root, dryRun: true })

    expect(result.removedFiles).toContain(".infinite/install.json")
    expect(result.removedFiles.length).toBeGreaterThan(1)
    expect(result.restoredFiles.length).toBeGreaterThan(0)
    expectTreeEquals(root, afterApply)
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(true)
  })

  it("is idempotent when no manifest is present", () => {
    const root = copyFixture("static-html-basic")
    applyFixture(root, {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" },
      x: { pixelId: "tw-pixel-123", eventTagIds: ["tw-event-1"] }
    })
    uninstallInstallation({ root })

    const second = uninstallInstallation({ root })

    expect(second.warnings).toContain(
      "No .infinite/install.json manifest found. Nothing to uninstall."
    )
    expect(second.manifestPath).toBeNull()
    expect(second.removedFiles).toEqual([])
    expect(second.restoredFiles).toEqual([])
  })

  it("refuses to remove a drifted managed file and leaves the install intact", () => {
    const root = copyFixture("next-app-router-basic")
    applyFixture(root, {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" }
    })

    const analyticsPath = join(root, "lib/infinite-analytics.ts")
    writeFileSync(analyticsPath, "export const drifted = true\n")

    expect(() => uninstallInstallation({ root })).toThrow(/Refusing to remove/)
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(true)
    expect(existsSync(join(root, "lib/infinite-analytics-client.tsx"))).toBe(true)
  })

  it("preserves founder edits that follow the managed wiring", () => {
    const root = copyFixture("next-app-router-basic")
    applyFixture(root, {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" }
    })

    const layoutPath = join(root, "app/layout.tsx")
    appendFileSync(layoutPath, "// founder note\n")

    uninstallInstallation({ root })

    const layout = readFileSync(layoutPath, "utf8")
    expect(layout).not.toContain("InfiniteAnalyticsClient")
    expect(layout.endsWith("// founder note\n")).toBe(true)
  })

  it("gates uninstall on a dirty git tree unless allow-dirty or dry-run", () => {
    const root = copyFixture("static-html-basic")
    gitRun(root, ["init"])
    gitRun(root, ["add", "-A"])
    gitRun(root, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "init"
    ])

    const committed = snapshotTree(root)

    applyFixture(root, {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" },
      x: { pixelId: "tw-pixel-123", eventTagIds: ["tw-event-1"] }
    })

    expect(() => uninstallInstallation({ root })).toThrow(
      "Refusing to uninstall on a dirty git tree without --allow-dirty."
    )
    expect(() => uninstallInstallation({ root, dryRun: true })).not.toThrow()

    uninstallInstallation({ root, allowDirty: true })

    expectTreeEquals(root, committed)
    expect(existsSync(join(root, ".infinite"))).toBe(false)
  })
})

describe("uninstallInstallation — manifest confinement (tampered .infinite/install.json)", () => {
  function tamperManifest(root: string, mutate: (manifest: Record<string, unknown>) => void): void {
    const manifestPath = join(root, ".infinite/install.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    mutate(manifest)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  it("refuses an appRoot that escapes the workspace root and touches nothing outside", () => {
    const root = copyFixture("next-app-router-basic")
    applyFixture(root, {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" }
    })

    // Plant a victim directory OUTSIDE the repo root (sibling of the fixture dir).
    // The empty lib/ dir is the exact target removeDirIfEmpty would prune.
    const outsideAppRoot = join(dirname(root), "outside-app")
    mkdirSync(join(outsideAppRoot, "lib"), { recursive: true })
    writeFileSync(join(outsideAppRoot, "marker.txt"), "untouched\n")

    tamperManifest(root, (manifest) => {
      manifest.appRoot = "../outside-app"
    })
    const before = snapshotTree(root)

    expect(() => uninstallInstallation({ root })).toThrow(/escapes the workspace root/)

    expectTreeEquals(root, before)
    expect(existsSync(join(outsideAppRoot, "lib"))).toBe(true)
    expect(readFileSync(join(outsideAppRoot, "marker.txt"), "utf8")).toBe("untouched\n")
  })

  it("refuses an absolute manifest.files entry and writes nothing outside", () => {
    const root = copyFixture("static-html-basic")
    applyFixture(root, {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" },
      x: { pixelId: "tw-pixel-123", eventTagIds: ["tw-event-1"] }
    })

    const victim = join(dirname(root), "victim.txt")
    writeFileSync(victim, "untouched\n")

    tamperManifest(root, (manifest) => {
      manifest.files = [...(manifest.files as string[]), victim]
    })
    const before = snapshotTree(root)

    expect(() => uninstallInstallation({ root })).toThrow(/absolute paths are not allowed/)

    expectTreeEquals(root, before)
    expect(readFileSync(victim, "utf8")).toBe("untouched\n")
  })

  it("refuses a ../ manifest.files entry and writes nothing outside", () => {
    const root = copyFixture("static-html-basic")
    applyFixture(root, {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" },
      x: { pixelId: "tw-pixel-123", eventTagIds: ["tw-event-1"] }
    })

    const victim = join(dirname(root), "victim.txt")
    writeFileSync(victim, "untouched\n")

    tamperManifest(root, (manifest) => {
      manifest.files = [...(manifest.files as string[]), "../victim.txt"]
    })
    const before = snapshotTree(root)

    expect(() => uninstallInstallation({ root })).toThrow(/escapes the workspace root/)

    expectTreeEquals(root, before)
    expect(readFileSync(victim, "utf8")).toBe("untouched\n")
  })
})

describe("uninstallInstallation — FIX 1: wiring-removal failure gates managed-file deletion", () => {
  it("does not delete managed module files when entrypoint wiring cannot be stripped (next-app-router)", () => {
    const root = copyFixture("next-app-router-basic")
    applyFixture(root, {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" }
    })

    // Add a trailing comment to the import line so removeLayoutWiring's literal
    // replace on the import no longer matches — the import stays in the layout
    const layoutPath = join(root, "app/layout.tsx")
    const layout = readFileSync(layoutPath, "utf8")
    const importLine = 'import { InfiniteAnalyticsClient } from "../lib/infinite-analytics-client"'
    const mutated = layout.replace(importLine, `${importLine} // analytics`)
    expect(mutated).not.toBe(layout)
    writeFileSync(layoutPath, mutated)

    const result = uninstallInstallation({ root })

    // Wiring warning must be present
    expect(result.warnings.some((w) => w.includes("automatically"))).toBe(true)

    // Managed module files must NOT have been deleted (imports still resolve)
    expect(existsSync(join(root, "lib/infinite-analytics-client.tsx"))).toBe(true)
    expect(existsSync(join(root, "lib/infinite-analytics.ts"))).toBe(true)

    // Manifest must be retained (hasWiringLeftover kept it)
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(true)

    // The import is still in the entrypoint (wiring wasn't fully stripped)
    const finalLayout = readFileSync(layoutPath, "utf8")
    expect(finalLayout).toContain("infinite-analytics-client")

    // The managed file the entrypoint still imports must still exist (no dangling import)
    expect(existsSync(join(root, "lib/infinite-analytics-client.tsx"))).toBe(true)
  })

  it("does not delete managed module files when entrypoint wiring cannot be stripped (next-pages-router)", () => {
    const root = copyFixture("next-pages-router-basic")
    applyFixture(root, {
      ga4: { measurementId: "G-TEST123" },
      x: { pixelId: "tw-pixel-123", eventTagIds: ["tw-event-1"] }
    })

    // Reindent the <InfiniteAnalyticsClient /> so the fixed-indent regex no longer matches
    const appPath = join(root, "pages/_app.tsx")
    const appSource = readFileSync(appPath, "utf8")
    const mutated = appSource.replace(
      /^( *)<InfiniteAnalyticsClient \/>/m,
      (_match, indent) => `${indent}  <InfiniteAnalyticsClient />`
    )
    expect(mutated).not.toBe(appSource)
    writeFileSync(appPath, mutated)

    const result = uninstallInstallation({ root })

    expect(result.warnings.some((w) => w.includes("automatically"))).toBe(true)
    expect(existsSync(join(root, "lib/infinite-analytics-client.tsx"))).toBe(true)
    expect(existsSync(join(root, "lib/infinite-analytics.ts"))).toBe(true)
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(true)
  })

  it("does not delete managed analytics module when main wiring cannot be stripped (vite-react)", () => {
    const root = copyFixture("vite-react-basic")
    applyFixture(root, {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" }
    })

    // Reindent bootLine so the literal `\n${bootLine}\n` replace no longer matches
    const mainPath = join(root, "src/main.tsx")
    const mainSource = readFileSync(mainPath, "utf8")
    const mutated = mainSource.replace(
      /^installInfiniteInstrumentation\(\)$/m,
      "  installInfiniteInstrumentation()"
    )
    expect(mutated).not.toBe(mainSource)
    writeFileSync(mainPath, mutated)

    const result = uninstallInstallation({ root })

    expect(result.warnings.some((w) => w.includes("automatically"))).toBe(true)
    expect(existsSync(join(root, "src/lib/infinite-analytics.ts"))).toBe(true)
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(true)
  })
})

