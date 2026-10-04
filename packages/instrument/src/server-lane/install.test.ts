import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { applyInstallation } from "../apply.js"
import { inspectWorkspace } from "../inspect.js"
import { readInstallManifest } from "../manifest.js"
import { planInstallation } from "../plan.js"
import type { WorkspaceInstallArtifacts } from "../types.js"
import { uninstallInstallation } from "../uninstall.js"
import { verifyInstallation } from "../verify.js"

import { SERVER_LANE_BRIEF_FILE, SERVER_LANE_GUIDE_FILE, serverLaneCopy } from "./copy.js"
import { UNPATCHABLE_REASONS } from "./middleware-patch.js"
import { SERVER_LANE_FENCE_START } from "./runtime-source.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-server-lane-${name}-`))
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

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

const infinite = {
  siteSourceKey: "site_public_test",
  collectPath: "/infinite/events/collect",
  productionHosts: ["example.com", "www.example.com"],
  consentMode: "not_required" as const
}
const withPixel: WorkspaceInstallArtifacts = { infinite, ga4: { measurementId: "G-TEST123" } }

function planAndApply(root: string, artifacts: WorkspaceInstallArtifacts) {
  const plan = planInstallation({
    root,
    inspect: inspectWorkspace(root),
    workspaceId: "ws_test",
    artifacts,
    serverLane: true
  })
  expect(plan.blockers).toEqual([])
  const apply = applyInstallation({ root, workspaceId: "ws_test", plan })
  return { plan, apply }
}

// Fixture import lines live in constants so package-shape.test.ts's scanner ignores them.
const NEXT_IMPORTS = ['import { NextResponse } from "next/server"', 'import type { NextRequest } from "next/server"'].join("\n")
const EXISTING_MIDDLEWARE = `${NEXT_IMPORTS}

export function middleware(request: NextRequest) {
  const response = NextResponse.next()
  response.headers.set("x-existing", "yes")
  return response
}
`

