// Review I1 P1-5: the job table's S checks on an agent's edit. Each check gets a passing edit and the
// failing edit it exists to catch (and an undetermined case where the wizard cannot tell), on a real tree.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { CheckContext, CheckResult, ChecklistItem, JobId } from "../wizard/contracts/jobs.js"
import { jobStaticCheckFunctions, type JobStaticCheckId, type JobStaticRunContext } from "./job-static.js"
import { JOB_TABLE } from "../wizard/contracts/jobs.js"
import { RUN3_DIR } from "../../test/wizard/run3-fixture.js"

const RUN3_SITE = join(RUN3_DIR, "site-6d16d8f")

const RUN = "7f3c2a91-b0de-4c55-9a11-23456789abcd"
const ctx: CheckContext = { runId: RUN, now: () => new Date("2026-10-02T10:00:00.000Z") }
const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function site(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "job-static-"))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

function item(jobId: JobId, target: string, files: string[]): ChecklistItem {
  return {
    id: `${jobId}:${target}`,
    jobId,
    n: JOB_TABLE[jobId].n,
    title: "t",
    owner: "agent",
    trigger: { finding: "f", evidence: files.map((file) => ({ file, line: 1 })) },
    allow: { files, create: [] },
    checks: [],
    state: "claimed"
  }
}

async function check(id: JobStaticCheckId, files: Record<string, string>, jobItem: ChecklistItem, run: JobStaticRunContext = {}, base?: Record<string, string | null>): Promise<CheckResult> {
  const root = site(files)
  const fns = jobStaticCheckFunctions({ run: () => run, readBaseFile: (_root, file) => (base ? (base[file] ?? null) : undefined) })
  const raw = await fns[id]({ item: jobItem, root, appRoot: ".", runId: RUN }, ctx)
  const results = Array.isArray(raw) ? raw : [raw]
  expect(results).toHaveLength(1)
  return results[0]!
}

// ---- job 8 ----
const SIGNUP = "app/api/signup/route.ts"
const signupRoute = (body: string) => `import { reportInfiniteOutcome } from "../../../lib/infinite-outcome"\nexport async function POST(req: Request) {\n  const { email } = await req.json()\n  const { data, error } = await supabase.auth.signUp({ email, password: "x" })\n  if (error) return Response.json({ error }, { status: 400 })\n${body}\n  return Response.json({ ok: true })\n}\n`
const GOOD = `  await reportInfiniteOutcome({ type: "sign_up", path: "/signup", eventId: \`signup:\${data.user.id}\` })`
const job8 = item("server_conversions", "signup", [SIGNUP])
const approved = { conversionNames: ["sign_up"] }

