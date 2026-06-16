import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { cpSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { applyInstallation } from "./apply.js"
import { inspectWorkspace } from "./inspect.js"
import { planInstallation } from "./plan.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-fixture-${name}-`))
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

describe("planInstallation", () => {
  it("returns an unsupported repo message for unknown shapes", async () => {
    const root = copyFixture("unsupported-basic")
    const inspectResult = await inspectWorkspace(root)
    const plan = await planInstallation({
      root,
      inspect: inspectResult,
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        }
      }
    })

    expect(plan.blockers).toContain("Unsupported repository shape for instrumentation.")
    expect(plan.confidence).toBeLessThan(0.5)
  })

  it("produces a deterministic plan for a Vite React fixture", async () => {
    const root = copyFixture("vite-react-basic")
    const inspectResult = await inspectWorkspace(root)
    const plan = await planInstallation({
      root,
      inspect: inspectResult,
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        },
        posthog: {
          projectKey: "phc_test",
          apiHost: "https://app.posthog.example"
        }
      }
    })

    expect(inspectResult.framework).toBe("vite-react")
    expect(plan).toMatchObject({
      framework: "vite-react",
      providers: ["ga4", "posthog"],
      envKeys: ["VITE_GA4_MEASUREMENT_ID", "VITE_POSTHOG_API_HOST", "VITE_POSTHOG_KEY"],
      applyMode: "supported"
    })
    expect(plan.files).toEqual(["index.html", "src/main.tsx", "src/lib/infinite-analytics.ts"])
    expect(plan.assumptions).toContain("Vite React public IDs can be surfaced through VITE_* environment variables or direct public wiring.")
    expect(plan.blockers).toEqual([])
    expect(plan.confidence).toBeGreaterThanOrEqual(0.75)
    expect(plan.instructions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/main.tsx",
          action: "modify",
          description: expect.stringContaining("installInfiniteInstrumentation")
        }),
        expect.objectContaining({
          path: "src/lib/infinite-analytics.ts",
          provider: "ga4",
          snippet: expect.stringContaining("G-TEST123")
        }),
        expect.objectContaining({
          path: "src/lib/infinite-analytics.ts",
          provider: "posthog",
          snippet: expect.stringContaining("phc_test")
        })
      ])
    )
  })

  it("produces a supported plan for a simple Next app router fixture", async () => {
    const root = copyFixture("next-app-router-basic")
    const inspectResult = await inspectWorkspace(root)
    const plan = await planInstallation({
      root,
      inspect: inspectResult,
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        }
      }
    })

    expect(inspectResult.framework).toBe("next-app-router")
    expect(plan).toMatchObject({
      framework: "next-app-router",
      providers: ["ga4"],
      envKeys: ["NEXT_PUBLIC_GA4_MEASUREMENT_ID"],
      applyMode: "supported"
    })
    expect(plan.files).toEqual([
      "app/layout.tsx",
      "lib/infinite-analytics-client.tsx",
      "lib/infinite-analytics.ts"
    ])
    expect(plan.blockers).toEqual([])
    expect(plan.confidence).toBeGreaterThanOrEqual(0.9)
    expect(plan.instructions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "app/layout.tsx",
          action: "modify",
          description: expect.stringContaining("root app layout")
        }),
        expect.objectContaining({
          path: "lib/infinite-analytics.ts",
          provider: "ga4",
          snippet: expect.stringContaining("G-TEST123")
        })
      ])
    )
  })

  it("keeps Next app router plans blocked when no root layout exists", async () => {
    const root = copyFixture("next-app-router-page-only")
    const inspectResult = await inspectWorkspace(root)
    const plan = await planInstallation({
      root,
      inspect: inspectResult,
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        }
      }
    })

    expect(inspectResult.framework).toBe("next-app-router")
    expect(plan.applyMode).toBe("plan-only")
    expect(plan.blockers).toContain(
      "Next.js App Router apply requires a root app/layout.* file so the managed client component can be mounted safely."
    )
    expect(plan.confidence).toBeLessThan(0.5)
  })

  it("produces a supported plan for a simple Next pages router fixture", async () => {
    const root = copyFixture("next-pages-router-basic")
    const inspectResult = await inspectWorkspace(root)
    const plan = await planInstallation({
      root,
      inspect: inspectResult,
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        },
        posthog: {
          projectKey: "phc_test",
          apiHost: "https://app.posthog.example"
        }
      }
    })

    expect(inspectResult.framework).toBe("next-pages-router")
    expect(plan).toMatchObject({
      framework: "next-pages-router",
      providers: ["ga4", "posthog"],
      envKeys: ["NEXT_PUBLIC_GA4_MEASUREMENT_ID", "NEXT_PUBLIC_POSTHOG_API_HOST", "NEXT_PUBLIC_POSTHOG_KEY"],
      applyMode: "supported"
    })
    expect(plan.files).toEqual([
      "pages/_app.tsx",
      "lib/infinite-analytics-client.tsx",
      "lib/infinite-analytics.ts"
    ])
    expect(plan.blockers).toEqual([])
    expect(plan.confidence).toBeGreaterThanOrEqual(0.9)
    expect(plan.instructions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "pages/_app.tsx",
          action: "modify",
          description: expect.stringContaining("pages/_app")
        }),
        expect.objectContaining({
          path: "lib/infinite-analytics.ts",
          provider: "posthog",
          snippet: expect.stringContaining("phc_test")
        })
      ])
    )
  })

  it("keeps Next pages router plans blocked when pages/_app is missing", async () => {
    const root = copyFixture("next-pages-router-index-only")
    const inspectResult = await inspectWorkspace(root)
    const plan = await planInstallation({
      root,
      inspect: inspectResult,
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        }
      }
    })

    expect(inspectResult.framework).toBe("next-pages-router")
    expect(plan.applyMode).toBe("plan-only")
    expect(plan.blockers).toContain(
      "Next.js Pages Router apply requires pages/_app.* so the managed client component can be mounted safely."
    )
    expect(plan.confidence).toBeLessThan(0.5)
  })

  it("blocks vite-react plan when main.tsx uses hydrateRoot instead of createRoot", async () => {
    const root = copyFixture("vite-react-basic")
    writeFileSync(
      join(root, "src/main.tsx"),
      'import React from "react";\nimport ReactDOM from "react-dom/client";\n\nfunction App(): React.JSX.Element {\n  return <h1>Vite fixture</h1>;\n}\n\nconst root = document.getElementById("root");\nif (!root) { throw new Error("Missing root element"); }\nReactDOM.hydrateRoot(root, <App />);\n'
    )
    const inspectResult = await inspectWorkspace(root)
    const plan = await planInstallation({
      root,
      inspect: inspectResult,
      artifacts: { ga4: { measurementId: "G-TEST123" } }
    })

    expect(plan.blockers).toContain(
      "Vite React apply only supports simple main entrypoints with ReactDOM.createRoot()."
    )
    expect(plan.applyMode).toBe("plan-only")
    expect(plan.confidence).toBeLessThanOrEqual(0.45)
    expect(() =>
      applyInstallation({ root, workspaceId: "ws-test", plan, allowDirty: true })
    ).toThrow(/Refusing to apply/)
  })

  it("blocks vite-react plan when main.tsx has no import block", async () => {
    const root = copyFixture("vite-react-basic")
    writeFileSync(join(root, "src/main.tsx"), 'console.log("no imports")\n')
    const inspectResult = await inspectWorkspace(root)
    const plan = await planInstallation({
      root,
      inspect: inspectResult,
      artifacts: { ga4: { measurementId: "G-TEST123" } }
    })

    expect(plan.blockers).toContain(
      "Vite React apply requires a simple import block at the top of src/main.*."
    )
  })

  it("blocks vite-react plan when an unmanaged infinite-analytics.ts already exists", async () => {
    const root = copyFixture("vite-react-basic")
    mkdirSync(join(root, "src/lib"), { recursive: true })
    writeFileSync(join(root, "src/lib/infinite-analytics.ts"), "export const custom = true\n")
    const inspectResult = await inspectWorkspace(root)
    const plan = await planInstallation({
      root,
      inspect: inspectResult,
      artifacts: { ga4: { measurementId: "G-TEST123" } }
    })

    expect(plan.blockers).toContain(
      "Vite React apply will not overwrite an existing unmanaged src/lib/infinite-analytics.ts file."
    )
    expect(plan.applyMode).toBe("plan-only")
  })

  it("blocks a GA4 install when a hand-rolled gtag tag already exists", async () => {
    const root = copyFixture("static-html-basic")
    writeFileSync(
      join(root, "index.html"),
      [
        "<!doctype html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="utf-8" />',
        "    <title>Static Fixture</title>",
        '    <script async src="https://www.googletagmanager.com/gtag/js?id=G-EXISTING"></script>',
        "    <script>",
        "      window.dataLayer = window.dataLayer || [];",
        "      function gtag(){dataLayer.push(arguments);}",
        "      gtag('js', new Date());",
        "      gtag('config', 'G-EXISTING');",
        "    </script>",
        "  </head>",
        "  <body>",
        "    <h1>Static fixture</h1>",
        "  </body>",
        "</html>",
        ""
      ].join("\n")
    )

    const inspectResult = await inspectWorkspace(root)
    const plan = await planInstallation({
      root,
      inspect: inspectResult,
      artifacts: { ga4: { measurementId: "G-TEST123" } }
    })

    expect(plan.blockers).toContain(
      "Existing GA4 analytics wiring was detected in this repo and is not managed by Infinite. Remove or migrate the existing GA4 tag before installing it with infinite-tag."
    )
    expect(() =>
      applyInstallation({ root, workspaceId: "ws-test", plan, allowDirty: true })
    ).toThrow(/Refusing to apply/)
  })

  it("does not block installing a different provider next to a hand-rolled gtag", async () => {
    const root = copyFixture("static-html-basic")
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html>\n<html lang="en">\n  <head>\n    <script async src="https://www.googletagmanager.com/gtag/js?id=G-EXISTING"></script>\n  </head>\n  <body>\n    <h1>Static fixture</h1>\n  </body>\n</html>\n'
    )

    const inspectResult = await inspectWorkspace(root)
    const plan = await planInstallation({
      root,
      inspect: inspectResult,
      artifacts: {
        posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" }
      }
    })

    expect(plan.blockers).toEqual([])
  })

  it("does not block our own managed re-apply", async () => {
    const root = copyFixture("static-html-basic")
    const artifacts = {
      ga4: { measurementId: "G-TEST123" },
      posthog: { projectKey: "phc_test", apiHost: "https://app.posthog.example" }
    }
    const firstPlan = await planInstallation({
      root,
      inspect: await inspectWorkspace(root),
      workspaceId: "ws-test",
      artifacts
    })
    expect(firstPlan.blockers).toEqual([])
    applyInstallation({ root, workspaceId: "ws-test", plan: firstPlan, allowDirty: true })

    const rerunPlan = await planInstallation({
      root,
      inspect: await inspectWorkspace(root),
      workspaceId: "ws-test",
      artifacts
    })

    expect(rerunPlan.blockers).toEqual([])
    expect(() =>
      applyInstallation({ root, workspaceId: "ws-test", plan: rerunPlan, allowDirty: true })
    ).not.toThrow()
  })

  it("blocks static-html plan when index.html has no closing </head> tag", async () => {
    const root = copyFixture("static-html-basic")
    writeFileSync(
      join(root, "index.html"),
      "<!doctype html>\n<html><body><h1>x</h1></body></html>\n"
    )
    const inspectResult = await inspectWorkspace(root)
    const plan = await planInstallation({
      root,
      inspect: inspectResult,
      artifacts: { ga4: { measurementId: "G-TEST123" } }
    })

    expect(inspectResult.framework).toBe("static-html")
    expect(plan.blockers).toContain("Static HTML apply requires a closing </head> tag.")
    expect(plan.applyMode).toBe("plan-only")
    expect(() =>
      applyInstallation({ root, workspaceId: "ws-test", plan, allowDirty: true })
    ).toThrow(/Refusing to apply/)
  })
})
