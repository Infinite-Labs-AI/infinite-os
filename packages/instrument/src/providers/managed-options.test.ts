// The managed-provider options the wizard's plan lines turn on, EXECUTED:
//   - decision 17: replay and autocapture OFF on sensitive pages (infinite.fast inject L340-362; its tests
//     test-inject-analytics.mjs L597-598 and L605-616 @ 9f65b47), every other page keeping PostHog's own
//     defaults — the keys are not even present — re-decided at every $pageview so an SPA route change
//     into or out of a listed page is honoured, with `/x/*` prefix rules;
//   - PostHog `defaults`: "2026-01-30" for new installs, "2025-05-24" where pinned (a re-install keeps
//     the managed value: `posthog-defaults.test.ts`);
//   - the Meta capture-only block beside an ADOPTED pixel (no second pixel, nothing sent).
import { describe, expect, it } from "vitest"

import { createBrowserVm, plain } from "../../test/site-code/browser-vm.js"

import { buildMetaCaptureOnlySnippet, metaProviderAdapter } from "./meta.js"
import {
  buildPostHogBootstrapSnippet,
  normalizeSensitivePaths,
  posthogProviderAdapter,
  POSTHOG_DEFAULTS,
  POSTHOG_STUB_METHODS
} from "./posthog.js"

function initOptions(snippet: string, url: string): Record<string, unknown> | null {
  const vm = createBrowserVm({ url })
  vm.runScript(snippet)
  expect(vm.scriptErrors).toEqual([])
  const queued = (vm.window.posthog as { _i: unknown[][] })._i
  return queued.length > 0 ? (plain(queued[0]![1]) as Record<string, unknown>) : null
}

