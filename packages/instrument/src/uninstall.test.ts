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
import { dirname, join, relative, sep } from "node:path"
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

// `.git/` IS part of the snapshot on purpose: byte-exactness over the object store,
// refs and index is what proves uninstall never stages, commits or otherwise rewrites
// git state behind the founder's back. Git's own bookkeeping, however, writes files in
// there that are NOT state and whose existence at any given instant is a race with a
// DETACHED background process: `git commit` spawns `git maintenance run --auto --detach`,
// which takes `.git/objects/maintenance.lock` for as long as it runs, and `.git/gc.log`
// records a maintenance complaint. A snapshot that caught the lock mid-flight failed the
// publish workflow's test step (infinite-tag 0.11.0, first attempt) with a 26-vs-27 key
// diff. `initFixtureRepo` below stops those processes being spawned at all; this filter is
// the second line of defence, so a future git version inventing a new transient file
// cannot block a release. A lock file is never meaningful project state.
function isTransientGitArtifact(relativePath: string): boolean {
  const segments = relativePath.split(sep)
  if (segments[0] !== ".git") return false
  const name = segments[segments.length - 1]
  return name.endsWith(".lock") || name === "gc.log"
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
      const relativePath = relative(root, absolutePath)
      if (isTransientGitArtifact(relativePath)) continue
      snapshot.set(relativePath, readFileSync(absolutePath, "utf8"))
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

// Every git invocation in this file is pinned away from the ambient environment:
// `GIT_CONFIG_*=/dev/null` ignores the machine's global/system config, and
// `maintenance.auto=false` + `gc.auto=0` stop git spawning its detached background
// maintenance process, which is what writes the transient files above into a tree we
// are about to assert is byte-identical.
const noBackgroundMaintenance = ["-c", "maintenance.auto=false", "-c", "gc.auto=0"]

function gitRun(root: string, args: string[]): void {
  const result = spawnSync("git", ["-C", root, ...noBackgroundMaintenance, ...args], {
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

// Initialise + commit a fixture repo with background maintenance disabled in the repo's
// OWN config as well as on the command line — the production code under test shells out
// to git itself (`detectRepoStatus`), and those invocations inherit the ambient
// environment, so the setting has to live in `.git/config` to cover them too. The config
// is written before the snapshot is taken, so it is stable, asserted state like any other.
function initFixtureRepo(root: string): void {
  gitRun(root, ["init"])
  gitRun(root, ["config", "maintenance.auto", "false"])
  gitRun(root, ["config", "gc.auto", "0"])
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

const infinite = {
  siteSourceKey: "site_public_test",
  collectPath: "/infinite/events/collect",
  productionHosts: ["example.com"],
  staticProxy: "vercel" as const,
  consentMode: "required" as const
}
const meta = { pixelId: "1234567890123456" }

// Every case carries the first-party Infinite runtime (+ Meta), so byte-exact
// round-trip is proven with all five providers across all four frameworks.
const roundTripCases: Array<{ fixture: string; artifacts: WorkspaceInstallArtifacts }> = [
  {
    fixture: "static-html-basic",
    artifacts: {
      infinite,
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" },
      x: { pixelId: "tw-pixel-123", eventTagIds: ["tw-event-1"] },
      meta
    }
  },
  {
    fixture: "vite-react-basic",
    artifacts: {
      infinite,
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" },
      meta
    }
  },
  {
    fixture: "next-app-router-basic",
    artifacts: {
      infinite,
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" },
      meta
    }
  },
  {
    fixture: "next-pages-router-basic",
    artifacts: {
      infinite,
      ga4: { measurementId: "G-TEST123" },
      x: { pixelId: "tw-pixel-123", eventTagIds: ["tw-event-1"] },
      meta
    }
  }
]

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("uninstallInstallation", () => {
  it("restores a byte-identical tree for an Infinite-only Vercel rewrite install", () => {
    const root = copyFixture("static-html-basic")
    const before = snapshotTree(root)

    applyFixture(root, { infinite })
    uninstallInstallation({ root })

    expectTreeEquals(root, before)
  })

  it("restores a byte-identical tree for a custom Infinite collection path", () => {
    const root = copyFixture("static-html-basic")
    const before = snapshotTree(root)

    applyFixture(root, {
      infinite: { ...infinite, collectPath: "/telemetry/events" }
    })
    uninstallInstallation({ root })

    expectTreeEquals(root, before)
  })

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
    initFixtureRepo(root)

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

  // Regression guard for the flake that failed the infinite-tag 0.11.0 publish run: git's
  // detached background maintenance can drop a lock file inside .git/ at any instant, so
  // the byte-exactness snapshot must not see it — while still catching anything real,
  // inside .git/ or out. A snapshot that cannot fail would be worse than the flake.
  it("ignores git's transient maintenance artefacts without blunting the assertion", () => {
    const root = copyFixture("static-html-basic")
    initFixtureRepo(root)

    const committed = snapshotTree(root)

    applyFixture(root, { ga4: { measurementId: "G-TEST123" } })
    uninstallInstallation({ root, allowDirty: true })

    // Exactly what `git maintenance run --auto --detach` leaves behind mid-flight.
    writeFileSync(join(root, ".git/objects/maintenance.lock"), "")
    writeFileSync(join(root, ".git/gc.log"), "warning: too many unreachable loose objects\n")
    expectTreeEquals(root, committed)

    // A real mutation of git state is still caught — that is why .git/ is snapshotted.
    const sneakyRef = join(root, ".git/refs/heads/sneaky")
    writeFileSync(sneakyRef, "0000000000000000000000000000000000000000\n")
    expect(() => expectTreeEquals(root, committed)).toThrow()
    rmSync(sneakyRef)

    // ...and so is a stray file left behind in the project itself.
    writeFileSync(join(root, "stray.txt"), "left behind\n")
    expect(() => expectTreeEquals(root, committed)).toThrow()
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

})
