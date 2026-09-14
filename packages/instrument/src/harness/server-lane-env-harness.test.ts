// The env step inside the full runbook: every branch a founder can hit from `infinite analytics`,
// against a real fixture repo whose .infinite/install.json already records a server lane (the
// October shape: middleware merged, env never set), with a mocked desktop bridge.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { parseHarnessArgs } from "./args.js"
import { buildHarnessReportPayload } from "./report-sink.js"
import { runHarness, type HarnessDeps, type HarnessIo } from "./run.js"
import {
  DesktopServerLaneBridge,
  type CommandRunner,
  type ServerLaneBridge,
  type ServerLaneBridgeAnswer,
  type ServerLaneHostingStatus,
  type ServerLaneMintResult,
  type ServerLaneProvisionResult,
  type ServerLaneStatus
} from "./server-lane-env.js"
import { HARNESS_REPORT_RELATIVE_PATH } from "./state.js"

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
    hosting: { connected: false, provider: null, connectionId: null, projectName: null, productionHost: null, envWriteGranted: false, error: null, ...hosting }
  }
}

interface FakeBridge extends ServerLaneBridge {
  calls: Array<{ route: "status" | "provision" | "mint"; body?: unknown }>
}

/** Statuses are served in order; the last one repeats. */
function fakeBridge(options: {
  statuses: Array<ServerLaneBridgeAnswer<ServerLaneStatus>>
  provision?: ServerLaneBridgeAnswer<ServerLaneProvisionResult>
  mints?: Array<ServerLaneBridgeAnswer<ServerLaneMintResult>>
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
      if (!options.provision) throw new Error("provision not expected")
      return options.provision
    },
    async mint(body) {
      calls.push({ route: "mint", body })
      const next = mints.shift()
      if (!next) throw new Error("mint not expected")
      return next
    }
  }
}

const SECRET = "test-server-event-secret-value-0042"
const here = dirname(fileURLToPath(import.meta.url))
const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

/** vite-react-basic with a server lane recorded by an earlier install (nothing left to install). */
function octoberRepo(options: { linkVercel?: boolean } = {}): string {
  const targetRoot = mkdtempSync(join(tmpdir(), "harness-env-"))
  tempRoots.push(targetRoot)
  const root = join(targetRoot, "site")
  cpSync(join(here, "../../test/fixtures/vite-react-basic"), root, { recursive: true })
  mkdirSync(join(root, ".infinite"), { recursive: true })
  writeFileSync(join(root, ".infinite/install.json"), JSON.stringify({
    workspaceId: "ws_1", appRoot: ".", framework: "vite-react", providers: [], files: [], envKeys: [], contentHashes: {},
    serverLane: { mode: "vercel-middleware", created: ["lib/infinite-server-lane.ts", "lib/infinite-outcome.ts", "middleware.ts"], brief: "INSTALL-SERVER-LANE.md" },
    wiringVersion: 1, verifiedAt: null
  }))
  if (options.linkVercel) {
    mkdirSync(join(root, ".vercel"), { recursive: true })
    writeFileSync(join(root, ".vercel/project.json"), JSON.stringify({ projectId: "prj_1", orgId: "team_1", projectName: "october-site" }))
  }
  return root
}

interface FakeIo extends HarnessIo {
  outLines: string[]
  errLines: string[]
  questions: string[]
}

function fakeIo(options: { interactive?: boolean; answers?: boolean[] } = {}): FakeIo {
  const outLines: string[] = []
  const errLines: string[] = []
  const questions: string[] = []
  const answers = [...(options.answers ?? [])]
  return {
    interactive: options.interactive ?? false,
    outLines,
    errLines,
    questions,
    out: (line) => {
      outLines.push(line)
    },
    err: (line) => {
      errLines.push(line)
    },
    confirm: async (question, defaultYes) => {
      questions.push(question)
      return answers.length > 0 ? answers.shift()! : defaultYes
    }
  }
}

/** The run starts at 2026-09-14T10:00:00.000Z (the report's startedAt comes from this clock). */
function deps(bridge: ServerLaneBridge | undefined, runner?: CommandRunner): HarnessDeps {
  let now = Date.parse("2026-09-14T10:00:00.000Z")
  return {
    discover: () => null,
    serverLaneEnv: { ...(bridge ? { bridge } : {}), ...(runner ? { runner } : {}) },
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
    budgetMs: 9_000,
    pollIntervalMs: 3_000
  }
}

function serverLaneRow(result: Awaited<ReturnType<typeof runHarness>>) {
  return result.report.providers.find((state) => state.provider === "server_lane")!
}

