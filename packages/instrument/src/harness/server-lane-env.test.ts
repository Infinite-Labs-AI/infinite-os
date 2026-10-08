import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  DesktopServerLaneBridge,
  isFreshServerLaneReceipt,
  redeployWithLocalVercel,
  redactSecrets,
  runServerLaneEnvStep,
  serverLaneBridgeRefusal,
  setVercelProductionVar,
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
    hosting: { connected: true, provider: "vercel", connectionId: "conn_1", projectName: "example-site", productionHost: "shop.example.com", envWriteGranted: true, error: null }
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
        hosting: { connected: true, provider: "vercel", connectionId: "conn_1", projectName: "example-site", productionHost: "shop.example.com", envWriteGranted: true, error: null }
      }
    })
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
    [{ something: "new" }, { unknown: true }],
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
    [403, null, "bridge_credentials_rejected"],
    [402, null, "subscription_required"],
  ])("HTTP %s %j → %s", (status, payload, code) => {
    expect(serverLaneBridgeRefusal(status, payload).code).toBe(code)
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

function linkedRepo(projectName = "example-site"): string {
  const root = mkdtempSync(join(tmpdir(), "server-lane-env-"))
  tempRoots.push(root)
  mkdirSync(join(root, ".vercel"), { recursive: true })
  writeFileSync(join(root, ".vercel", "project.json"), JSON.stringify({ projectId: "prj_1", orgId: "team_1", projectName }))
  return root
}

describe("local vercel CLI", () => {
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

const VERCEL_WRITABLE = { connected: true, provider: "vercel" as const, connectionId: "conn_1", projectName: "example-site", envWriteGranted: true }
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
    const { runner, calls } = vercelRunner({ git: options.git, deployUrl: "https://example-abc.vercel.app" })
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

  it("dirty tree + --redeploy, non-interactive: REFUSED, says why, and records dirty_working_tree", async () => {
    const run = await drive({ git: DIRTY, redeploy: true })
    expect(run.deployed).toBe(false)
    expect(run.report.redeploy).toEqual({ state: "skipped", reason: "dirty_working_tree" })
    expect(run.lines).toEqual([
      "Refused to run `vercel --prod`: Your working tree has uncommitted changes — `vercel --prod` would deploy them to production. Commit and push, then redeploy — or pass --allow-dirty with --redeploy to deploy it anyway.",
      "Redeploy production so the variables take effect (for example: vercel --prod)."
    ])
  })

  it("commits not pushed to the upstream are unsafe (unpushed_commits), refused without --allow-dirty", async () => {
    const run = await drive({ git: { ahead: 2 }, redeploy: true })
    expect(run.deployed).toBe(false)
    expect(run.report.redeploy).toEqual({ state: "skipped", reason: "unpushed_commits" })
    expect(run.lines[0]).toContain("This branch has 2 commits not pushed to its upstream — `vercel --prod` would deploy them to production")
    expect((await drive({ git: { ahead: 1 }, redeploy: true, allowDirty: true })).deployed).toBe(true)
  })
})
