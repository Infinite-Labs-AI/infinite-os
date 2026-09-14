import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { REDEPLOY_SKIPPED_COPY, REDEPLOY_UNCONFIRMED_COPY, serverLaneCopy } from "../server-lane/copy.js"

import {
  DesktopServerLaneBridge,
  SERVER_LANE_UPDATE_REQUIRED_REASON,
  detectEnvAddCapabilities,
  detectLocalVercel,
  inspectDeployTree,
  isFreshServerLaneReceipt,
  redeployWithLocalVercel,
  redactSecrets,
  runServerLaneEnvStep,
  serverLaneBridgeRefusal,
  setVercelProductionVar,
  waitForFirstServerLaneEvent,
  type CommandResult,
  type CommandRunner,
  type ServerLaneBridge,
  type ServerLaneBridgeAnswer,
  type ServerLaneHostingStatus,
  type ServerLaneMintResult,
  type ServerLaneProvisionResult,
  type ServerLaneStatus
} from "./server-lane-env.js"
import type { ServerLaneEnvReport } from "./types.js"

const SECRET = "test-server-event-secret-value-0042"
const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

function laneStatus(overrides: Partial<Omit<ServerLaneStatus, "hosting">> & { hosting?: Partial<ServerLaneHostingStatus> } = {}): ServerLaneStatus {
  const { hosting, ...rest } = overrides
  return {
    sourceId: "src_1",
    publicKey: "site_public123",
    secretSetAt: null,
    firstProductionReceivedAt: null,
    serverLaneFirstReceivedAt: null,
    serverLaneLastReceivedAt: null,
    lastProductionReceivedAt: null,
    laneState: "no_secret",
    ...rest,
    hosting: {
      connected: false,
      provider: null,
      connectionId: null,
      projectName: null,
      productionHost: null,
      envWriteGranted: false,
      error: null,
      ...hosting
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function fetchStub(responses: Response[]): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const queue = [...responses]
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    })
    const next = queue.shift()
    if (!next) throw new Error("no more responses")
    return next
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}

