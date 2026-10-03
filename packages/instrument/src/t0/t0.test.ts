// The T0 engine, executed (lane O6). Every scenario runs the page bytes in the SANDBOXED child (the
// built `dist/src/t0/child.js`), and each has a negative case that must fail on the bad input.
//
// Incidents named here (wf5-PORT-PLAN §4), one test each:
//   - "Preview leak, 5 of 44 PostHog pageviews (9fcbefa)"            → host_matrix
//   - "Two _fbc cookies; the first click shadowed later ones (06b2ce8)" → fbc_capture
//   - "Meta in-app browser wiped web storage" (F24)                    → storage_wiped
//   - "Phantom CompleteRegistrations (22d08d4)"                        → mirror_event_id
//   - "Navigation cut off the Lead /tr (69aa95c), hash raced (c6c69dd)" → navigation_order
//   - "Download button dead for GPC visitors (0df149b)"                → tags_absent
//   - "Parser folded unreadable into absent (b714a65)"                 → a crash/deadline is undetermined
//   - decision 12 (fake click id only on no-send loads)                → fake_click_id
import { createServer } from "node:net"
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  ATTRIBUTION_FIXTURE,
  BROKEN_MIRROR_FIXTURE,
  CTA_FIXTURE,
  DEAD_CTA_FIXTURE,
  FAKE,
  fakeArtifacts,
  guardedPage,
  hostGuardExpression,
  MIRROR_FIXTURE,
  page,
  sensitivePosthogSnippet,
  snippetBody
} from "../../test/wizard/t0-fixtures.js"
import { buildAnalyticsModuleSource } from "../frameworks/managed-files.js"
import { getProviderAdapter } from "../providers/index.js"
import type { InstallPlan } from "../types.js"
import type { CheckResult, T0Scenario } from "../wizard/contracts/jobs.js"
import { decodeNextBootstrap } from "./next-bootstrap.js"
import type { T0Session } from "./protocol.js"
import { runT0Sessions, t0ChildNodeFlags, t0PackageRoot, t0PermissionModelAvailable } from "./run.js"
import { defaultDenyReads, sandboxedSpawn } from "./sandbox.js"
import { clickTestLabel, ga4Hits, hostMatrixRows, reasonCode, runT0Scenarios, T0ScenarioError } from "./scenarios.js"
import { runSession } from "./session.js"

const NOW = () => new Date("2026-10-02T10:00:00.000Z")
const darwin = process.platform === "darwin"

async function t0(scenario: Omit<T0Scenario, "checkId"> & { checkId?: string }, artifacts = fakeArtifacts()): Promise<CheckResult[]> {
  return runT0Scenarios([{ checkId: scenario.id, ...scenario }], artifacts, { runId: FAKE.runId, now: NOW })
}

function only(results: CheckResult[], state?: CheckResult["state"]): CheckResult {
  const main = results.filter((result) => result.state !== "info")
  expect(main).toHaveLength(1)
  if (state) expect(main[0]!.state, main[0]!.reason).toBe(state)
  return main[0]!
}

