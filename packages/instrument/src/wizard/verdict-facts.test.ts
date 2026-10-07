import { expect, it } from "vitest"
import { item } from "../../test/wizard/repo.js"
import { verdictFactsFor } from "./verdict-facts.js"
import { buildReport, renderMarkdown, renderTerminal } from "./report.js"

it("carries installed consent activation metadata into the shared report facts", async () => {
  const ctx = { root: "/fixture", appRoot: ".", runId: "fixture", state: { get: () => ({ runId: "fixture", jobs: [], git: null, plan: { answers: { consentMode: "required" } } }) } }
  const deps = { env: {}, bridge: {}, git: {}, fs: { readText: async (path: string) => path.endsWith("/install.json") ? JSON.stringify({ ids: { infinite: { siteSourceKey: "public-fixture-id" } }, managedCapture: { mode: "required", module: "public/infinite-meta-click-id.js" } }) : null } }
  const facts = await verdictFactsFor(ctx as never, deps as never)
  expect(facts.consentActivation).toEqual({ mode: "required", infinite: true, capture: true })
})

it.each([false, true])("sanitizes owner locations and preserves only safe executable snippets (secret=%s)", async unsafe => {
  const secret = "sk_test_" + "fixtureCredentialValue".repeat(2)
  const path = `src/<!-- @here [open](https://example.test)/${secret}.tsx`
  const safeSnippet = 'import { InfiniteAnalyticsClient } from "../lib/infinite-analytics-client"\n<InfiniteAnalyticsClient />'
  const snippet = unsafe ? `boot('${secret}');` : safeSnippet
  const job = { ...item("unusual_layout:owner", [path]), state: "left_for_you" as const, ownerBoundary: { kind: "frozen_unit" as const, file: path, line: 1, wiring: snippet } }
  const ctx = { root: "/fixture", appRoot: ".", runId: "fixture", state: { get: () => ({ runId: "fixture", jobs: [job], git: null }) } }
  const deps = { env: {}, bridge: {}, git: {}, fs: { readText: async () => null } }
  const facts = await verdictFactsFor(ctx as never, deps as never)
  const report = buildReport({ runId: "fixture", tagVersion: "0.0.0", site: { repoLabel: "example/site", productionHost: null }, columns: { live_today: null, in_pr: null, proven_live: null }, provenLivePending: null, day7: null, notes: [], verdictFacts: facts })
  for (const text of [JSON.stringify(report), renderMarkdown(report, undefined, facts.jobs), renderTerminal(report, 100, { ownerJobs: facts.jobs })]) {
    expect(text).not.toContain(secret)
    for (const active of ["<!--", "@here", "](https:"]) expect(text).not.toContain(active)
  }
  if (unsafe) {
    expect(facts.jobs[0]!.ownerBoundary?.wiring).toBeUndefined()
    expect(report.notes.some(note => note.includes("Copyable owner snippet withheld"))).toBe(true)
  } else {
    expect(facts.jobs[0]!.ownerBoundary?.wiring).toBe(safeSnippet)
    expect(renderMarkdown(report, undefined, facts.jobs)).toContain(safeSnippet)
  }
  expect(job.ownerBoundary.wiring).toBe(snippet)
  expect(job.ownerBoundary.file).toBe(path)
})
