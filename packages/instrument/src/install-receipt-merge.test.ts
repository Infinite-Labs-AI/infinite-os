// One receipt, many installs: `.infinite/install.json` records EVERYTHING infinite-tag manages in a repo.
// A later install (`install --server-lane` after the browser tag, or the browser tag after the lane) merges
// into the receipt that is already there; it never replaces it. Replacing it lost the browser tag's
// record on a live site (2026-10-09): uninstall would then have left the tag behind, and doctor / a
// re-plan would have seen no tag at all.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { applyInstallation } from "./apply.js"
import { runCli } from "./cli.js"
import { inspectWorkspace } from "./inspect.js"
import { makeEditRecord } from "./install/edits.js"
import { GENERATED_API_RECORD } from "./jobs/generated-api.js"
import { computeContentHash, installManifestRelativePath, readInstallManifest, writeInstallManifest } from "./manifest.js"
import { planInstallation } from "./plan.js"
import { withHandoffInReceipt } from "./server-lane/handoff.js"
import { VERCEL_MIDDLEWARE_PATH } from "./server-lane/targets/vercel-any.js"
import type { InstallManifest, WorkspaceInstallArtifacts } from "./types.js"
import { uninstallInstallation } from "./uninstall.js"
import { applyPhase } from "./harness/run.js"

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
    // The receipt keeps the workspace of the install that created it.
    expect(merged.workspaceId).toBe(LANE_WORKSPACE)

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
      /middleware\.ts carries an edit an earlier infinite-tag run recorded[\s\S]*rolled back/
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

