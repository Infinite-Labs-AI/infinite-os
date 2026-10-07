// The real wiring (lane I1): `createDefaultWizardDeps` registers lane O9's checks on lane O6's runner, and the
// live reads go through the proxy-aware fetch. A loopback proxy that refuses every tunnel stands in for the
// network: nothing leaves this machine, and no app, agent or gh is started.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { O9_CHECK_IDS } from "../checks/o9.js"
import { buildHostGuardExpression } from "../host-guard.js"
import { fakeKeys } from "../../test/wizard/o7-fakes.js"
import type { O6CheckRunner } from "../checks/registry.js"
import { MCP_ENV } from "./contracts/agents.js"
import type { ChecklistItem } from "./contracts/jobs.js"
import { WIZARD_PATHS, type WizardRunState } from "./contracts/state.js"
import { parseWizardArgs } from "./command.js"
import { createDefaultWizardDeps, createDefaultWizardWiring, o9RunContext } from "./deps.js"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function site(): { root: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), "infinite-tag-deps-"))
  dirs.push(base)
  const root = join(base, "site")
  const home = join(base, "home")
  mkdirSync(root)
  mkdirSync(home)
  execFileSync("git", ["init", "-q", root])
  return { root, home }
}

async function deps(env: Record<string, string>, fetch?: typeof globalThis.fetch) {
  const { root, home } = site()
  const parsed = parseWizardArgs(["--json"], root)
  if (!parsed.ok) throw new Error(parsed.message)
  const controller = new AbortController()
  return createDefaultWizardDeps(
    { root, appRoot: ".", options: parsed.value.options, env: { ...env, HOME: home, GROWTH_OS_HOME: join(home, ".growth-os") }, platform: "darwin", tagVersion: "0.12.0-test", signal: controller.signal },
    { home, ...(fetch ? { fetch } : {}) }
  )
}

describe("O9 guard context", () => {
  it("uses exact approved guard bytes only for the current run and plan", () => {
    const { root } = site()
    const dir = join(root, WIZARD_PATHS.dir)
    mkdirSync(dir, { recursive: true })
    const runId = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
    const beforeAt = "2030-01-02T03:04:05.000Z"
    const guard = { emit: true, exempt: ["acme.example"], deny: ["localhost"] }
    const plan = { hash: "sha256:current", decisions: { consentMode: "not_required", conversionNames: ["lead"], privacyText: null, npmInstall: null }, lines: [
      { id: "conversion_names", kind: "conversion_names", text: "lead", jobIds: ["conversions_to_tools:lead"] },
      { id: "sensitive", kind: "sensitive_pages", text: "Off on /login", sensitivePaths: ["/login"], jobIds: ["posthog_improve:sensitive_pages"] }
    ] }
    writeFileSync(join(root, WIZARD_PATHS.beforeFacts), JSON.stringify({ schema: "infinite-tag.before-facts.v1", runId, facts: { keys: fakeKeys(), hosting: { provider: "none", vercel: null }, observedProductionHost: "acme.example" } }))
    writeFileSync(join(root, WIZARD_PATHS.planApprovals), JSON.stringify({ schema: "infinite-tag.plan-approvals.v1", planHash: "sha256:current", beforeAt, guard, plan, approvals: { approved: ["conversion_names", "sensitive"], declined: [], edits: {} } }))
    const state = { runId, plan: { hash: "sha256:current" }, steps: { before: { at: beforeAt } } }
    writeFileSync(join(root, WIZARD_PATHS.state), JSON.stringify(state))
    expect(o9RunContext(root, runId)?.expectedEmittedGuard).toBe(buildHostGuardExpression({ mode: "deny", exempt: guard.exempt, deny: guard.deny }))
    expect(o9RunContext(root, runId)).toMatchObject({ conversionNames: ["lead"], posthogSensitivePaths: ["/login"] })
    writeFileSync(join(root, WIZARD_PATHS.state), JSON.stringify({ ...state, plan: { hash: "sha256:other" } }))
    expect(o9RunContext(root, runId)?.expectedEmittedGuard).toBeUndefined()
    expect(o9RunContext(root, runId)?.conversionNames).toBeUndefined()
    expect(o9RunContext(root, runId)?.posthogSensitivePaths).toBeUndefined()
  })
})

