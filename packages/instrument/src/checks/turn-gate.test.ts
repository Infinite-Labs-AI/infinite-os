// §3f.9 post-turn gate (lane O9): one positive and one negative fixture per rule. Incidents guarded:
// 22d08d4 (phantom CompleteRegistrations: a page-built event id is refused at the turn) and 9fcbefa
// (a provider id that is not the connection's — e.g. a default — is refused).
import { describe, expect, it } from "vitest"

import { FIXED_NOW } from "../../test/wizard/fixture-fetch.js"
import type { TurnDiff } from "../wizard/contracts/jobs.js"

import { scanTurnDiff, turnGate, TURN_GATE_RULES, type TurnGateRule } from "./turn-gate.js"

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
  ["page_built_event_id", "src/app/signup.tsx", "fbq('track', 'CompleteRegistration', {}, { eventID: 'signup-' + id })", "fbq('track', 'CompleteRegistration', {}, { eventID: metaEventId })"]
]

describe("post-turn gate: one positive and one negative per rule", () => {
  for (const [rule, file, bad, good] of CASES) {
    it(`${rule}: ${bad}`, () => {
      expect(rules(diff(file, bad))).toContain(rule)
      expect(rules(diff(file, good))).not.toContain(rule)
    })
  }

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
    expect(rules(diff("src/lib/x.ts", "// see ~/.growth-os for details"))).toContain("secret_path_literal")
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