// Review round 1 (PR #15): each case below was found by a probe and fails without its fix.
describe("install receipt merge: review round 1", () => {
  it("1a: the post-install check covers only this run's files: a customer edit to the tag's layout does not roll the lane back", () => {
    const root = copyFixture("next-app-router-basic")
    installBrowserTagLikeTheWizard(root)
    const layout = join(root, "app/layout.tsx")
    writeFileSync(layout, readFileSync(layout, "utf8").replace("<body>", '<body className="x">'))
    const result = applyPhase({ root, workspaceId: LANE_WORKSPACE, plan: plan(root, LANE_WORKSPACE, {}, true), allowDirty: true })
    expect(result.staticVerify.routeChecks.join("\n")).not.toMatch(/drifted/)
    expect(result.outcome).toBe("applied")
    expect(readInstallManifest(root)!.serverLane?.mode).toBe("next-middleware")
  })

  it("1b: the tag after the lane is applied even when the customer edited the lane's created middleware", () => {
    const root = copyFixture("next-app-router-basic")
    apply(root, LANE_WORKSPACE, {}, true)
    const middleware = join(root, "middleware.ts")
    writeFileSync(middleware, `${readFileSync(middleware, "utf8")}\n// customer auth here\n`)
    const result = applyPhase({ root, workspaceId: BROWSER_WORKSPACE, plan: plan(root, BROWSER_WORKSPACE, { infinite }, false), allowDirty: true })
    expect(result.outcome).toBe("applied")
    expect(readInstallManifest(root)!.providers).toEqual(["infinite"])
  })

  it("2: a lane re-run may re-render the lane's own whole files even when a managed refresh recorded an edit there", () => {
    const root = copyFixture("next-app-router-basic")
    const original = snapshotTree(root)
    installBrowserTagLikeTheWizard(root)
    apply(root, LANE_WORKSPACE, {}, true)
    const module = "lib/infinite-server-lane.ts"
    const current = readFileSync(join(root, module), "utf8")
    const receipt = readInstallManifest(root)!
    // What refreshManaged records: the older generated bytes -> the current generated bytes.
    writeInstallManifest(root, {
      ...receipt,
      edits: [
        ...(receipt.edits ?? []),
        makeEditRecord({ file: module, before: current.replace("Managed by Infinite", "Managed by Infinite (old)"), after: current, jobId: null, planLineId: "managed_resume_refresh", by: "wizard", runId: RUN_ID, seq: 9 })
      ]
    })
    const result = apply(root, LANE_WORKSPACE, { infinite: { ...infinite, productionHosts: ["example.com", "www.example.com"] } }, true)
    expect(result.changedFiles).toContain(module)
    expect(readFileSync(join(root, module), "utf8")).toContain('"www.example.com"')
    // The whole file is still the lane's to remove: uninstall takes it off (the stale refresh record only warns).
    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
  })

  it("3: install --server-lane WITH the Infinite artifact keeps the wizard's ids, workspace, edits and capture", () => {
    const root = copyFixture("next-app-router-basic")
    const browser = installBrowserTagLikeTheWizard(root)
    apply(root, LANE_WORKSPACE, { infinite }, true)
    const merged = readInstallManifest(root)!
    expect(merged.ids).toEqual(browser.ids)
    expect(merged.workspaceId).toBe(BROWSER_WORKSPACE)
    expect(merged.providers).toEqual(["infinite"])
    expect(merged.edits).toEqual(browser.edits)
    expect(merged.managedCapture).toEqual(browser.managedCapture)
  })

  it("3b: a lane-only run keeps the earlier ids whole", () => {
    const root = copyFixture("next-app-router-basic")
    const browser = installBrowserTagLikeTheWizard(root)
    const ids = { ...browser.ids!, meta: ["1234567890123456"] }
    writeInstallManifest(root, { ...browser, ids })
    apply(root, LANE_WORKSPACE, {}, true)
    expect(readInstallManifest(root)!.ids).toEqual(ids)
  })

  it("4: static HTML helpers beside an adopted tag + a wizard edit on index.html, then the lane: uninstall takes the managed block off", () => {
    const root = copyFixture("static-html-basic")
    const page = join(root, "index.html")
    writeFileSync(page, readFileSync(page, "utf8").replace("</head>", `${ADOPTED_GA4}\n</head>`))
    const original = snapshotTree(root)
    apply(root, BROWSER_WORKSPACE, { ga4: { measurementId: "G-ADOPTED0" }, conversions: { helpers: true } }, false)
    const before = readFileSync(page, "utf8")
    const after = before.replace("<body>", '<body data-x="1">')
    writeFileSync(page, after)
    const receipt = readInstallManifest(root)!
    expect(receipt.providers).toEqual([])
    writeInstallManifest(root, {
      ...receipt,
      contentHashes: { ...receipt.contentHashes, "index.html": computeContentHash(after) },
      edits: [makeEditRecord({ file: "index.html", before, after, jobId: null, planLineId: "improve:test", by: "wizard", runId: RUN_ID, seq: 0 })]
    })
    apply(root, LANE_WORKSPACE, {}, true)

    uninstallInstallation({ root, dryRun: false })
    expect(readFileSync(page, "utf8")).not.toContain("infinite:start")
    expectTreeEquals(root, original)
  })

  it("a: a lane file the current plan disowns (the customer's own now) leaves the lane's created list", () => {
    // Vite on Vercel: the lane creates a root middleware (an entry). The customer then puts their own there.
    const root = copyFixture("vite-react-basic")
    writeFileSync(join(root, "vercel.json"), "{}\n")
    apply(root, LANE_WORKSPACE, {}, true)
    const entry = VERCEL_MIDDLEWARE_PATH
    expect(readInstallManifest(root)!.serverLane?.created).toContain(entry)
    const customer = 'export default function middleware() {\n  return new Response("mine")\n}\n'
    writeFileSync(join(root, entry), customer)
    const rerun = plan(root, LANE_WORKSPACE, {}, true)
    expect(rerun.serverLane?.created).toEqual(expect.arrayContaining([expect.objectContaining({ path: entry, action: "manual" })]))
    applyInstallation({ root, workspaceId: LANE_WORKSPACE, plan: rerun })
    const merged = readInstallManifest(root)!
    expect(merged.serverLane?.created ?? []).not.toContain(entry)
    expect(merged.files).not.toContain(entry)
    expect(merged.configOwnership?.[entry]).toBeUndefined()

    expect(() => uninstallInstallation({ root, dryRun: false })).not.toThrow()
    expect(readFileSync(join(root, entry), "utf8")).toBe(customer)
  })

  it("b: a browser re-run takes its own env keys whole; the lane's stay", () => {
    // (A re-run can no longer drop a tool implicitly, see "a re-run never silently removes an installed
    // tool" below; this run ADDS one, and the browser half's keys are still this run's, whole.)
    const root = copyFixture("next-app-router-basic")
    apply(root, BROWSER_WORKSPACE, { infinite }, false)
    const infiniteOnly = readInstallManifest(root)!.envKeys
    apply(root, LANE_WORKSPACE, {}, true)
    const withGa4 = plan(root, BROWSER_WORKSPACE, { infinite, ga4: { measurementId: "G-TEST123" } }, false)
    applyInstallation({ root, workspaceId: BROWSER_WORKSPACE, plan: withGa4 })
    const envKeys = readInstallManifest(root)!.envKeys
    expect(withGa4.envKeys.length).toBeGreaterThan(infiniteOnly.length)
    expect([...envKeys].sort()).toEqual([...new Set([...withGa4.envKeys, "INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"])].sort())
  })
})

