import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { afterEach, expect, it } from "vitest"
import { sensitivePosthogOptions } from "../install/posthog-sensitive.js"
import { GA4_PAGE_CHANGE_SCRIPT, META_PAGE_CHANGE_SCRIPT } from "../jobs/briefs.js"
import { itemChecksFor } from "../jobs/registry.js"
import { applyResults } from "../jobs/state-machine.js"
import { JOB_TABLE, type ChecklistItem, type CheckResult, type JobId } from "../wizard/contracts/jobs.js"
import { jobStaticCheckFunctions } from "./job-static.js"
import { o9CheckFunctions } from "./o9.js"

const fixture = join(__dirname, "../../test/wizard/fixture-site")
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function site(): string { const root = realpathSync(mkdtempSync(join(tmpdir(), "approved-job-edits-"))); roots.push(root); cpSync(fixture, root, { recursive: true }); return root }
const ctx = { runId: "approved-edits", now: () => new Date("2026-10-07T09:00:00Z") }
function item(id: string, files: string[]): ChecklistItem {
  const [jobId, target] = id.split(":") as [JobId, string]
  return { id, jobId, n: JOB_TABLE[jobId].n, title: "Approved change", state: "claimed", owner: "agent", allow: { files, create: [] }, trigger: { finding: "Approved change", evidence: [] }, checks: itemChecksFor(jobId, target, "next-app-router") }
}

it("verifies the prescribed sensitive-page edit on the main fixture", async () => {
  const root = site()
  const file = "app/providers.tsx"
  const before = readFileSync(join(root, file), "utf8")
  const after = before.replace('"https://us.i.posthog.com" }', `"https://us.i.posthog.com", ${sensitivePosthogOptions(before, ["/login"])} }`)
  writeFileSync(join(root, file), after)
  const job = item("posthog_improve:sensitive_pages", [file])
  const run = () => ({ posthogSensitivePaths: ["/login"] })
  const staticFns = jobStaticCheckFunctions({ root, run })
  const o9 = o9CheckFunctions({ root, version: "test", run, readBaseFile: (_root, path) => path === file ? before : null })
  const input = { item: job, root, appRoot: "." }
  const results = [...await o9.posthog_config(input, ctx) as CheckResult[], ...await staticFns.posthog_improve_applied(input, ctx) as CheckResult[]]
  expect(results.map(result => result.state)).toEqual(["pass", "pass"])
  expect(applyResults(job, results, ctx.runId, { budgetLeft: false }).item.state).toBe("waiting_deploy")
})

it.each(["ga4",] as const)("verifies the supplied %s navigation paste and rejects missing, commented, or misplaced copies", async tool => {
  const root = site()
  const file = "app/layout.tsx"
  const before = readFileSync(join(root, file), "utf8")
  const script = tool === "ga4" ? GA4_PAGE_CHANGE_SCRIPT : META_PAGE_CHANGE_SCRIPT
  const anchor = tool === "ga4" ? "gtag('config', 'G-FAKE00001');" : "fbq('track', 'PageView');"
  const job = item(`${tool}_improve:spa_page_view`, [file])
  const check = jobStaticCheckFunctions({ root, run: () => ({ expect: { ga4: ["G-FAKE00001"] } }) }).spa_page_view_applied
  const input = { item: job, root, appRoot: "." }
  for (const source of [before, before.replace(anchor, `${anchor}\n/*${script}*/`), before.replace(anchor, `${script}\n${anchor}`), before.replace(anchor, `${anchor}\n${script.replace("if (next === last) return;", "")}`)]) {
    writeFileSync(join(root, file), source)
    expect(await check(input, ctx)).toMatchObject([{ state: "problem" }])
  }
  writeFileSync(join(root, file), before.replace(anchor, `${anchor}\n${script}`))
  const results = await check(input, ctx) as CheckResult[]
  expect(results).toMatchObject([{ state: "pass" }])
  expect(applyResults(job, results, ctx.runId, { budgetLeft: false }).item.state).toBe("waiting_deploy")
})

it("the supplied Meta navigation script sends once per changed path and never on its initial load", () => {
  const sent: unknown[][] = []
  const events = new Map<string, () => void>()
  const location = { pathname: "/", search: "" }
  const history = { pushState: () => {}, replaceState: () => {} }
  const window = { fbq: (...args: unknown[]) => sent.push(args), addEventListener: (name: string, fn: () => void) => events.set(name, fn) }
  runInNewContext(META_PAGE_CHANGE_SCRIPT, { window, location, history })
  expect(sent).toEqual([])
  location.pathname = "/pricing"; history.pushState()
  expect(sent).toEqual([["track", "PageView"]])
  history.replaceState()
  expect(sent).toHaveLength(1)
  location.pathname = "/"; events.get("popstate")!()
  expect(sent).toHaveLength(2)
  runInNewContext(META_PAGE_CHANGE_SCRIPT, { window, location, history })
  location.pathname = "/login"; history.pushState()
  expect(sent).toHaveLength(3)
})

