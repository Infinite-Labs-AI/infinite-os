// End to end for the non-Next server lanes: which target a repo gets, which files land on disk,
// what the manifest records, and that `uninstall` puts the tree back byte-for-byte.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { applyInstallation } from "../../apply.js"
import { inspectWorkspace } from "../../inspect.js"
import { readInstallManifest } from "../../manifest.js"
import { planInstallation } from "../../plan.js"
import { renderPreview } from "../../render.js"
import type { WorkspaceInstallArtifacts } from "../../types.js"
import { uninstallInstallation } from "../../uninstall.js"
import { verifyInstallation } from "../../verify.js"
import { INFINITE_SERVER_EVENTS_DESTINATION } from "../../workspace-artifacts.js"
import { SERVER_LANE_BRIEF_FILE, SERVER_LANE_GUIDE_FILE } from "../copy.js"

import { CLOUDFLARE_MIDDLEWARE_PATH } from "./cloudflare.js"
import { NETLIFY_EDGE_FUNCTION_PATH } from "./netlify.js"
import { NODE_MODULE_PATH, NODE_OUTCOME_PATH } from "./node.js"
import { VERCEL_MIDDLEWARE_PATH, VERCEL_MODULE_PATH, VERCEL_OUTCOME_PATH } from "./vercel-any.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string, extra: Record<string, string> = {}): string {
  const source = join(fixtureRoot, "../../../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-lane-target-${name}-`))
  const target = join(targetRoot, name)
  tempRoots.push(targetRoot)
  cpSync(source, target, { recursive: true })
  for (const [relativePath, contents] of Object.entries(extra)) {
    const absolutePath = join(target, relativePath)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, contents)
  }
  return target
}

/** A Vite/React repo plus whatever host signal the case needs. */
function viteOn(extra: Record<string, string>): string {
  return copyFixture("vite-react-basic", extra)
}

function withDependency(root: string, dependency: string, version = "^1.0.0"): void {
  const packageJsonPath = join(root, "package.json")
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>
  }
  packageJson.dependencies = { ...(packageJson.dependencies ?? {}), [dependency]: version }
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2))
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

function plan(root: string, artifacts: WorkspaceInstallArtifacts = {}) {
  return planInstallation({
    root,
    inspect: inspectWorkspace(root),
    workspaceId: "ws_test",
    artifacts,
    serverLane: true
  })
}

function planAndApply(root: string, artifacts: WorkspaceInstallArtifacts = {}) {
  const installPlan = plan(root, artifacts)
  expect(installPlan.blockers).toEqual([])
  const apply = applyInstallation({ root, workspaceId: "ws_test", plan: installPlan })
  return { plan: installPlan, apply }
}

const EXISTING_MIDDLEWARE = 'export default function middleware() {\n  return new Response("hi")\n}\n'