describe("T0 never runs in the wizard's process", () => {
  const saved = { growth: process.env.GROWTH_OS_HOME, tag: process.env.INFINITE_TAG_MCP_TOKEN }
  beforeEach(() => {
    process.env.GROWTH_OS_HOME = "/tmp/fake-growth-os-home-for-t0"
    process.env.INFINITE_TAG_MCP_TOKEN = "FAKE-TEST-TOKEN-not-a-secret-0000000000000000000"
  })
  afterEach(() => {
    if (saved.growth === undefined) delete process.env.GROWTH_OS_HOME
    else process.env.GROWTH_OS_HOME = saved.growth
    if (saved.tag === undefined) delete process.env.INFINITE_TAG_MCP_TOKEN
    else process.env.INFINITE_TAG_MCP_TOKEN = saved.tag
    delete process.env.T0_PWNED
  })

  // Page code that escapes node:vm the classic way and reports what it can see.
  const escape = page(
    `<script>
      var p = this.constructor.constructor('return process')();
      var keys = Object.keys(p.env);
      navigator.sendBeacon('/leak', JSON.stringify({
        pid: p.pid,
        growth: p.env.GROWTH_OS_HOME || null,
        tag: keys.filter(function (k) { return k.indexOf('INFINITE_TAG_') === 0; }),
        home: p.env.HOME
      }));
      p.env.T0_PWNED = '1';
    </script>`
  )
  const session = (): T0Session => ({ id: "escape", actions: [{ kind: "load", label: "page", url: `https://${FAKE.host}/`, source: escape }] })
  const leaked = (body: string | null) => JSON.parse(body ?? "{}") as { pid: number; growth: string | null; tag: string[]; home: string }

  it("in the child the vm escape is closed: page code cannot reach the child's process, whatever the spelling (review O6-R6)", async () => {
    const outcome = await runT0Sessions([session()])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.sandboxed).toBe(darwin)
    expect(outcome.childPid).not.toBe(process.pid)
    const recording = outcome.response.sessions[0]!
    // The escape threw before the beacon: nothing leaked, the page saw an EvalError.
    expect(recording.requests.find((request) => request.url.endsWith("/leak"))).toBeUndefined()
    expect(recording.actions[0]!.scriptErrors.join(" ")).toMatch(/Code generation from strings disallowed/)
    expect(process.env.T0_PWNED).toBeUndefined()

    const attempts = page(
      `<script>
        var out = {};
        function attempt(name, fn) { try { out[name] = String(fn()); } catch (e) { out[name] = 'threw:' + e.name; } }
        attempt('constructor', function () { return fetch.constructor('return typeof process')(); });
        attempt('spelled', function () { return fetch['const' + 'ructor']('return typeof process')(); });
        attempt('async', function () { return (async function () {}).constructor === Function ? 'own realm' : 'host'; });
        attempt('hostArrayPush', function () { navigator.languages.constructor.prototype.push = function () { return 0; }; return 'patched'; });
        attempt('hostUrl', function () { Object.defineProperty(URL.prototype, 'href', { get: function () { return 'https://forged.invalid/'; } }); return new URL('https://x.test/').href; });
        attempt('ownRealm', function () { Array.prototype.t0Polyfill = function () { return 'ok'; }; return [].t0Polyfill() + eval('1+1'); });
        navigator.sendBeacon('/attempts', JSON.stringify(out));
      </script>`
    )
    const second = await runT0Sessions([{ id: "attempts", actions: [{ kind: "load", label: "page", url: `https://${FAKE.host}/`, source: attempts }] }])
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const seen = JSON.parse(second.response.sessions[0]!.requests.find((request) => request.url.endsWith("/attempts"))!.body ?? "{}") as Record<string, string>
    expect(seen.constructor).toBe("threw:EvalError")
    expect(seen.spelled).toBe("threw:EvalError")
    expect(seen.hostArrayPush).toBe("threw:TypeError")
    // The host URL the recorder resolves with is frozen too.
    expect(seen.hostUrl).toBe("threw:TypeError")
    // The page's OWN realm is untouched: its polyfills and eval still work.
    expect(seen.ownRealm).toBe("ok2")
  })

  it("negative: the same page run IN-PROCESS reaches the wizard's env and pid (why T0 is a hardened child)", async () => {
    const recording = await runSession(session())
    const seen = leaked(recording.requests.find((request) => request.url.endsWith("/leak"))!.body)
    expect(seen.pid).toBe(process.pid)
    expect(seen.growth).toBe("/tmp/fake-growth-os-home-for-t0")
    expect(seen.tag).toContain("INFINITE_TAG_MCP_TOKEN")
    expect(process.env.T0_PWNED).toBe("1")
  })

  it("the child runs with the codegen, frozen-intrinsics and permission-model flags for its Node version", () => {
    expect(t0ChildNodeFlags("/pkg", "22.23.2")).toEqual(["--disallow-code-generation-from-strings", "--frozen-intrinsics", "--permission", "--allow-fs-read=/pkg"])
    expect(t0ChildNodeFlags("/pkg", "23.0.0")).toContain("--permission")
    // negative: before the stable permission model (Node 20, 22.12, 18) only the two realm flags
    for (const version of ["22.12.0", "20.11.1", "18.20.0"]) expect(t0ChildNodeFlags("/pkg", version)).toEqual(["--disallow-code-generation-from-strings", "--frozen-intrinsics"])
    expect(t0PackageRoot("/opt/x/node_modules/infinite-tag/dist/src/t0/child.js")).toBe("/opt/x/node_modules/infinite-tag")
  })

  it.runIf(t0PermissionModelAvailable())("with those flags a Node child can neither write nor read outside the package, even WITHOUT sandbox-exec", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "t0-perm-")))
    writeFileSync(join(dir, "secret"), "FAKE-secret-for-the-permission-test")
    const script = `const fs=require('fs');const r={};try{fs.writeFileSync(${JSON.stringify(join(dir, "planted"))},'x');r.write='written'}catch(e){r.write=e.code}try{fs.readFileSync(${JSON.stringify(join(dir, "secret"))},'utf8');r.read='read'}catch(e){r.read=e.code}process.stdout.write(JSON.stringify(r))`
    const flags = t0ChildNodeFlags("/nonexistent-package-root")
    const hardened = await sandboxedSpawn(process.execPath, ["--no-warnings", ...flags, "-e", script], { denyReads: [], network: false, timeoutMs: 10_000, platform: "linux" })
    expect(JSON.parse(hardened.stdout)).toEqual({ write: "ERR_ACCESS_DENIED", read: "ERR_ACCESS_DENIED" })
    // negative: the same script without the flags writes and reads
    const plain = await sandboxedSpawn(process.execPath, ["-e", script], { denyReads: [], network: false, timeoutMs: 10_000, platform: "linux" })
    expect(JSON.parse(plain.stdout)).toEqual({ write: "written", read: "read" })
  })

  it("page code cannot unhook the recorder: reassigning document.hooks / resolveUrl / ownerDocument does not hide a beacon it set", async () => {
    const unhook = page(
      `<script>
        var noop = function () {};
        try { document.hooks = { onImageSrc: noop, onScriptConnected: noop, onAnchorActivation: noop, onFormSubmission: noop }; } catch (e) {}
        try { document.resolveUrl = function () { return 'about:blank'; }; } catch (e) {}
        var img = document.createElement('img');
        try { Object.defineProperty(img, 'ownerDocument', { value: { hooks: { onImageSrc: noop }, resolveUrl: noop } }); } catch (e) {}
        img.src = 'https://www.facebook.com/tr?id=${FAKE.pixel}&ev=PageView';
        var script = document.createElement('script');
        script.src = '/js/after.js';
        document.head.appendChild(script);
      </script>`
    )
    const outcome = await runT0Sessions([{ id: "unhook", actions: [{ kind: "load", label: "page", url: `https://${FAKE.host}/`, source: unhook }] }])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const urls = outcome.response.sessions[0]!.requests.map((request) => request.url)
    expect(urls).toContain(`https://www.facebook.com/tr?id=${FAKE.pixel}&ev=PageView`)
    expect(urls).toContain(`https://${FAKE.host}/js/after.js`)
  })

  it("a page that forges its own host_matrix by patching the recorder's realm still fails in the child (review O6-R6)", async () => {
    const forge =
      'var F=fetch["const"+"ructor"];var HA=F("return Array")();HA.__h=location.hostname;' +
      "var push=HA.prototype.push;HA.prototype.push=function(){for(var i=0;i<arguments.length;i++){var a=arguments[i];" +
      'if(a&&typeof a.url==="string"&&/google/.test(a.url)&&/(vercel\\.app|localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\.local|netlify\\.app|pages\\.dev)$/.test(HA.__h))return this.length}return push.apply(this,arguments)}'
    const ga4 = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)};gtag("js",new Date());gtag("config","${FAKE.ga4}");`
    const html = `<html><head><script>${forge}</script><script>${ga4}</script><script async src="https://www.googletagmanager.com/gtag/js?id=${FAKE.ga4}"></script></head><body></body></html>`
    const results = await t0({ id: "host_matrix", params: { productionHost: FAKE.host, source: { html } } })
    const main = only(results, "problem")
    expect(reasonCode(main)).toBe("previews_send_data")
    // negative: in-process (no hardening) the same prelude really does hide the preview's GA4 hits.
    // It patches THIS process's Array.prototype.push, so restore it whatever happens.
    const preview = (source: string) => runSession({ id: "forge", actions: [{ kind: "load", label: "preview", url: "https://acme-abc123.vercel.app/", source: { html: source } }] })
    const control = await preview(html.replace(`<script>${forge}</script>`, ""))
    expect(ga4Hits(control).length).toBeGreaterThan(0)
    const originalPush = Array.prototype.push
    try {
      const forged = await preview(html)
      expect(ga4Hits(forged)).toEqual([])
    } finally {
      Array.prototype.push = originalPush
    }
  })

  it.runIf(darwin)("darwin: network off denies even loopback; network on reaches it", async () => {
    const server = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port
    const script = `const s=require('net').connect(${port},'127.0.0.1');s.on('connect',()=>{console.log('connected');process.exit(0)});s.on('error',e=>{console.log(e.code);process.exit(0)})`
    const deny = defaultDenyReads({ homes: [], growthOsHome: null })
    const off = await sandboxedSpawn(process.execPath, ["-e", script], { denyReads: deny.paths, network: false, timeoutMs: 10_000 })
    const on = await sandboxedSpawn(process.execPath, ["-e", script], { denyReads: deny.paths, network: true, timeoutMs: 10_000 })
    server.close()
    expect(off.stdout.trim()).toBe("EPERM")
    expect(on.stdout.trim()).toBe("connected")
  })
})

describe("a T0 crash or deadline is undetermined (test error), never a pass", () => {
  it("a page that never yields hits the deadline", async () => {
    const hang = page("<script>setTimeout(function () { for (;;) {} }, 5);</script>")
    const results = await runT0Scenarios(
      [{ id: "one_runtime_per_page", checkId: "one_runtime_per_page", params: { productionHost: FAKE.host, source: hang } }],
      fakeArtifacts(),
      { runId: FAKE.runId, now: NOW, deadlineMs: 3_000 }
    )
    expect(results).toHaveLength(1)
    expect(results[0]!.state).toBe("undetermined")
    expect(reasonCode(results[0]!)).toBe("test_error")
    expect(results[0]!.reason).toContain("timeout")
  })

  it("a crashed child fails every scenario of the run as test_error", async () => {
    const results = await runT0Scenarios(
      [
        { id: "host_matrix", checkId: "host_matrix", params: { productionHost: FAKE.host } },
        { id: "fbc_capture", checkId: "fbc_capture", params: { productionHost: FAKE.host } }
      ],
      fakeArtifacts(),
      { runId: FAKE.runId, now: NOW, run: async () => ({ ok: false, reason: "crash", detail: "the T0 child exited 70" }) }
    )
    expect(results.map((result) => [result.checkId, result.state, reasonCode(result)])).toEqual([
      ["host_matrix", "undetermined", "test_error"],
      ["fbc_capture", "undetermined", "test_error"]
    ])
  })

  it("a missing child build is reported, not run in-process", async () => {
    const outcome = await runT0Sessions([], { childEntry: "/nonexistent/child.js" })
    expect(outcome).toMatchObject({ ok: false, reason: "not_built" })
  })

  it("bad scenario params throw (a wizard bug), unknown scenario ids too", async () => {
    await expect(t0({ id: "host_matrix", params: {} })).rejects.toBeInstanceOf(T0ScenarioError)
    await expect(t0({ id: "no_such_scenario", params: { productionHost: FAKE.host } })).rejects.toBeInstanceOf(T0ScenarioError)
  })
})

describe("host_matrix (decision 3: deny-list guard, production always fires)", () => {
  it("lists the 13-host matrix plus exempt hosts, deduplicated", () => {
    const rows = hostMatrixRows("acme.com", ["www.acme.com", "acme-git-main-x.vercel.app"])
    expect(rows.map((row) => `${row.host}:${row.expect}`)).toEqual([
      "acme.com:fires",
      "ACME.COM.:fires",
      "www.acme.com:fires",
      "acme-git-main-x.vercel.app:fires",
      "acme-abc123.vercel.app:silent",
      "localhost:silent",
      "127.0.0.1:silent",
      "0.0.0.0:silent",
      "[::1]:silent",
      "app.localhost:silent",
      "foo.local:silent",
      "x.netlify.app:silent",
      "x.pages.dev:silent",
      "staging.acme.com:fires",
      "other.example:fires"
    ])
  })

  it("guarded bytes: production, ACME.com. and an exempt *.vercel.app alias fire; previews stay silent; staging is labelled; the capture still writes on previews", async () => {
    const exempt = [FAKE.host, "acme-store-git-main-acme.vercel.app"]
    const results = await t0({ id: "host_matrix", params: { productionHost: FAKE.host, exempt, source: guardedPage(exempt) } })
    only(results, "pass")
    const info = results.find((result) => result.state === "info")
    expect(reasonCode(info!)).toBe("leaks_deny_list")
    expect(info!.reason).toContain("staging.acme-store.com")
  })

  it("negative: today's unguarded bytes fire on every preview and local host", async () => {
    const result = only(await t0({ id: "host_matrix", params: { productionHost: FAKE.host } }), "problem")
    expect(reasonCode(result)).toBe("previews_send_data")
    for (const host of ["acme-store-abc123.vercel.app", "localhost", "127.0.0.1", "x.netlify.app"]) expect(result.reason).toContain(host)
  })

  it("R22: IPv6 loopback and *.localhost are silent rows; a guard that forgets them fails", async () => {
    // A guard whose deny list lacks [::1] and .localhost (only the older v0 hosts).
    const partial = guardedPage([FAKE.host]).html!.split('"[::1]",').join("").split('".localhost",').join("")
    const result = only(await t0({ id: "host_matrix", params: { productionHost: FAKE.host, source: { html: partial } } }), "problem")
    expect(result.reason).toContain("[::1]: ")
    expect(result.reason).toContain("app.localhost: ")
    // negative: the full deny list passes (the guarded test above)
  })

  it("R7: an INVERTED guard (silent on production, firing on every preview) is a problem, not 'not installed'", async () => {
    const guard = hostGuardExpression([FAKE.host])
    const ga4 = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)};gtag("js",new Date());gtag("config","${FAKE.ga4}");`
    const inverted = page(`<script>(function(){ if (${guard}) return; ${ga4} })();</script><script async src="https://www.googletagmanager.com/gtag/js?id=${FAKE.ga4}"></script>`)
    const result = only(await t0({ id: "host_matrix", params: { productionHost: FAKE.host, source: inverted } }), "problem")
    expect(reasonCode(result)).toBe("previews_send_data")
    expect(result.reason).toContain("acme-store-abc123.vercel.app: ga4 fire")
    // with the tools named (the default page names them from the artifacts), production's silence is named too
    const named = only(await t0({ id: "host_matrix", params: { productionHost: FAKE.host, source: inverted, tools: ["ga4"] } }), "problem")
    expect(named.reason).toContain(`${FAKE.host}: ga4 silent on a host that must fire`)
    // a tool the caller names that never starts anywhere is a production problem, not "not installed"
    const nothing = only(await t0({ id: "host_matrix", params: { productionHost: FAKE.host, source: page(""), tools: ["ga4"] } }), "problem")
    expect(reasonCode(nothing)).toBe("production_silent")
    // negative: a page with no tag and no named tools is still "not installed" (undetermined)
    expect(reasonCode(only(await t0({ id: "host_matrix", params: { productionHost: FAKE.host, source: page("") } }), "undetermined"))).toBe("not_installed")
  })

  it("R23: a vendor loader request alone is not a start; a missing capture has its own code", async () => {
    // gtag.js is requested on every host, but gtag('config') runs only behind the guard: nothing measured on previews.
    const guard = hostGuardExpression([FAKE.host])
    const loaderOutside = page(
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)};(function(){ if (!${guard}) return; gtag("js",new Date()); gtag("config","${FAKE.ga4}"); })();</script><script async src="https://www.googletagmanager.com/gtag/js?id=${FAKE.ga4}"></script>`
    )
    only(await t0({ id: "host_matrix", params: { productionHost: FAKE.host, source: loaderOutside } }), "pass")
    // A capture that is (wrongly) host-guarded: the guard is fine for the tools, the capture is the problem.
    const capture = `(function(){var c=new URLSearchParams(location.search).get('fbclid');if(c)document.cookie='_fbc=fb.1.'+Date.now()+'.'+c+';path=/';})();`
    const ga4 = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)};gtag("js",new Date());gtag("config","${FAKE.ga4}");`
    const guardedCapture = page(
      `<script>(function(){ if (!${guard}) return; ${ga4} })();</script><script async src="https://www.googletagmanager.com/gtag/js?id=${FAKE.ga4}"></script><script>if (${guard}) { ${capture} }</script>`
    )
    const result = only(await t0({ id: "host_matrix", params: { productionHost: FAKE.host, source: guardedCapture } }), "problem")
    expect(reasonCode(result)).toBe("no_fbc_capture")
  })

  it("negative: a guard with no exempt list silences an exempt production alias", async () => {
    const alias = "acme-store-git-main-acme.vercel.app"
    const result = only(await t0({ id: "host_matrix", params: { productionHost: FAKE.host, exempt: [alias], source: guardedPage([FAKE.host]) } }), "problem")
    expect(result.reason).toContain(`${alias}: `)
  })
})

