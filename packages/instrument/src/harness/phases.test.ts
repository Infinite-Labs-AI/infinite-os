import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { cleanupSites, IDS, makeSite, STATIC_HTML } from "../../test/wizard/o7-fakes.js"

import { readWorkspaceGlobs, resolveAppRoot } from "./inspect.js"
import { preflightPhase, serverLanePhase } from "./run.js"
import { scanSourceFiles } from "./scan.js"

afterEach(cleanupSites)

const POSTHOG_PAGE = STATIC_HTML.replace("</head>", `  <script>posthog.init('${IDS.posthog}', { api_host: 'https://us.i.posthog.com' })</script>\n  </head>`)

describe("the extracted phases keep the harness's behaviour", () => {
  it("preflight blocks a writing run on a dirty tree only without --allow-dirty", () => {
    const root = makeSite({ "index.html": STATIC_HTML })
    expect(preflightPhase({ root, writes: true, allowDirty: false })).toMatchObject({ status: "not-a-git-repo", blockedByDirtyTree: false })
    expect(() => preflightPhase({ root, writes: true, allowDirty: false, nodeVersion: "v16.0.0" })).toThrow(/too old/)
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
})

describe("the scan reports truncation and stays in the app root", () => {
  it("public/ is walked only when asked (static sites), and the walk never leaves the app root", () => {
    const root = makeSite({ "apps/web/index.html": STATIC_HTML, "apps/web/public/landing.html": STATIC_HTML, "outside.html": STATIC_HTML })
    const appRoot = join(root, "apps/web")
    expect(scanSourceFiles(appRoot).files).toEqual(["index.html"])
    expect(scanSourceFiles(appRoot, { includePublic: true }).files).toEqual(["index.html", "public/landing.html"])
  })
})
