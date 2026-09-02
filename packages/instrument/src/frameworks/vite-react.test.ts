import { describe, expect, it } from "vitest"

// Access the internal helpers via the exported adapter's plan logic indirectly,
// but for unit-testing the scanner we inline-test via upsertMainEntrypoint
// behaviour (which is the only consumer of findImportSectionEnd /
// consumeImportStatement). We do this by importing the adapter and driving it
// through planInstallation-style inputs, avoiding the need to export internals.

// The functions under test are not exported, so we test them through the
// public surface: upsertMainEntrypoint is exercised via the adapter's apply()
// path, but findImportSectionEnd / consumeImportStatement are more directly
// exercised by calling them inline. Since they are not exported, we test their
// effects through plan() (which calls findImportSectionEnd and returns a blocker
// when it returns null) and through a small inline reimport trick.
//
// Rather than re-export internals, we test the observable outcomes:
//   FIX 1 — a file with `importantSetup()` does NOT get a "no import block" blocker
//            and the wiring is injected BEFORE the non-import line.
//   FIX 2 — a file with a stray `{` inside a line comment is accepted and wired.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach } from "vitest"
import { cpSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

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

const REACT_DOM_BOOT = 'ReactDOM.createRoot(document.getElementById("root")!).render(<App />)'
const BASE_ARTIFACTS = { ga4: { measurementId: "G-TEST123" } }

describe("vite-react import scanner — FIX 1: word-boundary check", () => {
  it("does not consume importantSetup() as an import statement", async () => {
    const root = copyFixture("vite-react-basic")
    // Write a main.tsx where an identifier starting with "import" (importantSetup)
    // appears immediately after the real import block.
    writeFileSync(
      join(root, "src/main.tsx"),
      [
        'import ReactDOM from "react-dom/client"',
        'import "./styles.css"',
        "importantSetup()",
        REACT_DOM_BOOT,
        ""
      ].join("\n")
    )

    const inspect = await inspectWorkspace(root)
    const plan = await planInstallation({ root, inspect, artifacts: BASE_ARTIFACTS })

    // The plan should succeed (no blocker about import block)
    expect(plan.blockers).not.toContain(
      "Vite React apply requires a simple import block at the top of src/main.*."
    )
    expect(plan.applyMode).toBe("supported")

    // Apply and verify the injected wiring lands before importantSetup(), not after
    applyInstallation({ root, workspaceId: "ws-test", plan, allowDirty: true })

    const { readFileSync } = await import("node:fs")
    const result = readFileSync(join(root, "src/main.tsx"), "utf8")

    const importLinePos = result.indexOf('import { installInfiniteInstrumentation }')
    const importantSetupPos = result.indexOf("importantSetup()")
    expect(importLinePos).toBeGreaterThanOrEqual(0)
    expect(importantSetupPos).toBeGreaterThan(importLinePos)
  })
})

describe("vite-react import scanner — FIX 2: comment/string delimiter skipping", () => {
  it("accepts a main.tsx with a stray { inside a line comment and is not forced to plan-only", async () => {
    const root = copyFixture("vite-react-basic")
    // A line comment containing an unbalanced `{` must not confuse the depth counter.
    writeFileSync(
      join(root, "src/main.tsx"),
      [
        'import ReactDOM from "react-dom/client"',
        'import x from "./x" // a comment with a stray {',
        'import y from "./y"',
        REACT_DOM_BOOT,
        ""
      ].join("\n")
    )

    const inspect = await inspectWorkspace(root)
    const plan = await planInstallation({ root, inspect, artifacts: BASE_ARTIFACTS })

    // Must NOT be refused to plan-only due to a null findImportSectionEnd
    expect(plan.blockers).not.toContain(
      "Vite React apply requires a simple import block at the top of src/main.*."
    )
    expect(plan.applyMode).toBe("supported")

    // Apply must succeed and inject wiring
    expect(() =>
      applyInstallation({ root, workspaceId: "ws-test", plan, allowDirty: true })
    ).not.toThrow()

    const { readFileSync } = await import("node:fs")
    const result = readFileSync(join(root, "src/main.tsx"), "utf8")
    expect(result).toContain("installInfiniteInstrumentation()")
  })

  it("accepts a main.tsx with a stray { inside an import path string", async () => {
    const root = copyFixture("vite-react-basic")
    // An import path string containing `{` must not throw off the depth counter.
    writeFileSync(
      join(root, "src/main.tsx"),
      [
        'import ReactDOM from "react-dom/client"',
        'import x from "./path{with}braces"',
        'import y from "./y"',
        REACT_DOM_BOOT,
        ""
      ].join("\n")
    )

    const inspect = await inspectWorkspace(root)
    const plan = await planInstallation({ root, inspect, artifacts: BASE_ARTIFACTS })

    expect(plan.applyMode).toBe("supported")
    expect(plan.blockers).not.toContain(
      "Vite React apply requires a simple import block at the top of src/main.*."
    )
  })
})

describe("vite-react binding-aware bootstrap recognition", () => {
  function planFor(root: string) {
    const inspect = inspectWorkspace(root)
    return planInstallation({ root, inspect, artifacts: BASE_ARTIFACTS })
  }

  it("installs cleanly for a named `createRoot` import (the real customer entrypoint)", () => {
    const root = copyFixture("vite-react-named-createroot")
    const plan = planFor(root)
    expect(plan.blockers).toEqual([])
    expect(plan.applyMode).toBe("supported")
    applyInstallation({ root, workspaceId: "ws-test", plan, allowDirty: true })
    const main = readFileSync(join(root, "src/main.tsx"), "utf8")
    expect(main).toContain('import { installInfiniteInstrumentation } from "./lib/infinite-analytics"')
    expect(main).toContain("installInfiniteInstrumentation()")
    expect(main).toContain("createRoot(root).render(<App />)")
  })

  const IMPORTS_TAIL = 'const el = document.getElementById("root")!\n'
  const recognized: Array<[string, string]> = [
    ["aliased named createRoot", 'import { createRoot as cr } from "react-dom/client"\n' + IMPORTS_TAIL + "cr(el).render(<App />)\n"],
    ["namespace import", 'import * as ReactDOMClient from "react-dom/client"\n' + IMPORTS_TAIL + "ReactDOMClient.createRoot(el).render(<App />)\n"],
    ["default member createRoot", 'import ReactDOM from "react-dom/client"\n' + IMPORTS_TAIL + "ReactDOM.createRoot(el).render(<App />)\n"],
    ["hydrateRoot", 'import { hydrateRoot } from "react-dom/client"\n' + IMPORTS_TAIL + "hydrateRoot(el, <App />)\n"],
    ["legacy ReactDOM.render", 'import ReactDOM from "react-dom"\n' + IMPORTS_TAIL + "ReactDOM.render(<App />, el)\n"],
    ["legacy named render", 'import { render } from "react-dom"\n' + IMPORTS_TAIL + "render(<App />, el)\n"]
  ]

  it.each(recognized)("wires an entrypoint that boots via %s", (_label, mainSource) => {
    const root = copyFixture("vite-react-basic")
    writeFileSync(join(root, "src/main.tsx"), mainSource)
    const plan = planFor(root)
    expect(plan.blockers).toEqual([])
    expect(plan.applyMode).toBe("supported")
    applyInstallation({ root, workspaceId: "ws-test", plan, allowDirty: true })
    expect(readFileSync(join(root, "src/main.tsx"), "utf8")).toContain("installInfiniteInstrumentation()")
  })

  it("does NOT match a shadowed local createRoot — it falls back to a manual step, never a wrong wire", () => {
    const root = copyFixture("vite-react-basic")
    // A local function named createRoot, never imported from react-dom. Matching the bare name would
    // wire the wrong file; binding-aware matching rejects it.
    writeFileSync(
      join(root, "src/main.tsx"),
      'import { setup } from "./setup"\n\nfunction createRoot(n: number) {\n  return n + 1\n}\n\nsetup(createRoot(1))\n'
    )
    const plan = planFor(root)
    expect(plan.blockers).toEqual([])
    const manual = plan.instructions.find((instruction) => instruction.action === "manual")
    expect(manual?.path).toBe("src/main.tsx")
    expect(manual?.snippet).toContain("installInfiniteInstrumentation()")
    expect(plan.files).not.toContain("src/main.tsx")

    const apply = applyInstallation({ root, workspaceId: "ws-test", plan, allowDirty: true })
    // The unmanageable entrypoint is left byte-for-byte; the managed module is still written.
    expect(readFileSync(join(root, "src/main.tsx"), "utf8")).not.toContain("installInfiniteInstrumentation")
    expect(existsSync(join(root, "src/lib/infinite-analytics.ts"))).toBe(true)
    expect(apply.requiresManual?.[0]?.path).toBe("src/main.tsx")
  })

  it("does NOT match createRoot imported from the WRONG package — it falls back to manual", () => {
    const root = copyFixture("vite-react-basic")
    // `createRoot` here is imported from some-other-pkg, not react-dom. Binding-aware matching must
    // reject it: it is a different function that merely shares the name.
    writeFileSync(
      join(root, "src/main.tsx"),
      'import { createRoot } from "some-other-pkg"\n\nconst el = document.getElementById("root")!\ncreateRoot(el).render(<App />)\n'
    )
    const plan = planFor(root)
    expect(plan.blockers).toEqual([])
    expect(plan.instructions.find((instruction) => instruction.action === "manual")?.path).toBe("src/main.tsx")
    expect(plan.files).not.toContain("src/main.tsx")
    const apply = applyInstallation({ root, workspaceId: "ws-test", plan, allowDirty: true })
    expect(apply.requiresManual?.[0]?.path).toBe("src/main.tsx")
    expect(readFileSync(join(root, "src/main.tsx"), "utf8")).not.toContain("installInfiniteInstrumentation")
  })

  it("is idempotent after a manual wiring: a hand-added boot line is not flagged again", () => {
    const root = copyFixture("vite-react-basic")
    // No recognizable bootstrap, but the user has already pasted the boot line by hand.
    writeFileSync(
      join(root, "src/main.tsx"),
      'import { installInfiniteInstrumentation } from "./lib/infinite-analytics"\nimport { boot } from "./boot"\n\ninstallInfiniteInstrumentation()\nboot()\n'
    )
    const plan = planFor(root)
    expect(plan.instructions.some((instruction) => instruction.action === "manual")).toBe(false)
    expect(plan.applyMode).toBe("supported")
  })

  it("keeps a HAND-wired entrypoint user-owned (out of managed files), so a later edit never trips verify", () => {
    const root = copyFixture("vite-react-basic")
    // Already-wired but NEVER auto-wired by infinite-tag (no prior manifest records it). It must stay
    // out of managed `files` — P3: the user owns their entrypoint.
    writeFileSync(
      join(root, "src/main.tsx"),
      'import { installInfiniteInstrumentation } from "./lib/infinite-analytics"\nimport { boot } from "./boot"\n\ninstallInfiniteInstrumentation()\nboot()\n'
    )
    const plan = planFor(root)
    expect(plan.files).not.toContain("src/main.tsx")
    expect(plan.files).toContain("src/lib/infinite-analytics.ts")
  })

  it("keeps the entrypoint MANAGED across an idempotent re-run (auto -> already-wired stays ours)", () => {
    const root = copyFixture("vite-react-named-createroot")
    const first = applyInstallation({ root, workspaceId: "ws-test", plan: planFor(root), allowDirty: true })
    expect(first.changedFiles).toContain("src/main.tsx")
    // Second run: the boot line is present (already-wired), but the manifest recorded it as ours, so
    // it is still a managed file and nothing changes.
    const second = applyInstallation({ root, workspaceId: "ws-test", plan: planFor(root), allowDirty: true })
    expect(second.changedFiles).toEqual([])
    expect(second.requiresManual).toBeUndefined()
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

    const { readFileSync, existsSync } = await import("node:fs")
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
