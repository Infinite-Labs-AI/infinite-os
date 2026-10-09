import type { GhClient } from "./gh.js"
import { expect, it } from "vitest"
import { blockedPreview, checkBucket, checksSummary, commitChecks, withDeploymentStates, readinessChecks } from "./checks.js"

const SHA = "a".repeat(40)
it.each(["failure", "cancelled",])("keeps %s blocking", state => expect(checkBucket(state)).toBe("fail"))
it.each(["queued",])("waits for %s", state => expect(checkBucket(state)).toBe("pending"))
it.each([ "skipped"])("treats %s as unmeasured", state => {
  expect(checkBucket(state)).toBe("skipping")
  expect(checksSummary([{ name: "ci", bucket: checkBucket(state), state }])).toEqual({ pass: 0, fail: 0, pending: 0, total: 1 })
})
it("does not hide cancelled or blocked checks from the failure count", () => {
  expect(checksSummary([{ name: "test", bucket: "cancel", state: "CANCELLED" }, { name: "Vercel", bucket: "fail", state: "failure", description: "Deployment was blocked" }])).toEqual({ pass: 0, fail: 2, pending: 0, total: 2 })
})

it("prefers a specific deployment state over a misleading description", () => {
  expect(blockedPreview({ name: "Vercel", bucket: "fail", state: "FAILURE", deploymentState: "BUILD_FAILED", description: "Deployment was blocked" })).toBe(false)
  expect(blockedPreview({ name: "Vercel", bucket: "fail", state: "FAILURE", deploymentState: "blocked", description: "unavailable" })).toBe(true)
})

it("reads only actual check runs and commit statuses for the requested SHA", async () => {
  const calls: string[][] = []
  const gh = { json: async (args: string[]) => {
    calls.push(args)
    if (args[1]!.includes("/check-runs")) return { total_count: 1, check_runs: [{ name: "lint", head_sha: SHA, status: "completed", conclusion: "success" }] }
    return { sha: SHA, total_count: 1, statuses: [{ context: "external validation", state: "pending", target_url: "https://example.test/check" }] }
  } } as unknown as GhClient
  expect(await commitChecks(gh, SHA)).toEqual([expect.objectContaining({ name: "lint", bucket: "pass" }), expect.objectContaining({ name: "external validation", bucket: "pending" })])
  expect(calls).toHaveLength(2)
  expect(calls.every(call => call[1]?.includes(`/commits/${SHA}/`))).toBe(true)
})
it("does not accept a different head or a malformed run inventory", async () => {
  for (const runs of [{ check_runs: [{ name: "ci", head_sha: "b".repeat(40), status: "completed", conclusion: "success" }] }, { check_runs: null }]) {
    const gh = { json: async (args: string[]) => args[1]!.includes("/check-runs") ? runs : { statuses: [] } } as unknown as GhClient
    await expect(commitChecks(gh, SHA)).rejects.toThrow()
  }
})
it("does not turn missing conclusions into passing results", async () => {
  const gh = { json: async (args: string[]) => args[1]!.includes("/check-runs") ? { check_runs: [{ name: "ci", head_sha: SHA, status: "completed", conclusion: null }] } : { statuses: [] } } as unknown as GhClient
  expect(await commitChecks(gh, SHA)).toEqual([expect.objectContaining({ name: "ci", bucket: "unknown" })])
})

it("keeps real build failures and cancelled checks despite base-red failures", () => {
  const checks = [{ name: "Vercel", bucket: "fail", state: "failure", description: "Build failed" }, { name: "test", bucket: "fail", state: "cancelled" }]
  expect(readinessChecks(checks, [{ name: "test", bucket: "fail", state: "failure" }]).checks).toEqual(checks)
})
it("does not hide a real build failure behind another environment's access block", async () => {
  const gh = { json: async (args: string[]) => args[1]!.includes("/statuses") ? [{ state: "failure", description: args[1]!.includes("/1/") ? "Deployment was blocked" : "Build failed" }] : [{ id: 1, creator: { login: "vercel[bot]" }, environment: "Preview – docs" }, { id: 2, creator: { login: "vercel[bot]" }, environment: "Preview – store" }] } as unknown as GhClient
  const checks = await withDeploymentStates(gh, SHA, [{ name: "Vercel", bucket: "fail", state: "failure" }])
  expect(readinessChecks(checks, []).checks).toHaveLength(1)
  expect(checks[0]!.description).toBe("Build failed")
})
