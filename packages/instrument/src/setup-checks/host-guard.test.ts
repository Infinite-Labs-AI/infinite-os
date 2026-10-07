// Adopted-init host guard (lane O9). Incident guarded: 9fcbefa, 5 of 44 PostHog page views from
// previews and localhost before infinite.fast's host guard.
import { describe, expect, it } from "vitest"

import { checkHostGuard, readAdoptedInitGuards } from "./host-guard.js"
import { buildHostGuardExpression } from "../host-guard.js"
import { escapeForTemplateLiteral } from "../text-escape.js"

const files = (record: Record<string, string>) => new Map(Object.entries(record))

const UNGUARDED = "posthog.init('phc_abcdefghijklmnop', { api_host: '/ingest' })"
const GUARDED_IIFE = [
  "(function () {",
  "  var host = location.hostname.toLowerCase().replace(/\\.$/, '')",
  "  if (host === 'localhost' || host.endsWith('.vercel.app')) return",
  "  posthog.init('phc_abcdefghijklmnop', { api_host: '/ingest' })",
  "})()"
].join("\n")
const GUARDED_CALL = "if (infiniteHostAllowed(['acme.com'])) {\n  gtag('config', 'G-ABC123')\n}"

describe("adopted init host guard", () => {
  it.each([
    { legacy: false, typed: false },
    { legacy: true, typed: false },
    { legacy: false, typed: true },
    { legacy: true, typed: true }
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

  it("recognises the legacy raw and escaped emissions before a production host is known", () => {
    const expression = buildHostGuardExpression({ mode: "deny", exempt: ["acme.example"], deny: [] })
      .replace('if (h === null) return true; ', '').replace(' if (!n) return false;', '').replace('})(typeof location !== "undefined" ? location.hostname : null)', '})(location.hostname)')
    const raw = `function start() { if (!(${expression})) return; fbq('init', '111222333444555'); }`
    const escaped = `<Script>{\`if (!(${escapeForTemplateLiteral(expression)})) return; fbq('init', '111222333444555');\`}</Script>`
    for (const source of [raw, escaped]) expect(checkHostGuard({ files: files({ "src/meta.tsx": source }), strict: true }).findings.map(finding => finding.code)).toEqual(["INF_SETUP_HOST_GUARD_PRESENT"])
  })

  it("accepts a verbatim escaped guard in a template-literal Script", () => {
    const emitted = buildHostGuardExpression({ mode: "deny", exempt: ["acme.example"], deny: [] })
    const source = `<Script id="analytics">{\`if (!(${escapeForTemplateLiteral(emitted)})) return; gtag('config', 'G-ABC123');\`}</Script>`
    expect(checkHostGuard({ files: files({ "app/layout.tsx": source }), strict: true, productionHosts: ["acme.example"], expectedEmittedGuard: emitted }).findings.map((finding) => finding.code)).toEqual(["INF_SETUP_HOST_GUARD_PRESENT"])
  })

  it("accepts a required guard in an && condition or another whole pair of parentheses", () => {
    const emitted = buildHostGuardExpression({ mode: "deny", exempt: ["acme.example"], deny: [] })
    for (const condition of [`typeof window !== "undefined" && ${emitted}`, `(${emitted})`]) {
      const source = `if (${condition}) { posthog.init('phc_abcdefghijklmnop', {}); }`
      expect(checkHostGuard({ files: files({ "src/ph.ts": source }), strict: true, productionHosts: ["acme.example"], expectedEmittedGuard: emitted }).findings.map((finding) => finding.code)).toEqual(["INF_SETUP_HOST_GUARD_PRESENT"])
    }
  })

  it("recognises structurally exact raw output in the doctor path before a production host is known", () => {
    const emitted = buildHostGuardExpression({ mode: "deny", exempt: ["acme.example"], deny: [] })
    const source = `function start() { if (!(${emitted})) return; fbq('init', '111222333444555'); }`
    expect(checkHostGuard({ files: files({ "src/meta.ts": source }), strict: true }).findings.map((finding) => finding.code)).toEqual(["INF_SETUP_HOST_GUARD_PRESENT"])
  })
  it("accepts only parameter and var TypeScript annotations on the approved emitted guard", () => {
    const emitted = buildHostGuardExpression({ mode: "deny", exempt: ["acme.example"], deny: [] })
    const annotated = emitted.replaceAll("(function (h) {", "(function (h: string) {").replace("})(h), i;", "})(h), i: number;")
    expect(annotated).not.toBe(emitted)
    const guarded = (expression: string) => checkHostGuard({
      files: files({
        "src/ga.ts": `function start() { if (!(${expression})) return; gtag('config', 'G-ABC123'); }`,
        "src/ph.ts": `function start() { if (!(${expression})) return; posthog.init('phc_abcdefghijklmnop', {}); }`,
        "src/meta.ts": `function start() { if (!(${expression})) return; fbq('init', '111222333444555'); }`
      }),
      strict: true,
      productionHosts: ["acme.example"],
      expectedEmittedGuard: emitted
    })
    expect(guarded(annotated).findings.map((finding) => finding.code)).toEqual(Array(3).fill("INF_SETUP_HOST_GUARD_PRESENT"))
    expect(guarded(annotated.replaceAll("h: string", "h:string").replace("i: number", "i:number")).findings.map((finding) => finding.code)).toEqual(Array(3).fill("INF_SETUP_HOST_GUARD_PRESENT"))
    expect(guarded(annotated.replace('"acme.example"', '"other.example"')).findings.map((finding) => finding.code)).toEqual(Array(3).fill("INF_SETUP_HOST_GUARD_MISSING"))
    expect(guarded(annotated.replace("if (x[i] === n) return true;", "if (x[i] === n) return false;")).findings.map((finding) => finding.code)).toEqual(Array(3).fill("INF_SETUP_HOST_GUARD_MISSING"))
  })
  it("is information in the harness and a problem as job 7's proof", () => {
    const input = { files: files({ "src/ph.ts": UNGUARDED }) }
    expect(checkHostGuard(input).findings.map((finding) => [finding.code, finding.state])).toEqual([["INF_SETUP_HOST_GUARD_MISSING", "info"]])
    expect(checkHostGuard({ ...input, strict: true }).findings.map((finding) => [finding.code, finding.state])).toEqual([
      ["INF_SETUP_HOST_GUARD_MISSING", "problem"]
    ])
  })

  it("recognises an early-return host check and a guard predicate (negative: no missing finding)", () => {
    const result = checkHostGuard({ files: files({ "src/ph.ts": GUARDED_IIFE, "src/ga.ts": GUARDED_CALL }), strict: true })
    expect(result.findings.map((finding) => finding.code)).toEqual(["INF_SETUP_HOST_GUARD_PRESENT", "INF_SETUP_HOST_GUARD_PRESENT"])
    expect(result.state).toBe("ok")
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

  it("groups a multi-page site into one line per tool (strict keeps one per init)", () => {
    const page = (n: number) => `<html><head><script>gtag('config', 'G-ABC123')</script></head><body>${n}</body></html>`
    const input = { files: files({ "a.html": page(1), "b.html": page(2), "c.html": page(3) }) }
    const grouped = checkHostGuard(input).findings
    expect(grouped).toHaveLength(1)
    expect(grouped[0]!.message).toContain("The same applies at b.html:1, c.html:1.")
    expect(checkHostGuard({ ...input, strict: true }).findings).toHaveLength(3)
  })
})

describe("adopted init host guard: only a governing guard with the right polarity counts (review P2-2)", () => {
  const strict = (code: string, file = "src/x.ts") => checkHostGuard({ files: files({ [file]: code }), strict: true, productionHosts: ["acme.com"] }).findings.map((finding) => finding.code)

  it("an inverted guard (fires ONLY on previews) is missing", () => {
    expect(strict("if (location.hostname.endsWith('.vercel.app')) {\n  gtag('config', 'G-ABC123')\n}")).toEqual(["INF_SETUP_HOST_GUARD_MISSING"])
  })

  it("a host read with no if, or a localStorage read beside a hostname read, is missing", () => {
    expect(strict("const debug = location.hostname === 'localhost'\ngtag('config', 'G-ABC123', { debug_mode: debug })")).toEqual(["INF_SETUP_HOST_GUARD_MISSING"])
    expect(strict("const saved = localStorage.getItem('x')\nconst domain = location.hostname\nposthog.init('phc_abcdefghijklmnop', {})")).toEqual(["INF_SETUP_HOST_GUARD_MISSING"])
    // `local` inside `localStorage` is not a deny-list host, even under an if.
    expect(strict("if (localStorage.getItem('x') && location.hostname) {\n  posthog.init('phc_abcdefghijklmnop', {})\n}")).toEqual(["INF_SETUP_HOST_GUARD_MISSING"])
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

  it("an allow predicate that RETURNS is inverted", () => {
    expect(strict("(function () {\n  if (infiniteHostAllowed(['acme.com'])) return\n  posthog.init('phc_abcdefghijklmnop', {})\n})()")).toEqual(["INF_SETUP_HOST_GUARD_MISSING"])
  })
})