describe("createDefaultWizardDeps (I1 wiring)", () => {
  it("stores check reasons with the current run's env and agent token redaction", async () => {
    const { root, home } = site()
    const runId = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
    const envValue = "synthetic-env-" + "value-".repeat(8)
    const mcpValue = "synthetic-mcp-" + "value-".repeat(8)
    const agentValue = "synthetic-agent-" + "value-".repeat(8)
    const publicId = "synthetic-public-id"
    const appRoot = "web"
    mkdirSync(join(root, appRoot))
    writeFileSync(join(root, appRoot, ".env.local"), `SERVICE_SETTING=${envValue}\nSITE_SETTING=${publicId}\n`)
    mkdirSync(join(root, WIZARD_PATHS.dir), { recursive: true })
    const keys = fakeKeys()
    keys.infinite.siteSourceKey = publicId
    writeFileSync(join(root, WIZARD_PATHS.beforeFacts), JSON.stringify({ schema: "infinite-tag.before-facts.v1", runId, facts: { keys } }))
    const parsed = parseWizardArgs(["--json"], root)
    if (!parsed.ok) throw new Error(parsed.message)
    const wired = await createDefaultWizardDeps({ root, appRoot, options: parsed.value.options, env: { HOME: home, [MCP_ENV.token]: mcpValue }, platform: "darwin", tagVersion: "0.12.0-test", signal: new AbortController().signal, state: () => ({ runId, steps: {} } as WizardRunState) }, { home })
    wired.agents.secretLiterals = () => [agentValue]
    const item: ChecklistItem = { id: "posthog_improve:proxy", jobId: "posthog_improve", n: 3, title: "Improve PostHog", owner: "agent", state: "claimed", allow: { files: [], create: [] }, trigger: { finding: "configured", evidence: [] }, checks: [{ id: "posthog_config", tier: "S", state: "not_run" }] }
    const reason = `read ${envValue}; ${mcpValue}; ${agentValue}; public ${publicId}`
    const [next] = wired.registry.apply([item], [{ checkId: "posthog_config", tier: "S", state: "problem", at: "2030-01-02T03:04:05.000Z", runId, reason }], runId)
    const stored = next!.checks[0]!.reason!
    for (const secret of [envValue, mcpValue, agentValue]) expect(JSON.stringify(next)).not.toContain(secret)
    expect(stored).toBe(`read [redacted: env_value]; [redacted: mcp_token]; [redacted: mcp_token]; public ${publicId}`)
  })

  it("registers every O9 check on O6's runner (the seams the steps call resolve to O9's functions)", async () => {
    const wired = await deps({})
    const registered = (wired.checks as O6CheckRunner).registered()
    for (const id of Object.values(O9_CHECK_IDS)) expect(registered).toContain(id)
  })

  it("live reads honour HTTPS_PROXY: a refusing proxy sees the CONNECT, the walk reads undetermined (never a pass)", async () => {
    const connects: string[] = []
    const proxy = createServer()
    proxy.on("connect", (request: IncomingMessage, socket: Socket) => {
      connects.push(String(request.url))
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n")
    })
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    try {
      const wired = await deps({ HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` })
      const results = await wired.checks.redirectWalk(["https://acme-store.com/"])
      expect(connects.length).toBeGreaterThan(0)
      expect(connects.every((target) => target === "acme-store.com:443")).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      expect(results.every((result) => result.state !== "pass")).toBe(true)
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  })

  it("NEGATIVE: an injected fetch replaces the network entirely (no proxy, no socket)", async () => {
    const seen: string[] = []
    const fetchSpy = (async (input: string | URL | Request) => {
      seen.push(String(input instanceof Request ? input.url : input))
      return new Response("", { status: 200, headers: { "content-type": "text/html" } })
    }) as typeof globalThis.fetch
    const wired = await deps({ HTTPS_PROXY: "http://127.0.0.1:9" }, fetchSpy)
    await wired.checks.redirectWalk(["https://acme-store.com/"])
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((url) => url.startsWith("https://acme-store.com/"))).toBe(true)
  })
})

describe("createDefaultWizardWiring: the SIGINT restore stage (review I1 P2-5)", () => {
  it("has a fenceAbort, a no-op before deps exist, and the runner's killAll (which awaits the restore) after", async () => {
    const wiring = createDefaultWizardWiring()
    expect(typeof wiring.fenceAbort).toBe("function")
    await expect(wiring.fenceAbort!()).resolves.toBeUndefined()
    const { root, home } = site()
    const parsed = parseWizardArgs(["--json"], root)
    if (!parsed.ok) throw new Error(parsed.message)
    const created = await wiring.createDeps({ root, appRoot: ".", options: parsed.value.options, env: { HOME: home }, platform: "darwin", tagVersion: "0.12.0-test", signal: new AbortController().signal })
    let killed = 0
    created.agents.killAll = async () => {
      killed += 1
    }
    await wiring.fenceAbort!()
    expect(killed).toBe(1)
  })
})
