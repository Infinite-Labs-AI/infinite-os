import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { parseHarnessArgs } from "./args.js"
import { EXIT_ARGS, EXIT_FAILED, EXIT_OK, runHarnessCommand } from "./command.js"
import { PROPOSED_CONVERSIONS_RELATIVE_PATH } from "./marking.js"
import { REPORT_SENT_LINE, reportNotSentLine, type HarnessReportPayload, type ReportSink } from "./report-sink.js"
import { INFINITE_PRIVACY_DISCLOSURE_NOTICE, runHarness, type HarnessIo } from "./run.js"
import { HARNESS_REPORT_RELATIVE_PATH } from "./state.js"
import type { VerificationBackend } from "./verify.js"

const tempRoots: string[] = []
const here = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const source = join(here, "../../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `harness-run-${name}-`))
  tempRoots.push(targetRoot)
  const target = join(targetRoot, name)
  cpSync(source, target, { recursive: true })
  return target
}

function write(root: string, relativePath: string, contents: string): void {
  mkdirSync(dirname(join(root, relativePath)), { recursive: true })
  writeFileSync(join(root, relativePath), contents)
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

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
      return answers.length > 0 ? (answers.shift() as boolean) : defaultYes
    }
  }
}

function clock() {
  let current = Date.parse("2026-09-02T10:00:00.000Z")
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms
    }
  }
}

const GTAG = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-EXIST01"></script><script>function gtag(){dataLayer.push(arguments)};gtag('config','G-EXIST01');</script>`

describe("parseHarnessArgs", () => {
  it("defaults to apply with adoption on and parses the teardown flags", () => {
    const args = parseHarnessArgs([
      "--plan", "--providers", "ga4,posthog", "--no-adopt-existing", "--conversions", "c.json", "--server-lane",
      "--url", "https://example.com", "--yes", "--allow-dirty", "--json", "--posthog-query-key", "phx_1", "--workspace", "ws_1"
    ])
    expect(args).toMatchObject({
      mode: "plan", providers: ["ga4", "posthog"], adoptExisting: false, conversions: "c.json", serverLane: true,
      url: "https://example.com", yes: true, allowDirty: true, json: true, posthogQueryKey: "phx_1", workspaceId: "ws_1", noMark: false, brief: false
    })
    expect(parseHarnessArgs([]).mode).toBe("apply")
    expect(parseHarnessArgs(["--no-mark", "--brief"])).toMatchObject({ noMark: true, brief: true })
  })

  it("rejects unknown flags, two modes, and unknown providers", () => {
    expect(() => parseHarnessArgs(["--bogus"])).toThrow(/Unknown argument: --bogus/)
    expect(() => parseHarnessArgs(["--check", "--plan"])).toThrow(/Pick one/)
    expect(() => parseHarnessArgs(["--providers", "ga4,tiktok"])).toThrow(/unknown provider "tiktok"/)
    expect(() => parseHarnessArgs(["--url"])).toThrow(/Missing value for --url/)
  })
})

describe("runHarnessCommand argument rule", () => {
  it("non-interactive apply without --conversions or --no-mark exits 2 with INF_ARGS_CONVERSIONS_REQUIRED, even with --yes", async () => {
    const io = fakeIo({ interactive: false })
    const code = await runHarnessCommand(["--yes", "--root", copyFixture("static-html-basic")], { io })
    expect(code).toBe(EXIT_ARGS)
    expect(io.errLines[0]).toContain("inf-error: INF_ARGS_CONVERSIONS_REQUIRED")
    expect(io.errLines[0]).toContain("--yes never approves conversion marking")
  })

  it("does not apply the rule to --check/--plan or to --no-mark", async () => {
    const root = copyFixture("static-html-basic")
    const io = fakeIo({ interactive: false })
    expect(await runHarnessCommand(["--check", "--root", root], { io })).toBe(EXIT_OK)
    expect(await runHarnessCommand(["--plan", "--root", root], { io })).toBe(EXIT_OK)
    expect(io.errLines.some((line) => line.includes("INF_ARGS_CONVERSIONS_REQUIRED"))).toBe(false)
  })

  it("unknown flags exit 2", async () => {
    const io = fakeIo()
    expect(await runHarnessCommand(["--nope"], { io })).toBe(EXIT_ARGS)
  })
})