describe("consent_matrix (Infinite's own lanes follow the runtime rule; no banner is touched)", () => {
  it("required and not_required: the runtime and the _fbc capture follow the recorded decision, DNT/GPC and the mode", async () => {
    only(await t0({ id: "consent_matrix", params: { productionHost: FAKE.host } }, fakeArtifacts("required")), "pass")
    only(await t0({ id: "consent_matrix", params: { productionHost: FAKE.host } }, fakeArtifacts("not_required")), "pass")
  })

  it("negative: a capture that ignores consent fails the matrix", async () => {
    const ungated = page(`<script>(function(){var c=new URLSearchParams(location.search).get('fbclid');if(c)document.cookie='_fbc=fb.1.'+Date.now()+'.'+c+';path=/';window.infiniteMetaClickId=function(){return ''};})();</script>`)
    const result = only(await t0({ id: "consent_matrix", params: { productionHost: FAKE.host, consentMode: "required", source: ungated } }), "problem")
    expect(result.reason).toContain("_fbc capture wrote")
  })

  it("a page with neither lane is undetermined, not a pass", async () => {
    only(await t0({ id: "consent_matrix", params: { productionHost: FAKE.host, consentMode: "required", source: page("") } }), "undetermined")
  })
})

describe("fbc_capture (two landings: one cookie, last click wins)", () => {
  it("today's capture keeps one _fbc holding the second click", async () => {
    only(await t0({ id: "fbc_capture", params: { productionHost: FAKE.host } }), "pass")
  })

  it("negative: a first-click-wins writer is caught", async () => {
    const firstWins = page(`<script>(function(){var c=new URLSearchParams(location.search).get('fbclid');if(c&&document.cookie.indexOf('_fbc=')===-1)document.cookie='_fbc=fb.1.'+Date.now()+'.'+c+';domain=acme-store.com;path=/';})();</script>`)
    expect(reasonCode(only(await t0({ id: "fbc_capture", params: { productionHost: FAKE.host, source: firstWins } }), "problem"))).toBe("fbc_not_last_click")
  })

  it("negative: a host-only copy beside the domain cookie is two cookies", async () => {
    const two = page(`<script>(function(){var c=new URLSearchParams(location.search).get('fbclid');if(!c)return;document.cookie='_fbc=fb.1.'+Date.now()+'.'+c+';path=/';document.cookie='_fbc=fb.1.'+Date.now()+'.'+c+';domain=acme-store.com;path=/';})();</script>`)
    expect(reasonCode(only(await t0({ id: "fbc_capture", params: { productionHost: FAKE.host, source: two } }), "problem"))).toBe("two_fbc_cookies")
  })

  it("negative: no capture at all", async () => {
    expect(reasonCode(only(await t0({ id: "fbc_capture", params: { productionHost: FAKE.host, source: page("") } }), "problem"))).toBe("no_fbc_capture")
  })
})

