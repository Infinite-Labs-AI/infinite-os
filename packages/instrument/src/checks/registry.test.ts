// The CheckRunner registry (lane O6, §3e.7): built-ins, the `register` seam O9 uses, dispatch of the
// coarse methods to registered ids, and the refusals (an unregistered id throws; a second registration
// throws). Every collaborator is a fake: no network, no real build.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { FAKE, fakeArtifacts } from "../../test/wizard/t0-fixtures.js"
import type { CheckResult } from "../wizard/contracts/jobs.js"
import type { TestRunFixtureCase } from "../wizard/contracts/test-engine.js"
import type { SandboxedSpawnFn } from "../t0/sandbox.js"
import { CHECK_RUNNER_SEAMS, CheckNotRegisteredError, createCheckRunner, O6_CHECK_IDS } from "./registry.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(readFileSync(join(here, "../../contracts/tag-wizard-v1/test-run.fixtures.json"), "utf8")) as TestRunFixtureCase[]
const NOW = () => new Date("2026-10-02T10:00:00.000Z")

function result(checkId: string, state: CheckResult["state"] = "pass"): CheckResult {
  return { checkId, state, tier: "T1", at: NOW().toISOString(), runId: FAKE.runId }
}

describe("the register seam", () => {
  it("dispatches each coarse method to its seam id with the documented input", async () => {
    const runner = createCheckRunner({ root: "/repo", appRoot: ".", now: NOW, runId: () => FAKE.runId })
    const inputs: Record<string, unknown> = {}
    for (const id of Object.values(CHECK_RUNNER_SEAMS)) {
      runner.register(id, async (input, ctx) => {
        inputs[id] = input
        expect(ctx.runId).toBe(FAKE.runId)
        return result(id)
      })
    }
    const hosting = { provider: "vercel" } as never
    const diff = { files: [] }
    expect((await runner.liveBytes(["https://acme.com/"], { ga4: ["G-FAKE00001"] }))[0]!.checkId).toBe("live_bytes")
    await runner.redirectWalk(["https://acme.com/?utm_source=x"])
    await runner.csp("https://acme.com/")
    await runner.metaDomains(["acme.com"], ["1234567890123456"])
    await runner.setupChecks("/repo")
    await runner.envTargets([], hosting)
    await runner.turnGate(diff, { connectionIds: ["G-FAKE00001"] })
    expect(inputs).toEqual({
      live_bytes: { urls: ["https://acme.com/"], expect: { ga4: ["G-FAKE00001"] } },
      redirect_walk: { urls: ["https://acme.com/?utm_source=x"] },
      csp: { url: "https://acme.com/" },
      meta_domains: { domains: ["acme.com"], pixelIds: ["1234567890123456"] },
      setup_checks: { appRoot: "/repo" },
      env_targets: { envSourcedIds: [], hosting },
      turn_gate: { diff, connectionIds: ["G-FAKE00001"] }
    })
  })

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
  it("grades a test run with the run id the runner was given (THE grader, via the CheckRunner)", async () => {
    const fixture = fixtures.find((entry) => entry.id === "dry_live_ga4_wrong_tid")!
    const runner = createCheckRunner({ root: "/repo", appRoot: ".", now: NOW, runId: () => FAKE.runId })
    const graded = await runner.gradeTestRun(fixture.result, fixture.request.expect, "dry_live", {
      cmpDetected: null,
      envSourcedIds: [],
      consentMode: "not_required",
      installedTools: ["infinite", "ga4", "posthog", "meta"]
    })
    expect(graded.ga4).toMatchObject({ state: "problem", runId: FAKE.runId, tier: "T1" })
    expect(graded.ga4.reason).toMatch(/^wrong_id/)
    const derived = (await runner.run("one_beacon_per_tool", { result: fixture.result, expect: fixture.request.expect, mode: "dry_live", ctx: { cmpDetected: null, envSourcedIds: [], installedTools: ["ga4"] } })) as CheckResult[]
    expect(derived.map((entry) => entry.checkId)).toEqual(["one_beacon_per_tool"])
  })

  it("t0 runs through the sandboxed runner (injected here) and stamps the current run id", async () => {
    let runId: string | null = null
    const runner = createCheckRunner({
      root: "/repo",
      appRoot: ".",
      now: NOW,
      runId: () => runId,
      t0Run: async () => ({ ok: false, reason: "timeout", detail: "T0 did not finish" })
    })
    runId = FAKE.runId
    const results = await runner.t0([{ id: "fbc_capture", checkId: "fbc_capture", params: { productionHost: FAKE.host } }], fakeArtifacts())
    expect(results).toEqual([{ checkId: "fbc_capture", state: "undetermined", reason: "test_error — timeout: T0 did not finish", tier: "T0", at: NOW().toISOString(), runId: FAKE.runId }])
  })

  it("buildBaseline stores the baseline that build_green_or_baseline compares against", async () => {
    const outputs = ["Module not found: Can't resolve 'x'", "Module not found: Can't resolve 'x'\nType error: y"]
    const spawn: SandboxedSpawnFn = async () => ({ exitCode: 1, signal: null, stdout: outputs.shift() ?? "", stderr: "", timedOut: false, aborted: false, sandboxed: true, pid: 1, stdoutTruncated: false, stderrTruncated: false })
    const root = mkdtempSync(join(tmpdir(), "registry-build-"))
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }))
    const runner = createCheckRunner({ root, appRoot: ".", now: NOW, spawn })
    const baseline = await runner.buildBaseline()
    expect(runner.baseline()).toBe(baseline)
    const graded = (await runner.run("build_green_or_baseline", {})) as CheckResult
    expect(graded.state).toBe("problem")
    expect(graded.reason).toContain("Type error: y")
    expect(graded.reason).not.toContain("Can't resolve 'x'")
  })
})