describe("install --server-lane on Next.js (App Router)", () => {
  it("creates middleware.ts + the module + the brief alongside the pixel, records the manifest, verifies, and re-runs idempotently", () => {
    const root = copyFixture("next-app-router-basic")
    const { plan, apply } = planAndApply(root, withPixel)

    expect(plan.serverLane).toMatchObject({
      mode: "next-middleware",
      briefPath: SERVER_LANE_BRIEF_FILE,
      modulePath: "lib/infinite-server-lane.ts",
      middleware: { path: "middleware.ts", action: "create" },
      envKeys: ["INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"],
      files: ["middleware.ts", "lib/infinite-server-lane.ts"]
    })
    expect(plan.files).toEqual(expect.arrayContaining(["app/layout.tsx", "lib/infinite-analytics.ts", "middleware.ts", "lib/infinite-server-lane.ts"]))
    expect(plan.envKeys).toEqual(expect.arrayContaining(["INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"]))

    expect(apply.changedFiles).toEqual(
      expect.arrayContaining(["middleware.ts", "lib/infinite-server-lane.ts", SERVER_LANE_BRIEF_FILE, ".infinite/install.json"])
    )
    expect(apply.serverLane?.briefWritten).toBe(true)
    expect(apply.serverLane?.manifest).toEqual({
      mode: "next-middleware",
      middleware: "middleware.ts",
      module: "lib/infinite-server-lane.ts",
      brief: SERVER_LANE_BRIEF_FILE,
      guide: SERVER_LANE_GUIDE_FILE
    })

    const middleware = readFileSync(join(root, "middleware.ts"), "utf8")
    expect(middleware).toContain("export default withInfiniteServerLane()")
    expect(middleware).toContain('matcher: ["/((?!_next/static|_next/image|favicon.ico|api|.*\\\\..*).*)"]')
    const module = readFileSync(join(root, "lib/infinite-server-lane.ts"), "utf8")
    // Public artifacts baked; the secret is env-only.
    expect(module).toContain('process.env.INFINITE_SITE_SOURCE_KEY || "site_public_test"')
    expect(module).toContain('const PRODUCTION_HOSTS: string[] = ["example.com", "www.example.com"]')
    expect(module).not.toMatch(/INFINITE_SERVER_EVENT_SECRET\s*=\s*"/)
    // The repo root holds a short pointer; the full guide lives under docs/.
    const brief = readFileSync(join(root, SERVER_LANE_BRIEF_FILE), "utf8")
    expect(brief.startsWith("<!-- Managed by Infinite")).toBe(true)
    expect(brief).toContain("infinite-tag CREATED `middleware.ts`")
    expect(brief).toContain(SERVER_LANE_GUIDE_FILE)
    expect(brief.split("\n").length).toBeLessThan(40) // a pointer, not the 700-line guide
    const guide = readFileSync(join(root, SERVER_LANE_GUIDE_FILE), "utf8")
    expect(guide).toContain("## The contract (implement exactly)")

    const manifest = readInstallManifest(root)!
    expect(manifest.serverLane).toEqual(apply.serverLane?.manifest)
    expect(manifest.configOwnership?.["middleware.ts"]).toMatchObject({ kind: "created" })
    expect(manifest.files).toEqual(expect.arrayContaining(["middleware.ts", "lib/infinite-server-lane.ts"]))
    expect(manifest.contentHashes["middleware.ts"]).toBeDefined()
    expect(verifyInstallation({ root }).buildOk).toBe(true)

    // Idempotent re-run: nothing changes on disk.
    const before = snapshotTree(root)
    const second = planAndApply(root, withPixel)
    expect(second.plan.serverLane?.middleware).toEqual({ path: "middleware.ts", action: "create" })
    expect(second.apply.changedFiles).toEqual([])
    expectTreeEquals(root, before)
  })

  it("uninstall removes everything the lane wrote and restores the original tree", () => {
    const root = copyFixture("next-app-router-basic")
    const original = snapshotTree(root)
    planAndApply(root, withPixel)

    const preview = uninstallInstallation({ root, dryRun: true })
    expect(preview.removedFiles).toEqual(
      expect.arrayContaining(["middleware.ts", "lib/infinite-server-lane.ts", SERVER_LANE_BRIEF_FILE, SERVER_LANE_GUIDE_FILE])
    )
    expect(existsSync(join(root, "middleware.ts"))).toBe(true)

    const result = uninstallInstallation({ root, dryRun: false })
    expect(result.removedFiles).toEqual(
      expect.arrayContaining(["middleware.ts", "lib/infinite-server-lane.ts", SERVER_LANE_BRIEF_FILE, SERVER_LANE_GUIDE_FILE, ".infinite/install.json"])
    )
    expectTreeEquals(root, original)
  })

  it("server lane alone (no pixel artifacts) is a complete install and reverses cleanly", () => {
    const root = copyFixture("next-app-router-basic")
    const original = snapshotTree(root)
    const { plan, apply } = planAndApply(root, {})
    expect(plan.providers).toEqual([])
    expect(plan.applyMode).toBe("supported")
    expect(plan.files).toEqual(["middleware.ts", "lib/infinite-server-lane.ts"])
    expect(existsSync(join(root, "lib/infinite-analytics.ts"))).toBe(false)
    expect(readFileSync(join(root, "app/layout.tsx"), "utf8")).toBe(original.get("app/layout.tsx"))
    expect(apply.changedFiles).toEqual(
      expect.arrayContaining(["middleware.ts", "lib/infinite-server-lane.ts", SERVER_LANE_BRIEF_FILE, ".infinite/install.json"])
    )
    // No artifact → env-only source key and no host allowlist baked.
    const module = readFileSync(join(root, "lib/infinite-server-lane.ts"), "utf8")
    expect(module).toContain('process.env.INFINITE_SITE_SOURCE_KEY || ""')
    expect(module).toContain("const PRODUCTION_HOSTS: string[] = []")

    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
  })

  it("patches an existing middleware with fenced blocks and uninstall restores it byte-for-byte", () => {
    const root = copyFixture("next-app-router-basic")
    writeFileSync(join(root, "middleware.ts"), EXISTING_MIDDLEWARE)
    const original = snapshotTree(root)

    const { plan, apply } = planAndApply(root, withPixel)
    expect(plan.serverLane?.middleware).toEqual({ path: "middleware.ts", action: "patch" })
    expect(apply.changedFiles).toContain("middleware.ts")

    const patched = readFileSync(join(root, "middleware.ts"), "utf8")
    expect(patched).toContain(SERVER_LANE_FENCE_START)
    expect(patched).toContain('import { withInfiniteServerLane } from "./lib/infinite-server-lane"')
    expect(patched).toContain("\nfunction middleware(request: NextRequest) {")
    expect(patched).toContain("export default withInfiniteServerLane(middleware)")
    expect(patched).toContain('response.headers.set("x-existing", "yes")')

    const manifest = readInstallManifest(root)!
    expect(manifest.configOwnership?.["middleware.ts"]).toMatchObject({ kind: "text-edits" })
    expect(readFileSync(join(root, SERVER_LANE_BRIEF_FILE), "utf8")).toContain("infinite-tag PATCHED your existing `middleware.ts`")
    expect(verifyInstallation({ root }).buildOk).toBe(true)

    // Re-run: the fence is present → keep, no changes.
    const before = snapshotTree(root)
    const second = planAndApply(root, withPixel)
    expect(second.plan.serverLane?.middleware).toEqual({ path: "middleware.ts", action: "keep" })
    expect(second.apply.changedFiles).toEqual([])
    expect(second.apply.warnings).toEqual([])
    expectTreeEquals(root, before)

    const result = uninstallInstallation({ root, dryRun: false })
    expect(result.restoredFiles).toContain("middleware.ts")
    expectTreeEquals(root, original)
  })

  it("leaves an unpatchable middleware untouched, still writes the module + a brief with the exact addition", () => {
    const root = copyFixture("next-app-router-basic")
    const narrow = `export function middleware(request) {\n  return undefined\n}\nexport const config = { matcher: ["/dashboard/:path*"] }\n`
    writeFileSync(join(root, "middleware.ts"), narrow)
    const original = snapshotTree(root)

    const { plan, apply } = planAndApply(root, withPixel)
    expect(plan.serverLane?.middleware).toEqual({
      path: "middleware.ts",
      action: "unpatchable",
      reason: UNPATCHABLE_REASONS.matcherNarrow
    })
    expect(plan.serverLane?.files).toEqual(["lib/infinite-server-lane.ts"])
    expect(readFileSync(join(root, "middleware.ts"), "utf8")).toBe(narrow)
    expect(apply.warnings.some((warning) => warning.includes("left untouched"))).toBe(true)
    expect(existsSync(join(root, "lib/infinite-server-lane.ts"))).toBe(true)
    // The root pointer carries the status; the exact hand-addition lives in the full guide.
    const brief = readFileSync(join(root, SERVER_LANE_BRIEF_FILE), "utf8")
    expect(brief).toContain("infinite-tag did NOT touch your existing `middleware.ts`")
    const guide = readFileSync(join(root, SERVER_LANE_GUIDE_FILE), "utf8")
    expect(guide).toContain(`### ${serverLaneCopy.exactAdditionHeading}`)
    expect(guide).toContain("export default withInfiniteServerLane(middleware)")

    const manifest = readInstallManifest(root)!
    expect(manifest.serverLane?.middleware).toBeUndefined()
    expect(manifest.configOwnership?.["middleware.ts"]).toBeUndefined()

    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
  })

  it("refuses to uninstall a created middleware the customer edited afterwards (and reruns keep it)", () => {
    const root = copyFixture("next-app-router-basic")
    planAndApply(root, withPixel)
    const middlewarePath = join(root, "middleware.ts")
    writeFileSync(middlewarePath, `${readFileSync(middlewarePath, "utf8")}\n// customer edit\n`)

    const rerun = planAndApply(root, withPixel)
    expect(rerun.plan.serverLane?.middleware).toEqual({ path: "middleware.ts", action: "keep" })
    expect(rerun.apply.warnings.some((warning) => warning.includes("edited after infinite-tag created it"))).toBe(true)

    expect(() => uninstallInstallation({ root, dryRun: false })).toThrow(/changed after installation/)
    // Uninstall is atomic: the refusal left the tree exactly as it was.
    expect(readFileSync(middlewarePath, "utf8")).toContain("// customer edit")
    expect(existsSync(join(root, "lib/infinite-server-lane.ts"))).toBe(true)
  })

  it("blocks when an unmanaged lib/infinite-server-lane.ts is in the way", () => {
    const root = copyFixture("next-app-router-basic")
    mkdirSync(join(root, "lib"))
    writeFileSync(join(root, "lib/infinite-server-lane.ts"), "export const mine = true\n")
    const plan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: withPixel,
      serverLane: true
    })
    expect(plan.blockers).toContain(
      "Server lane apply will not overwrite an existing unmanaged lib/infinite-server-lane.ts file."
    )
    expect(() => applyInstallation({ root, workspaceId: "ws_test", plan })).toThrow(/Refusing to apply/)
  })

  it("targets proxy.ts on Next.js 16+", () => {
    const root = copyFixture("next-app-router-basic")
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> }
    packageJson.dependencies.next = "^16.0.1"
    writeFileSync(join(root, "package.json"), JSON.stringify(packageJson, null, 2))
    const { plan } = planAndApply(root, {})
    expect(plan.serverLane?.middleware).toEqual({ path: "proxy.ts", action: "create" })
    expect(existsSync(join(root, "proxy.ts"))).toBe(true)
  })

  it("patches src/middleware.ts and places the module under src/lib", () => {
    const root = copyFixture("next-app-router-basic")
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "middleware.ts"), EXISTING_MIDDLEWARE)
    const { plan } = planAndApply(root, {})
    expect(plan.serverLane?.middleware).toEqual({ path: "src/middleware.ts", action: "patch" })
    expect(plan.serverLane?.modulePath).toBe("src/lib/infinite-server-lane.ts")
    expect(existsSync(join(root, "src/lib/infinite-server-lane.ts"))).toBe(true)
  })
})

