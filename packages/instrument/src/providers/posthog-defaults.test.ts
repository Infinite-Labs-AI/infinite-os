// PostHog's `defaults` bundle on an install and a RE-INSTALL: a fresh managed install gets "2026-01-30" and a
// re-run never moves it. Each case installs through the real plan/apply path and EXECUTES the written page: the PostHog stub
// queues `init(key, options)` on `posthog._i`, which is what array.js would read.
import { afterAll, describe, expect, it } from "vitest"

import { createBrowserVm, decodeNextBootstrap } from "../../test/site-code/browser-vm.js"
import { cleanupFixtures, installFixture, reinstallFixture, type InstalledFixture } from "../../test/site-code/install-fixture.js"
import type { WorkspaceInstallArtifacts } from "../types.js"

afterAll(cleanupFixtures)

const POSTHOG = { projectKey: "phc_test", apiHost: "https://us.i.posthog.com" }

function initDefaults(site: InstalledFixture, form: "static" | "next"): unknown {
  const vm = createBrowserVm({ url: "https://acme.com/" })
  if (form === "static") vm.runHtml(site.read("index.html"))
  else vm.runScript(decodeNextBootstrap(site.read("lib/infinite-analytics.ts")))
  expect(vm.scriptErrors).toEqual([])
  const queued = (vm.window.posthog as { _i: Array<[string, { defaults?: unknown }]> })._i
  expect(queued).toHaveLength(1)
  return queued[0]![1].defaults
}

describe.each([
  ["next", "next-app-router-basic"]
] as const)("PostHog defaults on a %s re-install", (form, fixture) => {
  const plain: WorkspaceInstallArtifacts = { posthog: { ...POSTHOG } }

  it("a fresh install gets 2026-01-30", () => {
    expect(initDefaults(installFixture(fixture, plain), form)).toBe("2026-01-30")
  })

  it("a re-run on a 2026-01-30 install never downgrades it", () => {
    const site = reinstallFixture(installFixture(fixture, plain), plain)
    expect(initDefaults(site, form)).toBe("2026-01-30")
    expect(site.plan.assumptions.join("\n")).not.toMatch(/Measurement changed|keeps its defaults/)
  })
})
