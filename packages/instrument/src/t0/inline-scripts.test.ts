// R4-2 (live run 4): job 5's offline `fbc_capture` check graded the MANAGED page (built from Infinite's keys; Meta was
// not connected, so it had no capture) and said "a landing with an fbclid wrote no _fbc cookie", while production, running
// the agent's `<Script id="meta-fbc-capture">`, wrote `_fbc`. These tests execute the real T0 engine on the page the
// job's files put on the browser.
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { FAKE } from "../../test/wizard/t0-fixtures.js"
import { capturePasteAsWritten } from "../jobs/briefs.js"
import type { CheckResult, ChecklistItem } from "../wizard/contracts/jobs.js"
import { itemT0Scenarios, runItemT0, T0_UNBUILDABLE_PREFIX } from "../wizard/item-t0.js"
import { cookTemplateLiteral, inlineScriptsOf, pageSourceFromFiles } from "./inline-scripts.js"
import { reasonCode, runT0Scenarios } from "./scenarios.js"

const RUN4 = join(__dirname, "../../test/wizard/fixtures/run4")
const merged = readFileSync(join(RUN4, "merged-5e6f3f3/app/layout.tsx"), "utf8")
const base = readFileSync(join(RUN4, "site-b7c8347/app/layout.tsx"), "utf8")
const HOST = "tag-smoke.foundernationtv.com"
const NOW = () => new Date("2026-10-03T20:52:39.000Z")

async function fbcCapture(source: ReturnType<typeof pageSourceFromFiles>): Promise<CheckResult> {
  if (!source.ok) throw new Error(source.reason)
  const results = await runT0Scenarios([{ id: "fbc", checkId: "fbc_capture", params: { productionHost: HOST, source: source.source } }], {}, { runId: FAKE.runId, now: NOW })
  expect(results).toHaveLength(1)
  return results[0]!
}

/** The run-4 layout with Infinite's capture pasted as the brief now gives it, in place of the agent's own script. */
function withManagedCapture(layout: string): string {
  const start = layout.indexOf('        {/* Meta ad-click id (_fbc) capture')
  const pixel = layout.indexOf('        {/* Meta Pixel (added by the marketing agency) */}')
  expect(start).toBeGreaterThan(0)
  expect(pixel).toBeGreaterThan(start)
  return `${layout.slice(0, start)}        ${capturePasteAsWritten("component", "not_required")}\n${layout.slice(pixel)}`
}

describe("cookTemplateLiteral (the engine's own escapes)", () => {
  it("cooks escapes the way a template literal does", () => {
    expect(cookTemplateLiteral("a\\\\s+b")).toBe("a\\s+b")
    expect(cookTemplateLiteral("x\\`y\\${z}")).toBe("x`y${z}")
    expect(cookTemplateLiteral("\\u0041\\x42\\u{43}\\n")).toBe("ABC\n")
    expect(cookTemplateLiteral("line\\\nnext")).toBe("linenext")
  })

  it("negative: a substitution or an engine-rejected escape cannot be known without running the file", () => {
    expect(cookTemplateLiteral("var id = '${process.env.X}'")).toBeNull()
    expect(cookTemplateLiteral("\\08")).toBeNull()
    expect(cookTemplateLiteral("\\xZZ")).toBeNull()
  })
})

describe("inlineScriptsOf: run 4's merged app/layout.tsx", () => {
  it("reads the four inline <Script> bodies in order, cooked, and lists the gtag loader as external", () => {
    const read = inlineScriptsOf("app/layout.tsx", merged)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.scripts.map((script) => script.label)).toEqual(["app/layout.tsx:17", "app/layout.tsx:24", "app/layout.tsx:33", "app/layout.tsx:51"])
    expect(read.externals).toEqual(["https://www.googletagmanager.com/gtag/js?id=G-8YB9G7SJE7"])
    // The guard's `\\s` in the source is `\s` once cooked.
    expect(read.scripts[1]!.code).toContain("replace(/^\\s+|\\s+$/g")
    expect(read.scripts[2]!.code).toContain("var fbc = 'fb.1.' + Date.now() + '.' + fbclid;")
  })

  it("negative: a body holding ${…} is refused with its line, never guessed", () => {
    const read = inlineScriptsOf("app/layout.tsx", '<Script id="x">{`fbq("init", "${PIXEL}")`}</Script>')
    expect(read).toEqual({ ok: false, reason: expect.stringContaining("app/layout.tsx:1") })
  })

  it("reads dangerouslySetInnerHTML literals and an HTML page's own scripts", () => {
    expect(inlineScriptsOf("app/a.tsx", '<script dangerouslySetInnerHTML={{ __html: "window.a = 1" }} />')).toMatchObject({ ok: true, scripts: [{ code: "window.a = 1" }] })
    expect(inlineScriptsOf("index.html", '<script src="/x.js"></script><script type="application/ld+json">{}</script><script>window.b=2</script>')).toMatchObject({
      ok: true,
      scripts: [{ code: "window.b=2", label: "index.html:1" }],
      externals: ["/x.js"]
    })
  })
})

