import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runInContext, createContext, type Context } from "node:vm"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { applyInstallation } from "../apply.js"
import { inspectWorkspace } from "../inspect.js"
import { planInstallation } from "../plan.js"
import type { InstallPlan, WorkspaceInstallArtifacts } from "../types.js"

import { buildAnalyticsModuleSource } from "./managed-files.js"

const fixtureRoot = dirname(fileURLToPath(import.meta.url))
const tempRoots: string[] = []

const frameworks = [
  {
    name: "Next App",
    fixture: "next-app-router-basic",
    modulePath: "lib/infinite-analytics.ts"
  },
  {
    name: "Next Pages",
    fixture: "next-pages-router-basic",
    modulePath: "lib/infinite-analytics.ts"
  },
  {
    name: "Vite",
    fixture: "vite-react-basic",
    modulePath: "src/lib/infinite-analytics.ts"
  }
] as const

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

function generateManagedModule(
  fixture: string,
  modulePath: string,
  artifacts: WorkspaceInstallArtifacts = {
    productionHosts: ["example.com"],
    ga4: { measurementId: "G-TEST123" }
  }
): string {
  const source = join(fixtureRoot, "../../test/fixtures", fixture)
  const tempRoot = mkdtempSync(join(tmpdir(), `instrument-managed-${fixture}-`))
  const root = join(tempRoot, fixture)
  tempRoots.push(tempRoot)
  cpSync(source, root, { recursive: true })

  const plan = planInstallation({
    root,
    workspaceId: "ws_test",
    artifacts
  })
  expect(plan.blockers).toEqual([])
  applyInstallation({ root, workspaceId: "ws_test", plan, allowDirty: true })
  return readFileSync(join(root, modulePath), "utf8")
}

function executeManagedModule(
  source: string,
  privacy: { consent?: "granted" | "denied"; dnt?: string; gpc?: boolean }
) {
  const externalScripts: Array<{ src: string }> = []
  const elements: Array<Record<string, unknown>> = []
  const windowListeners = new Map<string, (event: unknown) => void>()
  const documentListeners = new Map<string, (event: unknown) => void>()
  const localValues = new Map<string, string>()
  if (privacy.consent) localValues.set("infinite_analytics_consent", privacy.consent)

  const storage = (values: Map<string, string>) => ({
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    }
  })
  const location = {
    href: "https://example.com/",
    hostname: "example.com",
    origin: "https://example.com",
    pathname: "/"
  }
  const windowObject: Record<string, unknown> = {
    location,
    addEventListener(type: string, listener: (event: unknown) => void) {
      windowListeners.set(type, listener)
    }
  }
  let context: Context
  const document = {
    referrer: "",
    createElement(tagName: string) {
      expect(tagName).toBe("script")
      const attributes = new Map<string, string>()
      return {
        src: "",
        text: "",
        id: "",
        async: false,
        setAttribute(name: string, value: string) {
          attributes.set(name, value)
        },
        getAttribute(name: string) {
          return attributes.get(name) ?? null
        }
      }
    },
    getElementById(id: string) {
      return elements.find((element) => element.id === id) ?? null
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      documentListeners.set(type, listener)
    },
    head: {
      appendChild(element: Record<string, unknown>) {
        elements.push(element)
        if (typeof element.src === "string" && element.src.includes("/gtag/js")) {
          externalScripts.push({ src: element.src })
        }
        if (typeof element.text === "string" && element.text.length > 0) {
          runInContext(element.text, context)
        }
        return element
      }
    }
  }
  const sessionValues = new Map<string, string>()
  const moduleExports: Record<string, unknown> = {}
  context = createContext({
    exports: moduleExports,
    window: windowObject,
    document,
    location,
    history: {
      pushState() {},
      replaceState() {}
    },
    localStorage: storage(localValues),
    sessionStorage: storage(sessionValues),
    navigator: {
      doNotTrack: privacy.dnt ?? "0",
      globalPrivacyControl: privacy.gpc ?? false,
      sendBeacon() {
        return false
      }
    },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    fetch: async () => ({ ok: true }),
    setTimeout(callback: () => void) {
      callback()
      return 1
    },
    clearTimeout() {},
    URL,
    Date,
    JSON,
    Math,
    console
  })
  Object.assign(windowObject, context)

  const javascript =
    source.replace(
      "export function installInfiniteInstrumentation(): void {",
      "function installInfiniteInstrumentation() {"
    ) + "\nexports.installInfiniteInstrumentation = installInfiniteInstrumentation\n"
  runInContext(javascript, context)
  const install = moduleExports.installInfiniteInstrumentation as () => void
  install()
  install()

  return {
    externalScripts,
    grantConsent() {
      // A real consent UI produces a gesture right before dispatching (the runtime's
      // forged-event gate) — simulate the pointerdown a banner click would generate.
      documentListeners.get("pointerdown")?.({})
      windowListeners.get("infinite:analytics-consent-change")?.({ detail: { granted: true } })
    }
  }
}

