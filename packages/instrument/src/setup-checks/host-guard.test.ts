// Adopted-init host guard (lane O9). Incident guarded: 9fcbefa, 5 of 44 PostHog page views from
// previews and localhost before infinite.fast's host guard.
import { describe, expect, it } from "vitest"

import { checkHostGuard, readAdoptedInitGuards } from "./host-guard.js"

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