describe("DesktopServerLaneBridge", () => {
  const statusBody = {
    sourceId: "src_1",
    publicKey: "site_public123",
    envNames: { sourceKey: "INFINITE_SITE_SOURCE_KEY", secret: "INFINITE_SERVER_EVENT_SECRET" },
    secretSetAt: "2026-09-02T00:00:00.000Z",
    firstProductionReceivedAt: "2026-09-02T01:00:00.000Z",
    serverLaneFirstReceivedAt: null,
    serverLaneLastReceivedAt: null,
    lastProductionReceivedAt: "2026-09-14T09:00:00.000Z",
    laneState: "awaiting_first_event",
    hosting: { connected: true, provider: "vercel", connectionId: "conn_1", projectName: "october-site", productionHost: "october.dev", envWriteGranted: true, error: null }
  }

  it("GETs the status with the LOCAL bridge bearer and decodes the contract shape", async () => {
    const stub = fetchStub([json(200, statusBody)])
    const bridge = new DesktopServerLaneBridge({ bridgeUrl: "http://127.0.0.1:5000///", token: "bridge_tok", fetch: stub.fetch })
    const answer = await bridge.status()
    expect(stub.calls[0]).toMatchObject({ url: "http://127.0.0.1:5000/v1/analytics/server-lane", method: "GET" })
    expect(stub.calls[0]!.headers.authorization).toBe("Bearer bridge_tok")
    expect(answer).toEqual({
      ok: true,
      value: {
        sourceId: "src_1",
        publicKey: "site_public123",
        secretSetAt: "2026-09-02T00:00:00.000Z",
        firstProductionReceivedAt: "2026-09-02T01:00:00.000Z",
        serverLaneFirstReceivedAt: null,
        serverLaneLastReceivedAt: null,
        lastProductionReceivedAt: "2026-09-14T09:00:00.000Z",
        laneState: "awaiting_first_event",
        hosting: { connected: true, provider: "vercel", connectionId: "conn_1", projectName: "october-site", productionHost: "october.dev", envWriteGranted: true, error: null }
      }
    })
  })

  it("decodes hosting.error, and refuses a 'receiving' status that carries no server-lane receipt time", async () => {
    const stub = fetchStub([
      json(200, { ...statusBody, hosting: { ...statusBody.hosting, envWriteGranted: false, error: "provider_unavailable" } }),
      json(200, { ...statusBody, laneState: "receiving", serverLaneLastReceivedAt: null }),
      json(200, { ...statusBody, laneState: "receiving", serverLaneLastReceivedAt: "2026-09-14T09:30:00.000Z" })
    ])
    const bridge = new DesktopServerLaneBridge({ bridgeUrl: "http://127.0.0.1:5000", token: "t", fetch: stub.fetch })
    expect(await bridge.status()).toMatchObject({ ok: true, value: { hosting: { error: "provider_unavailable" } } })
    expect(await bridge.status()).toMatchObject({ ok: false, code: "unexpected_shape" })
    expect(await bridge.status()).toMatchObject({ ok: true, value: { laneState: "receiving", serverLaneLastReceivedAt: "2026-09-14T09:30:00.000Z" } })
  })

  it("POSTs exactly the contract bodies for provision-env and mint", async () => {
    const stub = fetchStub([
      json(200, { written: ["INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"], mintedNewSecret: false, redeploy: { deploymentId: "dpl_1" }, status: {} }),
      json(200, { publicKey: "site_public123", secret: SECRET, secretSetAt: "2026-09-14T00:00:00.000Z", envNames: {} })
    ])
    const bridge = new DesktopServerLaneBridge({ bridgeUrl: "http://127.0.0.1:5000", token: "t", fetch: stub.fetch })
    expect(await bridge.provisionEnv({ hostingConnectionId: "conn_1" })).toEqual({
      ok: true,
      value: { written: ["INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"], mintedNewSecret: false, redeploy: { deploymentId: "dpl_1" } }
    })
    expect(await bridge.mint({ confirmReplaceLive: true })).toMatchObject({ ok: true, value: { secret: SECRET } })
    expect(stub.calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ["POST", "http://127.0.0.1:5000/v1/analytics/server-lane/provision-env", { hostingConnectionId: "conn_1" }],
      ["POST", "http://127.0.0.1:5000/v1/analytics/server-lane/mint", { confirmReplaceLive: true }]
    ])
  })

  it.each([
    [{ skipped: true, reason: "no_production_deployment" }, { skipped: true, reason: "no_production_deployment" }],
    [{ unconfirmed: true, reason: "redeploy_submission_unknown" }, { unconfirmed: true, reason: "redeploy_submission_unknown" }],
    [{ something: "new" }, { unknown: true }],
    [{ skipped: true }, { unknown: true }],
    [undefined, { unknown: true }]
  ])("decodes redeploy %j as %j — never inventing a reason", async (redeploy, expected) => {
    const stub = fetchStub([json(200, { written: ["INFINITE_SITE_SOURCE_KEY"], mintedNewSecret: true, ...(redeploy ? { redeploy } : {}) })])
    const bridge = new DesktopServerLaneBridge({ bridgeUrl: "http://127.0.0.1:5000", token: "t", fetch: stub.fetch })
    expect(await bridge.provisionEnv({})).toMatchObject({ ok: true, value: { redeploy: expected } })
  })

  it("an unreachable app is a typed refusal, not a throw", async () => {
    const bridge = new DesktopServerLaneBridge({
      bridgeUrl: "http://127.0.0.1:5000",
      token: "t",
      fetch: (async () => {
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch
    })
    expect(await bridge.status()).toMatchObject({ ok: false, code: "unreachable", message: "the Infinite app was unreachable (ECONNREFUSED)" })
  })
})

describe("serverLaneBridgeRefusal — coded answers before status-only rungs", () => {
  it.each([
    [404, { error: "no_site_source" }, "no_site_source"],
    [404, { error: "not_linked", message: "Not linked" }, "not_linked"],
    [404, { error: { code: "not_found", message: "unknown route" } }, "desktop_update_required"],
    [404, null, "desktop_update_required"],
    [409, { error: "no_hosting_connection", message: "No Vercel connection" }, "no_hosting_connection"],
    [409, { error: "secret_in_use", message: "receiving" }, "secret_in_use"],
    [409, { error: "secret_changed_concurrently", message: "Another change landed" }, "secret_changed_concurrently"],
    [409, { error: "analytics_secret_env_plain", message: "INFINITE_SERVER_EVENT_SECRET is stored as plain text in Vercel" }, "analytics_secret_env_plain"],
    [409, { error: "demo_workspace_protected", message: "Demo workspaces cannot change hosting" }, "demo_workspace_protected"],
    [409, { error: "not_ready", state: "signed_out" }, "not_ready"],
    [403, { error: "missing_scope", message: "env write not granted" }, "missing_scope"],
    [401, { error: "unauthorized" }, "unauthorized"],
    [403, null, "bridge_credentials_rejected"],
    [401, null, "bridge_credentials_rejected"],
    [502, { error: "env_write_unknown", message: "Vercel timed out" }, "env_write_unknown"],
    [503, { error: "capability_unavailable" }, "desktop_update_required"],
    [503, { error: "no_linked_workspace", message: "Link a workspace in Infinite" }, "no_linked_workspace"],
    [402, null, "subscription_required"],
    [429, null, "rate_limited"],
    [500, null, "unavailable"]
  ])("HTTP %s %j → %s", (status, payload, code) => {
    expect(serverLaneBridgeRefusal(status, payload).code).toBe(code)
  })

  it("keeps the cloud's message for contract refusals, names sign-in for session codes, and says UPDATE only for a codeless 404", () => {
    expect(serverLaneBridgeRefusal(403, { error: "missing_scope", message: "env write not granted" }).message).toBe("env write not granted")
    expect(serverLaneBridgeRefusal(409, { error: "demo_workspace_protected", message: "Demo workspaces cannot change hosting" }).message).toBe("Demo workspaces cannot change hosting")
    expect(serverLaneBridgeRefusal(404, { error: "not_linked", message: "Not linked" }).message).toContain("sign in to the Infinite app")
    expect(serverLaneBridgeRefusal(404, { error: "not_linked" }).message).not.toContain("update the Infinite app")
    expect(serverLaneBridgeRefusal(401, { error: "unauthorized" }).message).toContain("session has expired")
    expect(serverLaneBridgeRefusal(401, { error: "unauthorized" }).message).not.toContain("bridge credentials")
    expect(serverLaneBridgeRefusal(409, { state: "signed_out" }).message).toContain("signed_out")
    expect(serverLaneBridgeRefusal(404, null).message).toBe(SERVER_LANE_UPDATE_REQUIRED_REASON)
    expect(SERVER_LANE_UPDATE_REQUIRED_REASON).toContain("update the Infinite app")
  })
})

// ---------------------------------------------------------------------------------------------
// vercel CLI
// ---------------------------------------------------------------------------------------------

interface RunCall {
  command: string
  args: string[]
  cwd: string
  input?: string
}

const HELP_58 = [
  "  ▲ vercel env add name [environment] [git-branch] [options]",
  "       --force                    Overwrite an existing variable for the same target",
  "       --sensitive                Store the value as sensitive for Production or Preview",
  "       --value <VALUE>            Set the variable value for non-interactive use; otherwise use stdin or the prompt",
  "  -y,  --yes                      Skip the confirmation prompt when adding an Environment Variable"
].join("\n")

const HELP_OLD = ["  ▲ vercel env add name [environment] [git-branch]", "  -d, --debug   Debug mode"].join("\n")

function fakeRunner(handler: (call: RunCall) => Partial<CommandResult> = () => ({}), log?: string[]): { runner: CommandRunner; calls: RunCall[] } {
  const calls: RunCall[] = []
  const runner: CommandRunner = async (command, args, options) => {
    const call = { command, args: [...args], cwd: options.cwd, ...(options.input !== undefined ? { input: options.input } : {}) }
    calls.push(call)
    log?.push(`${command} ${args.join(" ")}`)
    return { status: 0, stdout: "", stderr: "", ...handler(call) }
  }
  return { runner, calls }
}

interface GitState {
  /** `git status --porcelain` stdout; default clean. */
  porcelain?: string
  notRepo?: boolean
  /** Commits ahead of upstream; null = no upstream configured (the default). */
  ahead?: number | null
}

function gitAnswer(args: string[], git: GitState = {}): Partial<CommandResult> {
  if (git.notRepo) return { status: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" }
  if (args[0] === "status") return { stdout: git.porcelain ?? "" }
  if (args[0] === "rev-parse") return (git.ahead ?? null) === null ? { status: 128, stderr: "fatal: no upstream configured for branch 'main'" } : { stdout: "origin/main\n" }
  if (args[0] === "rev-list") return { stdout: `${git.ahead ?? 0}\n` }
  return {}
}

function vercelRunner(options: { help?: string; existing?: string[]; addFails?: string; addFailsCount?: number; deployUrl?: string; log?: string[]; git?: GitState } = {}) {
  const existing = new Set(options.existing ?? [])
  let failuresLeft = options.addFailsCount ?? Number.POSITIVE_INFINITY
  return fakeRunner((call) => {
    if (call.command === "git") return gitAnswer(call.args, options.git)
    const [first, second, name] = call.args
    if (first === "--version") return { stdout: "Vercel CLI 58.4.4\n58.4.4\n" }
    if (first === "env" && second === "add" && name === "--help") return { stdout: options.help ?? HELP_58 }
    if (first === "env" && second === "add") {
      if (options.addFails === name && failuresLeft > 0) {
        failuresLeft -= 1
        return { status: 1, stderr: `Error: You must re-authenticate (value was ${call.input})` }
      }
      if (existing.has(name!) && !call.args.includes("--force")) {
        return { status: 1, stderr: `Error: A variable with the name "${name}" already exists for the target production` }
      }
      existing.add(name!)
      return { stdout: `Added Environment Variable ${name} to Project` }
    }
    if (first === "env" && second === "rm") {
      existing.delete(name!)
      return { stdout: `Removed Environment Variable` }
    }
    if (first === "--prod") return { stdout: `Inspect: https://vercel.com/acme/site/abc\nProduction: ${options.deployUrl ?? "https://site-abc.vercel.app"}\n` }
    return {}
  }, options.log)
}

function linkedRepo(projectName = "october-site"): string {
  const root = mkdtempSync(join(tmpdir(), "server-lane-env-"))
  tempRoots.push(root)
  mkdirSync(join(root, ".vercel"), { recursive: true })
  writeFileSync(join(root, ".vercel", "project.json"), JSON.stringify({ projectId: "prj_1", orgId: "team_1", projectName }))
  return root
}

describe("local vercel CLI", () => {
  it("detects the link and the installed CLI; a missing link or binary is typed", async () => {
    const root = linkedRepo()
    const ok = vercelRunner()
    expect(await detectLocalVercel({ root, appRootAbsolute: root, runner: ok.runner })).toEqual({ ok: true, cwd: root, projectName: "october-site", version: "58.4.4" })

    const bare = mkdtempSync(join(tmpdir(), "server-lane-env-bare-"))
    tempRoots.push(bare)
    expect(await detectLocalVercel({ root: bare, appRootAbsolute: bare, runner: ok.runner })).toEqual({ ok: false, reason: "not_linked" })

    const missing = fakeRunner(() => ({ status: null, error: "spawn vercel ENOENT" }))
    expect(await detectLocalVercel({ root, appRootAbsolute: root, runner: missing.runner })).toEqual({ ok: false, reason: "cli_missing" })
  })

  it("reads flags from the installed CLI's help instead of guessing", async () => {
    expect(await detectEnvAddCapabilities(vercelRunner({ help: HELP_58 }).runner, "/x")).toEqual({ force: true, sensitive: true, yes: true })
    expect(await detectEnvAddCapabilities(vercelRunner({ help: HELP_OLD }).runner, "/x")).toEqual({ force: false, sensitive: false, yes: false })
  })

  it("passes the value on STDIN only — never in argv — and uses --force when the CLI has it", async () => {
    const { runner, calls } = vercelRunner({ existing: ["INFINITE_SERVER_EVENT_SECRET"] })
    const outcome = await setVercelProductionVar({
      runner, cwd: "/repo", name: "INFINITE_SERVER_EVENT_SECRET", value: SECRET, sensitive: true,
      capabilities: { force: true, sensitive: true, yes: true }, secrets: [SECRET]
    })
    expect(outcome).toEqual({ name: "INFINITE_SERVER_EVENT_SECRET", ok: true, replaced: false })
    expect(calls).toEqual([
      { command: "vercel", args: ["env", "add", "INFINITE_SERVER_EVENT_SECRET", "production", "--force", "--sensitive", "--yes"], cwd: "/repo", input: SECRET }
    ])
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain(SECRET)
  })

  it("an older CLI without --force takes the documented rm -y + add path when the variable exists", async () => {
    const { runner, calls } = vercelRunner({ help: HELP_OLD, existing: ["INFINITE_SITE_SOURCE_KEY"] })
    const outcome = await setVercelProductionVar({
      runner, cwd: "/repo", name: "INFINITE_SITE_SOURCE_KEY", value: "site_public123", sensitive: false,
      capabilities: { force: false, sensitive: false, yes: false }, secrets: [SECRET]
    })
    expect(outcome).toEqual({ name: "INFINITE_SITE_SOURCE_KEY", ok: true, replaced: true })
    expect(calls.map((call) => call.args)).toEqual([
      ["env", "add", "INFINITE_SITE_SOURCE_KEY", "production"],
      ["env", "rm", "INFINITE_SITE_SOURCE_KEY", "production", "-y"],
      ["env", "add", "INFINITE_SITE_SOURCE_KEY", "production"]
    ])
    expect(calls[1]!.input).toBeUndefined()
  })

  it("a failure detail never carries the secret, even when the CLI echoes stdin", async () => {
    const { runner } = vercelRunner({ addFails: "INFINITE_SERVER_EVENT_SECRET" })
    const outcome = await setVercelProductionVar({
      runner, cwd: "/repo", name: "INFINITE_SERVER_EVENT_SECRET", value: SECRET, sensitive: true,
      capabilities: { force: true, sensitive: true, yes: true }, secrets: [SECRET]
    })
    expect(outcome.ok).toBe(false)
    expect(JSON.stringify(outcome)).not.toContain(SECRET)
    expect(JSON.stringify(outcome)).toContain("<redacted>")
    expect(redactSecrets(`a ${SECRET} b ${SECRET}`, [SECRET])).toBe("a <redacted> b <redacted>")
  })
})

// ---------------------------------------------------------------------------------------------
// The step, driven directly
// ---------------------------------------------------------------------------------------------

interface FakeBridge extends ServerLaneBridge {
  calls: Array<{ route: "status" | "provision" | "mint"; body?: unknown }>
}

/** Statuses are served in order; the last one repeats. `log` interleaves with the vercel runner's. */
function fakeBridge(options: {
  statuses: Array<ServerLaneBridgeAnswer<ServerLaneStatus>>
  provision?: ServerLaneBridgeAnswer<ServerLaneProvisionResult>
  mints?: Array<ServerLaneBridgeAnswer<ServerLaneMintResult>>
  log?: string[]
}): FakeBridge {
  const statuses = [...options.statuses]
  const mints = [...(options.mints ?? [])]
  const calls: FakeBridge["calls"] = []
  return {
    calls,
    async status() {
      calls.push({ route: "status" })
      return statuses.length > 1 ? statuses.shift()! : statuses[0]!
    },
    async provisionEnv(body) {
      calls.push({ route: "provision", body })
      options.log?.push("bridge provision")
      if (!options.provision) throw new Error("provision not expected")
      return options.provision
    },
    async mint(body) {
      calls.push({ route: "mint", body })
      options.log?.push(`bridge mint ${JSON.stringify(body)}`)
      const next = mints.shift()
      if (!next) throw new Error("mint not expected")
      return next
    }
  }
}

function stepIo(options: { interactive?: boolean; answers?: boolean[] } = {}) {
  const lines: string[] = []
  const questions: string[] = []
  const answers = [...(options.answers ?? [])]
  return {
    lines,
    questions,
    interactive: options.interactive ?? false,
    say: (line: string) => {
      lines.push(line)
    },
    confirm: async (question: string, defaultYes: boolean) => {
      questions.push(question)
      return answers.length > 0 ? answers.shift()! : defaultYes
    }
  }
}

function stepInput(io: ReturnType<typeof stepIo>, overrides: Partial<Parameters<typeof runServerLaneEnvStep>[0]> = {}): Parameters<typeof runServerLaneEnvStep>[0] {
  const root = overrides.root ?? "/nonexistent-repo"
  return {
    mode: "apply",
    interactive: io.interactive,
    yes: false,
    replaceLiveSecret: false,
    redeploy: false,
    allowDirty: false,
    root,
    appRootAbsolute: root,
    say: io.say,
    confirm: io.confirm,
    ...overrides
  }
}

const VERCEL_WRITABLE = { connected: true, provider: "vercel" as const, connectionId: "conn_1", projectName: "october-site", envWriteGranted: true }
const MINTED: ServerLaneBridgeAnswer<ServerLaneMintResult> = { ok: true, value: { publicKey: "site_public123", secret: SECRET, secretSetAt: "2026-09-14T10:00:00.000Z" } }
const IN_USE: ServerLaneBridgeAnswer<ServerLaneMintResult> = { ok: false, code: "secret_in_use", message: "the current secret has received server-lane events since it was set", httpStatus: 409 }

describe("runServerLaneEnvStep — PATH B", () => {
  it("Infinite's write needs a yes: non-interactive without --yes writes nothing and prints the manual path", async () => {
    const io = stepIo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ hosting: VERCEL_WRITABLE }) }] })
    const result = await runServerLaneEnvStep(stepInput(io, { bridge }))
    expect(bridge.calls.map((call) => call.route)).toEqual(["status"])
    expect(result.report).toMatchObject({ path: "manual", envSet: "unknown", attempts: [{ path: "infinite_vercel", outcome: "declined" }] })
    const printed = io.lines.join("\n")
    expect(printed).toContain("Re-run with --yes")
    expect(printed).toContain("INFINITE_SITE_SOURCE_KEY=site_public123")
    expect(printed).toContain("Infinite → Connections → Website → Set them yourself → Reveal secret")
    expect(printed).toContain("env var only — never paste the secret into chat, messages, or your repo")
  })

  it("env_write_unknown stops: no local mint that could rotate a secret Vercel may already hold", async () => {
    const io = stepIo({ interactive: true })
    const root = linkedRepo()
    const bridge = fakeBridge({
      statuses: [{ ok: true, value: laneStatus({ hosting: VERCEL_WRITABLE }) }],
      provision: { ok: false, code: "env_write_unknown", message: "Vercel timed out", httpStatus: 502 }
    })
    const { runner, calls } = vercelRunner()
    const result = await runServerLaneEnvStep(stepInput(io, { bridge, runner, root, yes: true }))
    expect(bridge.calls.map((call) => call.route)).toEqual(["status", "provision"])
    expect(calls).toEqual([])
    expect(result.report).toMatchObject({ path: "manual", envSet: "unknown" })
    expect(io.lines.join("\n")).toContain("could not confirm the write to Vercel (Vercel timed out)")
  })

  it.each([
    ["analytics_secret_env_plain", "INFINITE_SERVER_EVENT_SECRET is stored as plain text in Vercel — delete it there first"],
    ["demo_workspace_protected", "Demo workspaces cannot change hosting"]
  ])("a %s refusal prints the cloud's message and stops at the manual path (no local mint)", async (code, message) => {
    const io = stepIo({ interactive: true })
    const root = linkedRepo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ hosting: VERCEL_WRITABLE }) }], provision: { ok: false, code, message, httpStatus: 409 } })
    const { runner, calls } = vercelRunner()
    const result = await runServerLaneEnvStep(stepInput(io, { bridge, runner, root, yes: true }))
    expect(calls).toEqual([])
    expect(result.report).toMatchObject({ path: "manual", attempts: [{ path: "infinite_vercel", outcome: "refused", code }] })
    expect(io.lines.join("\n")).toContain(`Infinite could not write the variables: ${message}.`)
  })

  it("an unconfirmed redeploy stays unconfirmed — never 'skipped'", async () => {
    const io = stepIo()
    const bridge = fakeBridge({
      statuses: [{ ok: true, value: laneStatus({ hosting: VERCEL_WRITABLE }) }],
      provision: { ok: true, value: { written: ["INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"], mintedNewSecret: false, redeploy: { unconfirmed: true, reason: "redeploy_submission_unknown" } } }
    })
    const result = await runServerLaneEnvStep(stepInput(io, { bridge, yes: true }))
    expect(result.report.redeploy).toEqual({ state: "unconfirmed", reason: "redeploy_submission_unknown" })
    const printed = io.lines.join("\n")
    expect(printed).toContain("Redeploy submitted, not confirmed (redeploy_submission_unknown) — check Vercel's latest production deployment")
    expect(printed).not.toContain("Redeploy didn't run")
  })

  it("an unknown redeploy shape is reported as unknown, with no invented reason", async () => {
    const io = stepIo()
    const bridge = fakeBridge({
      statuses: [{ ok: true, value: laneStatus({ hosting: VERCEL_WRITABLE }) }],
      provision: { ok: true, value: { written: ["INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"], mintedNewSecret: false, redeploy: { unknown: true } } }
    })
    const result = await runServerLaneEnvStep(stepInput(io, { bridge, yes: true }))
    expect(result.report.redeploy).toEqual({ state: "unknown" })
    expect(io.lines.join("\n")).toContain("Redeploy status unknown")
    expect(io.lines.join("\n")).not.toContain("Redeploy didn't run")
  })

  it("hosting.error is a read failure, not a permission answer: no provision call, no 'Reconnect', no connect hint", async () => {
    const io = stepIo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ hosting: { ...VERCEL_WRITABLE, envWriteGranted: false, error: "provider_unavailable" } }) }] })
    const result = await runServerLaneEnvStep(stepInput(io, { bridge, yes: true }))
    expect(bridge.calls.map((call) => call.route)).toEqual(["status"])
    const printed = io.lines.join("\n")
    expect(printed).toContain("Infinite couldn't read its Vercel connection (provider_unavailable) — this is not a permission problem.")
    expect(printed).not.toContain("Reconnect Vercel")
    expect(printed).not.toContain("Tip: connect Vercel")
    expect(result.report.hosting).toMatchObject({ error: "provider_unavailable" })
    expect(result.report.attempts[0]).toEqual({ path: "infinite_vercel", outcome: "unavailable", code: "provider_unavailable" })
  })

  it("multiple_hosting_connections names the production host instead of asking to reconnect", async () => {
    const io = stepIo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ hosting: { connected: true, provider: "vercel", connectionId: null, productionHost: "october.dev", envWriteGranted: false, error: "multiple_hosting_connections" } }) }] })
    await runServerLaneEnvStep(stepInput(io, { bridge, yes: true }))
    const printed = io.lines.join("\n")
    expect(printed).toContain("More than one Vercel project is connected to this workspace in Infinite")
    expect(printed).toContain("the project serving october.dev")
    expect(printed).not.toContain("Reconnect Vercel")
  })
})

