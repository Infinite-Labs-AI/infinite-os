// `infinite-tag doctor` end to end (lane O9): a real loopback HTTP server stands in for the customer's
// site, a fixture stands in for Meta's CDN — no test touches the real network. Incidents guarded:
//   • c912fa5 / 21b78ab: live checks hidden for two weeks because a failing step stopped the rest and
//     the summary never said so → every check runs on its own and the summary LEADS with what could
//     not be determined;
//   • d2f1809: the guardrail counted its own visits → every live request carries `Purpose: prefetch`,
//     and the one request meant to be recorded (the server-lane probe) is sent only on request.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FIXED_NOW, fixtureFetch, loopbackSite, type LoopbackSite } from "../../test/wizard/fixture-fetch.js"
import { buildManagedHtmlBlock } from "../frameworks/managed-html.js"
import { buildMetaPixelSnippet } from "../providers/meta.js"
import { buildPostHogBootstrapSnippet } from "../providers/posthog.js"

import { parseDoctorArgs, runDoctorCommand } from "./command.js"
import { DoctorUsageError, renderDoctorText, runDoctor, type DoctorReport } from "./run.js"

const SITE = "https://acme-store.test"
const GA4 = "G-ACME123"
const POSTHOG = "phc_acmeAcmeAcmeAcme0001"
const PIXEL = "111222333444555"

const GA4_SNIPPET = [
  "<script>",
  "window.dataLayer = window.dataLayer || [];",
  "window.gtag = window.gtag || function(){window.dataLayer.push(arguments);};",
  `(function(){ var s = document.createElement('script'); s.async = true; s.src = "https://www.googletagmanager.com/gtag/js?id=${GA4}"; document.head.appendChild(s); })();`,
  "window.gtag('js', new Date());",
  `window.gtag('config', "${GA4}");`,
  "</script>"
].join("\n")

const PAGE = `<!doctype html><html><head><title>Acme</title>${buildManagedHtmlBlock([
  GA4_SNIPPET,
  `<script>${buildPostHogBootstrapSnippet(POSTHOG, "/ingest")}</script>`,
  `<script>${buildMetaPixelSnippet(PIXEL)}</script>`
])}</head><body><h1>Acme</h1></body></html>`

const roots: string[] = []
let site: LoopbackSite
let meta: ReturnType<typeof fixtureFetch>

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-"))
  roots.push(root)
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), contents)
  }
  return root
}

function manifest(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    workspaceId: "wizard:0123456789abcdef",
    appRoot: ".",
    framework: "static-html",
    providers: ["ga4", "posthog", "meta"],
    files: [],
    envKeys: [],
    contentHashes: {},
    wiringVersion: 1,
    verifiedAt: null,
    ...extra
  })
}

/** Site requests go to the loopback server; Meta's CDN to a fixture; anything else fails. */
function composedFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith("https://connect.facebook.net/")) return meta.fetch(url, init)
    return site.fetch(url, init)
  }) as typeof fetch
}

const deps = () => ({ version: "0.12.0-test", now: FIXED_NOW, fetch: composedFetch(), attempts: 1, env: {} })