describe.each(frameworks)("$name managed analytics wrapper", ({ fixture, modulePath }) => {
  // 0.6.0 — FULL NATIVE providers: a GA4-only install gets Google's own gtag.js bootstrap (loader +
  // dataLayer + gtag('js') + gtag('config', ID) with the default page_view), installed ONCE, and no
  // Infinite runtime at all — mirror mode and the Infinite-consent gate over GA4 are gone. GA4's
  // consent is the site's own (Consent Mode), exactly as with a hand-pasted snippet.
  it("contains one native GA loader, installs it exactly once, and embeds no Infinite runtime for a GA4-only install", () => {
    const source = generateManagedModule(fixture, modulePath)
    expect(source.match(/googletagmanager\.com\/gtag\/js/g)).toHaveLength(1)
    expect(source).toContain("gtag('js', new Date())")
    expect(source).toContain("G-TEST123")
    expect(source).not.toContain("send_page_view")
    expect(source).not.toContain("data-infinite-runtime")
    expect(source).not.toContain("__infiniteGa4Consent")
    expect(source).not.toContain("infinite:analytics-consent-change")

    const runtime = executeManagedModule(source, { consent: "denied" })
    // install() ran twice (the wrapper is idempotent) → one loader.
    expect(runtime.externalScripts).toHaveLength(1)
    expect(runtime.externalScripts[0]?.src).toContain("googletagmanager.com/gtag/js?id=G-TEST123")
  })

  it.each([
    { dnt: "1", gpc: false },
    { dnt: "0", gpc: true },
    { consent: "denied" as const },
    { consent: "granted" as const }
  ])("loads GA natively whatever the Infinite privacy state (%o) — providers own their own consent", (privacy) => {
    const source = generateManagedModule(fixture, modulePath)
    const runtime = executeManagedModule(source, { ...privacy })
    expect(runtime.externalScripts).toHaveLength(1)
    // The Infinite consent event is not even listened for (no runtime is embedded).
    runtime.grantConsent()
    expect(runtime.externalScripts).toHaveLength(1)
  })

  it("keeps the generated wrapper parseable for an Infinite runtime install", () => {
    const source = generateManagedModule(fixture, modulePath, {
      productionHosts: ["example.com"],
      infinite: {
        siteSourceKey: "site_public_123",
        collectPath: "/infinite/events/collect",
        productionHosts: ["example.com"],
        staticProxy: "vercel",
        consentMode: "not_required"
      }
    })
    expect(() => executeManagedModule(source, { consent: "granted" })).not.toThrow()
  })
})

it("embeds bootstrap snippets as a JS string literal so backticks remain executable script text", () => {
  const source = buildAnalyticsModuleSource({
    instructions: [
      {
        path: "src/lib/infinite-analytics.ts",
        action: "create",
        provider: "infinite",
        description: "test snippet",
        snippet: "console.log(`tick`)"
      }
    ]
  } as InstallPlan)

  expect(() => executeManagedModule(source, { consent: "granted" })).not.toThrow()
})