describe("runServerLaneEnvStep — PATH C order (public key → mint → secret)", () => {
  it("the local path is never approved by --yes alone: non-interactive refuses before any write or mint", async () => {
    const io = stepIo()
    const root = linkedRepo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus() }] })
    const { runner, calls } = vercelRunner()
    const result = await runServerLaneEnvStep(stepInput(io, { bridge, runner, root, yes: true }))
    expect(bridge.calls.map((call) => call.route)).toEqual(["status"])
    expect(calls.map((call) => call.args[0])).toEqual(["--version"])
    expect(result.report.attempts).toEqual([{ path: "local_vercel", outcome: "declined", message: expect.stringContaining("needs an interactive yes") }])
  })

  it("probes the CLI and writes the PUBLIC key before minting, then writes the secret at once", async () => {
    const log: string[] = []
    const io = stepIo({ interactive: true, answers: [true, false] })
    const root = linkedRepo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ laneState: "awaiting_first_event", secretSetAt: "2026-09-02T00:00:00.000Z" }) }], mints: [MINTED], log })
    const result = await runServerLaneEnvStep(stepInput(io, { bridge, runner: vercelRunner({ log }).runner, root }))
    expect(log).toEqual([
      "vercel --version",
      "vercel env add --help",
      "vercel env add INFINITE_SITE_SOURCE_KEY production --force --yes",
      "bridge mint {}",
      "vercel env add INFINITE_SERVER_EVENT_SECRET production --force --sensitive --yes",
      // The redeploy prompt is preceded by the working-tree check (clean, no upstream) and declined.
      "git status --porcelain",
      "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}"
    ])
    expect(result.report).toMatchObject({ path: "local_vercel", envSet: "yes", mintedNewSecret: true, written: ["INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"] })
  })

  it("a failed PUBLIC-key write mints nothing: the secret is unchanged and says so", async () => {
    const log: string[] = []
    const io = stepIo({ interactive: true, answers: [true] })
    const root = linkedRepo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ laneState: "awaiting_first_event", secretSetAt: "2026-09-02T00:00:00.000Z" }) }], mints: [MINTED], log })
    const result = await runServerLaneEnvStep(stepInput(io, { bridge, runner: vercelRunner({ addFails: "INFINITE_SITE_SOURCE_KEY", log }).runner, root }))
    expect(bridge.calls.some((call) => call.route === "mint")).toBe(false)
    expect(log.some((entry) => entry.includes("INFINITE_SERVER_EVENT_SECRET"))).toBe(false)
    expect(result.report).toMatchObject({ path: "manual", envSet: "unknown", mintedNewSecret: false, written: [] })
    const printed = io.lines.join("\n")
    expect(printed).toContain("✗ vercel env add INFINITE_SITE_SOURCE_KEY production failed: Error: You must re-authenticate")
    expect(printed).toContain("Nothing was minted: this site's server-event secret is unchanged.")
    expect(printed).not.toContain("is now ACTIVE")
  })

  it("the live-secret guard keys off 'received since the secret was set' — decline keeps the secret and writes no secret", async () => {
    const log: string[] = []
    const io = stepIo({ interactive: true, answers: [true, false] })
    const root = linkedRepo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ laneState: "awaiting_first_event", secretSetAt: "2026-09-02T00:00:00.000Z" }) }], mints: [IN_USE], log })
    const result = await runServerLaneEnvStep(stepInput(io, { bridge, runner: vercelRunner({ log }).runner, root }))
    expect(log.indexOf("bridge mint {}")).toBeGreaterThan(log.findIndex((entry) => entry.includes("INFINITE_SITE_SOURCE_KEY")))
    expect(bridge.calls.filter((call) => call.route === "mint")).toEqual([{ route: "mint", body: {} }])
    expect(io.questions).toEqual([expect.stringContaining("Mint the secret"), "Replace that secret anyway? [y/N] "])
    const printed = io.lines.join("\n")
    expect(printed).toContain("current server-event secret (set 2026-09-02T00:00:00.000Z) has already received server-lane events since it was set")
    expect(printed).not.toContain("ALREADY RECEIVING")
    expect(printed).toContain("Kept the current secret — it was not replaced.")
    expect(log.some((entry) => entry.includes("INFINITE_SERVER_EVENT_SECRET"))).toBe(false)
    expect(result.report).toMatchObject({ path: "manual", mintedNewSecret: false, written: ["INFINITE_SITE_SOURCE_KEY"], attempts: [{ path: "local_vercel", outcome: "refused", code: "secret_in_use" }] })
  })

  it("secret_changed_concurrently: not the live guard, never retried, source key kept, plain copy + attempt recorded", async () => {
    const log: string[] = []
    const io = stepIo({ interactive: true, answers: [true] })
    const root = linkedRepo()
    const concurrent: ServerLaneBridgeAnswer<ServerLaneMintResult> = { ok: false, code: "secret_changed_concurrently", message: "Another secret change landed", httpStatus: 409 }
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ laneState: "awaiting_first_event", secretSetAt: "2026-09-02T00:00:00.000Z" }) }], mints: [concurrent, MINTED], log })
    const result = await runServerLaneEnvStep(stepInput(io, { bridge, runner: vercelRunner({ log }).runner, root, replaceLiveSecret: true }))
    expect(bridge.calls.filter((call) => call.route === "mint")).toEqual([{ route: "mint", body: {} }])
    expect(io.questions).toEqual([expect.stringContaining("Mint the secret")])
    const printed = io.lines.join("\n")
    expect(printed).toContain("Another secret change happened at the same moment — nothing was replaced. Re-run `infinite analytics`.")
    expect(printed).not.toContain("has already received server-lane events")
    expect(printed).not.toContain("is now ACTIVE")
    expect(log.some((entry) => entry.includes("INFINITE_SERVER_EVENT_SECRET"))).toBe(false)
    expect(result.report).toMatchObject({
      path: "manual", mintedNewSecret: false, written: ["INFINITE_SITE_SOURCE_KEY"],
      attempts: [{ path: "local_vercel", outcome: "refused", code: "secret_changed_concurrently", message: "Another secret change landed" }]
    })
  })

  it("an accepted live replace mints with confirmReplaceLive; --replace-live-secret skips the question", async () => {
    const acceptIo = stepIo({ interactive: true, answers: [true, true, false] })
    const acceptBridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ laneState: "awaiting_first_event", secretSetAt: "2026-09-02T00:00:00.000Z" }) }], mints: [IN_USE, MINTED] })
    const accepted = await runServerLaneEnvStep(stepInput(acceptIo, { bridge: acceptBridge, runner: vercelRunner().runner, root: linkedRepo() }))
    expect(acceptBridge.calls.filter((call) => call.route === "mint").map((call) => call.body)).toEqual([{}, { confirmReplaceLive: true }])
    expect(accepted.report).toMatchObject({ path: "local_vercel", envSet: "yes" })

    const flagIo = stepIo({ interactive: true, answers: [true, false] })
    const flagBridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ laneState: "awaiting_first_event" }) }], mints: [IN_USE, MINTED] })
    await runServerLaneEnvStep(stepInput(flagIo, { bridge: flagBridge, runner: vercelRunner().runner, root: linkedRepo(), replaceLiveSecret: true }))
    expect(flagIo.questions).not.toContain("Replace that secret anyway? [y/N] ")
    expect(flagBridge.calls.filter((call) => call.route === "mint").map((call) => call.body)).toEqual([{}, { confirmReplaceLive: true }])

    const nonInteractiveIo = stepIo({ interactive: false })
    const nonInteractiveBridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus() }], mints: [IN_USE] })
    // Non-interactive never reaches the mint (the local path itself needs a yes), so drive the refusal copy directly.
    await runServerLaneEnvStep(stepInput(nonInteractiveIo, { bridge: nonInteractiveBridge, runner: vercelRunner().runner, root: linkedRepo() }))
    expect(nonInteractiveBridge.calls.some((call) => call.route === "mint")).toBe(false)
  })

  it("a confirmed live replace whose SECRET write fails says plainly that a new secret is active and unset — and never prints it", async () => {
    const io = stepIo({ interactive: true, answers: [true, true] })
    const root = linkedRepo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ laneState: "awaiting_first_event", secretSetAt: "2026-09-02T00:00:00.000Z" }) }], mints: [IN_USE, MINTED] })
    const result = await runServerLaneEnvStep(stepInput(io, { bridge, runner: vercelRunner({ addFails: "INFINITE_SERVER_EVENT_SECRET" }).runner, root }))
    expect(result.report).toMatchObject({ path: "manual", envSet: "no", mintedNewSecret: true, written: ["INFINITE_SITE_SOURCE_KEY"] })
    const printed = `${io.lines.join("\n")}\n${JSON.stringify(result.report)}`
    expect(printed).toContain("✗ A NEW server-event secret is now ACTIVE for this site (minted just now), and it is NOT in Vercel. The server lane records nothing until INFINITE_SERVER_EVENT_SECRET is set to it in production.")
    expect(printed).toContain("Reveal secret, run `vercel env add INFINITE_SERVER_EVENT_SECRET production` and paste it at that prompt")
    expect(printed).not.toContain(SECRET)
  })

  it("a source key that changed mid-run is written again with the minted key before the secret", async () => {
    const log: string[] = []
    const io = stepIo({ interactive: true, answers: [true, false] })
    const root = linkedRepo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus() }], mints: [{ ok: true, value: { publicKey: "site_rotated999", secret: SECRET, secretSetAt: null } }], log })
    const { runner, calls } = vercelRunner({ log })
    const result = await runServerLaneEnvStep(stepInput(io, { bridge, runner, root }))
    const adds = calls.filter((call) => call.args[1] === "add" && call.args[2] !== "--help").map((call) => [call.args[2], call.input === SECRET ? "<secret>" : call.input])
    expect(adds).toEqual([["INFINITE_SITE_SOURCE_KEY", "site_public123"], ["INFINITE_SITE_SOURCE_KEY", "site_rotated999"], ["INFINITE_SERVER_EVENT_SECRET", "<secret>"]])
    expect(io.lines.join("\n")).toContain("source key changed during the run")
    expect(result.report).toMatchObject({ publicKey: "site_rotated999", envSet: "yes" })
  })

  it("--redeploy runs vercel --prod after the local path and records the production URL", async () => {
    const io = stepIo({ interactive: true, answers: [true] })
    const root = linkedRepo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus() }], mints: [MINTED] })
    const { runner, calls } = vercelRunner({ deployUrl: "https://october-abc.vercel.app" })
    const result = await runServerLaneEnvStep(stepInput(io, { bridge, runner, root, redeploy: true }))
    expect(calls.at(-1)!.args).toEqual(["--prod"])
    expect(io.questions).toEqual([expect.stringContaining("Mint the secret")])
    expect(result.report.redeploy).toEqual({ state: "deployed", url: "https://october-abc.vercel.app" })
  })
})