describe("job 8: server conversions", () => {
  it("outcome_after_success: after the success branch passes; before it, or in a catch, is a problem; none at all is a problem", async () => {
    expect((await check("outcome_after_success", { [SIGNUP]: signupRoute(GOOD) }, job8)).state).toBe("pass")
    const before = `import { reportInfiniteOutcome } from "x"\nexport async function POST(req) {\n  await reportInfiniteOutcome({ type: "sign_up", eventId: "a" })\n  const { data } = await supabase.auth.signUp({ email: "a", password: "b" })\n}\n`
    expect((await check("outcome_after_success", { [SIGNUP]: before }, job8)).state).toBe("problem")
    const inCatch = signupRoute(`  try { await x() } catch (e) {\n    await reportInfiniteOutcome({ type: "sign_up", eventId: data.user.id })\n  }`)
    expect((await check("outcome_after_success", { [SIGNUP]: inCatch }, job8)).reason).toMatch(/error branch/)
    expect((await check("outcome_after_success", { [SIGNUP]: signupRoute("") }, job8)).state).toBe("problem")
  })

  it("outcome_declared: an approved name passes; another name is a problem; a computed one is undetermined; no plan read is undetermined", async () => {
    expect((await check("outcome_declared", { [SIGNUP]: signupRoute(GOOD) }, job8, approved)).state).toBe("pass")
    expect((await check("outcome_declared", { [SIGNUP]: signupRoute(GOOD.replace('path: "/signup", ', 'properties: { path: "/signup" }, ')) }, job8, approved)).state).toBe("problem")
    expect((await check("outcome_declared", { [SIGNUP]: signupRoute(GOOD.replace('"sign_up"', '"signup_completed"')) }, job8, approved)).state).toBe("problem")
    expect((await check("outcome_declared", { [SIGNUP]: signupRoute(GOOD.replace('"sign_up"', "name")) }, job8, approved)).state).toBe("undetermined")
    expect((await check("outcome_declared", { [SIGNUP]: signupRoute(GOOD) }, job8, {})).state).toBe("undetermined")
  })

  it("event_id_stable: a row id passes; random, time-based, constant or missing ids are problems", async () => {
    expect((await check("event_id_stable", { [SIGNUP]: signupRoute(GOOD) }, job8)).state).toBe("pass")
    for (const id of ["crypto.randomUUID()", "`s:${Date.now()}`", '"signup"']) {
      expect((await check("event_id_stable", { [SIGNUP]: signupRoute(`  await reportInfiniteOutcome({ type: "sign_up", eventId: ${id} })`) }, job8)).state, id).toBe("problem")
    }
    expect((await check("event_id_stable", { [SIGNUP]: signupRoute(`  await reportInfiniteOutcome({ type: "sign_up" })`) }, job8)).reason).toMatch(/no eventId/)
  })

  it("no_pii_in_outcome: a hashed em passes; a raw email anywhere, an unhashed em, or ph is a problem", async () => {
    expect((await check("no_pii_in_outcome", { [SIGNUP]: signupRoute(`  await reportInfiniteOutcome({ type: "sign_up", eventId: data.user.id, adMatch: { em: sha256(email) } })`) }, job8)).state).toBe("pass")
    for (const body of [
      `  await reportInfiniteOutcome({ type: "sign_up", eventId: data.user.id, accountKey: email })`,
      `  await reportInfiniteOutcome({ type: "sign_up", eventId: data.user.id, properties: { email: data.user.email } })`,
      `  await reportInfiniteOutcome({ type: "sign_up", eventId: data.user.id, adMatch: { em: email } })`,
      `  await reportInfiniteOutcome({ type: "sign_up", eventId: data.user.id, adMatch: { ph: "x" } })`
    ]) {
      expect((await check("no_pii_in_outcome", { [SIGNUP]: signupRoute(body) }, job8)).state, body).toBe("problem")
    }
  })
})

// ---- job 9 ----
const LOGIN = "app/login/page.tsx"
const LOGOUT = "app/api/auth/logout/route.ts"
const NAV = "components/nav.tsx"
const login = (identify: string) => `"use client"\nexport function Login() {\n  async function submit() {\n    const { data, error } = await supabase.auth.signInWithPassword({ email, password })\n    if (error) return\n${identify}\n  }\n}\n`
const job9 = item("identify_reset", "auth", [LOGIN, LOGOUT, NAV])

describe("job 9: identify and reset", () => {
  it("identify_on_auth_success: the account id after the login passes; an email, a constant, before the login, or none is a problem", async () => {
    expect((await check("identify_on_auth_success", { [LOGIN]: login("    window.infiniteIdentify(data.user.id)") }, job9)).state).toBe("pass")
    expect((await check("identify_on_auth_success", { [LOGIN]: login("    window.infiniteIdentify(data.user.email)") }, job9)).state).toBe("problem")
    expect((await check("identify_on_auth_success", { [LOGIN]: login('    window.infiniteIdentify("user")') }, job9)).state).toBe("problem")
    const early = `"use client"\nexport function Login() {\n  async function submit() {\n    window.infiniteIdentify(id)\n    await supabase.auth.signInWithPassword({ email, password })\n  }\n}\n`
    expect((await check("identify_on_auth_success", { [LOGIN]: early }, job9)).state).toBe("problem")
    expect((await check("identify_on_auth_success", { [LOGIN]: login("") }, job9)).state).toBe("problem")
  })
})

// ---- jobs 2, 3 ----
describe("jobs 2 and 3: the Next config rewrites and the app shell", () => {
  const proxy: JobStaticRunContext["proxy"] = {
    infinite: { path: "/infinite/ledger", destination: "https://api.ultima.inc/api/analytics/events/collect" },
    posthog: { path: "/ingest", ingestHost: "https://us.i.posthog.com", assetsHost: "https://us-assets.i.posthog.com" }
  }
  const rewriteJob = item("unusual_layout", "next_config_rewrites", ["next.config.mjs"])
  it("next_rewrites_exact: the exact Infinite pair passes; a near miss is a problem; no run facts is undetermined", async () => {
    const good = `const nextConfig = {\n  async rewrites() {\n    return [{ source: "/infinite/ledger", destination: "https://api.ultima.inc/api/analytics/events/collect" }]\n  }\n}\nexport default nextConfig\n`
    expect((await check("next_rewrites_exact", { "next.config.mjs": good }, rewriteJob, { proxy })).state).toBe("pass")
    expect((await check("next_rewrites_exact", { "next.config.mjs": good.replace("/infinite/ledger", "/infinite/ledger/") }, rewriteJob, { proxy })).state).toBe("problem")
    expect((await check("next_rewrites_exact", { "next.config.mjs": good }, rewriteJob, {})).state).toBe("undetermined")
    // Job 3 asks for PostHog's pairs, not Infinite's.
    expect((await check("next_rewrites_exact", { "next.config.mjs": good }, item("posthog_improve", "proxy", ["next.config.mjs"]), { proxy })).state).toBe("problem")
  })
})