describe("R4-2: fbc_capture grades the page the job's files put on the browser", () => {
  it("run 4's merged layout WRITES _fbc (never the live false negative 'wrote no _fbc cookie'); its first-click-wins script is named for what it is", async () => {
    const result = await fbcCapture(pageSourceFromFiles([{ file: "app/layout.tsx", source: merged }]))
    expect(reasonCode(result)).not.toBe("no_fbc_capture")
    // The agent's own capture never replaces a stored _fbc, so a second ad click is lost: a real problem, named.
    expect(result.state).toBe("problem")
    expect(reasonCode(result)).toBe("fbc_not_last_click")
  })

  it("the capture the brief now hands the agent (Infinite's, escaped for the <Script> body) passes on the same layout", async () => {
    const result = await fbcCapture(pageSourceFromFiles([{ file: "app/layout.tsx", source: withManagedCapture(merged) }]))
    expect(result.state, result.reason).toBe("pass")
  })

  it("negative: the layout before the run (no capture at all) wrote no _fbc", async () => {
    expect(reasonCode(await fbcCapture(pageSourceFromFiles([{ file: "app/layout.tsx", source: base }])))).toBe("no_fbc_capture")
  })
})

describe("R4-2: itemT0Scenarios hands an adopted Meta job ITS page, never the managed one", () => {
  const item = (): ChecklistItem => ({
    id: "meta_improve:capture",
    jobId: "meta_improve",
    n: 5,
    title: "Improve the existing Meta pixel",
    owner: "agent",
    trigger: { finding: "capture", evidence: [{ file: "app/layout.tsx", line: 41 }] },
    allow: { files: ["app/layout.tsx"], create: [] },
    checks: [{ id: "fbc_capture", tier: "T0", state: "not_run" }],
    state: "claimed"
  })
  const fsOf = (text: string) => ({ readText: async () => text })
  const t0 = (scenarios: Parameters<typeof runT0Scenarios>[0]) => runT0Scenarios(scenarios, {}, { runId: FAKE.runId, now: NOW })

  it("the scenario carries the job file's scripts; the real T0 then grades the agent's code", async () => {
    const scenarios = await itemT0Scenarios(item(), [{ checkId: "fbc_capture" }], { productionHost: HOST }, { fs: fsOf(merged), root: "/repo" })
    expect(scenarios[0]!.params.source).toBeDefined()
    const results = await runItemT0({ checks: { t0 } as never }, scenarios, {} as never, { runId: FAKE.runId, at: () => NOW().toISOString() })
    expect(reasonCode(results[0]!)).toBe("fbc_not_last_click")
  })

  it("negative: a file the wizard cannot read without running it is undetermined (never the managed page's verdict)", async () => {
    const scenarios = await itemT0Scenarios(item(), [{ checkId: "fbc_capture" }], { productionHost: HOST }, { fs: fsOf('<Script id="m">{`fbq("init", "${ID}")`}</Script>'), root: "/repo" })
    const results = await runItemT0({ checks: { t0 } as never }, scenarios, {} as never, { runId: FAKE.runId, at: () => NOW().toISOString() })
    expect(results[0]).toMatchObject({ state: "undetermined" })
    expect(results[0]!.reason).toContain(T0_UNBUILDABLE_PREFIX)
    expect(results[0]!.reason).toContain("app/layout.tsx:1")
  })
})