describe("runHarness --check", () => {
  it("prints all seven providers, adopts the existing gtag, writes nothing", async () => {
    const root = copyFixture("static-html-basic")
    write(root, "index.html", `<!doctype html><html><head>${GTAG}</head><body><a href="/go">Go</a></body></html>`)
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs(["--check", "--root", root, "--ga4-measurement-id", "G-NEW00001"]), io, { discover: () => null })
    expect(result.exitCode).toBe(0)
    const table = io.outLines.join("\n")
    for (const provider of ["ga4", "gtm", "posthog", "meta", "x", "infinite", "server_lane"]) expect(table).toContain(provider)
    expect(table).toMatch(/ga4\s+adopted, not ours to verify\s+G-EXIST01\s+index\.html/)
    expect(table).toMatch(/posthog\s+skipped/)
    expect(existsSync(join(root, HARNESS_REPORT_RELATIVE_PATH))).toBe(false)
    expect(existsSync(join(root, PROPOSED_CONVERSIONS_RELATIVE_PATH))).toBe(false)
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain(GTAG)
    expect(result.report.steps.map((step) => [step.id, step.status])).toEqual([
      ["preflight", "ok"], ["inspect", "ok"], ["resolve-keys", "ok"], ["classify", "ok"], ["plan", "ok"],
      ["confirm", "skipped"], ["apply", "skipped"], ["conversions", "skipped"], ["server-lane", "skipped"], ["verify", "skipped"], ["report", "ok"]
    ])
  })

  it("shows a provider infinite-tag already installed as installed, with the manifest as evidence", async () => {
    const root = copyFixture("static-html-basic")
    await runHarness(parseHarnessArgs(["--apply", "--yes", "--no-mark", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1"]), fakeIo(), { discover: () => null })
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs(["--check", "--root", root]), io, { discover: () => null })
    expect(result.exitCode).toBe(0)
    expect(io.outLines.join("\n")).toMatch(/ga4\s+installed\s+—\s+\.infinite\/install\.json/)
  })

  it("halts with INF_DETECT_NO_FRAMEWORK on an unsupported repo and still prints the table", async () => {
    const root = copyFixture("unsupported-basic")
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs(["--check", "--root", root]), io, { discover: () => null })
    expect(result.exitCode).toBe(1)
    expect(result.report.failure).toMatchObject({ code: "INF_DETECT_NO_FRAMEWORK", next: "halt" })
    expect(io.outLines.join("\n")).toMatch(/server_lane\s+absent/)
  })
})