describe("storage_wiped (F24: storage gone, cookies kept, page 2 still attributable)", () => {
  it("first-touch in a cookie + the _fbc capture survive the wipe", async () => {
    const artifacts = fakeArtifacts()
    const source = page(`<script>${ATTRIBUTION_FIXTURE}</script><script>${snippetBody("meta", artifacts).replace(/^<script>|<\/script>$/gi, "")}</script>`)
    only(await t0({ id: "storage_wiped", params: { productionHost: FAKE.host, source } }), "pass")
  })

  it("negative: today's bytes keep no campaign in a cookie, so it is lost", async () => {
    const result = only(await t0({ id: "storage_wiped", params: { productionHost: FAKE.host } }), "problem")
    expect(result.reason).toContain("campaign")
    expect(result.reason).not.toContain("_fbc click id did not survive")
  })

  it("negative: attribution kept only in sessionStorage dies with it", async () => {
    const storageOnly = page(`<script>(function(){var c=new URLSearchParams(location.search).get('utm_campaign');if(c)sessionStorage.setItem('ft',c);})();</script>`)
    only(await t0({ id: "storage_wiped", params: { productionHost: FAKE.host, source: storageOnly, expectCampaign: true } }), "problem")
  })
})

describe("fake_click_id (decision 12: the marker never leaves the landing URL and _fbc)", () => {
  it("today's bytes keep the marker out of every request the site makes", async () => {
    only(await t0({ id: "fake_click_id", params: { productionHost: FAKE.host, clickSelectors: ["#t0-cta"] } }), "pass")
  })

  it("negative: a site fetch that forwards the query string is caught (the value is never echoed)", async () => {
    const leak = page(`<script>fetch('/api/visit?from=' + encodeURIComponent(location.search), { method: 'POST' });</script>`)
    const result = only(await t0({ id: "fake_click_id", params: { productionHost: FAKE.host, source: leak } }), "problem")
    expect(reasonCode(result)).toBe("fake_click_id_leaked")
    expect(result.reason).toContain("acme-store.com/api/visit")
    expect(result.reason).not.toContain("INFINITE_TEST_NOT_REAL_")
    expect(JSON.stringify(result.evidence)).not.toContain("INFINITE_TEST_NOT_REAL_")
  })

  it("negative: a raw click id stored at rest is caught", async () => {
    const stored = page(`<script>localStorage.setItem('fbclid', new URLSearchParams(location.search).get('fbclid'));</script>`)
    expect(only(await t0({ id: "fake_click_id", params: { productionHost: FAKE.host, source: stored } }), "problem").reason).toContain("localStorage")
  })
})

