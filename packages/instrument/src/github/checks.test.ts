import type { GhClient } from "./gh.js"
import { describe, expect, it } from "vitest"
import { checksSummary, checkPolicy, workflowPrTrigger, withDeploymentStates, headCheckActivity, headPrWorkflows } from "./checks.js"

describe("PR check classification", () => {
  it("keeps a cancelled first poll pending for another read", () => {
    expect(checksSummary([{ name: "test", bucket: "cancel", state: "CANCELLED" }])).toEqual({ pass: 0, fail: 0, pending: 1, total: 1 })
  })

  it("treats a blocked hosting preview as not measured", () => {
    expect(checksSummary([{ name: "Vercel", bucket: "fail", state: "FAILURE", description: "Deployment was blocked" }])).toEqual({ pass: 0, fail: 0, pending: 0, total: 1 })
  })
})

describe("base comparison policy", () => {
  const red = { name: "test", bucket: "fail", state: "FAILURE" }
  it("allows only failures known to be red on the base", () => {
    expect(checkPolicy([red], [red]).existing).toEqual([red])
    expect(checkPolicy([red], [{ ...red, bucket: "pass" }]).failing).toEqual([red])
    expect(checkPolicy([red], null).failing).toEqual([red])
    expect(checkPolicy([red], []).failing).toEqual([red])
    expect(checkPolicy([red], [red, { ...red, bucket: "pass" }]).failing).toEqual([red])
  })
  it("does not hide an ordinary hosting failure or unrelated blocked test", () => {
    expect(checkPolicy([{ ...red, name: "Vercel", description: "Build failed" }], []).failing).toHaveLength(1)
    expect(checkPolicy([{ ...red, name: "Vercel", description: "Build failed: permission denied reading a file" }], []).failing).toHaveLength(1)
    expect(checkPolicy([{ ...red, description: "Deployment was blocked" }], []).failing).toHaveLength(1)
  })
})

it.each(["Build failed: this API requires authorization", "Build failed: test user must have access"])("does not classify an ordinary deployment failure by a phrase in its log: %s", description => {
  expect(checkPolicy([{ name: "Vercel", bucket: "fail", state: "FAILURE", description }], []).failing).toHaveLength(1)
})

it("prefers an explicit deployment state over a misleading description", () => {
  expect(checkPolicy([{ name: "Vercel", bucket: "fail", state: "FAILURE", deploymentState: "BUILD_FAILED", description: "Deployment was blocked" }], []).failing).toHaveLength(1)
  expect(checkPolicy([{ name: "Vercel", bucket: "fail", state: "FAILURE", deploymentState: "blocked", description: "unavailable" }], []).blocked).toHaveLength(1)
})
it.each([
  ["on: push\njobs: {}", false], ["on: [push, workflow_dispatch]\njobs: {}", false],
  ["on:\n  push:\n    branches: [main]\n  workflow_dispatch:\njobs: {}", false],
  ["on: [push, pull_request]", true], ["on:\n  pull_request:\njobs: {}", true],
  ["on: *trigger_alias", null], ["invalid yaml", null]
])("reads workflow triggers conservatively: %s", (source, expected) => expect(workflowPrTrigger(source as string)).toBe(expected))

it.each(["'pull_request'", '"pull_request_target"'])("does not omit a quoted PR workflow event: %s", event => {
  expect(workflowPrTrigger(`on:\n  push:\n  ${event}:\njobs: {}`)).toBe(true)
})

it("does not infer absent PR triggers from partially understood YAML event keys", () => {
  expect(workflowPrTrigger('on:\n  push:\n  ? pull_request\n  : {}\njobs: {}')).toBeNull()
})


it("requests authoritative deployment statuses for the head SHA", async () => {
  const calls: string[][] = []
  const gh = { json: async (args: string[]) => {
    calls.push(args)
    if (args[1]!.includes("/statuses")) return [{ state: "failure", description: "Deployment was blocked" }]
    return [{ id: 7, creator: { login: "vercel[bot]" }, environment: "Preview" }]
  } } as unknown as GhClient
  const rows = await withDeploymentStates(gh, "a".repeat(40), [{ name: "Vercel", bucket: "fail", state: "FAILURE", description: "Deployment was blocked" }])
  expect(rows[0]!.deploymentState).toBe("failure")
  expect(checkPolicy(rows, []).blocked).toHaveLength(1)
  expect(calls[0]![1]).toContain(`deployments?sha=${"a".repeat(40)}`)
  expect(calls[1]![1]).toContain("deployments/7/statuses")
})


it("does not count skipped CI as a passing measurement", () => {
  expect(checksSummary([{ name: "ci", bucket: "skipping", state: "SKIPPED" }])).toEqual({ pass: 0, fail: 0, pending: 0, total: 1 })
})