describe("runHarness --plan", () => {
  it("writes the proposal and REPORT.md, marks nothing, installs nothing", async () => {
    const root = copyFixture("static-html-basic")
    write(root, "index.html", `<!doctype html><html><head></head><body><a href="/signup">Start</a><button>Go</button></body></html>`)
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs(["--plan", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1"]), io, { discover: () => null })
    expect(result.exitCode).toBe(0)
    expect(result.report.conversions).toEqual({ proposed: 2, marked: 0, skipped: 0, stale: 0 })
    expect(JSON.parse(readFileSync(join(root, PROPOSED_CONVERSIONS_RELATIVE_PATH), "utf8")).rows).toHaveLength(2)
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(PROPOSED_CONVERSIONS_RELATIVE_PATH)
    expect(readFileSync(join(root, HARNESS_REPORT_RELATIVE_PATH), "utf8")).toContain("| ga4 | absent |")
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(false)
    expect(readFileSync(join(root, "index.html"), "utf8")).not.toContain("data-analytics-cta-id")
    expect(io.outLines.join("\n")).toContain("Paste this to your agent:")
  })
})

describe("runHarness reportSink", () => {
  function captureSink(result: { sent: true } | { sent: false; reason: string } = { sent: true }) {
    const payloads: HarnessReportPayload[] = []
    const sink: ReportSink = { name: "capture", send: async (payload) => { payloads.push(payload); return result } }
    return { sink, payloads }
  }

  it("sends the state table after the report step and prints the sent line", async () => {
    const root = copyFixture("static-html-basic")
    write(root, "index.html", `<!doctype html><html><head>${GTAG}</head><body><a href="/go">Go</a></body></html>`)
    const { sink, payloads } = captureSink()
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs(["--plan", "--root", root, "--workspace", "proj_1"]), io, { discover: () => null, reportSink: sink })
    expect(result.exitCode).toBe(0)
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({ engineProjectId: "proj_1", ranAt: result.report.startedAt, framework: "static-html", hosting: result.report.hosting })
    expect(payloads[0].providers.ga4).toMatchObject({ state: "adopted", evidenceFile: "index.html", verification: { state: "adopted_not_ours" } })
    expect(Object.keys(payloads[0].providers)).toHaveLength(7)
    expect(JSON.stringify(payloads[0])).not.toContain(root)
    expect(io.outLines).toContain(REPORT_SENT_LINE)
  })

  it("--check never reports, and a failed send never fails the run", async () => {
    const root = copyFixture("static-html-basic")
    const { sink, payloads } = captureSink({ sent: false, reason: "the cloud was unreachable" })
    const checkIo = fakeIo()
    const check = await runHarness(parseHarnessArgs(["--check", "--root", root, "--workspace", "proj_1"]), checkIo, { discover: () => null, reportSink: sink })
    expect(check.exitCode).toBe(0)
    expect(payloads).toHaveLength(0)
    expect(checkIo.outLines.join("\n")).not.toContain("Report")

    const planIo = fakeIo()
    const plan = await runHarness(parseHarnessArgs(["--plan", "--root", root, "--workspace", "proj_1", "--json"]), planIo, { discover: () => null, reportSink: sink })
    expect(plan.exitCode).toBe(0)
    expect(payloads).toHaveLength(1)
    // --json: stdout is still exactly one document; the not-sent line rides stderr.
    expect(() => JSON.parse(planIo.outLines.join("\n"))).not.toThrow()
    expect(planIo.errLines).toContain(reportNotSentLine("the cloud was unreachable"))
  })

  it("a run that halted before inspecting sends nothing — seven unobserved rows are not a report", async () => {
    const root = copyFixture("unsupported-basic")
    const { sink, payloads } = captureSink()
    const io = fakeIo()
    await runHarness(parseHarnessArgs(["--plan", "--root", root, "--workspace", "proj_1"]), io, { discover: () => null, reportSink: sink })
    expect(payloads).toHaveLength(0)
    expect(io.outLines).toContain(reportNotSentLine("the run did not reach the report step"))
  })
})

describe("runHarness --plan --conversions", () => {
  it("validates the file, marks nothing, and leaves the tree clean", async () => {
    const root = copyFixture("static-html-basic")
    write(root, "index.html", `<!doctype html>\n<html>\n<head></head>\n<body>\n<a href="/signup">Start</a>\n</body>\n</html>\n`)
    const { execSync } = await import("node:child_process")
    execSync("git init -q && git add . && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: root })
    await runHarness(parseHarnessArgs(["--plan", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1"]), fakeIo(), { discover: () => null })
    const result = await runHarness(parseHarnessArgs(["--plan", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1", "--conversions", PROPOSED_CONVERSIONS_RELATIVE_PATH]), fakeIo(), { discover: () => null })
    expect(result.exitCode).toBe(0)
    expect(result.report.conversions).toEqual({ proposed: 1, marked: 0, skipped: 0, stale: 0 })
    expect(readFileSync(join(root, "index.html"), "utf8")).not.toContain("data-analytics-cta-id")
    const status = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean)
    expect(status.every((line) => line.includes(".infinite/") || line.includes(".gitignore"))).toBe(true)
  })
})

describe("runHarness --json", () => {
  it("emits exactly one JSON document on stdout in apply mode; narration goes to stderr", async () => {
    const root = copyFixture("static-html-basic")
    write(root, "index.html", `<!doctype html>\n<html>\n<head></head>\n<body>\n<a href="/signup">Start</a>\n</body>\n</html>\n`)
    const io = fakeIo({ interactive: true, answers: [false] })
    const result = await runHarness(parseHarnessArgs(["--apply", "--yes", "--json", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1"]), io, { discover: () => null })
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(io.outLines.join("\n")) as { providers: unknown[]; mode: string }
    expect(parsed.mode).toBe("apply")
    expect(parsed.providers).toHaveLength(7)
    expect(io.errLines.join("\n")).toContain("Infinite OS · analytics installer")
    expect(io.errLines.join("\n")).toContain("Proposed conversions")
  })
})

describe("runHarness --verify-only", () => {
  it("reads back every server-lane mode a manifest can record, not only Next middleware", async () => {
    const root = copyFixture("vite-react-basic")
    write(root, ".infinite/install.json", JSON.stringify({
      workspaceId: "ws_1", appRoot: ".", framework: "vite-react", providers: ["ga4"], files: [], envKeys: [], contentHashes: {},
      serverLane: { mode: "vercel-middleware", created: ["lib/infinite-server-lane.ts", "lib/infinite-outcome.ts", "middleware.ts"], brief: "INSTALL-SERVER-LANE.md" },
      wiringVersion: 1, verifiedAt: null
    }))
    const backend: VerificationBackend = {
      name: "stub", lanes: ["ga4", "posthog", "infinite", "meta", "server_lane"],
      verify: async (input) => Object.fromEntries(input.lanes.map((lane) => [lane, { state: "verified" as const, receiptAt: "2026-09-02T10:00:04.000Z" }]))
    }
    const io = fakeIo()
    const result = await runHarness(
      parseHarnessArgs(["--verify-only", "--root", root, "--url", "https://example.com/"]),
      io,
      { discover: () => null, backends: [backend], fetch: (async () => new Response("", { status: 200 })) as unknown as typeof fetch, ...clock(), budgetMs: 3_000, pollIntervalMs: 3_000 }
    )
    expect(result.report.failures).toEqual([])
    const lane = result.report.providers.find((state) => state.provider === "server_lane")
    expect(lane?.state).toBe("verified")
    expect(lane?.evidence).toBe("middleware.ts")
    expect(result.report.steps.find((step) => step.id === "verify")?.note).toContain("server_lane=verified")
  })
})

describe("runHarness --apply", () => {
  it("installs, marks approved conversions, and reports installed / not verifiable with NoneBackend", async () => {
    const root = copyFixture("static-html-basic")
    write(root, "index.html", `<!doctype html>\n<html>\n<head></head>\n<body>\n<a href="/signup">Start</a>\n</body>\n</html>\n`)
    const planIo = fakeIo()
    await runHarness(parseHarnessArgs(["--plan", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1"]), planIo, { discover: () => null })

    const io = fakeIo({ interactive: false })
    const time = clock()
    const result = await runHarness(
      parseHarnessArgs(["--apply", "--yes", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1", "--conversions", PROPOSED_CONVERSIONS_RELATIVE_PATH, "--url", "https://example.com/"]),
      io,
      { discover: () => null, fetch: (async () => new Response("<html></html>", { status: 200 })) as unknown as typeof fetch, ...time, budgetMs: 6_000, pollIntervalMs: 3_000 }
    )
    expect(result.exitCode).toBe(0)
    const html = readFileSync(join(root, "index.html"), "utf8")
    expect(html).toContain("G-NEW00001")
    expect(html).toContain('<a data-analytics-cta-id="start" data-analytics-cta-location="index" href="/signup">Start</a>')
    expect(existsSync(join(root, ".infinite/install.json"))).toBe(true)
    expect(existsSync(join(root, ".infinite/conversions.json"))).toBe(true)
    const table = io.outLines.join("\n")
    expect(table).toMatch(/ga4\s+installed, not verifiable \(run infinite analytics from the desktop CLI to verify\)/)
    expect(result.report.providers.find((state) => state.provider === "posthog")?.state).toBe("skipped")
    expect(table).not.toMatch(/ga4\s+verified/)
    expect(result.report.conversions).toEqual({ proposed: 1, marked: 1, skipped: 0, stale: 0 })
    expect(result.report.nextSteps[0]).toContain("GA4 key events")
    expect(readFileSync(join(root, HARNESS_REPORT_RELATIVE_PATH), "utf8")).toContain("## Verify before merging")
    expect(io.questions).toEqual([])
  })

  it("marks verified only with a receipt from a backend and fails INF_VERIFY_NO_RECEIPT otherwise", async () => {
    const root = copyFixture("static-html-basic")
    write(root, "index.html", `<!doctype html>\n<html>\n<head></head>\n<body></body>\n</html>\n`)
    const backend: VerificationBackend = {
      name: "stub",
      lanes: ["ga4", "posthog", "infinite", "meta", "server_lane"],
      verify: async () => ({
        ga4: { state: "verified", receiptAt: "2026-09-02T10:00:04.000Z" },
        posthog: { state: "no_receipt", causes: ["not deployed yet"] }
      })
    }
    const io = fakeIo()
    const result = await runHarness(
      parseHarnessArgs(["--apply", "--yes", "--no-mark", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--posthog-project-key", "phc_abcdefghijklmnop", "--posthog-api-host", "https://us.i.posthog.com", "--workspace", "ws_1", "--url", "https://example.com/"]),
      io,
      { discover: () => null, backends: [backend], fetch: (async () => new Response("", { status: 200 })) as unknown as typeof fetch, ...clock(), budgetMs: 3_000, pollIntervalMs: 3_000 }
    )
    expect(result.exitCode).toBe(1)
    const table = io.outLines.join("\n")
    expect(table).toMatch(/ga4\s+verified \(receipt at 2026-09-02T10:00:04\.000Z\)/)
    expect(table).toMatch(/posthog\s+installed, no receipt/)
    expect(result.report.failure).toMatchObject({ code: "INF_VERIFY_NO_RECEIPT", next: "continue" })
    expect(result.report.failure?.message).toContain("No posthog event arrived within 3s.")
  })

  it("halts with INF_ENV_DIRTY_TREE on a dirty git tree without --allow-dirty", async () => {
    const root = copyFixture("static-html-basic")
    const { execSync } = await import("node:child_process")
    execSync("git init -q && git add . && git -c user.email=t@t -c user.name=t commit -qm init && echo x >> index.html", { cwd: root })
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs(["--apply", "--yes", "--no-mark", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1"]), io, { discover: () => null })
    expect(result.exitCode).toBe(1)
    expect(result.report.failure).toMatchObject({ code: "INF_ENV_DIRTY_TREE", next: "halt" })
    expect(result.report.steps[1].status).toBe("not_run")
  })

  it("--plan then --apply --conversions passes the clean-tree gate: the harness's own outputs are not 'dirty'", async () => {
    const root = copyFixture("static-html-basic")
    write(root, "index.html", `<!doctype html>\n<html>\n<head></head>\n<body>\n<a href="/signup">Start</a>\n</body>\n</html>\n`)
    const { execSync } = await import("node:child_process")
    execSync("git init -q && git add . && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: root })
    await runHarness(parseHarnessArgs(["--plan", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1"]), fakeIo(), { discover: () => null })
    expect(execSync("git status --porcelain", { cwd: root, encoding: "utf8" })).toContain(".infinite/")

    const io = fakeIo()
    const result = await runHarness(
      parseHarnessArgs(["--apply", "--yes", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1", "--conversions", PROPOSED_CONVERSIONS_RELATIVE_PATH]),
      io,
      { discover: () => null }
    )
    expect(result.report.failures).toEqual([])
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain('data-analytics-cta-id="start"')
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain("G-NEW00001")
  })

  it("interactive apply asks for marking separately and never lets --yes approve it", async () => {
    const root = copyFixture("static-html-basic")
    write(root, "index.html", `<!doctype html>\n<html>\n<head></head>\n<body>\n<a href="/signup">Start</a>\n</body>\n</html>\n`)
    const io = fakeIo({ interactive: true, answers: [false] })
    const result = await runHarness(parseHarnessArgs(["--apply", "--yes", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1"]), io, { discover: () => null })
    expect(result.exitCode).toBe(0)
    expect(io.questions).toEqual(["Mark these 1 elements now? [y/N] "])
    expect(readFileSync(join(root, "index.html"), "utf8")).not.toContain("data-analytics-cta-id")
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain("G-NEW00001")
  })

  it("--server-lane on Next reports the chosen target as installed; on a static site it is brief only", async () => {
    const next = copyFixture("next-app-router-basic")
    const nextIo = fakeIo()
    const nextResult = await runHarness(parseHarnessArgs(["--apply", "--yes", "--no-mark", "--server-lane", "--root", next, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1"]), nextIo, { discover: () => null })
    expect(nextResult.report.failures).toEqual([])
    const lane = nextResult.report.providers.find((state) => state.provider === "server_lane")
    expect(lane?.state).toBe("installed")
    expect(lane?.reason).toContain("Next.js")
    expect(existsSync(join(next, "INSTALL-SERVER-LANE.md"))).toBe(true)

    const site = copyFixture("static-html-basic")
    const siteIo = fakeIo()
    const siteResult = await runHarness(parseHarnessArgs(["--apply", "--yes", "--no-mark", "--server-lane", "--root", site, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1"]), siteIo, { discover: () => null })
    const siteLane = siteResult.report.providers.find((state) => state.provider === "server_lane")
    expect(siteLane?.state).toBe("skipped")
    expect(siteLane?.reason).toContain("brief only")
  })

  it("a lane whose entry is not ours to edit is not 'installed': module written, entry manual", async () => {
    const root = copyFixture("vite-react-basic")
    write(root, "vercel.json", `{}`)
    write(root, "middleware.ts", `export default function middleware() {}\n`)
    const io = fakeIo()
    const result = await runHarness(parseHarnessArgs(["--apply", "--yes", "--no-mark", "--server-lane", "--root", root, "--ga4-measurement-id", "G-NEW00001", "--workspace", "ws_1", "--infinite-static-proxy", "vercel"]), io, { discover: () => null })
    const lane = result.report.providers.find((state) => state.provider === "server_lane")
    expect(lane?.state).not.toBe("installed")
    expect(lane?.reason).toContain("entry manual")
    expect(lane?.evidence).toBe("middleware.ts")
    expect(readFileSync(join(root, "middleware.ts"), "utf8")).toBe(`export default function middleware() {}\n`)
    expect(result.report.steps.find((step) => step.id === "verify")?.status).toBe("skipped")
  })

  it("runHarnessCommand maps a halting failure to exit 1 and an inf-error line", async () => {
    const root = copyFixture("unsupported-basic")
    const io = fakeIo()
    expect(await runHarnessCommand(["--apply", "--no-mark", "--root", root], { io, deps: { discover: () => null } })).toBe(EXIT_FAILED)
    expect(io.errLines.at(-1)).toContain("inf-error: INF_DETECT_NO_FRAMEWORK")
  })
})

describe("infinite-tag harness dispatch", () => {
  it("routes `harness` through the harness parser and help mentions it", async () => {
    const { runCli } = await import("../cli.js")
    const logSpy = (await import("vitest")).vi.spyOn(console, "log").mockImplementation(() => {})
    const errSpy = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await runCli(["help"])
      const help = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
      expect(help).toContain("harness")
      expect(help).toContain("--conversions <file>")
      expect(help).toContain("INF_ARGS_CONVERSIONS_REQUIRED")
    } finally {
      logSpy.mockRestore()
      errSpy.mockRestore()
    }
    // Unknown harness flags exit 2 through the harness parser, not the installer's.
    const originalWrite = process.stderr.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      expect(await runCli(["harness", "--bogus"])).toBe(EXIT_ARGS)
    } finally {
      process.stderr.write = originalWrite
    }
  })
})

describe("guided consent (Infinite)", () => {
  const infiniteArgs = (root: string, mode: string) => [
    mode, "--root", root, "--workspace", "ws_1",
    "--infinite-site-source-key", "site_public_123",
    "--infinite-production-host", "example.com",
    "--infinite-static-proxy", "vercel"
  ]

  it("interactive plan ASKS a consent choice instead of dead-ending on a raw blocker", async () => {
    const root = copyFixture("static-html-basic")
    const io = fakeIo({ interactive: true, answers: [false] }) // not gated → not_required
    const result = await runHarness(parseHarnessArgs(infiniteArgs(root, "--plan")), io, { discover: () => null })
    expect(io.questions.some((q) => q.toLowerCase().includes("consent banner"))).toBe(true)
    expect(result.report.steps.find((s) => s.id === "plan")?.status).toBe("ok")
    expect(result.report.failures).toEqual([])
  })

  it("non-interactive guides with INF_CONSENT_REQUIRED naming both flags, and never silently collects", async () => {
    const root = copyFixture("static-html-basic")
    const io = fakeIo({ interactive: false })
    const result = await runHarness(parseHarnessArgs(infiniteArgs(root, "--plan")), io, { discover: () => null })
    expect(io.errLines.some((l) => l.includes("INF_CONSENT_REQUIRED"))).toBe(true)
    expect(io.errLines.join("\n")).toContain("--infinite-consent-mode not-required")
    expect(io.errLines.join("\n")).toContain("--infinite-consent-mode required")
    // The plan still guards: with no decision it does not proceed to install.
    expect(result.report.steps.find((s) => s.id === "plan")?.status).toBe("failed")
  })

  it("interactive apply records the chosen mode in the written runtime", async () => {
    const root = copyFixture("static-html-basic")
    const io = fakeIo({ interactive: true, answers: [true, true, false] }) // gate=required, install=yes, mark=no
    const result = await runHarness(parseHarnessArgs([...infiniteArgs(root, "--apply"), "--url", "https://example.com/"]), io, {
      discover: () => null,
      fetch: (async () => new Response("<html></html>", { status: 200 })) as unknown as typeof fetch,
      ...clock(),
      budgetMs: 3_000,
      pollIntervalMs: 3_000
    })
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain('"mode":"required"')
  })

  it("an explicit --infinite-consent-mode skips the prompt entirely", async () => {
    const root = copyFixture("static-html-basic")
    const io = fakeIo({ interactive: true, answers: [] })
    const result = await runHarness(
      parseHarnessArgs([...infiniteArgs(root, "--plan"), "--infinite-consent-mode", "not-required"]),
      io,
      { discover: () => null }
    )
    expect(io.questions.some((q) => q.toLowerCase().includes("consent banner"))).toBe(false)
    expect(result.report.steps.find((s) => s.id === "plan")?.status).toBe("ok")
  })
})

describe("server-side checkout detection (harness)", () => {
  it("surfaces the checkout_started + purchase recommendation in --plan next steps and the proposal", async () => {
    const root = copyFixture("next-pages-router-basic")
    write(root, "pages/api/stripe-checkout.ts", "export default async function h(){ await stripe.checkout.sessions.create({}) }\n")
    write(root, "pages/api/stripe-webhook.ts", "export default function h(req){ const e = stripe.webhooks.constructEvent(req.body, sig, sk); if(e.type==='checkout.session.completed'){} }\n")
    const io = fakeIo({ interactive: false })
    const result = await runHarness(
      parseHarnessArgs(["--plan", "--root", root, "--workspace", "ws_1", "--ga4-measurement-id", "G-NEW00001"]),
      io,
      { discover: () => null }
    )
    const nextSteps = result.report.nextSteps.join("\n")
    expect(nextSteps).toContain("checkout_started")
    expect(nextSteps).toContain("purchase")
    expect(nextSteps).toContain("pages/api/stripe-checkout.ts")
    const proposal = JSON.parse(readFileSync(join(root, PROPOSED_CONVERSIONS_RELATIVE_PATH), "utf8"))
    expect(proposal.serverCheckout?.code).toBe("INF_CHECKOUT_SERVER_SIDE")
  })

  it("recommends the funnel identity merge and post-response capture on the detected checkout→webhook pair", async () => {
    const root = copyFixture("next-pages-router-basic")
    write(root, "pages/api/stripe-checkout.ts", "export default async function h(){ await stripe.checkout.sessions.create({}) }\n")
    write(root, "pages/api/stripe-webhook.ts", "export default function h(req){ const e = stripe.webhooks.constructEvent(req.body, sig, sk); if(e.type==='checkout.session.completed'){} }\n")
    const io = fakeIo({ interactive: false })
    const result = await runHarness(
      parseHarnessArgs(["--plan", "--root", root, "--workspace", "ws_1", "--ga4-measurement-id", "G-NEW00001"]),
      io,
      { discover: () => null }
    )
    const nextSteps = result.report.nextSteps.join("\n")
    expect(nextSteps).toContain("INF_FUNNEL_IDENTITY_MERGE")
    expect(nextSteps).toContain("$anon_distinct_id")
    expect(nextSteps).toContain("INF_FUNNEL_CAPTURE_AFTER_RESPONSE")
    // Surfaced in the written report too.
    const report = readFileSync(join(root, HARNESS_REPORT_RELATIVE_PATH), "utf8")
    expect(report).toContain("INF_FUNNEL_IDENTITY_MERGE")
    expect(report).toContain("INF_FUNNEL_CAPTURE_AFTER_RESPONSE")
  })
})

describe("privacy disclosure reminder (Infinite install)", () => {
  const infiniteArgs = (root: string, mode: string) => [
    mode, "--root", root, "--workspace", "ws_1",
    "--infinite-site-source-key", "site_public_123",
    "--infinite-production-host", "example.com",
    "--infinite-static-proxy", "vercel",
    "--infinite-consent-mode", "not-required"
  ]

  it("reminds the user to disclose Infinite in their privacy policy when Infinite is being installed", async () => {
    const root = copyFixture("static-html-basic")
    const io = fakeIo({ interactive: false })
    const result = await runHarness(parseHarnessArgs(infiniteArgs(root, "--plan")), io, { discover: () => null })
    expect(result.report.nextSteps).toContain(INFINITE_PRIVACY_DISCLOSURE_NOTICE)
    expect(INFINITE_PRIVACY_DISCLOSURE_NOTICE).toContain("INF_PRIVACY_DISCLOSURE")
    expect(INFINITE_PRIVACY_DISCLOSURE_NOTICE).toContain("visit key that rotates every 30 minutes")
    expect(INFINITE_PRIVACY_DISCLOSURE_NOTICE).toContain("raw IP address and full user agent stay server-side")
    // Surfaced in the written report's checklist.
    const report = readFileSync(join(root, HARNESS_REPORT_RELATIVE_PATH), "utf8")
    expect(report).toContain("INF_PRIVACY_DISCLOSURE")
  })

  it("does NOT remind about disclosure when no Infinite source is being installed", async () => {
    const root = copyFixture("static-html-basic")
    write(root, "index.html", `<!doctype html>\n<html>\n<head></head>\n<body>\n<a href="/signup">Start</a>\n</body>\n</html>\n`)
    const io = fakeIo({ interactive: false })
    const result = await runHarness(
      parseHarnessArgs(["--plan", "--root", root, "--workspace", "ws_1", "--ga4-measurement-id", "G-NEW00001"]),
      io,
      { discover: () => null }
    )
    expect(result.report.nextSteps.some((step) => step.includes("INF_PRIVACY_DISCLOSURE"))).toBe(false)
  })
})