describe("mirror_event_id (D11/D18: only the server's id, once per id)", () => {
  const withMirror = (mirror: string) => page(`<script>${snippetBody("meta", fakeArtifacts()).replace(/^<script>|<\/script>$/gi, "")}</script><script>${mirror}</script>`)

  it("null / empty / absent fire nothing; a real id fires once, verbatim; Purchase is refused", async () => {
    only(await t0({ id: "mirror_event_id", params: { productionHost: FAKE.host, source: withMirror(MIRROR_FIXTURE) } }), "pass")
  })

  it("negative: a mirror that fires on null is a phantom conversion", async () => {
    const result = only(await t0({ id: "mirror_event_id", params: { productionHost: FAKE.host, source: withMirror(BROKEN_MIRROR_FIXTURE) } }), "problem")
    expect(result.reason).toContain("null metaEventId fired fbq")
    expect(result.reason).toContain("Purchase")
  })

  it("no mirror on the page is undetermined (not installed), never a pass", async () => {
    expect(reasonCode(only(await t0({ id: "mirror_event_id", params: { productionHost: FAKE.host } }), "undetermined"))).toBe("not_installed")
  })
})

describe("navigation_order (the conversion request is issued before the page leaves)", () => {
  const withMirror = (mirror: string) => page(`<script>${snippetBody("meta", fakeArtifacts()).replace(/^<script>|<\/script>$/gi, "")}</script><script>${mirror}</script>`)

  it("fbq → navigate; waits for the 50 ms /tr, or the 400 ms budget when it never completes", async () => {
    only(await t0({ id: "navigation_order", params: { productionHost: FAKE.host, source: withMirror(MIRROR_FIXTURE) } }), "pass")
  })

  it("negative: a mirror that does not wait lets the navigation cut the request off", async () => {
    const result = only(await t0({ id: "navigation_order", params: { productionHost: FAKE.host, source: withMirror(BROKEN_MIRROR_FIXTURE) } }), "problem")
    expect(result.reason).toContain("before the /tr request completed")
  })
})