describe("runServerLaneEnvStep — receiving", () => {
  it("receiving is shown with the SERVER-LANE receipt time, never the pixel's", async () => {
    const io = stepIo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ laneState: "receiving", secretSetAt: "2026-09-02T00:00:00.000Z", serverLaneLastReceivedAt: "2026-09-14T09:58:00.000Z", lastProductionReceivedAt: "2026-09-14T09:59:59.000Z" }) }] })
    const result = await runServerLaneEnvStep(stepInput(io, { bridge }))
    expect(result.report).toMatchObject({ path: "already_receiving", envSet: "yes" })
    expect(io.lines.join("\n")).toContain("last server-lane event at 2026-09-14T09:58:00.000Z")
    expect(io.lines.join("\n")).not.toContain("09:59:59")
  })

  it("a rotated secret (awaiting_first_event) with fresh PIXEL traffic and an old server-lane receipt is not receiving", async () => {
    const io = stepIo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ laneState: "awaiting_first_event", secretSetAt: "2026-09-14T09:00:00.000Z", serverLaneFirstReceivedAt: "2026-09-03T00:00:00.000Z", serverLaneLastReceivedAt: "2026-09-10T00:00:00.000Z", lastProductionReceivedAt: "2026-09-14T09:59:59.000Z" }) }] })
    const result = await runServerLaneEnvStep(stepInput(io, { bridge }))
    expect(result.report.path).toBe("manual")
    expect(io.lines.join("\n")).not.toContain("receiving events")
  })
})