describe("Vercel, any framework", () => {
  it("writes the root middleware, the lane module and the outcome helper, and reverses cleanly", () => {
    const root = viteOn({ "vercel.json": "{}\n" })
    const original = snapshotTree(root)

    const { plan: installPlan, apply } = planAndApply(root)
    expect(installPlan.serverLane).toMatchObject({
      mode: "vercel-middleware",
      briefPath: SERVER_LANE_BRIEF_FILE,
      targetLabel: "Vercel root middleware (any framework)",
      targetEvidence: "vercel.json",
      installPackages: ["@vercel/functions"],
      files: [VERCEL_MODULE_PATH, VERCEL_OUTCOME_PATH, VERCEL_MIDDLEWARE_PATH]
    })
    expect(installPlan.envKeys).toEqual(
      expect.arrayContaining(["INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"])
    )
    expect(apply.changedFiles).toEqual(
      expect.arrayContaining([
        VERCEL_MODULE_PATH,
        VERCEL_OUTCOME_PATH,
        VERCEL_MIDDLEWARE_PATH,
        SERVER_LANE_BRIEF_FILE,
        ".infinite/install.json"
      ])
    )
    expect(apply.serverLane?.manifest).toEqual({
      mode: "vercel-middleware",
      created: [VERCEL_MODULE_PATH, VERCEL_OUTCOME_PATH, VERCEL_MIDDLEWARE_PATH],
      // Only the directory the lane had to make; a `lib/` the repo already had would not be listed.
      createdDirs: ["lib"],
      brief: SERVER_LANE_BRIEF_FILE,
      guide: SERVER_LANE_GUIDE_FILE
    })

    const middleware = readFileSync(join(root, VERCEL_MIDDLEWARE_PATH), "utf8")
    expect(middleware).toContain('from "@vercel/functions"')
    expect(middleware).toContain('from "./lib/infinite-server-lane"')
    expect(middleware).toContain("context.waitUntil(task)")

    const manifest = readInstallManifest(root)!
    for (const path of [VERCEL_MODULE_PATH, VERCEL_OUTCOME_PATH, VERCEL_MIDDLEWARE_PATH]) {
      expect(manifest.configOwnership?.[path]).toMatchObject({ kind: "created" })
      expect(manifest.contentHashes[path]).toBeDefined()
    }
    expect(verifyInstallation({ root }).buildOk).toBe(true)

    // The guide tells the agent the one thing infinite-tag cannot do itself; the root is a pointer.
    expect(readFileSync(join(root, SERVER_LANE_BRIEF_FILE), "utf8")).toContain(SERVER_LANE_GUIDE_FILE)
    const brief = readFileSync(join(root, SERVER_LANE_GUIDE_FILE), "utf8")
    expect(brief).toContain("npm install @vercel/functions")
    expect(brief).toContain("Post a purchase from a server route")
    expect(brief).toContain("postInfiniteOutcome")

    // Idempotent: a second run touches nothing.
    const before = snapshotTree(root)
    const second = planAndApply(root)
    expect(second.apply.changedFiles).toEqual([])
    expectTreeEquals(root, before)

    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
  })

  it("is chosen by a linked .vercel/project.json too, and by vercel.json over every other signal", () => {
    expect(plan(viteOn({ ".vercel/project.json": '{"projectId":"p"}\n' })).serverLane?.mode).toBe(
      "vercel-middleware"
    )
    const tie = viteOn({ "vercel.json": "{}\n", "netlify.toml": "[build]\n" })
    expect(plan(tie).serverLane).toMatchObject({ mode: "vercel-middleware", targetEvidence: "vercel.json" })
  })

  it("leaves an existing unmanaged middleware.ts alone and puts the exact file in the brief", () => {
    const root = viteOn({ "vercel.json": "{}\n", "middleware.ts": EXISTING_MIDDLEWARE })
    const original = snapshotTree(root)

    const { plan: installPlan, apply } = planAndApply(root)
    expect(installPlan.serverLane?.created).toEqual([
      { path: VERCEL_MODULE_PATH, role: "module", action: "create" },
      { path: VERCEL_OUTCOME_PATH, role: "module", action: "create" },
      {
        path: VERCEL_MIDDLEWARE_PATH,
        role: "entry",
        action: "manual",
        reason: "middleware.ts already exists and is not managed by Infinite"
      }
    ])
    expect(installPlan.serverLane?.files).toEqual([VERCEL_MODULE_PATH, VERCEL_OUTCOME_PATH])
    expect(readFileSync(join(root, VERCEL_MIDDLEWARE_PATH), "utf8")).toBe(EXISTING_MIDDLEWARE)
    expect(apply.warnings.some((warning) => warning.includes("left untouched"))).toBe(true)

    const brief = readFileSync(join(root, SERVER_LANE_GUIDE_FILE), "utf8")
    expect(brief).toContain("Files to add by hand")
    expect(brief).toContain("`middleware.ts` was NOT written")
    expect(brief).toContain("export default function middleware")
    expect(readInstallManifest(root)?.serverLane?.created).toEqual([VERCEL_MODULE_PATH, VERCEL_OUTCOME_PATH])

    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
  })

  it("blocks on an unmanaged lib/infinite-server-lane.ts rather than overwriting it", () => {
    const root = viteOn({ "vercel.json": "{}\n", [VERCEL_MODULE_PATH]: "export const mine = true\n" })
    const installPlan = plan(root)
    expect(installPlan.blockers).toContain(
      `Server lane apply will not overwrite an existing unmanaged ${VERCEL_MODULE_PATH} file.`
    )
    expect(() => applyInstallation({ root, workspaceId: "ws_test", plan: installPlan })).toThrow(/Refusing to apply/)
  })

  it("keeps a file the customer edited after we created it, and refuses to uninstall it", () => {
    const root = viteOn({ "vercel.json": "{}\n" })
    planAndApply(root)
    const middlewarePath = join(root, VERCEL_MIDDLEWARE_PATH)
    writeFileSync(middlewarePath, `${readFileSync(middlewarePath, "utf8")}\n// customer edit\n`)

    const rerun = planAndApply(root)
    expect(rerun.plan.serverLane?.created).toContainEqual({
      path: VERCEL_MIDDLEWARE_PATH,
      role: "entry",
      action: "keep"
    })
    expect(rerun.apply.warnings.some((warning) => warning.includes("edited after infinite-tag created it"))).toBe(true)
    expect(readFileSync(middlewarePath, "utf8")).toContain("// customer edit")

    expect(() => uninstallInstallation({ root, dryRun: false })).toThrow(/changed after installation/)
    expect(existsSync(middlewarePath)).toBe(true)
  })

  it("installs alongside the pixel and names the target (and why) in the preview", () => {
    const root = viteOn({ "vercel.json": "{}\n" })
    const artifacts: WorkspaceInstallArtifacts = {
      infinite: {
        siteSourceKey: "site_public_test",
        collectPath: "/infinite/events/collect",
        productionHosts: ["example.com"],
        consentMode: "not_required"
      }
    }
    const { plan: installPlan } = planAndApply(root, artifacts)
    const preview = renderPreview(installPlan)
    expect(preview).toContain("→ Vercel root middleware (any framework)  (chosen because this repo has vercel.json)")
    expect(preview).toContain(`+ ${VERCEL_MIDDLEWARE_PATH}`)
    expect(preview).toContain("postInfiniteOutcome() for your server routes")
    expect(preview).toContain("→ then run: npm install @vercel/functions")

    // The public artifacts are baked in; the secret never is.
    const module = readFileSync(join(root, VERCEL_MODULE_PATH), "utf8")
    expect(module).toContain('const INFINITE_SOURCE_KEY_FALLBACK = "site_public_test"')
    expect(module).toContain('const INFINITE_PRODUCTION_HOSTS: string[] = ["example.com"]')
    expect(module).not.toMatch(/INFINITE_SERVER_EVENT_SECRET\s*=\s*"[^"]/)
  })
})