describe("tags_absent (F15: every marked CTA navigates within 1 s with the tags blocked, hung or undefined)", () => {
  it("the click helper with its 1 s backstop navigates in every variant", async () => {
    only(await t0({ id: "tags_absent", params: { productionHost: FAKE.host, bodyHtml: '<a id="cta" href="/download" data-infinite-conversion="download">Get it</a>', source: guardedPage([FAKE.host], `<a id="cta" href="/download" data-infinite-conversion="download">Get it</a><script>${CTA_FIXTURE}</script>`) } }), "pass")
  })

  it("negative: a handler that waits on GA4's callback with no backstop is a dead button", async () => {
    const result = only(await t0({ id: "tags_absent", params: { productionHost: FAKE.host, source: guardedPage([FAKE.host], `<a href="/download" data-infinite-conversion="download">Get it</a><script>${DEAD_CTA_FIXTURE}</script>`) } }), "problem")
    expect(reasonCode(result)).toBe("dead_cta")
  })

  it("no marked CTA in the markup is undetermined", async () => {
    only(await t0({ id: "tags_absent", params: { productionHost: FAKE.host, source: page("") } }), "undetermined")
  })
})

describe("sensitive_pages (D17: replay and autocapture off on sensitive pages, defaults elsewhere)", () => {
  it("the D17 options are set on /login and /checkout and left alone on /", async () => {
    const source = page(`<script>${sensitivePosthogSnippet(["/login", "/checkout"])}</script>`)
    only(await t0({ id: "sensitive_pages", params: { productionHost: FAKE.host, sensitivePaths: ["/login", "/checkout/"], source } }), "pass")
  })

  it("negative: today's PostHog snippet records replay on /login", async () => {
    const result = only(await t0({ id: "sensitive_pages", params: { productionHost: FAKE.host, sensitivePaths: ["/login"] } }), "problem")
    expect(result.reason).toContain("/login: replay ON")
  })

  it("negative: options forced off everywhere lose PostHog's defaults on ordinary pages", async () => {
    const source = page(`<script>${sensitivePosthogSnippet(["/"])}</script>`)
    expect(only(await t0({ id: "sensitive_pages", params: { productionHost: FAKE.host, sensitivePaths: ["/login"], source } }), "problem").reason).toContain("ordinary page")
  })
})

