import type { GhClient } from "./gh.js"
import { expect, it } from "vitest"
import { blockedPreview, checkBucket, checksSummary, commitChecks, withDeploymentStates } from "./checks.js"

const SHA = "a".repeat(40)
it.each(["failure", "error", "timed_out", "action_required", "cancelled", "canceled", "startup_failure"])("keeps %s blocking", state => expect(checkBucket(state)).toBe("fail"))
it.each(["queued", "in_progress", "pending", "waiting"])("waits for %s", state => expect(checkBucket(state)).toBe("pending"))
it.each(["neutral", "skipped"])("treats %s as unmeasured", state => {
  expect(checkBucket(state)).toBe("skipping")
  expect(checksSummary([{ name: "ci", bucket: checkBucket(state), state }])).toEqual({ pass: 0, fail: 0, pending: 0, total: 1 })
})
it("does not hide cancelled or blocked checks from the failure count", () => {
  expect(checksSummary([{ name: "test", bucket: "cancel", state: "CANCELLED" }, { name: "Vercel", bucket: "fail", state: "failure", description: "Deployment was blocked" }])).toEqual({ pass: 0, fail: 2, pending: 0, total: 2 })
})

it.each(["Build failed: this API requires authorization", "Build failed: test user must have access"])("does not classify an ordinary deployment failure by a phrase in its log: %s", description => {
  expect(blockedPreview({ name: "Vercel", bucket: "fail", state: "FAILURE", description })).toBe(false)
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
it("reads later check-run pages before deciding that the head finished", async () => {
  const gh = { json: async (args: string[]) => {
    if (args[1]!.includes("/status?")) return { total_count: 0, statuses: [] }
    const second = new URL(args[1]!, "https://fixture.invalid").searchParams.get("page") === "2"
    return { total_count: 101, check_runs: second ? [{ name: "late check", head_sha: SHA, status: "queued", conclusion: null }] : Array.from({ length: 100 }, (_, id) => ({ name: `check ${id}`, head_sha: SHA, status: "completed", conclusion: "success" })) }
  } } as unknown as GhClient
  const checks = await commitChecks(gh, SHA)
  expect(checks).toHaveLength(101)
  expect(checks.at(-1)).toMatchObject({ name: "late check", bucket: "pending" })
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
it("keeps an in-progress run pending even if an earlier conclusion is still present", async () => {
  const gh = { json: async (args: string[]) => args[1]!.includes("/check-runs") ? { check_runs: [{ name: "ci", head_sha: SHA, status: "in_progress", conclusion: "success" }] } : { statuses: [] } } as unknown as GhClient
  expect(await commitChecks(gh, SHA)).toEqual([expect.objectContaining({ name: "ci", bucket: "pending" })])
})

it("matches successful hosting projects by environment name without requiring equal dashboard links", async () => {
  const gh = { json: async (args: string[]) => {
    if (args[1]!.includes("/statuses")) return [{ state: "success", environment_url: "https://preview.example.test" }]
    return ["store", "docs"].map((project, index) => ({ id: index + 1, creator: { login: "vercel[bot]" }, environment: `Preview – ${project}` }))
  } } as unknown as GhClient
  const checks = ["store", "docs"].map(project => ({ name: `Vercel – ${project}`, bucket: "pass", state: "SUCCESS", link: `https://vercel.com/team/${project}/deployments/example` }))
  expect(await withDeploymentStates(gh, SHA, checks)).toEqual(checks.map(check => ({ ...check, deploymentState: "success" })))
})
it("combines explicitly named environments for a provider-wide status without link matching", async () => {
  const gh = { json: async (args: string[]) => args[1]!.includes("/statuses") ? [{ state: "success" }] : ["store", "docs"].map((name, id) => ({ id, creator: { login: "vercel[bot]" }, environment: `Preview – ${name}` })) } as unknown as GhClient
  expect(await withDeploymentStates(gh, SHA, [{ name: "Vercel", bucket: "pass", state: "SUCCESS" }])).toEqual([expect.objectContaining({ bucket: "pass", deploymentState: "success" })])
})
it.each(["pending", "fail", "skipping"])("does not promote a %s check from a successful deployment", async bucket => {
  const gh = { json: async (args: string[]) => args[1]!.includes("/statuses") ? [{ state: "success" }] : [{ id: 7, creator: { login: "vercel[bot]" }, environment: "Preview" }] } as unknown as GhClient
  expect((await withDeploymentStates(gh, SHA, [{ name: "Vercel", bucket, state: bucket }]))[0]!.bucket).toBe(bucket)
})
it("leaves skipped hosting checks unmeasured without querying deployments", async () => {
  const gh = { json: async () => { throw new Error("must not read a deployment for a skipped check") } } as unknown as GhClient
  const skipped = [{ name: "Vercel", bucket: "skipping", state: "skipped" }]
  expect(await withDeploymentStates(gh, SHA, skipped)).toEqual(skipped)
})
it("uses the latest deployment per named environment and preserves other projects' failures", async () => {
  const gh = { json: async (args: string[]) => {
    if (args[1]!.includes("/statuses")) return [{ state: /deployments\/3\//.test(args[1]!) ? "success" : "failure" }]
    return [{ id: 3, creator: { login: "vercel[bot]" }, environment: "Preview – store" }, { id: 2, creator: { login: "vercel[bot]" }, environment: "Preview – docs" }, { id: 1, creator: { login: "vercel[bot]" }, environment: "Preview – store" }]
  } } as unknown as GhClient
  const checks = await withDeploymentStates(gh, SHA, ["store", "docs"].map(name => ({ name: `Vercel – ${name}`, bucket: "pass", state: "SUCCESS" })))
  expect(checks.map(row => row.bucket)).toEqual(["pass", "fail"])
})
it.each(["failure", "error"])("retains authoritative hosting access details from a coarse %s state", async state => {
  const calls: string[][] = []
  const description = "Vercel - Git author must have access to the project on Vercel to create deployments"
  const gh = { json: async (args: string[]) => { calls.push(args); return args[1]!.includes("/statuses") ? [{ state, description }] : [{ id: 7, creator: { login: "vercel[bot]" }, environment: "Preview" }] } } as unknown as GhClient
  const checks = await withDeploymentStates(gh, SHA, [{ name: "Vercel", bucket: "fail", state: "FAILURE" }])
  expect(checks[0]).toMatchObject({ deploymentState: state, description, bucket: "fail" })
  expect(blockedPreview(checks[0]!)).toBe(true)
  expect(calls[0]![1]).toContain(`deployments?sha=${SHA}`)
})