describe("install --server-lane on Next.js (Pages Router)", () => {
  it("creates middleware.ts + module + brief and reverses cleanly", () => {
    const root = copyFixture("next-pages-router-basic")
    const original = snapshotTree(root)
    const { plan } = planAndApply(root, withPixel)
    expect(plan.framework).toBe("next-pages-router")
    expect(plan.serverLane?.middleware).toEqual({ path: "middleware.ts", action: "create" })
    expect(existsSync(join(root, "middleware.ts"))).toBe(true)
    expect(existsSync(join(root, "lib/infinite-server-lane.ts"))).toBe(true)
    expect(existsSync(join(root, SERVER_LANE_BRIEF_FILE))).toBe(true)
    expect(verifyInstallation({ root }).buildOk).toBe(true)
    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
  })
})

describe("install --server-lane on other stacks", () => {
  it("Vite: writes only the brief (mode brief), tracks it, and returns the brief text for printing", () => {
    const root = copyFixture("vite-react-basic")
    const original = snapshotTree(root)
    const { plan, apply } = planAndApply(root, { ga4: { measurementId: "G-TEST123" } })
    expect(plan.serverLane).toMatchObject({ mode: "brief", briefPath: SERVER_LANE_BRIEF_FILE, files: [] })
    expect(apply.serverLane?.manifest).toEqual({ mode: "brief", brief: SERVER_LANE_BRIEF_FILE, guide: SERVER_LANE_GUIDE_FILE })
    // `brief` (returned + printed) is the full guide; the guide file matches it, the root a pointer.
    expect(apply.serverLane?.brief).toContain('This project was detected as "vite-react"')
    expect(readFileSync(join(root, SERVER_LANE_GUIDE_FILE), "utf8")).toBe(apply.serverLane?.brief)
    expect(readFileSync(join(root, SERVER_LANE_BRIEF_FILE), "utf8")).toContain(SERVER_LANE_GUIDE_FILE)
    expect(readInstallManifest(root)?.serverLane).toEqual({ mode: "brief", brief: SERVER_LANE_BRIEF_FILE, guide: SERVER_LANE_GUIDE_FILE })
    const result = uninstallInstallation({ root, dryRun: false })
    expect(result.removedFiles).toContain(SERVER_LANE_BRIEF_FILE)
    expect(result.removedFiles).toContain(SERVER_LANE_GUIDE_FILE)
    expectTreeEquals(root, original)
  })

  it("Vite, server lane alone: the brief is the whole install", () => {
    const root = copyFixture("vite-react-basic")
    const original = snapshotTree(root)
    const { plan } = planAndApply(root, {})
    expect(plan.providers).toEqual([])
    expect(plan.files).toEqual([])
    expect(existsSync(join(root, SERVER_LANE_BRIEF_FILE))).toBe(true)
    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
  })

  it("does not overwrite an unmanaged docs guide, and the root pointer never lies about it", () => {
    const root = copyFixture("vite-react-basic")
    mkdirSync(join(root, "docs"))
    writeFileSync(join(root, SERVER_LANE_GUIDE_FILE), "# our own docs\n")
    const { apply } = planAndApply(root, {})

    // The customer's file is untouched and NOT recorded — the manifest claim must be true.
    expect(readFileSync(join(root, SERVER_LANE_GUIDE_FILE), "utf8")).toBe("# our own docs\n")
    expect(readInstallManifest(root)?.serverLane).toEqual({ mode: "brief", brief: SERVER_LANE_BRIEF_FILE })
    expect(apply.serverLane?.manifest.guide).toBeUndefined()
    expect(apply.warnings.some((warning) => warning.includes("not managed by Infinite"))).toBe(true)

    // The root pointer must NOT link to the customer's file or claim serverLane.guide.
    const pointer = readFileSync(join(root, SERVER_LANE_BRIEF_FILE), "utf8")
    expect(pointer).not.toContain(`(${SERVER_LANE_GUIDE_FILE})`)
    expect(pointer).not.toContain("serverLane.guide")
    expect(pointer).toContain("was NOT written")
    expect(pointer).toContain("npx infinite-tag server-lane --brief")

    // Uninstall removes only the pointer we wrote; the customer's docs file stays.
    uninstallInstallation({ root, dryRun: false })
    expect(existsSync(join(root, SERVER_LANE_BRIEF_FILE))).toBe(false)
    expect(readFileSync(join(root, SERVER_LANE_GUIDE_FILE), "utf8")).toBe("# our own docs\n")
  })

  it("does not overwrite an unmanaged INSTALL-SERVER-LANE.md; reports briefWritten=false", () => {
    const root = copyFixture("vite-react-basic")
    writeFileSync(join(root, SERVER_LANE_BRIEF_FILE), "# my own notes\n")
    const { apply } = planAndApply(root, {})
    expect(apply.serverLane?.briefWritten).toBe(false)
    expect(readFileSync(join(root, SERVER_LANE_BRIEF_FILE), "utf8")).toBe("# my own notes\n")
    expect(apply.warnings.some((warning) => warning.includes("not managed by Infinite"))).toBe(true)
    // The root pointer was blocked, but the full guide (a different path) is still written + tracked.
    expect(readInstallManifest(root)?.serverLane).toEqual({ mode: "brief", guide: SERVER_LANE_GUIDE_FILE })
  })

  it("Unsupported: the plan is blocked but carries the brief-mode lane for printing", () => {
    const root = copyFixture("unsupported-basic")
    const plan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: {},
      serverLane: true
    })
    expect(plan.blockers).toContain("Unsupported repository shape for instrumentation.")
    expect(plan.serverLane).toMatchObject({ mode: "brief", briefPath: SERVER_LANE_BRIEF_FILE })
    expect(() => applyInstallation({ root, workspaceId: "ws_test", plan })).toThrow(/Refusing to apply/)
    expect(existsSync(join(root, SERVER_LANE_BRIEF_FILE))).toBe(false)
  })
})