describe("one_runtime_per_page (job 2)", () => {
  it("today's managed block starts each tool once", async () => {
    only(await t0({ id: "one_runtime_per_page", params: { productionHost: FAKE.host } }), "pass")
  })

  it("negative: a hand-written gtag config beside the managed one runs twice", async () => {
    const managed = guardedPage([FAKE.host]).html!
    const doubled = { html: managed.replace("</head>", `<script>gtag('config', '${FAKE.ga4}');</script></head>`) }
    expect(only(await t0({ id: "one_runtime_per_page", params: { productionHost: FAKE.host, source: doubled } }), "problem").reason).toContain("gtag config for G-FAKE00001 ran 2 times")
  })

  it("negative: a page without the managed tag", async () => {
    const result = only(await t0({ id: "one_runtime_per_page", params: { productionHost: FAKE.host, pages: [{ path: "/", source: guardedPage([FAKE.host]) }, { path: "/blog", source: page("") }] } }), "problem")
    expect(result.reason).toContain("/blog: no managed tag ran")
  })
})

describe("click_test (jobs 10, 11: static HTML / Vite markup only)", () => {
  const body = `<a id="signup" href="/signup" data-infinite-conversion="sign_up">Start</a><script>${CTA_FIXTURE}</script>`

  it("the marked element fires the conversion to GA4 and PostHog before the page leaves", async () => {
    const results = await t0({
      id: "click_test",
      params: { productionHost: FAKE.host, source: guardedPage([FAKE.host], body), clicks: [{ selector: "#signup", label: "sign_up", expect: { ga4: ["sign_up"], posthog: ["sign_up"] } }] }
    })
    const result = only(results, "pass")
    expect(clickTestLabel(result)).toBe("sign_up")
  })

  it("negative: the expected conversion never fires", async () => {
    const results = await t0({
      id: "click_test",
      params: { productionHost: FAKE.host, source: guardedPage([FAKE.host], '<a id="signup" href="/signup">Start</a>'), clicks: [{ selector: "#signup", label: "sign_up", expect: { ga4: ["sign_up"] } }] }
    })
    expect(only(results, "problem").reason).toContain("ga4 did not receive sign_up")
  })

  it("negative: fbq('track', 'Lead') on a click is a problem (browser conversions only through the mirror)", async () => {
    const results = await t0({
      id: "click_test",
      params: {
        productionHost: FAKE.host,
        source: guardedPage([FAKE.host], `${body}<script>document.addEventListener('click',function(){fbq('track','Lead');});</script>`),
        clicks: [{ selector: "#signup", label: "sign_up", expect: { ga4: ["sign_up"] } }]
      }
    })
    expect(only(results, "problem").reason).toContain("standard conversion (Lead) on a click")
  })

  it("a missing element: problem on static HTML, undetermined on Vite (React renders it)", async () => {
    const click = [{ selector: "#nope", label: "sign_up", expect: { ga4: ["sign_up"] } }]
    only(await t0({ id: "click_test", params: { productionHost: FAKE.host, source: page(""), clicks: click } }), "problem")
    only(await t0({ id: "click_test", params: { productionHost: FAKE.host, framework: "vite-react", source: page(""), clicks: click } }), "undetermined")
  })

  it("R13: a click that expects no event is refused (a vacuous pass would mark key events); so is a label with ';'", async () => {
    const source = guardedPage([FAKE.host], '<button id="signup">Start</button>')
    for (const expectation of [{}, { ga4: [] }, { ga4: [], posthog: [], infinite: [] }]) {
      await expect(t0({ id: "click_test", params: { productionHost: FAKE.host, source, clicks: [{ selector: "#signup", label: "sign_up", expect: expectation }] } })).rejects.toBeInstanceOf(T0ScenarioError)
    }
    await expect(t0({ id: "click_test", params: { productionHost: FAKE.host, source, clicks: [{ selector: "#signup", label: "a;b", expect: { ga4: ["a;b"] } }] } })).rejects.toThrow(/plain event name/)
    // negative: the same dead button with a real expectation is a problem, not a pass
    const dead = only(await t0({ id: "click_test", params: { productionHost: FAKE.host, source, clicks: [{ selector: "#signup", label: "sign_up", expect: { ga4: ["sign_up"] } }] } }), "problem")
    expect(dead.reason).toContain("ga4 did not receive sign_up")
  })

  it("R14: on Vite a silent click whose handler may live in a module script T0 does not run is not_exercised, never a problem", async () => {
    const vite = guardedPage([FAKE.host], '<button id="signup" data-infinite-conversion="sign_up">Start</button><script type="module" src="/src/main.js"></script>')
    const click = [{ selector: "#signup", label: "sign_up", expect: { ga4: ["sign_up"] } }]
    const result = only(await t0({ id: "click_test", params: { productionHost: FAKE.host, framework: "vite", source: vite, clicks: click } }), "undetermined")
    expect(reasonCode(result)).toBe("not_exercised")
    // negative: the same page graded as static HTML (no module to blame) is a problem
    only(await t0({ id: "click_test", params: { productionHost: FAKE.host, framework: "static-html", source: vite, clicks: click } }), "problem")
    // and on Vite an fbq standard conversion on the click is still a problem
    const lead = guardedPage([FAKE.host], `<button id="signup">Start</button><script type="module" src="/src/main.js"></script><script>document.addEventListener('click',function(){fbq('track','Lead');});</script>`)
    only(await t0({ id: "click_test", params: { productionHost: FAKE.host, framework: "vite", source: lead, clicks: click } }), "problem")
  })

  it("a caller's own scenario id dispatches on its checkId (`<item>:click_test`)", async () => {
    const results = await runT0Scenarios(
      [{ id: "conversions_to_tools:sign_up:click_test", checkId: "click_test", params: { productionHost: FAKE.host, source: guardedPage([FAKE.host], body), clicks: [{ selector: "#signup", label: "sign_up", expect: { ga4: ["sign_up"] } }] } }],
      fakeArtifacts(),
      { runId: FAKE.runId, now: NOW }
    )
    expect(only(results, "pass").checkId).toBe("click_test")
    // negative: neither the id nor the checkId names a scenario
    await expect(runT0Scenarios([{ id: "x:y", checkId: "nope", params: {} }], fakeArtifacts(), { runId: FAKE.runId, now: NOW })).rejects.toBeInstanceOf(T0ScenarioError)
  })
})

