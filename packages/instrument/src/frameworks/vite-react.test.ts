// The Vite adapter injects the analytics tag into index.html (like static-html) and NEVER reads or
// edits the React entrypoint. These tests prove: the block lands in index.html, main.tsx is untouched
// regardless of its contents (even an old "false-supported" shape), uninstall reverses it, re-install
// is idempotent, and a genuinely-unwritable index.html (no </head>) falls closed to the manual step.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { planInstallation } from "../plan.js"
import { inspectWorkspace } from "../inspect.js"
import { applyInstallation } from "../apply.js"
import { uninstallInstallation } from "../uninstall.js"
import { verifyInstallation } from "../verify.js"
import type { WorkspaceInstallArtifacts } from "../types.js"
import { applyPosthogProxy } from "../workspace-artifacts.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-vite-react-test-${name}-`))
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

const BASE_ARTIFACTS = { ga4: { measurementId: "G-TEST123" } }
const MANAGED_START = "<!-- infinite:start -->"

function planFor(root: string, artifacts: WorkspaceInstallArtifacts = BASE_ARTIFACTS) {
  return planInstallation({ root, inspect: inspectWorkspace(root), workspaceId: "ws_test", artifacts })
}

describe("vite-react index.html injection", () => {
  it("injects the managed <script> into index.html and NEVER touches src/main.tsx", () => {
    const root = copyFixture("vite-react-basic")
    const mainBefore = readFileSync(join(root, "src/main.tsx"), "utf8")

    const plan = planFor(root)
    expect(plan.blockers).toEqual([])
    expect(plan.applyMode).toBe("supported")
    expect(plan.files).toContain("index.html")
    expect(plan.files).not.toContain("src/main.tsx")
    expect(plan.files).not.toContain("src/lib/infinite-analytics.ts")

    const apply = applyInstallation({ root, workspaceId: "ws_test", plan, allowDirty: true })
    expect(apply.changedFiles).toContain("index.html")
    expect(apply.requiresManual).toBeUndefined()

    const html = readFileSync(join(root, "index.html"), "utf8")
    expect(html).toContain(MANAGED_START)
    expect(html).toContain("G-TEST123")
    // The entrypoint is untouched and NO analytics module was created.
    expect(readFileSync(join(root, "src/main.tsx"), "utf8")).toBe(mainBefore)
    expect(existsSync(join(root, "src/lib/infinite-analytics.ts"))).toBe(false)
    expect(verifyInstallation({ root }).buildOk).toBe(true)
  })

  it("installs regardless of main.tsx contents — an adversarial entrypoint is simply IGNORED", () => {
    // An old false-"supported" shape: a real react-dom import shadowed by a local createRoot. The
    // adapter no longer reads main.tsx at all, so it installs cleanly by injecting into index.html.
    const root = copyFixture("vite-react-basic")
    const adversarial =
      [
        'import { createRoot } from "react-dom/client"',
        "function createRoot(n: number) { return { render() { void n } } }",
        "createRoot(1).render()"
      ].join("\n") + "\n"
    writeFileSync(join(root, "src/main.tsx"), adversarial)

    const plan = planFor(root)
    expect(plan.applyMode).toBe("supported")
    const apply = applyInstallation({ root, workspaceId: "ws_test", plan, allowDirty: true })
    expect(apply.requiresManual).toBeUndefined()
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain(MANAGED_START)
    // The entrypoint is left byte-for-byte — never read, never edited.
    expect(readFileSync(join(root, "src/main.tsx"), "utf8")).toBe(adversarial)
  })

  it("a COMMENTED provider snippet in main.tsx does NOT suppress the install (false-adoption guard)", () => {
    // The live iter7 P0: a commented posthog.init( in main.tsx made detectUnmanagedProviders ADOPT
    // posthog, dropping it from the install -> green exit, no pixel. It must still be INSTALLED.
    const root = copyFixture("vite-react-basic")
    writeFileSync(
      join(root, "src/main.tsx"),
      [
        'import { createRoot } from "react-dom/client"',
        '// posthog.init("phc_example", { api_host: "https://us.i.posthog.com" })',
        "const s = \"gtag('config')\"",
        'createRoot(document.getElementById("root")!).render(null)',
        "void s",
        ""
      ].join("\n")
    )

    const plan = planFor(root, { posthog: { projectKey: "phc_test", apiHost: "https://us.i.posthog.com" } })
    // Installed, not adopted.
    expect(plan.providers).toContain("posthog")
    expect(plan.adopted.map((entry) => entry.provider)).not.toContain("posthog")
    expect(plan.files).toContain("index.html")

    const apply = applyInstallation({ root, workspaceId: "ws_test", plan, allowDirty: true })
    expect(apply.changedFiles).toContain("index.html")
    const html = readFileSync(join(root, "index.html"), "utf8")
    expect(html).toContain(MANAGED_START)
    expect(html).toContain("phc_test")
  })

  it("uninstall removes the managed block from index.html, restoring it exactly", () => {
    const root = copyFixture("vite-react-basic")
    const original = readFileSync(join(root, "index.html"), "utf8")
    applyInstallation({ root, workspaceId: "ws_test", plan: planFor(root), allowDirty: true })
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain(MANAGED_START)

    uninstallInstallation({ root, allowDirty: true })
    const after = readFileSync(join(root, "index.html"), "utf8")
    expect(after).not.toContain(MANAGED_START)
    expect(after).toBe(original)
  })

  it("full cycle: install -> reinstall (idempotent) -> verify -> uninstall", () => {
    const root = copyFixture("vite-react-basic")
    const original = readFileSync(join(root, "index.html"), "utf8")

    const first = applyInstallation({ root, workspaceId: "ws_test", plan: planFor(root), allowDirty: true })
    expect(first.changedFiles).toContain("index.html")
    const afterFirst = readFileSync(join(root, "index.html"), "utf8")

    const second = applyInstallation({ root, workspaceId: "ws_test", plan: planFor(root), allowDirty: true })
    expect(second.changedFiles).toEqual([])
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe(afterFirst)
    expect(afterFirst.match(/infinite:start/g)).toHaveLength(1)

    expect(verifyInstallation({ root }).buildOk).toBe(true)

    uninstallInstallation({ root, allowDirty: true })
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe(original)
  })

  it("falls closed to the manual step (exit-2 machinery) when index.html has no </head>", () => {
    const root = copyFixture("vite-react-basic")
    writeFileSync(join(root, "index.html"), "<html><body><div id=\"root\"></div></body></html>\n")

    const plan = planFor(root)
    // Not a hard block; index.html is simply NOT a managed file, and apply surfaces the manual step.
    expect(plan.applyMode).toBe("supported")
    expect(plan.files).not.toContain("index.html")

    const apply = applyInstallation({ root, workspaceId: "ws_test", plan, allowDirty: true })
    expect(apply.requiresManual?.[0]?.path).toBe("index.html")
    expect(apply.requiresManual?.[0]?.snippet).toContain(MANAGED_START)
    expect(readFileSync(join(root, "index.html"), "utf8")).not.toContain(MANAGED_START)
  })
})