// Review round 2 (PR #15).
describe("install receipt merge: review round 2", () => {
  it("J: a pre-browserTag receipt for helpers beside an adopted tag, then a new lane run: uninstall still takes the tag off", () => {
    const root = copyFixture("next-app-router-basic")
    const layout = join(root, "app/layout.tsx")
    writeFileSync(layout, readFileSync(layout, "utf8").replace("<body>", `<head>${ADOPTED_GA4}</head>\n      <body>`))
    const original = snapshotTree(root)
    apply(root, BROWSER_WORKSPACE, { ga4: { measurementId: "G-ADOPTED0" }, conversions: { helpers: true } }, false)
    // What 0.13.0 wrote: no browserTag marker, no ids.
    const { browserTag: _browserTag, ids: _ids, ...legacy } = readInstallManifest(root)!
    expect(legacy.providers).toEqual([])
    writeInstallManifest(root, legacy as InstallManifest)

    apply(root, LANE_WORKSPACE, {}, true)
    expect(readInstallManifest(root)!.browserTag).toBe(true)

    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
  })

  it("K: a browser re-run that changes a tool's id records the new id (the run's ids are taken whole)", () => {
    const root = copyFixture("next-app-router-basic")
    const posthog = { projectKey: "phc_test", apiHost: "/ingest", proxy: { path: "/ingest", assetsHost: "https://us-assets.i.posthog.com", ingestHost: "https://us.i.posthog.com" } }
    apply(root, BROWSER_WORKSPACE, { infinite, posthog }, false)
    expect(readInstallManifest(root)!.ids?.posthog).toEqual({ projectKey: "phc_test", apiHost: "/ingest" })
    apply(root, BROWSER_WORKSPACE, { infinite, posthog: { ...posthog, projectKey: "phc_other" } }, false)
    const merged = readInstallManifest(root)!
    expect(merged.providers).toEqual(["posthog", "infinite"])
    expect(readFileSync(join(root, "lib/infinite-analytics.ts"), "utf8")).not.toContain("phc_test")
    expect(merged.ids).toEqual({ ga4: [], posthog: { projectKey: "phc_other", apiHost: "/ingest" }, meta: [], infinite: { siteSourceKey: infinite.siteSourceKey } })
  })
})

