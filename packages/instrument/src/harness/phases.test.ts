// The harness phases lane O7 extracted (run.ts) and its inspect/scan additions: the improve
// classification, monorepo app roots, the scan's truncation report.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { cleanupSites, IDS, makeSite, read, STATIC_HTML } from "../../test/wizard/o7-fakes.js"
import type { ImproveLine } from "../types.js"

import { classifyProviders, readWorkspaceGlobs, resolveAppRoot } from "./inspect.js"
import { applyPhase, classifyPhase, inspectPhase, planPhase, preflightPhase, serverLanePhase } from "./run.js"
import { scanSourceFiles, SCAN_MAX_FILES, walkSourceFiles } from "./scan.js"

afterEach(cleanupSites)

const POSTHOG_PAGE = STATIC_HTML.replace("</head>", `  <script>posthog.init('${IDS.posthog}', { api_host: 'https://us.i.posthog.com' })</script>\n  </head>`)
const proxyLine: ImproveLine = { id: "improve_additive:posthog:proxy", kind: "improve_additive", provider: "posthog", target: "proxy", text: "proxy", owner: "code", evidence: { file: "index.html", line: 6 } }

describe("classify: adopt → improve only with the wizard's improve lines (decision 4)", () => {
  it("an adopted provider with improve lines is `improve` (still adopted, never install)", () => {
    const root = makeSite({ "index.html": POSTHOG_PAGE })
    const phase = inspectPhase({ root })
    const classes = classifyPhase({ manifest: null, detected: phase.detected, keys: { artifacts: {}, sources: {} }, adoptExisting: true, serverLane: false, improve: { posthog: [proxyLine] } })
    expect(classes.find((entry) => entry.provider === "posthog")).toMatchObject({ action: "improve", improve: [proxyLine] })
    // The plan lists it as adopted, with its lines, and installs nothing for it.
    const plan = planPhase({ root, inspect: phase.inspect, classifications: classes, keys: { artifacts: {}, sources: {} }, serverLane: false })
    expect(plan.plan.providers).toEqual([])
    expect(plan.plan.adopted).toEqual([expect.objectContaining({ provider: "posthog", improve: [proxyLine] })])
  })

  it("NEGATIVE: without improve lines (the harness) the classification is exactly today's `adopt`", () => {
    const root = makeSite({ "index.html": POSTHOG_PAGE })
    const phase = inspectPhase({ root })
    const classes = classifyProviders({ manifest: null, detected: phase.detected, keys: { artifacts: {}, sources: {} }, adoptExisting: true, serverLane: false })
    expect(classes.find((entry) => entry.provider === "posthog")?.action).toBe("adopt")
    expect(classes.some((entry) => entry.action === "improve")).toBe(false)
  })
})

describe("the extracted phases keep the harness's behaviour", () => {
  it("preflight blocks a writing run on a dirty tree only without --allow-dirty", () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    expect(preflightPhase({ root, writes: true, allowDirty: false })).toMatchObject({ status: "not-a-git-repo", blockedByDirtyTree: false })
    expect(() => preflightPhase({ root, writes: true, allowDirty: false, nodeVersion: "v16.0.0" })).toThrow(/too old/)
  })

  it("apply: requiresManual comes back as open jobs; static verification passes", () => {
    const root = makeSite({ "package.json": `{"dependencies":{"react":"18.0.0","vite":"5.0.0"}}\n`, "index.html": "<html><body></body></html>\n", "vercel.json": "{}\n" })
    const phase = inspectPhase({ root })
    const keys = { artifacts: { ga4: { measurementId: IDS.ga4 } }, sources: { ga4: "flag" as const } }
    const classes = classifyPhase({ manifest: null, detected: phase.detected, keys, adoptExisting: true, serverLane: false })
    const plan = planPhase({ root, inspect: phase.inspect, classifications: classes, keys, workspaceId: "wizard:abababababababab", serverLane: false })
    const applied = applyPhase({ root, workspaceId: "wizard:abababababababab", plan: plan.plan, allowDirty: true })
    expect(applied.outcome).toBe("applied")
    expect(applied.openJobs.map((job) => job.path)).toEqual(["index.html"])
    expect(read(root, "index.html")).toBe("<html><body></body></html>\n")
  })

  it("serverLanePhase: a manual entry is never 'installed'", () => {
    const outcome = serverLanePhase({
      lane: { mode: "vercel-middleware", briefPath: "INSTALL-SERVER-LANE.md", envKeys: [], files: [], assumptions: [], created: [{ path: "middleware.ts", role: "entry", action: "manual", reason: "exists" }, { path: "lib/infinite-server-lane.ts", role: "module", action: "create" }] },
      applied: { manifest: { mode: "vercel-middleware" }, brief: "", briefWritten: true }
    })
    expect(outcome).toMatchObject({ kind: "manual_entry", manualEntry: { path: "middleware.ts" } })
  })
})

