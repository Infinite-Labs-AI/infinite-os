// Adopted-init host guard (lane O9). Incident guarded: 9fcbefa, 5 of 44 PostHog page views from
// previews and localhost before infinite.fast's host guard.
import { describe, expect, it } from "vitest"

import { checkHostGuard, readAdoptedInitGuards } from "./host-guard.js"
import { buildHostGuardExpression } from "../host-guard.js"

const files = (record: Record<string, string>) => new Map(Object.entries(record))

const GUARDED_IIFE = [
  "(function () {",
  "  var host = location.hostname.toLowerCase().replace(/\\.$/, '')",
  "  if (host === 'localhost' || host.endsWith('.vercel.app')) return",
  "  posthog.init('phc_abcdefghijklmnop', { api_host: '/ingest' })",
  "})()"
].join("\n")

describe("adopted init host guard", () => {
  it.each([
    { legacy: false, typed: false },
    { legacy: false, typed: true },
  ])("accepts the exact approved emission and rejects changed hosts or guard logic (legacy=$legacy, typed=$typed)", ({ legacy, typed }) => {
    const expected = buildHostGuardExpression({ mode: "deny", exempt: ["acme.example"], deny: [] })
    let expression = legacy
      ? expected.replace('if (h === null) return true; ', '').replace(' if (!n) return false;', '').replace('})(typeof location !== "undefined" ? location.hostname : null)', '})(location.hostname)')
      : expected
    if (typed) expression = expression.replaceAll("(function (h) {", "(function (h: string) {").replace("})(h), i;", "})(h), i: number;")
    const read = (guard: string) => checkHostGuard({
      files: files({ "src/meta.ts": `function start() { if (!(${guard})) return; fbq('init', '111222333444555'); }` }),
      strict: true,
      productionHosts: ["acme.example"],
      expectedEmittedGuard: expected
    }).findings.map(finding => finding.code)
    expect(read(expression)).toEqual(["INF_SETUP_HOST_GUARD_PRESENT"])
    expect(read(expression.replace('"acme.example"', '"other.example"'))).toEqual(["INF_SETUP_HOST_GUARD_MISSING"])
    expect(read(expression.replace("if (d[i] === n) return false;", "if (d[i] === n) return true;"))).toEqual(["INF_SETUP_HOST_GUARD_MISSING"])
  })

  it("does not let a closed guard block cover a later init", () => {
    const code = "if (infiniteHostAllowed(['acme.com'])) {\n  gtag('config', 'G-ABC123')\n}\nposthog.init('phc_abcdefghijklmnop', {})"
    const reads = readAdoptedInitGuards(files({ "src/both.ts": code }))
    expect(reads.map((read) => [read.tool, read.guarded])).toEqual([
      ["GA4", true],
      ["PostHog", false]
    ])
  })

  it("flags a guard that would silence a deny-shaped production host", () => {
    const result = checkHostGuard({ files: files({ "src/ph.ts": GUARDED_IIFE }), productionHosts: ["acme-store.vercel.app"] })
    expect(result.findings[0]).toMatchObject({ code: "INF_SETUP_HOST_GUARD_SILENCES_PRODUCTION", state: "problem" })
    // Negative: a production host the deny rules do not match is never "silenced".
    expect(checkHostGuard({ files: files({ "src/ph.ts": GUARDED_IIFE }), productionHosts: ["acme.com"] }).state).toBe("ok")
  })

  it("covers Meta's bootstrap init and ignores the _fbc capture", () => {
    const reads = readAdoptedInitGuards(files({ "index.html": "<html><head><script>window.infiniteMetaClickId=function(){};fbq('init', '111222333444555');</script></head><body></body></html>" }))
    expect(reads.map((read) => read.tool)).toEqual(["Meta pixel"])
  })
})

describe("adopted init host guard: only a governing guard with the right polarity counts (review P2-2)", () => {
  const strict = (code: string, file = "src/x.ts") => checkHostGuard({ files: files({ [file]: code }), strict: true, productionHosts: ["acme.com"] }).findings.map((finding) => finding.code)

  it("an inverted guard (fires ONLY on previews) is missing", () => {
    expect(strict("if (location.hostname.endsWith('.vercel.app')) {\n  gtag('config', 'G-ABC123')\n}")).toEqual(["INF_SETUP_HOST_GUARD_MISSING"])
  })

  it("a negated deny test wrapping the init, an early-return predicate and the emitted guard are guarded (negatives)", () => {
    expect(strict("const h = location.hostname\nif (h !== 'localhost' && !h.endsWith('.vercel.app')) {\n  gtag('config', 'G-ABC123')\n}")).toEqual(["INF_SETUP_HOST_GUARD_PRESENT"])
    expect(strict("(function () {\n  if (!infiniteHostAllowed(['acme.com'])) return\n  posthog.init('phc_abcdefghijklmnop', {})\n})()")).toEqual(["INF_SETUP_HOST_GUARD_PRESENT"])
    const emitted =
      '(function () {\nif (!((function (h) { var n = (function (h) { h = String(h == null ? "" : h).replace(/^\\s+|\\s+$/g, "").toLowerCase(); return h.charAt(h.length - 1) === "." ? h.slice(0, -1) : h; })(h), i; var x = ["acme.com"], d = ["localhost","127.0.0.1","::1","[::1]","0.0.0.0"], s = [".localhost",".local",".vercel.app",".netlify.app",".pages.dev"]; for (i = 0; i < x.length; i += 1) if (x[i] === n) return true; for (i = 0; i < d.length; i += 1) if (d[i] === n) return false; for (i = 0; i < s.length; i += 1) if (n.length > s[i].length && n.slice(n.length - s[i].length) === s[i]) return false; return true; })(location.hostname))) return;\nfbq(\'init\', \'111222333444555\');\n})();'
    expect(strict(`<html><head><script>${emitted}</script></head><body></body></html>`, "index.html")).toEqual(["INF_SETUP_HOST_GUARD_PRESENT"])
    // The same expression with an onDenied beat before its return.
    const withBeat = emitted.replace(")) return;", ")) {\nwindow.__denied = true;\nreturn;\n}")
    expect(strict(`<html><head><script>${withBeat}</script></head><body></body></html>`, "index.html")).toEqual(["INF_SETUP_HOST_GUARD_PRESENT"])
  })
})