beforeEach(async () => {
  site = await loopbackSite(SITE, (request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html" })
      response.end(request.method === "HEAD" ? undefined : PAGE)
    } else if (path === "/ingest/static/array.js") {
      response.writeHead(200, { "content-type": "application/javascript" })
      response.end("/* posthog-js */")
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  meta = fixtureFetch({
    [`https://connect.facebook.net/signals/config/${PIXEL}`]: { body: `config.set("${PIXEL}", "x", {});\ninstance.configLoaded("${PIXEL}");` }
  })
})

afterEach(async () => {
  await site.close()
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

const FLAG_IDS = { ga4: [GA4], meta: [PIXEL], posthog: { projectKey: POSTHOG, apiHost: "/ingest" }, infinite: null }

describe("doctor exit codes (§3d.5)", () => {
  it("0 when every check passes, and every live request declared itself a check", async () => {
    const root = repo({ "index.html": PAGE })
    const report = await runDoctor({ root, url: `${SITE}/`, flagIds: FLAG_IDS, probeServerLane: false }, deps())
    expect(report.results.filter((result) => result.state !== "pass" && result.state !== "info")).toEqual([])
    expect(report.exitCode).toBe(0)
    expect(site.requests.length).toBeGreaterThanOrEqual(3)
    for (const request of [...site.requests, ...meta.requests]) expect(request.headers.purpose).toBe("prefetch")
    expect(site.requests.some((request) => request.url.includes("/__infinite_probe/"))).toBe(false)
  })

  it("0 on a GA4-only check: Meta-only static findings are not graded when no Meta id was given (review P2-6)", async () => {
    const root = repo({})
    const report = await runDoctor({ root, url: `${SITE}/`, flagIds: { ga4: [GA4], meta: [], posthog: null, infinite: null }, probeServerLane: false }, deps())
    const clickIds = report.results.filter((result) => result.reason?.includes("INF_SETUP_CLICK_ID_UNDETERMINED"))
    expect(clickIds.map((result) => result.state)).toEqual(["info"])
    expect(report.results.filter((result) => result.state === "problem" || result.state === "undetermined")).toEqual([])
    expect(report.exitCode).toBe(0)
  })

  it("1 when any check finds a problem", async () => {
    const root = repo({ "index.html": PAGE })
    const report = await runDoctor({ root, url: `${SITE}/`, flagIds: { ...FLAG_IDS, meta: ["999888777666555"] }, probeServerLane: false }, deps())
    expect(report.results.find((result) => result.checkId === "meta_live_init")!.state).toBe("problem")
    expect(report.exitCode).toBe(1)
  })

  it("3 when nothing is wrong but something could not be determined (no --url: the live checks did not run)", async () => {
    const root = repo({ "index.html": PAGE })
    const report = await runDoctor({ root, url: null, flagIds: FLAG_IDS, probeServerLane: false }, deps())
    expect(report.results.map((result) => [result.checkId, result.state])).toContainEqual(["live_checks", "undetermined"])
    expect(report.exitCode).toBe(3)
    expect(site.requests).toEqual([])
  })
})

describe("doctor ids", () => {
  it("reads the ids block of .infinite/install.json when no flag is given", async () => {
    const ids = { ga4: [GA4], posthog: { projectKey: POSTHOG, apiHost: "/ingest" }, meta: [PIXEL], infinite: null }
    const root = repo({ "index.html": PAGE, ".infinite/install.json": manifest({ ids }) })
    const report = await runDoctor({ root, url: `${SITE}/`, flagIds: null, probeServerLane: false }, deps())
    expect(report.ids.source).toBe("install.json")
    expect(report.results.find((result) => result.checkId === "ga4_loader_id")!.state).toBe("pass")
    expect(report.exitCode).toBe(0)
  })

  it("refuses to run with no ids at all (never a silent clean)", async () => {
    const root = repo({ "index.html": PAGE, ".infinite/install.json": manifest() })
    await expect(runDoctor({ root, url: `${SITE}/`, flagIds: null, probeServerLane: false }, deps())).rejects.toBeInstanceOf(DoctorUsageError)
  })

  it("flags win over install.json", () => {
    const parsed = parseDoctorArgs(["--expect-ga4", GA4, "--expect-ga4", "G-SECOND1"], "/tmp/x")
    expect(parsed.options.flagIds).toEqual({ ga4: [GA4, "G-SECOND1"], meta: [], posthog: null, infinite: null })
  })
})

describe("the server-lane probe is opt-in", () => {
  const laneManifest = () => manifest({ ids: { ga4: [GA4], posthog: null, meta: [], infinite: null }, serverLane: { mode: "brief" } })

  it("without --probe-server-lane: undetermined (not probed) and no probe request (negative)", async () => {
    const root = repo({ "index.html": PAGE, ".infinite/install.json": laneManifest() })
    const report = await runDoctor({ root, url: `${SITE}/`, flagIds: null, probeServerLane: false }, deps())
    expect(report.results.find((result) => result.checkId === "server_lane_probe")).toMatchObject({ state: "undetermined" })
    expect(report.results.find((result) => result.checkId === "server_lane_probe")!.reason).toContain("not_probed")
    expect(site.requests.some((request) => request.url.includes("/__infinite_probe/"))).toBe(false)
    expect(report.exitCode).toBe(3)
  })

  it("with the flag, linked or not, doctor sends NOTHING (E3: no run-less receipt verb) and says where to look", async () => {
    for (const linkedApp of [() => false, () => true]) {
      const root = repo({ "index.html": PAGE, ".infinite/install.json": laneManifest() })
      const readServerLaneReceipt = vi.fn(async () => ({ state: "verified" as const, reason: null }))
      const report = await runDoctor({ root, url: `${SITE}/`, flagIds: null, probeServerLane: true }, { ...deps(), linkedApp, readServerLaneReceipt })
      const cell = report.results.find((result) => result.checkId === "server_lane_probe")!
      expect(cell).toMatchObject({ state: "undetermined" })
      expect(cell.reason).toContain("not_probed")
      expect(cell.reason).toContain("nothing was sent")
      expect(readServerLaneReceipt).not.toHaveBeenCalled()
    }
    expect(site.requests.some((request) => request.url.includes("/__infinite_probe/"))).toBe(false)
  })
})

describe("doctor command", () => {
  let out: string[]
  let err: string[]
  beforeEach(() => {
    out = []
    err = []
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")))
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void err.push(args.join(" ")))
  })
  afterEach(() => vi.restoreAllMocks())

  it("--json prints the report and returns its exit code", async () => {
    const root = repo({ "index.html": PAGE })
    const code = await runDoctorCommand(
      ["--json", "--root", root, "--url", `${SITE}/`, "--expect-ga4", GA4, "--expect-posthog", POSTHOG, "--posthog-api-host", "/ingest", "--expect-meta", PIXEL],
      deps()
    )
    const report = JSON.parse(out.join("\n")) as DoctorReport
    expect(report.schema).toBe("infinite-tag.doctor.v1")
    expect(code).toBe(report.exitCode)
    expect(code).toBe(0)
  })

  it("--json returns 1 on a problem and 3 when something could not be determined", async () => {
    const root = repo({ "index.html": PAGE })
    const base = ["--json", "--root", root, "--expect-ga4", GA4, "--expect-posthog", POSTHOG, "--posthog-api-host", "/ingest"]
    expect(await runDoctorCommand([...base, "--url", `${SITE}/`, "--expect-meta", "999888777666555"], deps())).toBe(1)
    expect(await runDoctorCommand([...base, "--expect-meta", PIXEL], deps())).toBe(3)
    const reports = out.map((text) => JSON.parse(text) as DoctorReport)
    expect(reports.map((report) => report.exitCode)).toEqual([1, 3])
  })

  it("usage errors exit 2 (and --json still prints JSON)", async () => {
    expect(await runDoctorCommand(["--url", "http://acme.test/"])).toBe(2)
    expect(await runDoctorCommand(["--expect-meta", "1234"])).toBe(2)
    expect(await runDoctorCommand(["--expect-posthog", POSTHOG])).toBe(2)
    expect(await runDoctorCommand(["--frobnicate"])).toBe(2)
    out = []
    expect(await runDoctorCommand(["--json", "--root", repo({})])).toBe(2)
    expect(JSON.parse(out.join("\n"))).toMatchObject({ schema: "infinite-tag.doctor.v1", exitCode: 2, error: { code: "usage" } })
    expect(await runDoctorCommand(["--help"])).toBe(0)
  })

  it("the text report leads with what could not be determined", async () => {
    const root = repo({ "index.html": PAGE })
    const report = await runDoctor({ root, url: null, flagIds: FLAG_IDS, probeServerLane: false }, deps())
    const text = renderDoctorText(report).split("\n")
    expect(text[2]).toMatch(/^1 could not be determined \(did not run or could not tell\) · 0 problems/)
    expect(text.at(-1)).toBe("exit 3")
  })
})