describe("Netlify", () => {
  it("writes an edge function declared in-file, and never touches netlify.toml", () => {
    const netlifyToml = '[build]\n  publish = "dist"\n'
    const root = viteOn({ "netlify.toml": netlifyToml })
    const original = snapshotTree(root)

    const { plan: installPlan, apply } = planAndApply(root)
    expect(installPlan.serverLane).toMatchObject({
      mode: "netlify-edge",
      targetEvidence: "netlify.toml",
      files: ["lib/infinite-outcome.ts", NETLIFY_EDGE_FUNCTION_PATH]
    })
    expect(installPlan.serverLane?.installPackages).toBeUndefined()
    expect(readFileSync(join(root, "netlify.toml"), "utf8")).toBe(netlifyToml)

    const edgeFunction = readFileSync(join(root, NETLIFY_EDGE_FUNCTION_PATH), "utf8")
    expect(edgeFunction).toContain('path: "/*"')
    expect(edgeFunction).toContain("Netlify?.env?.get")
    expect(edgeFunction).not.toContain("import ")
    expect(apply.serverLane?.manifest.mode).toBe("netlify-edge")

    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
    expect(existsSync(join(root, "netlify/edge-functions"))).toBe(false)
  })

  it("is chosen by an @netlify/* dependency alone", () => {
    const root = copyFixture("vite-react-basic")
    withDependency(root, "@netlify/functions", "^2.0.0")
    expect(plan(root).serverLane).toMatchObject({
      mode: "netlify-edge",
      targetEvidence: 'the "@netlify/functions" dependency'
    })
  })
})