describe("the first server-lane event", () => {
  const RUN_START = "2026-09-14T10:00:00.000Z"
  const timing = () => {
    let now = 0
    return { now: () => now, sleep: async (ms: number) => { now += ms }, budgetMs: 9_000, pollIntervalMs: 3_000 }
  }
  const receiving = (last: string, secretSetAt = "2026-09-14T09:00:00.000Z") =>
    laneStatus({ laneState: "receiving", secretSetAt, serverLaneLastReceivedAt: last })

  it("isFreshServerLaneReceipt: receiving, newer than the run start (5 s skew), and at/after secretSetAt", () => {
    const startMs = Date.parse(RUN_START)
    expect(isFreshServerLaneReceipt(receiving("2026-09-14T10:00:10.000Z"), startMs)).toBe("2026-09-14T10:00:10.000Z")
    expect(isFreshServerLaneReceipt(receiving("2026-09-14T09:59:58.000Z"), startMs)).toBe("2026-09-14T09:59:58.000Z")
    expect(isFreshServerLaneReceipt(receiving("2026-09-14T09:59:50.000Z"), startMs)).toBeNull()
    expect(isFreshServerLaneReceipt(receiving("2026-09-14T10:00:10.000Z", "2026-09-14T10:00:20.000Z"), startMs)).toBeNull()
    expect(isFreshServerLaneReceipt({ ...receiving("2026-09-14T10:00:10.000Z"), laneState: "awaiting_first_event" }, startMs)).toBeNull()
    expect(isFreshServerLaneReceipt(laneStatus({ laneState: "awaiting_first_event", lastProductionReceivedAt: "2026-09-14T10:00:10.000Z" }), startMs)).toBeNull()
  })

  it("'ever received' before this run never counts", async () => {
    const bridge = fakeBridge({ statuses: [{ ok: true, value: receiving("2026-09-10T00:00:00.000Z", "2026-09-02T00:00:00.000Z") }] })
    expect(await waitForFirstServerLaneEvent({ bridge, runStartedAt: RUN_START, ...timing() })).toEqual({ state: "waiting" })
    // t=0, 3s, 6s, 9s — the same "next poll must fit in the budget" rule as the verify backends.
    expect(bridge.calls.length).toBe(4)
  })

  it("fresh PIXEL traffic without a server-lane receipt never counts", async () => {
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ laneState: "awaiting_first_event", secretSetAt: "2026-09-14T09:00:00.000Z", lastProductionReceivedAt: "2026-09-14T10:00:05.000Z", firstProductionReceivedAt: "2026-09-14T10:00:05.000Z" }) }] })
    expect(await waitForFirstServerLaneEvent({ bridge, runStartedAt: RUN_START, ...timing() })).toEqual({ state: "waiting" })
  })

  it("a fresh server-lane receipt under the current secret is the receipt", async () => {
    const bridge = fakeBridge({
      statuses: [
        { ok: true, value: laneStatus({ laneState: "awaiting_first_event", secretSetAt: "2026-09-14T09:00:00.000Z" }) },
        { ok: true, value: receiving("2026-09-14T10:00:05.000Z") }
      ]
    })
    expect(await waitForFirstServerLaneEvent({ bridge, runStartedAt: RUN_START, ...timing() })).toEqual({ state: "received", at: "2026-09-14T10:00:05.000Z" })
  })

  it("a terminal refusal stops at once; transient ones retry up to three times", async () => {
    const signedOut = fakeBridge({ statuses: [{ ok: false, code: "not_ready", message: "Infinite Desktop is not ready (signed_out)", httpStatus: 409 }] })
    expect(await waitForFirstServerLaneEvent({ bridge: signedOut, runStartedAt: RUN_START, ...timing(), budgetMs: 60_000 })).toEqual({ state: "refused", message: "Infinite Desktop is not ready (signed_out)" })
    expect(signedOut.calls.length).toBe(1)
    const flaky = fakeBridge({ statuses: [{ ok: false, code: "rate_limited", message: "rate limited", httpStatus: 429 }] })
    expect(await waitForFirstServerLaneEvent({ bridge: flaky, runStartedAt: RUN_START, ...timing(), budgetMs: 60_000 })).toEqual({ state: "refused", message: "rate limited" })
    expect(flaky.calls.length).toBe(3)
  })
})

