import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { applyInstallation } from "../apply.js"
import { inspectWorkspace } from "../inspect.js"
import { planInstallation } from "../plan.js"
import { uninstallInstallation } from "../uninstall.js"
import { verifyInstallation } from "../verify.js"
import { applyPosthogProxy } from "../workspace-artifacts.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-next-proxy-${name}-`))
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

const proxyArtifacts = applyPosthogProxy(
  {
    posthog: {
      projectKey: "phc_abcDEF0123456789xyz",
      apiHost: "https://us.i.posthog.com"
    }
  },
  { proxy: true }
)

describe.each([
  ["next-app-router-basic", "app router"],
  ["next-pages-router-basic", "pages router"]
])("Next %s posthog reverse proxy — next.config.mjs", (fixture) => {
  it("creates next.config.mjs with the rewrites, verifies, and removes it on uninstall", () => {
    const root = copyFixture(fixture)
    const plan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: proxyArtifacts
    })
    expect(plan.blockers).toEqual([])
    expect(plan.files).toContain("next.config.mjs")

    const applied = applyInstallation({
      root,
      workspaceId: "ws_test",
      plan,
      allowDirty: true
    })
    expect(applied.changedFiles).toContain("next.config.mjs")

    const config = readFileSync(join(root, "next.config.mjs"), "utf8")
    expect(config.split("\n")[0]).toBe("// Managed by Infinite. Public install artifacts only.")
    expect(config).toContain(
      '{ source: "/ingest/static/:path(.*)", destination: "https://us-assets.i.posthog.com/static/:path" }'
    )
    expect(config).toContain(
      '{ source: "/ingest/array/:path(.*)", destination: "https://us-assets.i.posthog.com/array/:path" }'
    )
    expect(config).toContain(
      '{ source: "/ingest/:path(.*)", destination: "https://us.i.posthog.com/:path" }'
    )

    const manifest = JSON.parse(readFileSync(join(root, ".infinite/install.json"), "utf8"))
    expect(manifest.files).toContain("next.config.mjs")
    expect(verifyInstallation({ root }).buildOk).toBe(true)

    const result = uninstallInstallation({ root, allowDirty: true })
    expect(result.removedFiles).toContain("next.config.mjs")
    expect(existsSync(join(root, "next.config.mjs"))).toBe(false)
  })

  it("is idempotent — a re-apply does not rewrite next.config.mjs", () => {
    const root = copyFixture(fixture)
    const first = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: proxyArtifacts
    })
    applyInstallation({
      root,
      workspaceId: "ws_test",
      plan: first,
      allowDirty: true
    })
    const before = readFileSync(join(root, "next.config.mjs"), "utf8")

    const second = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: proxyArtifacts
    })
    const applied = applyInstallation({
      root,
      workspaceId: "ws_test",
      plan: second,
      allowDirty: true
    })
    expect(applied.changedFiles).toEqual([])
    expect(readFileSync(join(root, "next.config.mjs"), "utf8")).toBe(before)
  })

  it("refuses to edit an existing UNMANAGED next.config: plan-only + manual instruction", () => {
    const root = copyFixture(fixture)
    writeFileSync(join(root, "next.config.js"), "module.exports = { reactStrictMode: true }\n")

    const plan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: proxyArtifacts
    })
    expect(plan.applyMode).toBe("plan-only")
    expect(plan.blockers.some((b) => b.includes("next.config.js"))).toBe(true)
    // The manual instruction carries the exact rewrites for the user to paste.
    const manual = plan.instructions.find((i) => i.path === "next.config.js")
    expect(manual?.snippet).toContain("/ingest/static/:path(.*)")
    // A plan-only plan must never be applied.
    expect(() =>
      applyInstallation({
        root,
        workspaceId: "ws_test",
        plan,
        allowDirty: true
      })
    ).toThrow(/Refusing to apply/)
    // The consumer's own config is left untouched.
    expect(readFileSync(join(root, "next.config.js"), "utf8")).toBe(
      "module.exports = { reactStrictMode: true }\n"
    )
  })

  it("proves exact rewrites in an unmanaged config without owning or deleting it", () => {
    const root = copyFixture(fixture)
    const manualConfig = [
      "module.exports = {",
      "  reactStrictMode: true,",
      "  async rewrites() {",
      "    return [",
      '      { source: "/ingest/static/:path(.*)", destination: "https://us-assets.i.posthog.com/static/:path" },',
      '      { source: "/ingest/array/:path(.*)", destination: "https://us-assets.i.posthog.com/array/:path" },',
      '      { source: "/ingest/:path(.*)", destination: "https://us.i.posthog.com/:path" }',
      "    ]",
      "  }",
      "}",
      ""
    ].join("\n")
    writeFileSync(join(root, "next.config.js"), manualConfig)

    const plan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: proxyArtifacts
    })
    expect(plan.blockers).toEqual([])
    expect(plan.files).not.toContain("next.config.js")

    applyInstallation({ root, workspaceId: "ws_test", plan, allowDirty: true })
    expect(readFileSync(join(root, "next.config.js"), "utf8")).toBe(manualConfig)
    uninstallInstallation({ root, allowDirty: true })
    expect(readFileSync(join(root, "next.config.js"), "utf8")).toBe(manualConfig)
  })

  it("refuses to trust or remove a hand-edited generated config", () => {
    const root = copyFixture(fixture)
    const first = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: proxyArtifacts
    })
    applyInstallation({
      root,
      workspaceId: "ws_test",
      plan: first,
      allowDirty: true
    })
    const edited = `${readFileSync(join(root, "next.config.mjs"), "utf8")}\n// customer addition\n`
    writeFileSync(join(root, "next.config.mjs"), edited)

    const rerun = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: proxyArtifacts
    })
    expect(rerun.applyMode).toBe("plan-only")
    expect(rerun.blockers.join("\n")).toMatch(/changed|ownership|hash/i)
    expect(() => uninstallInstallation({ root, allowDirty: true })).toThrow(
      /changed|ownership|hash/i
    )
    expect(readFileSync(join(root, "next.config.mjs"), "utf8")).toBe(edited)
  })
})