describe("T0 runs the Next managed module's decoded bootstrapSource (as its useEffect would)", () => {
  it("the decoded bytes start every lane on production; unguarded today, so previews fire too (negative)", async () => {
    const artifacts = fakeArtifacts()
    const instructions = (["ga4", "posthog", "meta", "infinite"] as const).flatMap(
      (provider) => getProviderAdapter(provider).plan("next-app-router", artifacts[provider], { artifacts }).instructions
    )
    const decoded = decodeNextBootstrap(buildAnalyticsModuleSource({ instructions } as unknown as InstallPlan))
    if (!decoded.ok) throw new Error(decoded.reason)
    const source = { html: "<!doctype html><html><head></head><body></body></html>", scripts: [{ code: decoded.source, label: "bootstrapSource" }] }
    only(await t0({ id: "one_runtime_per_page", params: { productionHost: FAKE.host, source } }), "pass")
    only(await t0({ id: "fbc_capture", params: { productionHost: FAKE.host, source } }), "pass")
    expect(reasonCode(only(await t0({ id: "host_matrix", params: { productionHost: FAKE.host, source } }), "problem"))).toBe("previews_send_data")
  })
})

describe("all scenarios in one sandboxed child", () => {
  it("returns one graded result per scenario (plus info), each tier T0 and run-scoped", async () => {
    const results = await runT0Scenarios(
      [
        { id: "fbc_capture", checkId: "fbc_capture", params: { productionHost: FAKE.host } },
        { id: "one_runtime_per_page", checkId: "one_runtime_per_page", params: { productionHost: FAKE.host } },
        { id: "fake_click_id", checkId: "fake_click_id", params: { productionHost: FAKE.host } }
      ],
      fakeArtifacts(),
      { runId: FAKE.runId, now: NOW }
    )
    expect(results.map((result) => [result.checkId, result.state])).toEqual([
      ["fbc_capture", "pass"],
      ["one_runtime_per_page", "pass"],
      ["fake_click_id", "pass"]
    ])
    for (const result of results) expect(result).toMatchObject({ tier: "T0", runId: FAKE.runId, at: "2026-10-02T10:00:00.000Z" })
  })
})

describe("navigations the page cannot make (vm-page)", () => {
  it("javascript:, data: and vbscript: are never recorded as navigations, in any case; a real one is", async () => {
    const html = `<html><body><script>
      location.href = "data:text/html,<h1>x</h1>";
      location.assign("VBScript:msgbox(1)");
      location.replace("  JavaScript:void(0)");
      window.open("DATA:text/html,y");
      location.href = "/next";
    </script></body></html>`
    const recording = await runSession({ id: "schemes", actions: [{ kind: "load", label: "page", url: `https://${FAKE.host}/`, source: { html } }] })
    const navigations = recording.requests.filter((request) => request.kind === "navigation").map((request) => request.url)
    // negative: the real navigation in the same script IS recorded (the filter does not drop everything)
    expect(navigations).toEqual([`https://${FAKE.host}/next`])
  })
})
