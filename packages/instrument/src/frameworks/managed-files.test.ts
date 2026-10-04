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

import { jsLiteral } from "../providers/validate.js"

import { buildAnalyticsModuleSource } from "./managed-files.js"

const fixtureRoot = dirname(fileURLToPath(import.meta.url))
const tempRoots: string[] = []

// The JS analytics MODULE wrapper is a Next-only mechanism now — Vite injects a <script> into
// index.html (see vite-react.test.ts), so it is not exercised here.
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

// Next.js joins EVERY provider's bootstrap into ONE inline <script> (ga4, posthog, x, meta, infinite,
// in plan order). One snippet that throws therefore stops every provider after it, silently: the
// managed PostHog stub did exactly that until its method list was replaced, so on every Next.js
// install that managed PostHog the Meta pixel, the X pixel and the Infinite runtime never started.
// This runs the whole assembled module the way a browser does — `window` IS the global, and an
// inline script that throws is reported, not propagated to the code that appended it.
function executeAssembledModuleAsBrowser(source: string) {
  const loaded: string[] = []
  const scriptErrors: Error[] = []
  const elements: Array<Record<string, unknown>> = []
  const localValues = new Map<string, string>()
  const storage = (values: Map<string, string>) => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key)
  })
  const location = { href: "https://example.com/", hostname: "example.com", origin: "https://example.com", pathname: "/", search: "" }
  let context: Context
  const scriptElement = () => {
    const attributes = new Map<string, string>()
    return {
      src: "",
      text: "",
      id: "",
      async: false,
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      getAttribute: (name: string) => attributes.get(name) ?? null
    }
  }
  const document = {
    referrer: "",
    createElement: scriptElement,
    getElementById: (id: string) => elements.find((element) => element.id === id) ?? null,
    // The third-party loaders insert their library before the first <script> on the page.
    getElementsByTagName: () => [
      { parentNode: { insertBefore: (element: Record<string, unknown>) => void loaded.push(String(element.src)) } }
    ],
    addEventListener() {},
    head: {
      appendChild(element: Record<string, unknown>) {
        elements.push(element)
        if (typeof element.src === "string" && element.src) loaded.push(element.src)
        if (typeof element.text === "string" && element.text.length > 0) {
          try {
            runInContext(element.text, context)
          } catch (error) {
            scriptErrors.push(error as Error)
          }
        }
        return element
      }
    }
  }
  const moduleExports: Record<string, unknown> = {}
  const browserGlobal: Record<string, unknown> = {
    exports: moduleExports,
    document,
    location,
    history: { pushState() {}, replaceState() {} },
    localStorage: storage(localValues),
    sessionStorage: storage(new Map()),
    navigator: { doNotTrack: "0", globalPrivacyControl: false, sendBeacon: () => false },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    fetch: async () => ({ ok: true }),
    setTimeout: () => 1,
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
    URL,
    Date,
    JSON,
    Math,
    console
  }
  browserGlobal.window = browserGlobal
  browserGlobal.self = browserGlobal
  context = createContext(browserGlobal)
  const javascript =
    source.replace("export function installInfiniteInstrumentation(): void {", "function installInfiniteInstrumentation() {") +
    "\nexports.installInfiniteInstrumentation = installInfiniteInstrumentation\n"
  runInContext(javascript, context)
  ;(moduleExports.installInfiniteInstrumentation as () => void)()
  return { window: browserGlobal, loaded, scriptErrors }
}

const ALL_PROVIDERS: WorkspaceInstallArtifacts = {
  productionHosts: ["example.com"],
  ga4: { measurementId: "G-TEST123" },
  posthog: { projectKey: "phc_test", apiHost: "https://us.i.posthog.com" },
  x: { pixelId: "tw-pixel-123", eventTagIds: ["tw-event-1"] },
  meta: { pixelId: "1234567890123456" },
  infinite: {
    siteSourceKey: "site_public_123",
    collectPath: "/infinite/events/collect",
    productionHosts: ["example.com"],
    staticProxy: "vercel",
    consentMode: "not_required"
  }
}

