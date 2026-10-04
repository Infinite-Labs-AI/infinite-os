// P2-2: PostHog's `defaults` bundle on a RE-INSTALL. A fresh managed install gets "2026-01-30"; a site
// whose managed PostHog already carries "2025-05-24" (every install made by 0.6–0.11) keeps it until an
// explicit `defaults` (an approved plan line) moves it, and the plan then says "measurement changed".
// Each case installs through the real plan/apply path and EXECUTES the written page: the PostHog stub
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
  ["static", "static-html-basic"],
  ["next", "next-app-router-basic"]
] as const)("PostHog defaults on a %s re-install", (form, fixture) => {
  const old: WorkspaceInstallArtifacts = { posthog: { ...POSTHOG, defaults: "2025-05-24" } }
  const plain: WorkspaceInstallArtifacts = { posthog: { ...POSTHOG } }

  it("a fresh install gets 2026-01-30", () => {
    expect(initDefaults(installFixture(fixture, plain), form)).toBe("2026-01-30")
  })

  it("an existing managed install on 2025-05-24 KEEPS it when the plan does not ask to move it", () => {
    const site = reinstallFixture(installFixture(fixture, old), plain)
    expect(initDefaults(site, form)).toBe("2025-05-24")
    expect(site.plan.assumptions.join("\n")).toMatch(/PostHog keeps its defaults bundle "2025-05-24"/)
    expect(site.plan.assumptions.join("\n")).not.toMatch(/Measurement changed/)
  })

  it("negative: an explicit move is applied AND announced as a measurement change", () => {
    const site = reinstallFixture(installFixture(fixture, old), { posthog: { ...POSTHOG, defaults: "2026-01-30" } })
    expect(initDefaults(site, form)).toBe("2026-01-30")
    expect(site.plan.assumptions.join("\n")).toMatch(/Measurement changed: PostHog's defaults bundle moves from "2025-05-24" to "2026-01-30"/)
  })

  it("a re-run on a 2026-01-30 install never downgrades it", () => {
    const site = reinstallFixture(installFixture(fixture, plain), plain)
    expect(initDefaults(site, form)).toBe("2026-01-30")
    expect(site.plan.assumptions.join("\n")).not.toMatch(/Measurement changed|keeps its defaults/)
  })
})