describe("decision 17: sensitive pages", () => {
  const snippet = buildPostHogBootstrapSnippet("phc_test", "https://us.i.posthog.com", undefined, {
    sensitivePaths: ["/checkout/success", "/login"]
  })

  it.each([ "/login/",])("%s: replay and autocapture OFF", (path) => {
    expect(initOptions(snippet, `https://acme.com${path}`)).toEqual({
      api_host: "https://us.i.posthog.com",
      defaults: POSTHOG_DEFAULTS,
      disable_session_recording: true,
      autocapture: false
    })
  })

  it.each([ "/login-help",])("%s: PostHog's own defaults, keys absent", (path) => {
    expect(initOptions(snippet, `https://acme.com${path}`)).toEqual({ api_host: "https://us.i.posthog.com", defaults: POSTHOG_DEFAULTS })
  })

  it("negative: without the plan line, /login keeps PostHog's defaults", () => {
    const plainSnippet = buildPostHogBootstrapSnippet("phc_test", "https://us.i.posthog.com")
    expect(initOptions(plainSnippet, "https://acme.com/login")).toEqual({
      api_host: "https://us.i.posthog.com",
      defaults: POSTHOG_DEFAULTS
    })
  })

  it("with the preview guard: nothing on a preview (methods queue-only), the options in production", () => {
    const guarded = buildPostHogBootstrapSnippet("phc_test", "https://us.i.posthog.com", undefined, {
      sensitivePaths: ["/login"],
      guard: { mode: "deny", exempt: ["acme.com"], deny: [] }
    })
    const vm = createBrowserVm({ url: "https://acme-abc123.vercel.app/login" })
    vm.runScript(guarded + "\nposthog.identify('user_1'); posthog.capture('x');")
    expect(vm.scriptErrors).toEqual([])
    expect(vm.loaded).toEqual([])
    expect((vm.window.posthog as { _i: unknown[] })._i).toEqual([])
    // Every stub method except init exists and only queues.
    for (const name of POSTHOG_STUB_METHODS.filter((method) => method !== "init")) {
      expect(typeof (vm.window.posthog as Record<string, unknown>)[name]).toBe("function")
    }
    expect(plain(Array.from(vm.window.posthog as ArrayLike<unknown>))).toEqual([["identify", "user_1"], ["capture", "x"]])
    expect(initOptions(guarded, "https://acme.com/login")).toMatchObject({ disable_session_recording: true, autocapture: false })
  })

  // P2-5: an SPA changes pages without a load. PostHog records a $pageview per History-API route change
  // (its `defaults` bundles); the snippet re-decides there through the instance `loaded` hands it.
  function routeAware(paths: string[], landing: string) {
    const vm = createBrowserVm({ url: `https://acme.com${landing}` })
    vm.runScript(buildPostHogBootstrapSnippet("phc_test", "https://us.i.posthog.com", undefined, { sensitivePaths: paths }))
    expect(vm.scriptErrors).toEqual([])
    const options = (vm.window.posthog as { _i: Array<[string, { loaded?: (instance: unknown) => void }]> })._i[0]![1]
    const configs: unknown[] = []
    let listener: ((data: { event: string }) => void) | undefined
    options.loaded!({
      on: (name: string, callback: (data: { event: string }) => void) => {
        if (name === "eventCaptured") listener = callback
      },
      set_config: (config: unknown) => void configs.push(plain(config))
    })
    const location = vm.window.location as { pathname: string }
    return {
      configs,
      go(path: string, event = "$pageview") {
        location.pathname = path
        listener!({ event })
      }
    }
  }

  it("a client-side navigation INTO a sensitive page turns replay and autocapture off, and back on leaving it", () => {
    const page = routeAware(["/login"], "/")
    page.go("/pricing")
    expect(page.configs).toEqual([]) // not sensitive → untouched
    page.go("/login/")
    expect(page.configs).toEqual([{ disable_session_recording: true, autocapture: false }])
    page.go("/dashboard")
    expect(page.configs).toEqual([
      { disable_session_recording: true, autocapture: false },
      { disable_session_recording: false, autocapture: true }
    ])
  })

  it("a /* rule covers the path and everything under it (a dynamic segment), and nothing beside it", () => {
    const page = routeAware(["/account/*"], "/")
    page.go("/account-help")
    expect(page.configs).toEqual([])
    page.go("/account/123/billing")
    expect(page.configs).toEqual([{ disable_session_recording: true, autocapture: false }])
    const landing = buildPostHogBootstrapSnippet("phc_test", "https://us.i.posthog.com", undefined, { sensitivePaths: ["/account/*"] })
    expect(initOptions(landing, "https://acme.com/account")).toMatchObject({ autocapture: false })
    expect(initOptions(landing, "https://acme.com/accounts")).not.toHaveProperty("autocapture")
  })

  it("normalises the page list and refuses anything that is not a root-relative path", () => {
    expect(normalizeSensitivePaths(["/account/*", "/account/*/"])).toHaveProperty("error")
    expect(normalizeSensitivePaths(["/account/*"])).toEqual({ paths: ["/account/*"] })
    expect(normalizeSensitivePaths(["/login/", "/login", "/a/b"])).toEqual({ paths: ["/a/b", "/login"] })
    expect(normalizeSensitivePaths(undefined)).toEqual({ paths: [] })
    for (const bad of [["login"], ["/login?next=/"], ["/login#x"], ["//evil.example"], [42], "not-a-list"]) {
      expect(normalizeSensitivePaths(bad)).toHaveProperty("error")
    }
  })
})

describe("PostHog defaults", () => {
  const plan = (artifact: Record<string, unknown>) =>
    posthogProviderAdapter.plan("static-html", { projectKey: "phc_test", apiHost: "https://us.i.posthog.com", ...artifact } as never)

  it("negative: any other bundle is a plan blocker", () => {
    expect(plan({ defaults: "2024-01-01" }).blockers.join("\n")).toMatch(/PostHog defaults must be/)
  })
})

describe("Meta capture-only beside an ADOPTED pixel", () => {
  it("plans the _fbc capture alone: no second pixel, no fbq", () => {
    const plan = metaProviderAdapter.plan("static-html", { pixelId: "6543210987654321", captureOnly: true } as never, {
      artifacts: { meta: { pixelId: "6543210987654321", captureOnly: true } }
    })
    expect(plan.blockers).toEqual([])
    const snippet = plan.instructions[0]!.snippet
    expect(snippet).toContain("infiniteMetaClickId")
    expect(snippet).not.toContain("fbevents.js")
    expect(snippet).not.toMatch(/fbq\(/)
    expect(plan.assumptions.join("\n")).toMatch(/left exactly as it is/)
  })

  it("executed: writes _fbc for an ad click and sends nothing", () => {
    const vm = createBrowserVm({ url: "https://acme.com/?fbclid=Adopted_Click" })
    vm.runScript(buildMetaCaptureOnlySnippet())
    expect(vm.cookies.values("_fbc")).toHaveLength(1)
    expect(vm.loaded).toEqual([])
    expect(vm.fetches).toEqual([])
    expect(vm.window.fbq).toBeUndefined()
  })
})