// PR #15 follow-up (i): a later run must never SILENTLY take a tool off the page that the receipt records
// as installed. The README's `install --server-lane --workspace <id> --yes` picks up the file `infinite
// setup` saved (often the Infinite source alone) and used to re-render the browser tag from it, dropping
// the GA4 / PostHog / Meta the wizard installed. Removing a tool is only ever `uninstall`.
describe("install receipt merge: a re-run never silently removes an installed tool", () => {
  const WORKSPACE = "ws_rerun_keeps_tools_test"
  const ga4 = { measurementId: "G-TEST123" }
  const posthog = { projectKey: "phc_test", apiHost: "https://us.i.posthog.com" }
  const meta = { pixelId: "1234567890123456" }
  let artifactsDir: string
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), "instrument-receipt-merge-artifacts-"))
    tempRoots.push(artifactsDir)
    process.env.INFINITE_ARTIFACTS_DIR = artifactsDir
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    delete process.env.INFINITE_ARTIFACTS_DIR
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  /** The browser tag with four tools, then the file `infinite setup` saved: the Infinite source alone. */
  function wizardTagThenSavedInfiniteOnly(root: string): InstallManifest {
    apply(root, WORKSPACE, { infinite, ga4, posthog, meta }, false)
    const receipt = readInstallManifest(root)!
    expect(receipt.providers).toEqual(["ga4", "posthog", "meta", "infinite"])
    writeFileSync(join(artifactsDir, `${WORKSPACE}.json`), JSON.stringify({ workspaceId: WORKSPACE, infinite }))
    return receipt
  }

  it("the README's install --server-lane --workspace <id> --yes adds the lane and leaves the browser tag and its record whole", async () => {
    const root = copyFixture("next-app-router-basic")
    const browser = wizardTagThenSavedInfiniteOnly(root)
    const tagBefore = new Map(browser.files.map((file) => [file, readFileSync(join(root, file), "utf8")]))

    const code = await runCli(["install", "--root", root, "--server-lane", "--workspace", WORKSPACE, "--yes"])
    expect(code).toBe(0)
    // The summary names the tag it left alone; it never says the pixel is "NOT installed".
    const out = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
    expect(out).toContain("Browser tag left as it is (Google Analytics, PostHog, Meta Pixel, and Infinite, as installed).")
    expect(out).not.toContain("Browser pixel NOT installed.")

    for (const [file, contents] of tagBefore) expect(readFileSync(join(root, file), "utf8")).toBe(contents)
    const merged = readInstallManifest(root)!
    expect(merged.providers).toEqual(browser.providers)
    expect(merged.ids).toEqual(browser.ids)
    for (const file of browser.files) expect(merged.contentHashes[file]).toBe(browser.contentHashes[file])
    // The saved Infinite source still configures the lane.
    expect(merged.serverLane?.mode).toBe("next-middleware")
    expect(readFileSync(join(root, "lib/infinite-server-lane.ts"), "utf8")).toContain(infinite.siteSourceKey)
  })

  it("a plain browser install from a saved file that lacks installed tools is refused, naming them, and writes nothing", async () => {
    const root = copyFixture("next-app-router-basic")
    wizardTagThenSavedInfiniteOnly(root)
    const before = snapshotTree(root)

    const code = await runCli(["install", "--root", root, "--workspace", WORKSPACE, "--yes"])
    expect(code).toBe(1)
    const out = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
    expect(out).toMatch(/Google Analytics, PostHog and Meta Pixel/)
    expect(out).toContain("npx infinite-tag uninstall")
    expectTreeEquals(root, before)
  })

  it("a browser re-run that omits a recorded tool is a plan blocker, and apply refuses it before writing", () => {
    const root = copyFixture("next-app-router-basic")
    apply(root, BROWSER_WORKSPACE, { infinite, posthog }, false)
    const before = snapshotTree(root)

    const rerun = planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: BROWSER_WORKSPACE, artifacts: { infinite }, serverLane: false })
    expect(rerun.blockers.join(" ")).toMatch(/would remove PostHog[\s\S]*\.infinite\/install\.json records it as installed/)
    expect(() => applyInstallation({ root, workspaceId: BROWSER_WORKSPACE, plan: rerun })).toThrow(/would remove PostHog/)
    expectTreeEquals(root, before)
  })

  it("the same refusal holds with --server-lane when the run carries browser artifacts of its own", () => {
    const root = copyFixture("next-app-router-basic")
    apply(root, BROWSER_WORKSPACE, { infinite, ga4 }, false)
    const rerun = planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: BROWSER_WORKSPACE, artifacts: { infinite }, serverLane: true })
    expect(rerun.blockers.join(" ")).toMatch(/would remove Google Analytics/)
  })

  it("a lane-only plan carries the lane's inputs but plans no browser tag", () => {
    const root = copyFixture("next-app-router-basic")
    apply(root, BROWSER_WORKSPACE, { infinite, ga4 }, false)
    const lanePlan = planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: BROWSER_WORKSPACE, artifacts: { infinite }, serverLane: true, laneOnly: true })
    expect(lanePlan.blockers).toEqual([])
    expect(lanePlan.providers).toEqual([])
    expect(lanePlan.files).not.toContain("app/layout.tsx")
    expect(lanePlan.serverLane?.mode).toBe("next-middleware")
  })
})