describe("monorepo app roots: Vercel rootDirectory → workspace globs → today's rule", () => {
  const mono = () =>
    makeSite({
      "package.json": `{"private":true,"workspaces":{"packages":["apps/*"]}}\n`,
      "apps/web/index.html": STATIC_HTML,
      "apps/docs/index.html": STATIC_HTML,
      "apps/api/package.json": `{"name":"api"}\n`
    })

  it("rootDirectory = apps/web wins", () => {
    expect(resolveAppRoot(mono(), { vercelRootDirectory: "apps/web" })).toMatchObject({ appRoot: "apps/web", source: "vercel_root_directory" })
  })

  it("NEGATIVE: a rootDirectory that escapes the repo or does not exist is ignored", () => {
    expect(resolveAppRoot(mono(), { vercelRootDirectory: "../elsewhere" }).source).not.toBe("vercel_root_directory")
    expect(resolveAppRoot(mono(), { vercelRootDirectory: "apps/missing" }).source).not.toBe("vercel_root_directory")
  })

  it("two web apps among the globs is ambiguous (no guess); an explicit flag wins over everything", () => {
    const root = mono()
    expect(readWorkspaceGlobs(root)).toEqual(["apps/*"])
    expect(resolveAppRoot(root)).toMatchObject({ appRoot: undefined, ambiguous: true, candidates: ["apps/docs", "apps/web"] })
    expect(resolveAppRoot(root, { flag: "apps/docs", vercelRootDirectory: "apps/web" })).toMatchObject({ appRoot: "apps/docs", source: "flag" })
  })

  it("pnpm-workspace.yaml globs are read too", () => {
    const root = makeSite({ "pnpm-workspace.yaml": "packages:\n  - \"sites/*\"\n  - '!sites/old'\nother: 1\n", "sites/shop/index.html": STATIC_HTML })
    expect(readWorkspaceGlobs(root)).toEqual(["sites/*"])
    expect(resolveAppRoot(root)).toMatchObject({ appRoot: "sites/shop", source: "workspace_globs" })
  })
})

describe("the scan reports truncation and stays in the app root", () => {
  it("2,001 files → truncated with a warning; the walk keeps its first 2,000 in order", () => {
    const root = makeSite({})
    mkdirSync(join(root, "src"))
    for (let index = 0; index <= SCAN_MAX_FILES; index += 1) writeFileSync(join(root, "src", `f${String(index).padStart(4, "0")}.ts`), "export {}\n")
    const scan = scanSourceFiles(root)
    expect(scan.truncated).toBe(true)
    expect(scan.files).toHaveLength(SCAN_MAX_FILES)
    expect(scan.warning).toMatch(/stopped at 2,000 files/)
    expect(walkSourceFiles(root)).toEqual(scan.files)
  })

  it("NEGATIVE: exactly 2,000 files is not truncated", () => {
    const root = makeSite({})
    mkdirSync(join(root, "src"))
    for (let index = 0; index < SCAN_MAX_FILES; index += 1) writeFileSync(join(root, "src", `f${index}.ts`), "export {}\n")
    expect(scanSourceFiles(root)).toMatchObject({ truncated: false, warning: null })
  })

  it("public/ is walked only when asked (static sites), and the walk never leaves the app root", () => {
    const root = makeSite({ "apps/web/index.html": STATIC_HTML, "apps/web/public/landing.html": STATIC_HTML, "outside.html": STATIC_HTML })
    const appRoot = join(root, "apps/web")
    expect(scanSourceFiles(appRoot).files).toEqual(["index.html"])
    expect(scanSourceFiles(appRoot, { includePublic: true }).files).toEqual(["index.html", "public/landing.html"])
  })
})