describe("directories the lane did not create", () => {
  it("leaves a pre-existing empty netlify/ directory alone and prunes only netlify/edge-functions", () => {
    // An empty `netlify/` IS the hosting evidence (hosting.ts), so deleting it on uninstall would
    // both change a tree we never wrote and un-detect the host.
    const root = copyFixture("vite-react-basic")
    mkdirSync(join(root, "netlify"))
    const original = snapshotTree(root)

    const { apply } = planAndApply(root)
    expect(apply.serverLane?.manifest.createdDirs).toEqual(["netlify/edge-functions", "lib"])

    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
    expect(existsSync(join(root, "netlify"))).toBe(true)
    expect(existsSync(join(root, "netlify/edge-functions"))).toBe(false)
  })

  it("leaves a pre-existing empty functions/ directory alone", () => {
    const root = viteOn({ "wrangler.toml": 'name = "app"\npages_build_output_dir = "dist"\n' })
    mkdirSync(join(root, "functions"))
    const { apply } = planAndApply(root)
    expect(apply.serverLane?.manifest.createdDirs).not.toContain("functions")

    uninstallInstallation({ root, dryRun: false })
    expect(existsSync(join(root, "functions"))).toBe(true)
    expect(existsSync(join(root, CLOUDFLARE_MIDDLEWARE_PATH))).toBe(false)
  })

  it("still prunes a functions/ directory it created itself", () => {
    const root = viteOn({ "wrangler.toml": 'name = "app"\npages_build_output_dir = "dist"\n' })
    const { apply } = planAndApply(root)
    expect(apply.serverLane?.manifest.createdDirs).toContain("functions")
    uninstallInstallation({ root, dryRun: false })
    expect(existsSync(join(root, "functions"))).toBe(false)
  })

  it("remembers what it created across an idempotent re-run", () => {
    const root = viteOn({ "netlify.toml": "[build]\n" })
    planAndApply(root)
    // Second run: the directories already exist, so only the carried-forward record can prune them.
    const second = planAndApply(root)
    expect(second.apply.changedFiles).toEqual([])
    const createdDirs = readInstallManifest(root)?.serverLane?.createdDirs ?? []
    expect([...createdDirs].sort()).toEqual(["lib", "netlify", "netlify/edge-functions"])
    // Deepest first, or the parent is still non-empty when uninstall reaches it.
    expect(createdDirs.indexOf("netlify/edge-functions")).toBeLessThan(createdDirs.indexOf("netlify"))
    uninstallInstallation({ root, dryRun: false })
    expect(existsSync(join(root, "netlify"))).toBe(false)
  })
})

describe("--infinite-api-origin", () => {
  it("moves the server lane, the outcome helper and the brief to the same host as the browser lane", () => {
    const root = viteOn({ "vercel.json": "{}\n" })
    const apiOrigin = "https://api.infinite.fast"
    planAndApply(root, {
      infinite: {
        siteSourceKey: "site_public_test",
        collectPath: "/infinite/ledger",
        productionHosts: ["example.com"],
        consentMode: "not_required",
        apiOrigin
      }
    })
    for (const path of [VERCEL_MODULE_PATH, VERCEL_OUTCOME_PATH]) {
      const source = readFileSync(join(root, path), "utf8")
      expect(source).toContain(`"${apiOrigin}/api/analytics/events/server"`)
      expect(source).not.toContain(INFINITE_SERVER_EVENTS_DESTINATION)
    }
    const brief = readFileSync(join(root, SERVER_LANE_GUIDE_FILE), "utf8")
    expect(brief).toContain(`POST ${apiOrigin}/api/analytics/events/server`)
    expect(brief).toContain(`${apiOrigin}/api/analytics/site/server-lane/receipt`)
    expect(brief).not.toContain(INFINITE_SERVER_EVENTS_DESTINATION)
  })
})

