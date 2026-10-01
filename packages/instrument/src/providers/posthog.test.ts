// The managed PostHog snippet, EXECUTED. The stub is the part of PostHog's snippet that runs before
// array.js arrives: it queues every call made in the meantime. A stub that throws while it is built
// never queues `init` at all, so array.js loads and finds nothing to start. A grep for "identify"
// cannot catch that; only running the bytes can. No network: array.js is never loaded here.
import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { buildPostHogBootstrapSnippet } from "./posthog.js"

// PostHog's current official snippet method list, as infinite.fast ships it
// (infinite-site .github/scripts/inject-analytics.cjs at 9f65b47).
const OFFICIAL_METHODS =
  "init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(
    " "
  )

type Stub = unknown[] & Record<string, unknown> & { _i: unknown[][] }

/** Values built inside the vm belong to another realm; compare their plain JSON shape. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

/** Run a snippet the way a browser would: a page with one <script>, no PostHog loaded yet. */
function runSnippet(source: string, after = ""): { stub: Stub; scripts: Array<Record<string, unknown>>; error?: Error } {
  const scripts: Array<Record<string, unknown>> = []
  const window: Record<string, unknown> = {}
  const document = {
    createElement: () => ({}) as Record<string, unknown>,
    getElementsByTagName: () => [{ parentNode: { insertBefore: (node: Record<string, unknown>) => scripts.push(node) } }]
  }
  const context: Record<string, unknown> = { window, document, Array }
  // A page's top-level `posthog` IS window.posthog; mirror that binding for the vm.
  Object.defineProperty(context, "posthog", { get: () => window.posthog })
  let error: Error | undefined
  try {
    runInNewContext(`${source}\n${after}`, context)
  } catch (caught) {
    error = caught as Error
  }
  return { stub: window.posthog as Stub, scripts, error }
}

describe("the managed PostHog snippet, executed", () => {
  const snippet = buildPostHogBootstrapSnippet("phc_test", "https://us.i.posthog.com")

  it("builds the stub without throwing and queues init for array.js", () => {
    const { stub, scripts, error } = runSnippet(snippet)
    expect(error).toBeUndefined()
    // The stub names the default instance "posthog" before queueing it.
    expect(plain(stub._i)).toEqual([["phc_test", { api_host: "https://us.i.posthog.com", defaults: "2025-05-24" }, "posthog"]])
    expect(scripts).toHaveLength(1)
    expect(scripts[0]!.src).toBe("https://us-assets.i.posthog.com/static/array.js")
  })

  it("lets the site identify a visitor before PostHog has loaded, and queues the call", () => {
    const { stub, error } = runSnippet(snippet, 'posthog.identify("user_123", { plan: "pro" }); posthog.alias("user_123")')
    expect(error).toBeUndefined()
    expect(typeof stub.identify).toBe("function")
    expect(plain([...stub])).toEqual([
      ["identify", "user_123", { plan: "pro" }],
      ["alias", "user_123"]
    ])
  })

  it("stubs exactly PostHog's current official method list, each one callable and queued", () => {
    const { stub, error } = runSnippet(snippet)
    expect(error).toBeUndefined()
    for (const method of OFFICIAL_METHODS) {
      expect(typeof stub[method], method).toBe("function")
    }
    expect(snippet).toContain(`o='${OFFICIAL_METHODS.join(" ")}'.split(' ')`)
  })

  it("negative: the stub list it replaced throws while building and never queues init", () => {
    // The previous list named methods under parents the stub never creates (person.*, group.*).
    const broken = snippet.replace(
      /o='[^']*'\.split/,
      "o='init capture people.set person.set_once group.set'.split"
    )
    const { stub, error } = runSnippet(broken)
    expect(error?.name).toBe("TypeError")
    expect(plain(stub._i)).toEqual([])
    // And with no top-level identify, an early identify throws even when the stub builds.
    const noIdentify = snippet.replace(/o='[^']*'\.split/, "o='init capture'.split")
    expect(runSnippet(noIdentify, 'posthog.identify("user_123")').error?.name).toBe("TypeError")
  })
})