// ---- job 1 ----
describe("job 1: the server lane mount", () => {
  const job1 = item("server_lane_mount", "server_ts", ["server.ts", "lib/infinite-server-lane.js"])
  it("mounted before the routes passes; after a route, or not at all, is a problem", async () => {
    const server = (lines: string) => `import express from "express"\nimport { infiniteServerLane } from "./lib/infinite-server-lane.js"\nconst app = express()\n${lines}\napp.listen(3000)\n`
    expect((await check("server_lane_mount_order", { "server.ts": server(`app.use(infiniteServerLane())\napp.get("/", home)`) }, job1)).state).toBe("pass")
    expect((await check("server_lane_mount_order", { "server.ts": server(`app.use(express.static("public"))\napp.use(infiniteServerLane())`) }, job1)).state).toBe("problem")
    expect((await check("server_lane_mount_order", { "server.ts": server(`app.get("/", home)`) }, job1)).state).toBe("problem")
  })
})

// ---- job 12 ----
describe("job 12: the CSP hosts", () => {
  const job12 = item("csp", "next_config_mjs", ["next.config.mjs"])
  const run: JobStaticRunContext = { productionHosts: ["acme-store.com"], expect: { ga4: ["G-ACME000001"] } }
  const config = (policy: string) => `const csp = "${policy}"\nexport default { async headers() { return [{ source: "/(.*)", headers: [{ key: "Content-Security-Policy", value: csp }] }] } }\n`
  const BASE = "default-src 'self'; script-src 'self'; connect-src 'self'"
  const GOOD = "default-src 'self'; script-src 'self' https://www.googletagmanager.com; connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com"
  it("every needed host and nothing broader passes; a missing host, a new *, or a new 'unsafe-inline' is a problem", async () => {
    const base = { "next.config.mjs": config(BASE) }
    expect((await check("csp_hosts", { "next.config.mjs": config(GOOD) }, job12, run, base)).state).toBe("pass")
    expect((await check("csp_hosts", { "next.config.mjs": config(BASE) }, job12, run, base)).reason).toMatch(/googletagmanager/)
    expect((await check("csp_hosts", { "next.config.mjs": config(`${GOOD}; img-src *`) }, job12, run, base)).reason).toMatch(/\*/)
    expect((await check("csp_hosts", { "next.config.mjs": config(GOOD.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")) }, job12, run, base)).reason).toMatch(/unsafe-inline/)
    expect((await check("csp_hosts", { "next.config.mjs": config(GOOD) }, job12, {}, base)).state).toBe("undetermined")
  })
})

it("does not register any privacy-policy check", () => {
  expect(Object.keys(jobStaticCheckFunctions({}))).not.toContain("privacy_names_installed_tools")
  expect(JOB_TABLE.privacy_paragraph.checks).toEqual([])
})

describe("§3x.3 (B3, W4) track_after_success: job 10 sends an outcome where it succeeds, never from its link", () => {
  const SIGNUP_PAGE = "app/signup/page.tsx"
  const run3Page = readFileSync(join(RUN3_SITE, SIGNUP_PAGE), "utf8")
  const job10 = (files: string[] = [SIGNUP_PAGE]) => item("conversions_to_tools", "signup", files)
  const names: JobStaticRunContext = { conversionNames: ["signup"] }

  it("negative: missing, outside the success branch, or after the navigation → problem", async () => {
    expect((await check("track_after_success", { [SIGNUP_PAGE]: run3Page }, job10(), names)).reason).toMatch(/no infiniteTrack\("signup"\)/)
    const onSubmit = run3Page.replace("event.preventDefault()", 'event.preventDefault()\n    infiniteTrack("signup")')
    expect((await check("track_after_success", { [SIGNUP_PAGE]: onSubmit }, job10(), names)).reason).toMatch(/not sent inside its success branch/)
    const after = run3Page.replace('if (response.ok) window.location.assign("/account")', 'if (response.ok) { window.location.assign("/account"); infiniteTrack("signup") }')
    expect((await check("track_after_success", { [SIGNUP_PAGE]: after }, job10(), names)).state).toBe("problem")
    // A name the user did not approve is not the conversion.
    const other = run3Page.replace('if (response.ok) window.location.assign("/account")', 'if (response.ok) { infiniteTrack("lead"); window.location.assign("/account") }')
    expect((await check("track_after_success", { [SIGNUP_PAGE]: other }, job10(), names)).state).toBe("problem")
  })
})

// LF4 close round 2 (P1-1): every job target carries a check that PROVES its change is in the code. At 709c10b a
// download conversion on Next and the mirror job had only checks that pass with nothing of the job in the code, so an
// untouched job was reported "done in code" when the agent's turns ended.
describe("close round 2: the proving checks (pass only with the job's change in the code)", () => {
  const names = { conversionNames: ["download", "signup"] }
  const page = (body: string) => `"use client"\nimport { infiniteTrack } from "../lib/infinite-analytics"\nexport default function Download() {\n  return <button onClick={() => ${body}}>Get the app</button>\n}\n`

  it("conversion_tracked: infiniteTrack(<approved name>) in the job's files passes; none is the change MISSING", async () => {
    const job = item("conversions_to_tools", "download", ["app/download/page.tsx"])
    const tracked = await check("conversion_tracked", { "app/download/page.tsx": page('infiniteTrack("download")') }, job, names)
    expect(tracked).toMatchObject({ state: "pass" })
    const none = await check("conversion_tracked", { "app/download/page.tsx": page("undefined") }, job, names)
    expect(none).toMatchObject({ state: "problem", absent: true })
    expect(none.reason).toMatch(/no infiniteTrack\("download"\)/)
    // Another conversion's call is not this one.
    expect((await check("conversion_tracked", { "app/download/page.tsx": page('infiniteTrack("signup")') }, job, names)).state).toBe("problem")
    // Unknown approved names: undetermined, never a pass.
    expect((await check("conversion_tracked", { "app/download/page.tsx": page('infiniteTrack("download")') }, job, {})).state).toBe("undetermined")
  })

  it("meta_mirror_wired: the job's files call infiniteMetaMirror and fire no standard event straight from the browser", async () => {
    const job = item("meta_improve", "mirror", ["app/checkout/page.tsx"])
    const mirrored = 'import { infiniteMetaMirror } from "../lib/infinite-analytics"\nexport async function done(id: string) {\n  await infiniteMetaMirror("Purchase", id)\n}\n'
    expect(await check("meta_mirror_wired", { "app/checkout/page.tsx": mirrored }, job)).toMatchObject({ state: "pass" })
    const nothing = await check("meta_mirror_wired", { "app/checkout/page.tsx": "export function done() {}\n" }, job)
    expect(nothing).toMatchObject({ state: "problem", absent: true })
    const direct = await check("meta_mirror_wired", { "app/checkout/page.tsx": `${mirrored}export function other() { fbq('track', 'Lead') }\n` }, job)
    expect(direct.state).toBe("problem")
    expect(direct.absent).toBeUndefined()
    expect(direct.reason).toContain("still fires Lead straight from the browser")
  })

  it("NEGATIVE: the checks that pass on code with nothing of the job in it never prove a change; every job that has local checks has a proving one", () => {
    for (const [jobId, spec] of Object.entries(JOB_TABLE)) {
      const local = spec.checks.filter((entry) => ["S", "B", "T0"].includes(entry.tier))
      if (local.length === 0 || jobId === "review_comments") continue
      expect(local.some((entry) => entry.provesChange), jobId).toBe(true)
    }
    const flagged = (jobId: JobId, checkId: string) => JOB_TABLE[jobId].checks.find((entry) => entry.checkId === checkId)?.provesChange === true
    expect(flagged("conversions_to_tools", "no_fbq_standard_on_click")).toBe(false)
    expect(flagged("meta_improve", "meta_event_id_from_helper")).toBe(false)
    expect(flagged("posthog_improve", "posthog_config")).toBe(false)
    expect(flagged("identify_reset", "reset_on_every_signout")).toBe(false)
    expect(flagged("identify_reset", "build")).toBe(false)
  })
})