describe("redeploy reason copy", () => {
  const IN_VERCEL = "redeploy production in Vercel so the new variables take effect."
  const RECONNECT = "reconnect Vercel in Infinite → Connections → Website, then re-run `infinite analytics`."
  it.each([
    ["no_production_deployment", "there is no production deployment yet", "deploy production in Vercel so the new variables take effect."],
    ["serving_deployment_unknown", "couldn't tell which deployment production serves", IN_VERCEL],
    ["serving_deployment_not_ready", "production's current deployment isn't ready yet", "redeploy production in Vercel once it is."],
    ["serving_deployment_mismatch", "production serves a deployment from a different repository", IN_VERCEL],
    ["serving_deployment_no_git_source", "production's deployment wasn't built from Git", IN_VERCEL],
    ["production_build_in_progress", "a newer production build is already running", "the new variables apply when it finishes."],
    ["access_denied", "Vercel connection was refused", RECONNECT],
    ["connection_unavailable", "Vercel connection is unavailable", RECONNECT],
    ["project_mismatch", "connected Vercel project doesn't match this site", RECONNECT],
    ["provider_unavailable", "Vercel was unreachable", "re-run `infinite analytics` shortly."],
    ["provider_rejected", "Vercel rejected the redeploy", IN_VERCEL],
    ["some_future_code", null, "Redeploy production in Vercel so the new variables take effect."]
  ])("skipped %s → plain copy, code in parentheses, unblock step last", (code, plain, unblock) => {
    const line = serverLaneCopy.envStep.redeploySkipped(code)
    expect(line).toContain(`(${code})`)
    if (plain) expect(line).toContain(plain)
    else expect(REDEPLOY_SKIPPED_COPY[code]).toBeUndefined()
    expect(line.endsWith(unblock)).toBe(true)
  })

  it.each([
    ["redeploy_submission_unknown", "Redeploy submitted, not confirmed"],
    ["deployment_mismatch", "A deployment was created but didn't match production's commit"],
    ["some_future_code", "Redeploy submitted, not confirmed"]
  ])("unconfirmed %s → never 'redeploy again' blind", (code, plain) => {
    const line = serverLaneCopy.envStep.redeployUnconfirmed(code)
    expect(line).toContain(plain)
    expect(line).toContain(`(${code})`)
    expect(line.endsWith("check Vercel's latest production deployment before redeploying again.")).toBe(true)
    if (code === "some_future_code") expect(REDEPLOY_UNCONFIRMED_COPY[code]).toBeUndefined()
  })

  it("every mapped code is pinned by the table above (a new cloud code needs a row)", () => {
    expect(Object.keys(REDEPLOY_SKIPPED_COPY).sort()).toEqual([
      "access_denied", "connection_unavailable", "no_production_deployment", "production_build_in_progress", "project_mismatch",
      "provider_rejected", "provider_unavailable", "serving_deployment_mismatch", "serving_deployment_no_git_source",
      "serving_deployment_not_ready", "serving_deployment_unknown"
    ])
    expect(Object.keys(REDEPLOY_UNCONFIRMED_COPY).sort()).toEqual(["deployment_mismatch", "redeploy_submission_unknown"])
  })
})