describe("Cloudflare", () => {
  it("writes functions/_middleware.ts for a Pages project", () => {
    const root = viteOn({ "wrangler.toml": 'name = "app"\npages_build_output_dir = "dist"\n' })
    const original = snapshotTree(root)

    const { plan: installPlan } = planAndApply(root)
    expect(installPlan.serverLane).toMatchObject({
      mode: "cloudflare-pages",
      targetEvidence: "wrangler.toml",
      files: ["lib/infinite-outcome.ts", CLOUDFLARE_MIDDLEWARE_PATH]
    })
    const middleware = readFileSync(join(root, CLOUDFLARE_MIDDLEWARE_PATH), "utf8")
    expect(middleware).toContain("export const onRequest")
    expect(middleware).toContain("cf-connecting-ip")
    expect(middleware).toContain("return context.next()")

    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
  })

  it("treats an existing functions/ directory as the Pages signal", () => {
    const root = viteOn({
      "functions/hello.ts": "export const onRequest = () => new Response('hi')\n",
      "wrangler.toml": 'name = "app"\nmain = "src/index.ts"\n'
    })
    expect(plan(root).serverLane?.mode).toBe("cloudflare-pages")
  })

  it("falls back to the brief for a plain Worker, writing nothing", () => {
    const root = viteOn({ "wrangler.toml": 'name = "worker"\nmain = "src/index.ts"\n' })
    const { plan: installPlan, apply } = planAndApply(root)
    expect(installPlan.serverLane).toMatchObject({ mode: "brief", files: [] })
    expect(existsSync(join(root, CLOUDFLARE_MIDDLEWARE_PATH))).toBe(false)
    expect(apply.serverLane?.brief).toContain("Cloudflare Workers")
  })
})

describe("Express / any Node server", () => {
  it("writes the module and the outcome helper, and never edits a server file", () => {
    const root = copyFixture("vite-react-basic", {
      "server.js": 'import express from "express"\nconst app = express()\napp.listen(3000)\n'
    })
    withDependency(root, "express", "^4.19.2")
    const serverBefore = readFileSync(join(root, "server.js"), "utf8")
    const original = snapshotTree(root)

    const { plan: installPlan } = planAndApply(root)
    expect(installPlan.serverLane).toMatchObject({
      mode: "node-module",
      targetEvidence: 'the "express" dependency',
      files: [NODE_MODULE_PATH, NODE_OUTCOME_PATH]
    })
    expect(readFileSync(join(root, "server.js"), "utf8")).toBe(serverBefore)

    const brief = readFileSync(join(root, SERVER_LANE_GUIDE_FILE), "utf8")
    expect(brief).toContain("Mount it in your server")
    expect(brief).toContain("app.use(infiniteServerLane())")
    expect(brief).toContain('import { infiniteServerLane } from "./lib/infinite-server-lane.js"')

    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
  })
})

describe("no host signal", () => {
  it("still writes only the brief, exactly as before", () => {
    const root = copyFixture("vite-react-basic")
    const original = snapshotTree(root)
    const { plan: installPlan, apply } = planAndApply(root)
    expect(installPlan.serverLane).toMatchObject({ mode: "brief", files: [] })
    expect(apply.serverLane?.manifest).toEqual({ mode: "brief", brief: SERVER_LANE_BRIEF_FILE, guide: SERVER_LANE_GUIDE_FILE })
    uninstallInstallation({ root, dryRun: false })
    expectTreeEquals(root, original)
  })

  it("a static HTML site on Vercel gets the same runnable lane a framework does", () => {
    const root = copyFixture("static-html-basic", { "vercel.json": "{}\n" })
    const { plan: installPlan } = planAndApply(root)
    expect(installPlan.serverLane?.mode).toBe("vercel-middleware")
    expect(existsSync(join(root, VERCEL_MIDDLEWARE_PATH))).toBe(true)
  })
})

describe("Next.js is untouched by hosting detection", () => {
  it("keeps the Next middleware lane even with vercel.json, netlify.toml and wrangler.toml present", () => {
    const root = copyFixture("next-app-router-basic", {
      "vercel.json": "{}\n",
      "netlify.toml": "[build]\n",
      "wrangler.toml": 'name = "app"\n'
    })
    const { plan: installPlan } = planAndApply(root)
    expect(installPlan.serverLane).toMatchObject({
      mode: "next-middleware",
      middleware: { path: "middleware.ts", action: "create" },
      modulePath: "lib/infinite-server-lane.ts"
    })
    expect(installPlan.serverLane?.created).toBeUndefined()
    expect(existsSync(join(root, VERCEL_OUTCOME_PATH))).toBe(false)
  })
})