describe("vite-react posthog reverse proxy (vercel.json)", () => {
  it("creates vercel.json with EU-region rewrites, verifies, and reverses on uninstall", async () => {
    const root = copyFixture("vite-react-basic")
    const artifacts = applyPosthogProxy(
      { posthog: { projectKey: "phc_abcDEF0123456789xyz", apiHost: "https://eu.i.posthog.com" } },
      { proxy: true }
    )
    const inspect = inspectWorkspace(root)
    const plan = planInstallation({ root, inspect, workspaceId: "ws_test", artifacts })
    expect(plan.blockers).toEqual([])
    expect(plan.files).toContain("vercel.json")

    const applied = applyInstallation({ root, workspaceId: "ws_test", plan, allowDirty: true })
    expect(applied.changedFiles).toContain("vercel.json")

    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"))
    expect(vercel.rewrites).toEqual([
      { source: "/ingest/static/:path(.*)", destination: "https://eu-assets.i.posthog.com/static/:path" },
      { source: "/ingest/array/:path(.*)", destination: "https://eu-assets.i.posthog.com/array/:path" },
      { source: "/ingest/:path(.*)", destination: "https://eu.i.posthog.com/:path" }
    ])
    expect(verifyInstallation({ root }).buildOk).toBe(true)

    const result = uninstallInstallation({ root, allowDirty: true })
    expect(result.removedFiles).toContain("vercel.json")
    expect(existsSync(join(root, "vercel.json"))).toBe(false)
  })

  it("reapplies Infinite-only as PostHog plus Infinite without replacing customer routes", () => {
    const root = copyFixture("vite-react-basic")
    const original = '{ "rewrites" : [ { "source" : "/customer", "destination" : "/api/customer" } ] }\n'
    writeFileSync(join(root, "vercel.json"), original)
    const infiniteOnly: WorkspaceInstallArtifacts = {
      productionHosts: ["example.com"],
      infinite: {
        siteSourceKey: "site_public_123",
        collectPath: "/infinite/events/collect",
        productionHosts: ["example.com"],
        staticProxy: "vercel",
        consentMode: "required"
      }
    }
    const mixed = applyPosthogProxy(
      {
        ...infiniteOnly,
        posthog: { projectKey: "phc_test", apiHost: "https://eu.i.posthog.com" }
      },
      { proxy: true }
    )

    applyInstallation({
      root,
      workspaceId: "ws_test",
      plan: planInstallation({ root, workspaceId: "ws_test", artifacts: infiniteOnly }),
      allowDirty: true
    })
    applyInstallation({
      root,
      workspaceId: "ws_test",
      plan: planInstallation({ root, workspaceId: "ws_test", artifacts: mixed }),
      allowDirty: true
    })

    expect(JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")).rewrites).toEqual([
      { source: "/customer", destination: "/api/customer" },
      { source: "/ingest/static/:path(.*)", destination: "https://eu-assets.i.posthog.com/static/:path" },
      { source: "/ingest/array/:path(.*)", destination: "https://eu-assets.i.posthog.com/array/:path" },
      { source: "/ingest/:path(.*)", destination: "https://eu.i.posthog.com/:path" },
      {
        source: "/infinite/events/collect",
        destination: "https://api.ultima.inc/api/analytics/events/collect"
      }
    ])

    uninstallInstallation({ root, allowDirty: true })
    expect(readFileSync(join(root, "vercel.json"), "utf8")).toBe(original)
  })
})