it("does not trust suites returned for a different SHA", async () => {
  const gh = { json: async (args: string[]) => args[1]!.includes("check-suites") ? { total_count: 1, check_suites: [{ id: 1, head_sha: "b".repeat(40), status: "completed", conclusion: "success" }] } : { total_count: 0, workflow_runs: [] } } as unknown as GhClient
  await expect(headCheckActivity(gh, "a".repeat(40))).rejects.toThrow("head SHA")
})

it("reads workflows introduced only in the PR head", async () => {
  const calls: string[][] = []
  const gh = { json: async (args: string[]) => {
    calls.push(args)
    return args[1]!.includes("workflows?") ? [{ path: ".github/workflows/new.yml", type: "file" }] : { encoding: "base64", content: Buffer.from("on: pull_request\njobs: {}").toString("base64") }
  } } as unknown as GhClient
  expect(await headPrWorkflows(gh, "a".repeat(40))).toEqual({ expected: [".github/workflows/new.yml"], unknown: false })
  expect(calls.every(args => args[1]!.includes(`ref=${"a".repeat(40)}`))).toBe(true)
})


it("reads later suite pages before deciding that the head finished", async () => {
  const sha = "a".repeat(40)
  const gh = { json: async (args: string[]) => {
    if (args[1]!.includes("/actions/runs?")) return { total_count: 0, workflow_runs: [] }
    const queued = args[1]!.includes("page=2")
    return { total_count: 101, check_suites: queued ? [{ id: 101, head_sha: sha, status: "queued", conclusion: null }] : Array.from({ length: 100 }, (_, id) => ({ id, head_sha: sha, status: "completed", conclusion: "success" })) }
  } } as unknown as GhClient
  expect((await headCheckActivity(gh, sha)).pending).toEqual(["Check suite 101"])
})

it("reads a failed suite's actual jobs instead of guessing its failed check name", async () => {
  const sha = "a".repeat(40)
  const gh = { json: async (args: string[]) => {
    if (args[1]!.includes("/actions/runs?")) return { total_count: 0, workflow_runs: [] }
    if (args[1]!.includes("/check-runs")) return { total_count: 1, check_runs: [{ name: "lint", conclusion: "failure" }] }
    return { total_count: 1, check_suites: [{ id: 7, head_sha: sha, status: "completed", conclusion: "failure" }] }
  } } as unknown as GhClient
  const result = await headCheckActivity(gh, sha)
  expect(result.failed).toEqual([])
  expect(result.results).toMatchObject([{ name: "lint", bucket: "fail" }])
  expect(checkPolicy(result.results, [{ name: "lint", bucket: "fail", state: "failure" }]).existing).toHaveLength(1)
})


it("does not use a completed push event as proof of a PR-triggered workflow", async () => {
  const sha = "a".repeat(40)
  const gh = { json: async (args: string[]) => args[1]!.includes("/actions/runs?") ? { total_count: 1, workflow_runs: [{ id: 7, head_sha: sha, path: ".github/workflows/ci.yml", event: "push", status: "completed", conclusion: "success" }] } : { total_count: 0, check_suites: [] } } as unknown as GhClient
  expect((await headCheckActivity(gh, sha)).workflowPaths).toEqual([])
})


it.each(["failure", "error"])("retains the deployment API's exact access explanation with coarse %s state", async state => {
  const description = "Vercel - Git author must have access to the project on Vercel to create deployments"
  const gh = { json: async (args: string[]) => args[1]!.includes("/statuses") ? [{ state, description }] : [{ id: 7, creator: { login: "vercel[bot]" } }] } as unknown as GhClient
  const checks = await withDeploymentStates(gh, "a".repeat(40), [{ name: "Vercel", bucket: "fail", state: "FAILURE" }])
  expect(checks[0]!.description).toBe(description)
  expect(checkPolicy(checks, []).blocked).toHaveLength(1)
  expect(checkPolicy(checks, []).failing).toHaveLength(0)
})

it("keeps specific deployment failures and ordinary authorization errors failed", async () => {
  for (const [state, description] of [["BUILD_FAILED", "Deployment was blocked"], ["failure", "Build failed: this API requires authorization"], ["error", "Build failed: test user must have access"]]) {
    const gh = { json: async (args: string[]) => args[1]!.includes("/statuses") ? [{ state, description }] : [{ id: 7, creator: { login: "vercel[bot]" } }] } as unknown as GhClient
    const checks = await withDeploymentStates(gh, "a".repeat(40), [{ name: "Vercel", bucket: "fail", state: "FAILURE" }])
    expect(checkPolicy(checks, []).failing).toHaveLength(1)
  }
})
