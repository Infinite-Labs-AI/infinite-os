// I1b: an item's T0 scenarios carry the run's facts, and an unbuildable scenario is undetermined for that
// item only. Executes the real helpers over a real temp repo dir (no network, no agent).
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import type { WizardContext, WizardDeps } from "./contracts/deps.js"
import type { CheckResult, T0Scenario } from "./contracts/jobs.js"
import { WIZARD_PATHS } from "./contracts/state.js"
import { nodeWizardFs } from "./fs.js"
import { runItemT0, t0RunParams, T0_UNBUILDABLE_PREFIX } from "./item-t0.js"

const RUN = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"

function root(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "infinite-tag-item-t0-")))
  mkdirSync(join(dir, WIZARD_PATHS.dir), { recursive: true })
  return dir
}

function ctx(dir: string, runId: string | null = RUN): WizardContext {
  return { root: dir, runId, state: { get: () => ({ runId }) } } as unknown as WizardContext
}

function writeRunFacts(dir: string, runId: string): void {
  const facts = { census: { entries: [], envSourcedIds: [], identify: { identifyCalls: [], resetCalls: [] } }, keys: {}, hosting: {}, dryLive: null, checks: [], observedProductionHost: "www.acme-store.com" }
  writeFileSync(join(dir, WIZARD_PATHS.beforeFacts), JSON.stringify({ schema: "infinite-tag.before-facts.v1", runId, measuredAt: "2026-10-02T09:00:00.000Z", productionHost: "acme-store.com", facts }))
  writeFileSync(
    join(dir, `${WIZARD_PATHS.dir}/plan-approvals.json`),
    JSON.stringify({ schema: "infinite-tag.plan-approvals.v1", planHash: "h", beforeAt: null, candidates: [], approvals: {}, privacyText: null, guard: { emit: true, exempt: ["acme-store.com", "www.acme-store.com"], deny: ["localhost"] } })
  )
}

describe("the run-level T0 params", () => {
  it("NEGATIVE: another run's facts are never used (no production host is invented)", async () => {
    const dir = root()
    writeRunFacts(dir, "00000000-0000-4000-8000-000000000000")
    expect(await t0RunParams(ctx(dir), { fs: nodeWizardFs })).toEqual({ exempt: ["acme-store.com", "www.acme-store.com"] })
  })
})

describe("runItemT0", () => {
  const result = (scenario: T0Scenario, state: CheckResult["state"]): CheckResult => ({ checkId: scenario.checkId, tier: "T0", state, at: "2026-10-02T09:00:00.000Z", runId: RUN })
  const scenarios: T0Scenario[] = [
    { id: "a:host_matrix", checkId: "host_matrix", params: {} },
    { id: "a:fbc_capture", checkId: "fbc_capture", params: { productionHost: "acme-store.com" } }
  ]

  it("an unbuildable scenario is undetermined for that item; its sibling keeps its real verdict", async () => {
    const checks = {
      t0: async ([scenario]: readonly T0Scenario[]) => {
        if (!("productionHost" in scenario!.params)) throw Object.assign(new Error("host_matrix: params.productionHost must be a non-empty string"), { name: "T0ScenarioError" })
        return [result(scenario!, "pass")]
      }
    } as unknown as WizardDeps["checks"]
    const out = await runItemT0({ checks }, scenarios, {}, { runId: RUN, at: () => "2026-10-02T09:00:00.000Z" })
    expect(out.map((entry) => [entry.checkId, entry.state])).toEqual([
      ["host_matrix", "undetermined"],
      ["fbc_capture", "pass"]
    ])
    expect(out[0]!.reason).toContain(T0_UNBUILDABLE_PREFIX)
  })

  it("NEGATIVE: a crash of the runner itself still throws (never read as a verdict)", async () => {
    const checks = { t0: async () => Promise.reject(new Error("sandbox child died")) } as unknown as WizardDeps["checks"]
    await expect(runItemT0({ checks }, scenarios, {}, { runId: RUN, at: () => "x" })).rejects.toThrow("sandbox child died")
  })
})
