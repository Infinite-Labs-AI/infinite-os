import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { parseHarnessArgs } from "./args.js"
import { EXIT_ARGS, runHarnessCommand } from "./command.js"
import { PROPOSED_CONVERSIONS_RELATIVE_PATH } from "./marking.js"
import { reportNotSentLine, type HarnessReportPayload, type ReportSink } from "./report-sink.js"
import {
  runHarness,
  type HarnessIo
} from "./run.js"
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

describe("runHarnessCommand argument rule", () => {
  it("non-interactive apply without --conversions or --no-mark exits 2 with INF_ARGS_CONVERSIONS_REQUIRED, even with --yes", async () => {
    const io = fakeIo({ interactive: false })
    const code = await runHarnessCommand(["--yes", "--root", copyFixture("static-html-basic")], { io })
    expect(code).toBe(EXIT_ARGS)
    expect(io.errLines[0]).toContain("inf-error: INF_ARGS_CONVERSIONS_REQUIRED")
    expect(io.errLines[0]).toContain("--yes never approves conversion marking")
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
      ["confirm", "skipped"], ["apply", "skipped"], ["conversions", "skipped"], ["setup-checks", "ok"], ["server-lane", "skipped"], ["server-lane-env", "skipped"], ["verify", "skipped"], ["report", "ok"]
    ])
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
  it("fails honestly without an installation manifest instead of returning a green skipped check", async () => {
    const root = copyFixture("static-html-basic")
    const result = await runHarness(parseHarnessArgs(["--verify-only", "--root", root, "--url", "https://example.com/"]), fakeIo(), {discover: () => null})
    expect(result.exitCode).toBe(1)
    expect(result.report.failure?.code).toBe("INF_VERIFY_INCOMPLETE")
    expect(result.report.failure?.message).toContain("manifest")
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
})

describe("guided consent (Infinite)", () => {
  const infiniteArgs = (root: string, mode: string) => [
    mode, "--root", root, "--workspace", "ws_1",
    "--infinite-site-source-key", "site_public_123",
    "--infinite-production-host", "example.com",
    "--infinite-static-proxy", "vercel"
  ]

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
})

describe("custom build ownership", () => {
  it("allows inspecting generated output but refuses installing into it", async () => {
    const root=copyFixture("static-html-basic")
    write(root,"vercel.json",JSON.stringify({buildCommand:"node build.cjs",outputDirectory:"dist"}))
    const html="<!doctype html><html><head></head><body>Generated</body></html>"
    write(root,"dist/index.html",html)
    const check=await runHarness(parseHarnessArgs(["--check","--root",root,"--app-root","dist"]),fakeIo(),{discover:()=>null})
    expect(check.exitCode).toBe(0)
    expect(check.report.nextSteps.join(" ")).toContain("generated")
    const apply=await runHarness(parseHarnessArgs(["--apply","--yes","--no-mark","--allow-dirty","--workspace","ws_1","--root",root,"--app-root","dist"]),fakeIo(),{discover:()=>null})
    expect(apply.exitCode).toBe(1)
    expect(apply.report.failure?.message).toContain("generated build output")
    expect(readFileSync(join(root,"dist/index.html"),"utf8")).toBe(html)
    expect(existsSync(join(root,".infinite/install.json"))).toBe(false)
  })
})

it("cannot bypass custom build ownership by selecting one source subdirectory", async () => {
  const root=copyFixture("unsupported-basic")
  write(root,"vercel.json",JSON.stringify({buildCommand:"node build.cjs",outputDirectory:"dist"}))
  const html="<!doctype html><html><head></head><body>Auth</body></html>"
  write(root,"get-started/index.html",html)
  const result=await runHarness(parseHarnessArgs(["--plan","--root",root,"--app-root","get-started"]),fakeIo(),{discover:()=>null})
  expect(result.exitCode).toBe(1)
  expect(result.report.failure?.code).toBe("INF_SOURCE_OUTPUT_OWNERSHIP")
  expect(readFileSync(join(root,"get-started/index.html"),"utf8")).toBe(html)
  expect(existsSync(join(root,".infinite/install.json"))).toBe(false)
})