describe("local redeploy — never ships an unchecked working tree", () => {
  function emptyReport(): ServerLaneEnvReport {
    return {
      path: "local_vercel", envSet: "yes", envNames: { sourceKey: "INFINITE_SITE_SOURCE_KEY", secret: "INFINITE_SERVER_EVENT_SECRET" },
      publicKey: "site_public123", laneState: "no_secret", statusRefusal: null, hosting: null, written: [], mintedNewSecret: true,
      redeploy: { state: "not_run" }, attempts: [], firstEvent: { state: "not_checked" }
    }
  }

  async function drive(options: { git?: GitState; interactive?: boolean; redeploy?: boolean; allowDirty?: boolean; answers?: boolean[] }) {
    const { runner, calls } = vercelRunner({ git: options.git, deployUrl: "https://october-abc.vercel.app" })
    const lines: string[] = []
    const prompts: Array<{ question: string; defaultYes: boolean }> = []
    const answers = [...(options.answers ?? [])]
    const report = emptyReport()
    await redeployWithLocalVercel({
      runner, cwd: "/repo", interactive: options.interactive ?? false, redeploy: options.redeploy ?? false, allowDirty: options.allowDirty ?? false, secrets: [SECRET],
      say: (line) => { lines.push(line) },
      confirm: async (question, defaultYes) => {
        prompts.push({ question, defaultYes })
        return answers.length > 0 ? answers.shift()! : defaultYes
      }
    }, report)
    return { report, lines, prompts, deployed: calls.some((call) => call.command === "vercel" && call.args[0] === "--prod"), calls }
  }

  const DIRTY = { porcelain: " M src/App.tsx\n?? notes.txt\n" }

  it("clean tree + --redeploy deploys without a prompt (behavior unchanged); the tree is checked first", async () => {
    const run = await drive({ git: { ahead: 0 }, redeploy: true })
    expect(run.deployed).toBe(true)
    expect(run.prompts).toEqual([])
    expect(run.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      "git status --porcelain",
      "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
      "git rev-list --count @{upstream}..HEAD",
      "vercel --prod"
    ])
    expect(run.report.redeploy).toEqual({ state: "deployed", url: "https://october-abc.vercel.app" })
  })

  it("clean tree, interactive, no flag: the original [y/N] prompt; no upstream is not a finding", async () => {
    const run = await drive({ git: { ahead: null }, interactive: true, answers: [true] })
    expect(run.prompts).toEqual([{ question: "Run `vercel --prod` now? It deploys this LOCAL working tree (including uncommitted changes) to production. [y/N] ", defaultYes: false }])
    expect(run.deployed).toBe(true)
  })

  it("the harness's own outputs (.infinite/, .gitignore) do not make the tree dirty", async () => {
    expect(await inspectDeployTree(vercelRunner({ git: { porcelain: "?? .infinite/\n M .gitignore\n" } }).runner, "/repo")).toEqual({ state: "clean" })
  })

  it("dirty tree + --redeploy, non-interactive: REFUSED, says why, and records dirty_working_tree", async () => {
    const run = await drive({ git: DIRTY, redeploy: true })
    expect(run.deployed).toBe(false)
    expect(run.report.redeploy).toEqual({ state: "skipped", reason: "dirty_working_tree" })
    expect(run.lines).toEqual([
      "Refused to run `vercel --prod`: Your working tree has uncommitted changes — `vercel --prod` would deploy them to production. Commit and push, then redeploy — or pass --allow-dirty with --redeploy to deploy it anyway.",
      "Redeploy production so the variables take effect (for example: vercel --prod)."
    ])
  })

  it("dirty tree + --redeploy --allow-dirty deploys, with the warning printed", async () => {
    const run = await drive({ git: DIRTY, redeploy: true, allowDirty: true })
    expect(run.deployed).toBe(true)
    expect(run.lines[0]).toBe("! Your working tree has uncommitted changes — `vercel --prod` would deploy them to production. Deploying anyway (--redeploy --allow-dirty).")
    expect(run.report.redeploy).toMatchObject({ state: "deployed" })
  })

  it("dirty tree, interactive: the prompt names the uncommitted changes and defaults to No — even with --redeploy", async () => {
    for (const redeploy of [false, true]) {
      const run = await drive({ git: DIRTY, interactive: true, redeploy })
      expect(run.prompts).toEqual([{ question: "Your working tree has uncommitted changes — `vercel --prod` would deploy them to production. Run it anyway? [y/N] ", defaultYes: false }])
      expect(run.deployed).toBe(false)
      expect(run.report.redeploy).toEqual({ state: "skipped", reason: "dirty_working_tree" })
    }
    const accepted = await drive({ git: DIRTY, interactive: true, answers: [true] })
    expect(accepted.deployed).toBe(true)
  })

  it("not a git repository is treated as unsafe (git_state_unknown), same as dirty", async () => {
    const refused = await drive({ git: { notRepo: true }, redeploy: true })
    expect(refused.deployed).toBe(false)
    expect(refused.report.redeploy).toEqual({ state: "skipped", reason: "git_state_unknown" })
    expect(refused.lines[0]).toContain("git state couldn't be read")
    const prompted = await drive({ git: { notRepo: true }, interactive: true })
    expect(prompted.prompts[0]).toMatchObject({ defaultYes: false })
    expect(prompted.prompts[0]!.question).toContain("would deploy whatever is in it to production, unchecked")
  })

  it("commits not pushed to the upstream are unsafe (unpushed_commits), refused without --allow-dirty", async () => {
    const run = await drive({ git: { ahead: 2 }, redeploy: true })
    expect(run.deployed).toBe(false)
    expect(run.report.redeploy).toEqual({ state: "skipped", reason: "unpushed_commits" })
    expect(run.lines[0]).toContain("This branch has 2 commits not pushed to its upstream — `vercel --prod` would deploy them to production")
    expect((await drive({ git: { ahead: 1 }, redeploy: true, allowDirty: true })).deployed).toBe(true)
  })

  it("non-interactive without --redeploy never touches git or vercel", async () => {
    const run = await drive({ git: DIRTY })
    expect(run.calls).toEqual([])
    expect(run.report.redeploy).toEqual({ state: "skipped", reason: "not run without --redeploy" })
  })
})
