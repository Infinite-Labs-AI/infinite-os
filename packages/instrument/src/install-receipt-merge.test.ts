// One receipt, many installs: `.infinite/install.json` records EVERYTHING infinite-tag manages in a repo.
// A later install (`install --server-lane` after the browser tag, or the browser tag after the lane) merges
// into the receipt that is already there; it never replaces it. Replacing it lost the browser tag's
// record on a live site (2026-10-09): uninstall would then have left the tag behind, and doctor / a
// re-plan would have seen no tag at all.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { applyInstallation } from "./apply.js"
import { inspectWorkspace } from "./inspect.js"
import { makeEditRecord } from "./install/edits.js"
import { GENERATED_API_RECORD } from "./jobs/generated-api.js"
import { computeContentHash, installManifestRelativePath, readInstallManifest, writeInstallManifest } from "./manifest.js"
import { planInstallation } from "./plan.js"
import { withHandoffInReceipt } from "./server-lane/handoff.js"
import type { InstallManifest, WorkspaceInstallArtifacts } from "./types.js"
import { uninstallInstallation } from "./uninstall.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-receipt-merge-${name}-`))
  const target = join(targetRoot, name)
  tempRoots.push(targetRoot)
  cpSync(join(fixtureRoot, "../test/fixtures", name), target, { recursive: true })
  return target
}

function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>()
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolutePath = join(current, entry.name)
      if (entry.isDirectory()) walk(absolutePath)
      else snapshot.set(relative(root, absolutePath), readFileSync(absolutePath, "utf8"))
    }
  }
  walk(root)
  return snapshot
}

function expectTreeEquals(root: string, expected: Map<string, string>): void {
  const actual = snapshotTree(root)
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort())
  for (const [path, content] of expected) expect(actual.get(path)).toBe(content)
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

// Synthetic ids only: never a real customer's workspace, site source or pixel.
const BROWSER_WORKSPACE = "ws_wizard_fingerprint_test"
const LANE_WORKSPACE = "ws_server_lane_test"
const RUN_ID = "run_browser_tag_test"
const ADOPTED_GA4 = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-ADOPTED0"></script>'
const infinite = {
  siteSourceKey: "site_public_receipt_test",
  collectPath: "/infinite/events/collect",
  productionHosts: ["example.com"],
  consentMode: "not_required" as const
}

function plan(root: string, workspaceId: string, artifacts: WorkspaceInstallArtifacts, serverLane: boolean) {
  const result = planInstallation({ root, inspect: inspectWorkspace(root), workspaceId, artifacts, serverLane })
  expect(result.blockers).toEqual([])
  return result
}

function apply(root: string, workspaceId: string, artifacts: WorkspaceInstallArtifacts, serverLane: boolean) {
  return applyInstallation({ root, workspaceId, plan: plan(root, workspaceId, artifacts, serverLane) })
}

/**
 * The browser tag as the wizard leaves it: the managed apply's receipt, then the wizard's own
 * additions on top: a recorded edit to a file it does not own (reversible byte for byte), the
 * managed click-id capture (a created module + its record), the public ids and the run id.
 */
function installBrowserTagLikeTheWizard(root: string): InstallManifest {
  apply(root, BROWSER_WORKSPACE, { infinite }, false)
  const page = "app/page.tsx"
  const pageBefore = readFileSync(join(root, page), "utf8")
  const pageAfter = pageBefore.replace("<main>", '<main data-infinite-conversion="signup">')
  writeFileSync(join(root, page), pageAfter)
  const captureModule = "public/infinite-meta-click-id.js"
  const captureSource = "// Managed by Infinite. Public install artifacts only.\n"
  mkdirSync(join(root, "public"), { recursive: true })
  writeFileSync(join(root, captureModule), captureSource)
  const receipt = readInstallManifest(root)!
  const withWizard: InstallManifest = {
    ...receipt,
    runId: RUN_ID,
    files: [...receipt.files, captureModule],
    contentHashes: { ...receipt.contentHashes, [captureModule]: computeContentHash(captureSource) },
    edits: [
      makeEditRecord({ file: page, before: pageBefore, after: pageAfter, jobId: null, planLineId: "improve:test", by: "wizard", runId: RUN_ID, seq: 0 }),
      makeEditRecord({ file: captureModule, before: null, after: captureSource, jobId: "meta_improve:capture", planLineId: "capture_beside_adopted_pixel:meta:capture", by: "wizard", runId: RUN_ID, seq: 1 })
    ],
    managedCapture: {
      module: captureModule,
      entrypoints: ["app/layout.tsx"],
      pixelFiles: ["app/layout.tsx"],
      mode: "not_required",
      strategy: "before_interactive",
      moduleHash: computeContentHash(captureSource)
    },
    ids: { ga4: [], posthog: null, meta: [], infinite: { siteSourceKey: infinite.siteSourceKey } }
  }
  writeInstallManifest(root, withWizard)
  return withWizard
}

