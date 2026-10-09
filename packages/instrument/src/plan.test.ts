import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  it("blocks static Infinite collection without a proven Vercel same-origin proxy", () => {
    const root = copyFixture("static-html-basic")
    const plan = planInstallation({
      root,
      workspaceId: "ws_test",
      artifacts: {
        infinite: {
          siteSourceKey: "site_public_123",
          collectPath: "/infinite/events/collect",
          productionHosts: ["example.com"]
        }
      }
    })

    expect(plan.blockers.join("\n")).toContain("same-origin proxy")
    expect(plan.instructions.some((instruction) => instruction.snippet.includes("app.ultima.inc"))).toBe(false)
  })

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
      // Config is baked into the injected index.html <script>, so there are no VITE_* env keys.
      envKeys: [],
      applyMode: "supported"
    })
    // The only managed file is index.html — never the React entrypoint, never a JS analytics module.
    expect(plan.files).toEqual(["index.html"])
    expect(plan.files).not.toContain("src/main.tsx")
    expect(plan.assumptions).toContain(
      "Vite React public IDs are baked into the injected index.html <script> at install time."
    )
    expect(plan.blockers).toEqual([])
    expect(plan.confidence).toBeGreaterThanOrEqual(0.75)
    // Provider snippets are full <script> blocks targeting index.html, and there is no main.tsx edit.
    expect(plan.instructions.some((instruction) => instruction.path === "src/main.tsx")).toBe(false)
    expect(plan.instructions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "index.html",
          provider: "ga4",
          snippet: expect.stringContaining("G-TEST123")
        }),
        expect.objectContaining({
          path: "index.html",
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

  it("adopts a hand-rolled gtag tag instead of blocking: no second GA4 copy, Infinite still installs", async () => {
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
      workspaceId: "ws-test",
      artifacts: {
        ga4: { measurementId: "G-TEST123" },
        infinite: {
          siteSourceKey: "site_public_123",
          collectPath: "/infinite/ledger",
          productionHosts: ["example.com"],
          staticProxy: "vercel",
          consentMode: "not_required"
        }
      }
    })

    expect(plan.adopted).toEqual([{ provider: "ga4", via: "snippet", file: "index.html" }])
    expect(plan.blockers).toEqual([])
    expect(plan.providers).toEqual(["infinite"])
    expect(plan.instructions.map((instruction) => instruction.provider).filter(Boolean)).toEqual(["infinite"])
    expect(plan.instructions.some((instruction) => instruction.snippet.includes("G-TEST123"))).toBe(false)
    expect(plan.assumptions).toContain(
      "Existing Google Analytics found in index.html (existing snippet); left untouched. infinite-tag will not install a second copy."
    )
    expect(plan.confidence).toBeGreaterThan(0.45)
    expect(plan.applyMode).toBe("supported")

    const before = readFileSync(join(root, "index.html"), "utf8")
    applyInstallation({ root, workspaceId: "ws-test", plan, allowDirty: true })
    const after = readFileSync(join(root, "index.html"), "utf8")
    expect(after).toContain('src="https://www.googletagmanager.com/gtag/js?id=G-EXISTING"')
    expect(after).not.toContain("G-TEST123")
    expect(after.indexOf("G-EXISTING")).toBe(before.indexOf("G-EXISTING"))
    expect(after).toContain("site_public_123")
  })

  it("when every requested provider already exists, the plan has nothing to write and apply is a no-op", async () => {
    const root = copyFixture("static-html-basic")
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html>\n<html lang="en">\n  <head>\n    <script>gtag("config", "G-EXISTING")</script>\n  </head>\n  <body></body>\n</html>\n'
    )
    const before = readFileSync(join(root, "index.html"), "utf8")

    const plan = await planInstallation({
      root,
      inspect: await inspectWorkspace(root),
      workspaceId: "ws-test",
      artifacts: { ga4: { measurementId: "G-TEST123" } }
    })

    expect(plan.adopted).toEqual([{ provider: "ga4", via: "snippet", file: "index.html" }])
    expect(plan.providers).toEqual([])
    expect(plan.blockers).toEqual([])
    expect(plan.files).toEqual([])
    expect(plan.instructions).toEqual([])

    const result = applyInstallation({ root, workspaceId: "ws-test", plan, allowDirty: true })
    expect(result.changedFiles).toEqual([])
    expect(result.warnings).toEqual([
      "Nothing to install: Google Analytics already exists in index.html and was left untouched."
    ])
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe(before)
    expect(existsSync(join(root, ".infinite", "install.json"))).toBe(false)
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