function everythingPrinted(io: FakeIo, root: string): string {
  return [...io.outLines, ...io.errLines, ...io.questions, readFileSync(join(root, HARNESS_REPORT_RELATIVE_PATH), "utf8")].join("\n")
}

const APPLY = ["--apply", "--yes", "--no-mark"]
const VERCEL_WRITABLE = { connected: true, provider: "vercel" as const, connectionId: "conn_1", projectName: "october-site", envWriteGranted: true }

describe("harness server-lane env step", () => {
  it("a lane receiving with its CURRENT secret is verified at the server-lane receipt time — never the newer pixel time — and nothing is written", async () => {
    const root = octoberRepo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ laneState: "receiving", secretSetAt: "2026-09-02T00:00:00.000Z", serverLaneFirstReceivedAt: "2026-09-03T00:00:00.000Z", serverLaneLastReceivedAt: "2026-09-14T09:58:00.000Z", lastProductionReceivedAt: "2026-09-14T09:59:59.000Z" }) }] })
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs([...APPLY, "--root", root]), io, deps(bridge))
    expect(result.exitCode).toBe(0)
    expect(bridge.calls.map((call) => call.route)).toEqual(["status"])
    expect(serverLaneRow(result)).toMatchObject({ state: "verified", verification: { kind: "verified", receiptAt: "2026-09-14T09:58:00.000Z" } })
    expect(result.report.serverLaneEnv).toMatchObject({ path: "already_receiving", envSet: "yes", firstEvent: { state: "received", at: "2026-09-14T09:58:00.000Z" } })
    expect(io.outLines.join("\n")).toContain("receiving events with its current secret (last server-lane event at 2026-09-14T09:58:00.000Z)")
    expect(result.report.steps.find((step) => step.id === "verify")).toMatchObject({ status: "ok", note: "server_lane=verified (receiving with the current secret)" })
  })

  it("a ROTATED secret (old server-lane receipts, fresh pixel traffic) is never verified: --verify-only waits and exits nonzero", async () => {
    const root = octoberRepo()
    const rotated = laneStatus({ laneState: "awaiting_first_event", secretSetAt: "2026-09-14T09:00:00.000Z", serverLaneFirstReceivedAt: "2026-09-03T00:00:00.000Z", serverLaneLastReceivedAt: "2026-09-10T00:00:00.000Z", lastProductionReceivedAt: "2026-09-14T10:00:01.000Z", firstProductionReceivedAt: "2026-09-02T00:00:00.000Z" })
    const bridge = fakeBridge({ statuses: [{ ok: true, value: rotated }] })
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs(["--verify-only", "--root", root]), io, deps(bridge))
    // One read by the env step, then the bounded first-event poll (t=0, 3s, 6s, 9s).
    expect(bridge.calls.map((call) => call.route)).toEqual(["status", "status", "status", "status", "status"])
    expect(result.exitCode).toBe(1)
    expect(result.report.failure?.code).toBe("INF_VERIFY_INCOMPLETE")
    expect(result.report.failure?.message).toContain("Installed is not working.")
    expect(serverLaneRow(result)).toMatchObject({ state: "installed", verification: { kind: "awaiting_first_event" } })
    expect([...io.outLines, ...io.errLines].join("\n")).not.toContain("receiving events")
  })

  it("PATH B: Infinite writes both vars and redeploys (--yes approves), then the lane is verified only on a fresh server-lane receipt under the new secret", async () => {
    const root = octoberRepo()
    const before = laneStatus({ laneState: "no_secret", hosting: VERCEL_WRITABLE })
    const bridge = fakeBridge({
      statuses: [
        { ok: true, value: before },
        // Pixel traffic arriving during the redeploy is not a receipt.
        { ok: true, value: { ...before, laneState: "awaiting_first_event", secretSetAt: "2026-09-14T10:00:30.000Z", lastProductionReceivedAt: "2026-09-14T10:01:00.000Z" } },
        { ok: true, value: { ...before, laneState: "receiving", secretSetAt: "2026-09-14T10:00:30.000Z", serverLaneFirstReceivedAt: "2026-09-14T10:02:00.000Z", serverLaneLastReceivedAt: "2026-09-14T10:02:00.000Z" } }
      ],
      provision: { ok: true, value: { written: ["INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"], mintedNewSecret: true, redeploy: { deploymentId: "dpl_42" } } }
    })
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs([...APPLY, "--root", root]), io, deps(bridge))
    expect(result.exitCode).toBe(0)
    expect(bridge.calls.filter((call) => call.route === "provision")).toEqual([{ route: "provision", body: { hostingConnectionId: "conn_1" } }])
    const out = io.outLines.join("\n")
    expect(out).toContain('Infinite will add INFINITE_SITE_SOURCE_KEY and INFINITE_SERVER_EVENT_SECRET to the Vercel project "october-site" (production) and redeploy it.')
    expect(out).toContain('✓ Infinite wrote INFINITE_SITE_SOURCE_KEY and INFINITE_SERVER_EVENT_SECRET to "october-site" (production).')
    expect(out).toContain("Redeploy started (dpl_42)")
    expect(io.questions).toEqual([])
    expect(serverLaneRow(result)).toMatchObject({ state: "verified", verification: { kind: "verified", receiptAt: "2026-09-14T10:02:00.000Z" } })
    expect(result.report.serverLaneEnv).toMatchObject({ path: "infinite_vercel", envSet: "yes", mintedNewSecret: true, redeploy: { state: "started", deploymentId: "dpl_42" }, firstEvent: { state: "received", at: "2026-09-14T10:02:00.000Z" } })
  })

  it("PATH B with the redeploy skipped and no event yet: installed — waiting for the first event (env set: yes), never 'verified'", async () => {
    const root = octoberRepo()
    const status = laneStatus({ laneState: "awaiting_first_event", secretSetAt: "2026-09-02T00:00:00.000Z", hosting: VERCEL_WRITABLE })
    const bridge = fakeBridge({
      statuses: [{ ok: true, value: status }],
      provision: { ok: true, value: { written: ["INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"], mintedNewSecret: false, redeploy: { skipped: true, reason: "serving_deployment_not_ready" } } }
    })
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs([...APPLY, "--root", root]), io, deps(bridge))
    expect(result.exitCode).toBe(0)
    expect(io.outLines.join("\n")).toContain("Redeploy didn't run (serving_deployment_not_ready): production's current deployment isn't ready yet — redeploy production in Vercel once it is.")
    expect(io.outLines.join("\n")).toMatch(/server_lane\s+installed — waiting for the first event \(env set: yes\)/)
    expect(serverLaneRow(result).verification).toMatchObject({ kind: "awaiting_first_event", envSet: "yes" })
    expect(result.report.nextSteps.join("\n")).toContain("infinite analytics --verify-only")
    expect(result.report.nextSteps.join("\n")).toContain("Redeploy didn't run (serving_deployment_not_ready)")
    // The cloud payload stays inside its vocabulary.
    const payload = buildHarnessReportPayload(result.report, { engineProjectId: "proj_1", tagVersion: "0.9.1" })
    expect(payload.providers.server_lane?.verification).toEqual({ state: "not_verifiable", reason: "waiting for the first event (env set: yes)" })
  })

  it("PATH B with an UNCONFIRMED redeploy says 'submitted, not confirmed' in the output, the next steps and --json", async () => {
    const root = octoberRepo()
    const bridge = fakeBridge({
      statuses: [{ ok: true, value: laneStatus({ laneState: "no_secret", hosting: VERCEL_WRITABLE }) }],
      provision: { ok: true, value: { written: ["INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"], mintedNewSecret: true, redeploy: { unconfirmed: true, reason: "redeploy_submission_unknown" } } }
    })
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs([...APPLY, "--json", "--root", root, "--providers", "ga4"]), io, deps(bridge))
    const parsed = JSON.parse(io.outLines[0]!) as typeof result.report
    expect(parsed.serverLaneEnv?.redeploy).toEqual({ state: "unconfirmed", reason: "redeploy_submission_unknown" })
    expect(io.errLines.join("\n")).toContain("Redeploy submitted, not confirmed (redeploy_submission_unknown) — check Vercel's latest production deployment")
    expect(parsed.nextSteps.join("\n")).toContain("Redeploy submitted, not confirmed")
    expect(parsed.nextSteps.join("\n")).not.toContain("Redeploy didn't run")
  })

  it("missing_scope → reconnect copy, then the local vercel path: public key written before the mint, values on stdin only, secret never printed", async () => {
    const root = octoberRepo({ linkVercel: true })
    const bridge = fakeBridge({
      statuses: [
        { ok: true, value: laneStatus({ laneState: "no_secret", hosting: VERCEL_WRITABLE }) },
        { ok: true, value: laneStatus({ laneState: "awaiting_first_event", secretSetAt: "2026-09-14T10:00:00.000Z" }) }
      ],
      provision: { ok: false, code: "missing_scope", message: "env write not granted", httpStatus: 403 },
      mints: [{ ok: true, value: { publicKey: "site_public123", secret: SECRET, secretSetAt: "2026-09-14T10:00:00.000Z" } }]
    })
    const runs: Array<{ args: string[]; input?: string; mintsSoFar: number }> = []
    const runner: CommandRunner = async (command, args, options) => {
      // A clean tree with no upstream, so the original redeploy prompt is the one asked.
      if (command === "git") return args[0] === "status" ? { status: 0, stdout: "", stderr: "" } : { status: 128, stdout: "", stderr: "fatal: no upstream" }
      runs.push({ args: [...args], ...(options.input !== undefined ? { input: options.input } : {}), mintsSoFar: bridge.calls.filter((call) => call.route === "mint").length })
      if (args[0] === "--version") return { status: 0, stdout: "58.4.4", stderr: "" }
      if (args[2] === "--help") return { status: 0, stdout: "--force  --sensitive  --yes", stderr: "" }
      return { status: 0, stdout: "Added", stderr: "" }
    }
    // --yes approves Infinite's write; the local mint still asks, and the deploy is declined.
    const io = fakeIo({ interactive: true, answers: [true, false] })
    const result = await runHarness(parseHarnessArgs([...APPLY, "--root", root]), io, deps(bridge, runner))
    const out = io.outLines.join("\n")
    expect(out).toContain("Reconnect Vercel in Infinite → Connections → Website to allow environment variables.")
    expect(io.questions).toEqual([
      "Mint the secret and set both variables in Vercel production now? [Y/n] ",
      "Run `vercel --prod` now? It deploys this LOCAL working tree (including uncommitted changes) to production. [y/N] "
    ])
    expect(runs.filter((run) => run.args[1] === "add" && run.args[2] !== "--help")).toEqual([
      { args: ["env", "add", "INFINITE_SITE_SOURCE_KEY", "production", "--force", "--yes"], input: "site_public123", mintsSoFar: 0 },
      { args: ["env", "add", "INFINITE_SERVER_EVENT_SECRET", "production", "--force", "--sensitive", "--yes"], input: SECRET, mintsSoFar: 1 }
    ])
    expect(runs.some((run) => run.args.includes(SECRET))).toBe(false)
    expect(runs.some((run) => run.args[0] === "--prod")).toBe(false)
    expect(result.report.serverLaneEnv).toMatchObject({ path: "local_vercel", envSet: "yes", written: ["INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"], redeploy: { state: "skipped", reason: "declined" } })
    expect(result.report.nextSteps).toContain("Redeploy production so the variables take effect (for example: vercel --prod).")
    expect(serverLaneRow(result).verification).toMatchObject({ kind: "awaiting_first_event", envSet: "yes" })
    expect(everythingPrinted(io, root)).not.toContain(SECRET)
    expect(JSON.stringify(result.report)).not.toContain(SECRET)
  })

  it("--redeploy on a DIRTY local tree asks (default No) instead of deploying, and --json carries the skipped reason", async () => {
    const root = octoberRepo({ linkVercel: true })
    const bridge = fakeBridge({
      statuses: [{ ok: true, value: laneStatus({ laneState: "no_secret" }) }],
      mints: [{ ok: true, value: { publicKey: "site_public123", secret: SECRET, secretSetAt: "2026-09-14T10:00:00.000Z" } }]
    })
    const commands: string[] = []
    const runner: CommandRunner = async (command, args) => {
      commands.push(`${command} ${args.join(" ")}`)
      if (command === "git") return args[0] === "status" ? { status: 0, stdout: " M src/App.tsx\n", stderr: "" } : { status: 128, stdout: "", stderr: "fatal: no upstream" }
      if (args[0] === "--version") return { status: 0, stdout: "58.4.4", stderr: "" }
      if (args[2] === "--help") return { status: 0, stdout: "--force  --sensitive  --yes", stderr: "" }
      return { status: 0, stdout: "ok", stderr: "" }
    }
    // Yes to the mint; the dirty-tree prompt is left to its default.
    const io = fakeIo({ interactive: true, answers: [true] })
    const result = await runHarness(parseHarnessArgs([...APPLY, "--redeploy", "--json", "--root", root, "--providers", "ga4"]), io, deps(bridge, runner))
    expect(io.questions.at(-1)).toBe("Your working tree has uncommitted changes — `vercel --prod` would deploy them to production. Run it anyway? [y/N] ")
    expect(commands).not.toContain("vercel --prod")
    const parsed = JSON.parse(io.outLines[0]!) as typeof result.report
    expect(parsed.serverLaneEnv).toMatchObject({ path: "local_vercel", envSet: "yes", redeploy: { state: "skipped", reason: "dirty_working_tree" } })
    expect(parsed.nextSteps).toContain("Redeploy production so the variables take effect (for example: vercel --prod).")
    expect(JSON.stringify(parsed)).not.toContain(SECRET)
  })

  it("an old Infinite app (bridge 404) is a typed 'update the app' refusal, then PATH A — and --json stays one parseable document", async () => {
    const root = octoberRepo()
    const bridge = new DesktopServerLaneBridge({
      bridgeUrl: "http://127.0.0.1:5000",
      token: "bridge_tok",
      fetch: (async () => new Response(JSON.stringify({ error: { code: "not_found", message: "unknown verb" } }), { status: 404 })) as unknown as typeof fetch
    })
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs([...APPLY, "--json", "--root", root, "--providers", "ga4", "--infinite-site-source-key", "site_fromflag1"]), io, deps(bridge))
    expect(io.outLines.length).toBe(1)
    const parsed = JSON.parse(io.outLines[0]!) as typeof result.report
    expect(parsed.serverLaneEnv).toMatchObject({
      path: "manual",
      envSet: "unknown",
      envNames: { sourceKey: "INFINITE_SITE_SOURCE_KEY", secret: "INFINITE_SERVER_EVENT_SECRET" },
      publicKey: "site_fromflag1",
      statusRefusal: { code: "desktop_update_required" },
      written: [],
      // No status seam → no receipt check ran; the row still refuses to read as a bare "installed".
      firstEvent: { state: "not_checked" }
    })
    const err = io.errLines.join("\n")
    expect(err).toContain("update the Infinite app")
    expect(err).toContain("INFINITE_SITE_SOURCE_KEY=site_fromflag1")
    expect(err).toContain("INFINITE_SERVER_EVENT_SECRET=<secret>   get it in Infinite → Connections → Website → Set them yourself → Reveal secret (or Infinite → Site Analytics → Settings → Conversions → Server events)")
    expect(err).toContain("The secret is an env var only — never paste the secret into chat, messages, or your repo.")
    expect(err).toContain("Add both to your PRODUCTION environment, then redeploy.")
    const row = parsed.providers.find((state) => state.provider === "server_lane")!
    expect(row).toMatchObject({ state: "installed", verification: { kind: "awaiting_first_event", envSet: "unknown" } })
    expect(parsed.nextSteps.join("\n")).toContain("on your PRODUCTION deployment, then redeploy")
  })

  it("a cloud 404 not_linked through the bridge says sign in — not 'update the Infinite app'", async () => {
    const root = octoberRepo()
    const bridge = new DesktopServerLaneBridge({
      bridgeUrl: "http://127.0.0.1:5000",
      token: "bridge_tok",
      fetch: (async () => new Response(JSON.stringify({ error: "not_linked", message: "Not linked" }), { status: 404 })) as unknown as typeof fetch
    })
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs([...APPLY, "--root", root]), io, deps(bridge))
    expect(result.report.serverLaneEnv?.statusRefusal).toMatchObject({ code: "not_linked" })
    expect(io.outLines.join("\n")).toContain("sign in to the Infinite app")
    expect(io.outLines.join("\n")).not.toContain("update the Infinite app")
  })

  it("no Infinite app at all (standalone infinite-tag harness): PATH A, and the row never reads as a bare 'installed'", async () => {
    const root = octoberRepo()
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs([...APPLY, "--root", root]), io, deps(undefined))
    expect(result.report.serverLaneEnv).toMatchObject({ path: "manual", statusRefusal: { code: "no_desktop" } })
    expect(io.outLines.join("\n")).toContain("Open it and re-run `infinite analytics`")
    expect(io.outLines.join("\n")).toMatch(/server_lane\s+installed — waiting for the first event \(env set: unknown\)/)
  })

  it("no hosting connection and no local link: PATH A with the connect-Vercel hint; nothing minted", async () => {
    const root = octoberRepo()
    const bridge = fakeBridge({ statuses: [{ ok: true, value: laneStatus({ laneState: "awaiting_first_event", secretSetAt: "2026-09-02T00:00:00.000Z" }) }] })
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs([...APPLY, "--root", root]), io, deps(bridge))
    expect(bridge.calls.map((call) => call.route)).toEqual(["status"])
    expect(result.report.serverLaneEnv?.attempts).toEqual([{ path: "local_vercel", outcome: "unavailable", code: "not_linked" }])
    const out = io.outLines.join("\n")
    expect(out).toContain("INFINITE_SITE_SOURCE_KEY=site_public123")
    expect(out).toContain("connect Vercel in Infinite → Connections → Website")
  })
})
