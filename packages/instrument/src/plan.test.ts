import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
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
  it("installs GA4 and PostHog natively with NO Infinite runtime when there is no Infinite source (0.6.0: mirror mode removed)", () => {
    const root = copyFixture("static-html-basic")
    const plan = planInstallation({
      root,
      workspaceId: "ws_test",
      artifacts: {
        ga4: { measurementId: "G-ABC123XYZ" },
        posthog: { projectKey: "phc_abc123", apiHost: "https://us.i.posthog.com" }
      }
    })

    const providerInstructions = plan.instructions
      .filter((instruction) => instruction.provider)
      .map((instruction) => instruction.provider)
    // Before 0.6.0 a dormant Infinite runtime rode along to forward page views into GA4/PostHog;
    // the runtime now emits only to Infinite, so without a source there is nothing to embed.
    expect(providerInstructions).toEqual(["ga4", "posthog"])
    expect(plan.providers).toEqual(["ga4", "posthog"])
    expect(plan.instructions.some((instruction) => instruction.snippet.includes("data-infinite-runtime"))).toBe(false)
  })

  it("pins every browser provider before Infinite in the full provider order", () => {
    const root = copyFixture("static-html-basic")
    const plan = planInstallation({
      root,
      workspaceId: "ws_test",
      artifacts: {
        infinite: {
          siteSourceKey: "site_public_123",
          collectPath: "/infinite/events/collect",
          productionHosts: ["example.com"],
          staticProxy: "vercel",
          consentMode: "required"
        },
        ga4: { measurementId: "G-ABC123XYZ" },
        posthog: { projectKey: "phc_abc123", apiHost: "https://us.i.posthog.com" },
        x: { pixelId: "o1abc", eventTagIds: ["tw-event-1"] },
        meta: { pixelId: "1234567890123456" }
      }
    })

    expect(
      plan.instructions
        .filter((instruction) => instruction.provider)
        .map((instruction) => instruction.provider)
    ).toEqual(["ga4", "posthog", "x", "meta", "infinite"])
  })

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

  it("plans the exact Infinite rewrite when static Vercel support is explicit", () => {
    const root = copyFixture("static-html-basic")
    const plan = planInstallation({
      root,
      workspaceId: "ws_test",
      artifacts: {
        infinite: {
          siteSourceKey: "site_public_123",
          collectPath: "/infinite/events/collect",
          productionHosts: ["example.com"],
          staticProxy: "vercel",
          consentMode: "required"
        }
      }
    })

    expect(plan.blockers).toEqual([])
    expect(plan.files).toContain("vercel.json")
    expect(plan.instructions.find((instruction) => instruction.path === "vercel.json")?.snippet).toContain(
      "https://api.ultima.inc/api/analytics/events/collect"
    )
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

  it("plans an explicit Infinite source after provider initialization in a Next app router fixture", async () => {
    const root = copyFixture("next-app-router-basic")
    const inspectResult = await inspectWorkspace(root)
    const plan = await planInstallation({
      root,
      inspect: inspectResult,
      workspaceId: "ws_test",
      artifacts: {
        infinite: {
          siteSourceKey: "site_public_123",
          collectPath: "/infinite/events/collect",
          productionHosts: ["example.com"],
          consentMode: "required"
        },
        ga4: { measurementId: "G-TEST123" },
        meta: { pixelId: "1234567890123456" }
      }
    })

    expect(plan.providers).toEqual(["ga4", "meta", "infinite"])
    expect(plan.blockers).toEqual([])
    expect(plan.applyMode).toBe("supported")
    expect(plan.instructions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "lib/infinite-analytics.ts",
          provider: "infinite",
          snippet: expect.stringContaining("/infinite/events/collect")
        }),
        expect.objectContaining({
          path: "lib/infinite-analytics.ts",
          provider: "meta",
          snippet: expect.stringContaining("fbevents.js")
        })
      ])
    )
    expect(plan.instructions.map((instruction) => instruction.snippet).join("\n")).not.toContain(
      "app.ultima.inc"
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

  it("adopts a GA4 install managed through Tag Manager and names the container file", async () => {
    const root = copyFixture("static-html-basic")
    writeFileSync(
      join(root, "index.html"),
      [
        "<!doctype html>",
        '<html lang="en">',
        "  <head>",
        "    <script>(function(w,d,s,l,i){w[l]=w[l]||[];j=d.createElement(s);j.src='https://www.googletagmanager.com/gtm.js?id='+i;})(window,document,'script','dataLayer','GTM-ABCD12');</script>",
        "  </head>",
        "  <body></body>",
        "</html>",
        ""
      ].join("\n")
    )

    const plan = await planInstallation({
      root,
      inspect: await inspectWorkspace(root),
      artifacts: { ga4: { measurementId: "G-TEST123" }, meta: { pixelId: "1234567890123456" } }
    })

    expect(plan.adopted).toEqual([{ provider: "ga4", via: "gtm", file: "index.html" }])
    expect(plan.providers).toEqual(["meta"])
    expect(plan.blockers).toEqual([])
    expect(plan.assumptions).toContain(
      "Existing Google Analytics found in index.html (Google Tag Manager); left untouched. infinite-tag will not install a second copy."
    )
  })

  it("a GTM container adopts GA4 only — a requested Meta pixel still installs", async () => {
    const root = copyFixture("static-html-basic")
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html>\n<html lang="en">\n  <head>\n    <script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD12"></script>\n  </head>\n  <body></body>\n</html>\n'
    )

    const plan = await planInstallation({
      root,
      inspect: await inspectWorkspace(root),
      artifacts: { meta: { pixelId: "1234567890123456" } }
    })

    expect(plan.adopted).toEqual([])
    expect(plan.providers).toEqual(["meta"])
    expect(plan.blockers).toEqual([])
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
    expect(plan.adopted).toEqual([])
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
