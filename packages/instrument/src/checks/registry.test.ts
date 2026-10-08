// The CheckRunner registry (lane O6, §3e.7): built-ins, the `register` seam O9 uses, dispatch of the
// coarse methods to registered ids, and the refusals (an unregistered id throws; a second registration
// throws). Every collaborator is a fake: no network, no real build.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { FAKE } from "../../test/wizard/t0-fixtures.js"
import type { CheckResult } from "../wizard/contracts/jobs.js"
import type { TestRunFixtureCase } from "../wizard/contracts/test-engine.js"
import { CheckNotRegisteredError, createCheckRunner, O6_CHECK_IDS } from "./registry.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(readFileSync(join(here, "../../contracts/tag-wizard-v1/test-run.fixtures.json"), "utf8")) as TestRunFixtureCase[]
const NOW = () => new Date("2026-10-02T10:00:00.000Z")

function result(checkId: string, state: CheckResult["state"] = "pass"): CheckResult {
  return { checkId, state, tier: "T1", at: NOW().toISOString(), runId: FAKE.runId }
}

describe("the register seam", () => {
  it("negative: an unregistered check throws (the post-turn gate above all: no gate, no silent pass)", async () => {
    const runner = createCheckRunner({ root: "/repo", appRoot: "." })
    await expect(runner.turnGate({ files: [] }, { connectionIds: [] })).rejects.toBeInstanceOf(CheckNotRegisteredError)
    await expect(runner.run("posthog_config", {})).rejects.toBeInstanceOf(CheckNotRegisteredError)
  })

  it("negative: registering an id twice throws, built-in ids included", () => {
    const runner = createCheckRunner({ root: "/repo", appRoot: "." })
    runner.register("csp", async () => result("csp"))
    expect(() => runner.register("csp", async () => result("csp"))).toThrow(/already registered/)
    expect(() => runner.register("host_matrix", async () => result("host_matrix"))).toThrow(/already registered/)
    for (const id of O6_CHECK_IDS) expect(runner.registered()).toContain(id)
  })
})

describe("built-in checks", () => {
  it("grades a test run of the runner's own run (THE grader, via the CheckRunner); another run's facts are refused", async () => {
    const fixture = fixtures.find((entry) => entry.id === "dry_live_ga4_wrong_tid")!
    const ctx = { cmpDetected: null, envSourcedIds: [], consentMode: "not_required" as const, installedTools: ["infinite", "ga4", "posthog", "meta"] as const, metaPixelOwnership: null }
    // negative (review O6-R19): a runner on a different run never stamps its id on these facts
    const other = createCheckRunner({ root: "/repo", appRoot: ".", now: NOW, runId: () => FAKE.runId })
    expect(fixture.result.runId).not.toBe(FAKE.runId)
    await expect(other.gradeTestRun(fixture.result, fixture.request.expect, "dry_live", ctx)).rejects.toThrow(/stale facts/)
    const runner = createCheckRunner({ root: "/repo", appRoot: ".", now: NOW, runId: () => fixture.result.runId })
    const graded = await runner.gradeTestRun(fixture.result, fixture.request.expect, "dry_live", {
      cmpDetected: null,
      envSourcedIds: [],
      consentMode: "not_required",
      installedTools: ["infinite", "ga4", "posthog", "meta"],
      metaPixelOwnership: null
    })
    expect(graded.ga4).toMatchObject({ state: "problem", runId: fixture.result.runId, tier: "T1" })
    expect(graded.ga4.reason).toMatch(/^wrong_id/)
    const derived = (await runner.run("one_beacon_per_tool", { result: fixture.result, expect: fixture.request.expect, mode: "dry_live", ctx: { cmpDetected: null, envSourcedIds: [], installedTools: ["ga4"] } })) as CheckResult[]
    expect(derived.map((entry) => entry.checkId)).toEqual(["one_beacon_per_tool"])
  })
})