/** Values built inside the vm belong to another realm; compare their plain JSON shape. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

describe.each(frameworks)("$name assembled module with every provider, executed", ({ fixture, modulePath }) => {
  it("starts GA4, PostHog, X, Meta and the Infinite runtime from the one shared script", () => {
    const source = generateManagedModule(fixture, modulePath, ALL_PROVIDERS)
    const { window, loaded, scriptErrors } = executeAssembledModuleAsBrowser(source)
    expect(scriptErrors).toEqual([])
    // GA4
    expect(typeof window.gtag).toBe("function")
    expect(loaded.some((src) => src.includes("googletagmanager.com/gtag/js?id=G-TEST123"))).toBe(true)
    // PostHog: init queued for array.js.
    const posthog = window.posthog as { _i: unknown[][] }
    expect((plain(posthog._i) as unknown[][])[0]).toEqual(["phc_test", { api_host: "https://us.i.posthog.com", defaults: "2026-01-30" }, "posthog"])
    expect(loaded).toContain("https://us-assets.i.posthog.com/static/array.js")
    // X
    expect(typeof window.twq).toBe("function")
    expect(loaded).toContain("https://static.ads-twitter.com/uwt.js")
    // Meta: autoConfig off, init, PageView — queued for fbevents.js.
    const fbq = window.fbq as { queue: ArrayLike<unknown>[] }
    expect(typeof fbq).toBe("function")
    expect(plain(fbq.queue.map((args) => Array.from(args)))).toEqual([
      ["set", "autoConfig", "false", "1234567890123456"],
      ["init", "1234567890123456"],
      ["track", "PageView"]
    ])
    expect(loaded).toContain("https://connect.facebook.net/en_US/fbevents.js")
    // Infinite's own runtime, last in the script.
    expect(window.__infiniteAnalyticsRuntime).toBe(true)
  })

  // Per-provider isolation (the Phase-1 F4 follow-up): each provider runs in its own try, so the old
  // PostHog stub — which threw while it was built — now costs PostHog alone.
  it("a provider that throws (the old PostHog stub) leaves GA4, X, Meta and Infinite started", () => {
    const source = generateManagedModule(fixture, modulePath, ALL_PROVIDERS)
    // The stub list it replaced named methods under parents the stub never creates.
    const broken = source.replace(/o='[^']*'\.split/, "o='init capture people.set person.set_once group.set'.split")
    expect(broken).not.toBe(source)
    const { window, scriptErrors } = executeAssembledModuleAsBrowser(broken)
    expect(scriptErrors).toEqual([])
    expect(typeof window.gtag).toBe("function")
    expect(typeof window.twq).toBe("function")
    expect(typeof window.fbq).toBe("function")
    expect(window.__infiniteAnalyticsRuntime).toBe(true)
  })

  it("a GA4 snippet that throws (first in the script) leaves PostHog, X, Meta and Infinite started", () => {
    const source = generateManagedModule(fixture, modulePath, ALL_PROVIDERS)
    const broken = source.replace("window.gtag('js', new Date());", "window.gtag('js', new Date()); throw new Error('ga4 broke');")
    expect(broken).not.toBe(source)
    const { window, scriptErrors, loaded } = executeAssembledModuleAsBrowser(broken)
    expect(scriptErrors).toEqual([])
    expect(loaded).toContain("https://us-assets.i.posthog.com/static/array.js")
    expect(typeof window.twq).toBe("function")
    expect(typeof window.fbq).toBe("function")
    expect(window.__infiniteAnalyticsRuntime).toBe(true)
  })

  it("negative: without the per-provider try, the same throw stops every provider after it", () => {
    const source = generateManagedModule(fixture, modulePath, ALL_PROVIDERS)
    const broken = source.replace(/o='[^']*'\.split/, "o='init capture people.set person.set_once group.set'.split")
    const unisolated = stripProviderIsolation(broken)
    expect(unisolated).not.toBe(broken)
    const { window, scriptErrors } = executeAssembledModuleAsBrowser(unisolated)
    expect(scriptErrors).toHaveLength(1)
    expect(scriptErrors[0]!.message).toMatch(/set_once/)
    expect(typeof window.gtag).toBe("function") // before PostHog in the script: unaffected
    expect(window.twq).toBeUndefined()
    expect(window.fbq).toBeUndefined()
    expect(window.__infiniteAnalyticsRuntime).toBeUndefined()
  })
})

/** The module with every provider's `try { … } catch {}` wrapper removed (the pre-isolation bytes). */
function stripProviderIsolation(source: string): string {
  const literal = source.match(/^const bootstrapSource = (".*")$/m)![1]!
  const decoded = JSON.parse(literal) as string
  const stripped = decoded
    .split("\n\n")
    .map((snippet) =>
      snippet.startsWith("try {\n") && snippet.endsWith("\n} catch (_infiniteProviderError) {}")
        ? snippet.slice("try {\n".length, -"\n} catch (_infiniteProviderError) {}".length)
        : snippet
    )
    .join("\n\n")
  return source.replace(literal, () => jsLiteral(stripped))
}