describe("install receipt: a later install merges into the receipt already there", () => {
  it("install --server-lane after the browser tag keeps the browser tag's record and adds the lane's", () => {
    const root = copyFixture("next-app-router-basic")
    const browser = installBrowserTagLikeTheWizard(root)
    expect(browser.providers).toEqual(["infinite"])

    const result = apply(root, LANE_WORKSPACE, {}, true)
    expect(result.changedFiles).toContain(installManifestRelativePath)

    const merged = readInstallManifest(root)!
    // The browser tag's record, untouched.
    expect(merged.workspaceId).toBe(BROWSER_WORKSPACE)
    expect(merged.providers).toEqual(["infinite"])
    expect(merged.runId).toBe(RUN_ID)
    expect(merged.edits).toEqual(browser.edits)
    expect(merged.managedCapture).toEqual(browser.managedCapture)
    expect(merged.ids).toEqual(browser.ids)
    for (const file of browser.files) {
      expect(merged.files).toContain(file)
      expect(merged.contentHashes[file]).toBe(browser.contentHashes[file])
    }
    for (const key of browser.envKeys) expect(merged.envKeys).toContain(key)
    // The lane's record, added.
    expect(merged.serverLane).toEqual(result.serverLane?.manifest)
    for (const file of ["middleware.ts", "lib/infinite-server-lane.ts", "lib/infinite-outcome.ts"]) {
      expect(merged.files).toContain(file)
      expect(merged.contentHashes[file]).toBe(computeContentHash(readFileSync(join(root, file), "utf8")))
    }
    expect(merged.configOwnership?.["middleware.ts"]).toMatchObject({ kind: "created" })
    expect(merged.envKeys).toEqual(expect.arrayContaining(["INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"]))
    expect(new Set(merged.files).size).toBe(merged.files.length)
  })

  it("re-running the same server-lane install over the merged receipt changes nothing", () => {
    const root = copyFixture("next-app-router-basic")
    installBrowserTagLikeTheWizard(root)
    apply(root, LANE_WORKSPACE, {}, true)
    const before = snapshotTree(root)
    const second = apply(root, LANE_WORKSPACE, {}, true)
    expect(second.changedFiles).toEqual([])
    expectTreeEquals(root, before)
  })

  it("uninstall after the merged receipt reverses BOTH installs byte for byte", () => {
    const root = copyFixture("next-app-router-basic")
    const original = snapshotTree(root)
    installBrowserTagLikeTheWizard(root)
    apply(root, LANE_WORKSPACE, {}, true)

    const result = uninstallInstallation({ root, dryRun: false })
    expect(result.warnings).toEqual([])
    expect(result.editsLeftAsIs).toEqual([])
    expectTreeEquals(root, original)
  })

  it("the browser tag after a server-lane-only install keeps the lane's record, and uninstall reverses both", () => {
    const root = copyFixture("next-app-router-basic")
    const original = snapshotTree(root)
    const laneApply = apply(root, LANE_WORKSPACE, {}, true)
    const lane = readInstallManifest(root)!

    apply(root, BROWSER_WORKSPACE, { infinite }, false)
    const merged = readInstallManifest(root)!
    expect(merged.serverLane).toEqual(laneApply.serverLane?.manifest)
    expect(merged.configOwnership?.["middleware.ts"]).toEqual(lane.configOwnership?.["middleware.ts"])
    for (const file of lane.files) expect(merged.files).toContain(file)
    expect(merged.providers).toEqual(["infinite"])
    expect(merged.files).toEqual(expect.arrayContaining(["app/layout.tsx", "lib/infinite-analytics.ts"]))
    // This run re-planned the browser half, so its workspace is the one recorded.
    expect(merged.workspaceId).toBe(BROWSER_WORKSPACE)

    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
  })

  it("helpers-only browser install beside an ADOPTED tag, then the lane: uninstall still takes the helpers off", () => {
    const root = copyFixture("next-app-router-basic")
    const layout = join(root, "app/layout.tsx")
    writeFileSync(layout, readFileSync(layout, "utf8").replace("<body>", `<head>${ADOPTED_GA4}</head>\n      <body>`))
    const original = snapshotTree(root)
    apply(root, BROWSER_WORKSPACE, { ga4: { measurementId: "G-ADOPTED0" }, conversions: { helpers: true } }, false)
    const browser = readInstallManifest(root)!
    expect(browser.providers).toEqual([]) // the adopted GA4 is never claimed
    expect(browser.files).toContain("lib/infinite-analytics.ts")

    apply(root, LANE_WORKSPACE, {}, true)
    const merged = readInstallManifest(root)!
    expect(merged.files).toEqual(expect.arrayContaining([...browser.files, "middleware.ts"]))

    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
  })

  it("a lane run after the wizard's server-events handoff keeps the handoff in the lane's created files", () => {
    const root = copyFixture("next-app-router-basic")
    const original = snapshotTree(root)
    installBrowserTagLikeTheWizard(root)
    const handoff = "docs/infinite-server-events.md"
    const contents = "<!-- Managed by Infinite -->\n# Server events\n"
    mkdirSync(join(root, "docs"), { recursive: true })
    writeFileSync(join(root, handoff), contents)
    writeInstallManifest(root, withHandoffInReceipt(readInstallManifest(root)!, handoff, contents))

    apply(root, LANE_WORKSPACE, {}, true)
    const merged = readInstallManifest(root)!
    expect(merged.serverLane?.mode).toBe("next-middleware")
    expect(merged.serverLane?.created).toEqual(expect.arrayContaining([handoff, "lib/infinite-outcome.ts"]))
    expect(merged.configOwnership?.[handoff]).toMatchObject({ kind: "created" })

    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
  })

  it("refuses a lane that would rewrite a file an earlier run's recorded edit lives in, and rolls every write back", () => {
    const root = copyFixture("next-app-router-basic")
    installBrowserTagLikeTheWizard(root)
    // The customer's own middleware, which an earlier run's agent edited (recorded, reversible).
    const middlewareBefore = 'export function middleware() {\n  return undefined\n}\n'
    const middlewareAfter = 'export function middleware() {\n  // conversions wired by the agent\n  return undefined\n}\n'
    writeFileSync(join(root, "middleware.ts"), middlewareAfter)
    const receipt = readInstallManifest(root)!
    writeInstallManifest(root, {
      ...receipt,
      edits: [
        ...(receipt.edits ?? []),
        makeEditRecord({ file: "middleware.ts", before: middlewareBefore, after: middlewareAfter, jobId: "job_test", planLineId: null, by: "agent", runId: RUN_ID, seq: 2 })
      ]
    })
    const lanePlan = plan(root, LANE_WORKSPACE, {}, true)
    expect(lanePlan.serverLane?.middleware?.path).toBe("middleware.ts")
    const before = snapshotTree(root)

    expect(() => applyInstallation({ root, workspaceId: LANE_WORKSPACE, plan: lanePlan })).toThrow(
      /middleware\.ts carries an edit an earlier infinite-tag run recorded/
    )
    // Every file and the receipt are back as they were. (The wizard's generated-source bookkeeping only
    // ever grows: it lists bytes infinite-tag generated, so it is not part of the customer's tree.)
    const after = snapshotTree(root)
    after.delete(GENERATED_API_RECORD)
    before.delete(GENERATED_API_RECORD)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [path, content] of before) expect(after.get(path)).toBe(content)
  })

  it("a corrupt receipt fails the install loudly and is never overwritten", () => {
    const root = copyFixture("next-app-router-basic")
    installBrowserTagLikeTheWizard(root)
    const lanePlan = plan(root, LANE_WORKSPACE, {}, true)
    writeFileSync(join(root, installManifestRelativePath), "{ not json")
    const before = snapshotTree(root)

    expect(() => applyInstallation({ root, workspaceId: LANE_WORKSPACE, plan: lanePlan })).toThrow(/Corrupt \.infinite\/install\.json/)
    expectTreeEquals(root, before)
  })

  it("refuses to merge into a receipt recorded for a different app root or framework", () => {
    const root = copyFixture("next-app-router-basic")
    installBrowserTagLikeTheWizard(root)
    const lanePlan = plan(root, LANE_WORKSPACE, {}, true)
    const receipt = readInstallManifest(root)!
    writeInstallManifest(root, { ...receipt, framework: "vite-react" })
    const before = snapshotTree(root)

    expect(() => applyInstallation({ root, workspaceId: LANE_WORKSPACE, plan: lanePlan })).toThrow(
      /records a vite-react install at "\."; this run installs next-app-router at "\."/
    )
    expectTreeEquals(root, before)
  })
})
