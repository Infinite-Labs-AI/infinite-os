// The adopted PostHog config check (lane O9). Incident guarded: the month-long silent outage's PostHog
// region flip — a region that differs from the connected project's is a problem.
import { describe, expect, it } from "vitest"

import { buildManagedHtmlBlock } from "../frameworks/managed-html.js"
import { sensitivePosthogOptions } from "../install/posthog-sensitive.js"

import { checkPosthogConfig, posthogConfigDrift, readPosthogConfigs } from "./posthog-config.js"

const files = (record: Record<string, string>) => new Map(Object.entries(record))

const PROXIED_SPA = `posthog.init('phc_abcdefghijklmnop', {\n  api_host: '/ingest',\n  ui_host: 'https://eu.posthog.com',\n  defaults: '2025-05-24'\n})`

describe("posthog config", () => {
  it("reads every adopted init, not only the first file", () => {
    const reads = readPosthogConfigs(
      files({
        "src/app/providers.tsx": PROXIED_SPA,
        "src/legacy.ts": "posthog.init('phc_abcdefghijklmnop', { api_host: 'https://eu.i.posthog.com', autocapture: false })"
      })
    )
    expect(reads.map((read) => [read.file, read.options.api_host, read.options.autocapture])).toEqual([
      ["src/app/providers.tsx", "/ingest", undefined],
      ["src/legacy.ts", "https://eu.i.posthog.com", "false"]
    ])
  })

  it("passes a proxied SPA config with history page views (negative: no finding)", () => {
    expect(checkPosthogConfig({ files: files({ "src/app/providers.tsx": PROXIED_SPA }) }).findings).toEqual([])
  })

  it("notes a direct PostHog host and missing SPA page views (info, never a problem)", () => {
    const result = checkPosthogConfig({ files: files({ "src/app/providers.tsx": "posthog.init('phc_abcdefghijklmnop', { api_host: 'https://us.i.posthog.com' })" }) })
    expect(result.findings.map((finding) => [finding.code, finding.state])).toEqual([
      ["INF_SETUP_POSTHOG_NOT_PROXIED", "info"],
      ["INF_SETUP_POSTHOG_SPA_PAGEVIEWS", "info"]
    ])
  })

  it("says undetermined when the options are a variable", () => {
    const result = checkPosthogConfig({ files: files({ "src/ph.ts": "posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, options)" }) })
    expect(result.state).toBe("undetermined")
    expect(result.findings[0]!.code).toBe("INF_SETUP_POSTHOG_CONFIG_UNREADABLE")
  })

  it("reads PostHogProvider options={{…}}", () => {
    const reads = readPosthogConfigs(files({ "app/providers.tsx": "<PostHogProvider apiKey={key} options={{ api_host: '/ingest', defaults: '2026-01-30' }}>" }))
    expect(reads[0]!.options).toEqual({ api_host: "/ingest", defaults: "2026-01-30" })
    expect(reads[0]!.readable).toBe(true)
  })

  it("flags a region that differs from the connected project's (only with an expectation)", () => {
    const input = { files: files({ "src/ph.ts": "posthog.init('phc_abcdefghijklmnop', { api_host: 'https://us.i.posthog.com', defaults: '2025-05-24' })" }) }
    expect(checkPosthogConfig({ ...input, expectedApiHost: "https://eu.i.posthog.com" }).findings.map((finding) => finding.code)).toContain(
      "INF_SETUP_POSTHOG_REGION_MISMATCH"
    )
    expect(checkPosthogConfig({ ...input, expectedApiHost: "https://us.i.posthog.com" }).findings.map((finding) => finding.code)).not.toContain(
      "INF_SETUP_POSTHOG_REGION_MISMATCH"
    )
  })

  it("skips infinite-tag's own managed PostHog", () => {
    const html = `<html><head>${buildManagedHtmlBlock(["<script>posthog.init('phc_abcdefghijklmnop', { api_host: 'https://us.i.posthog.com' })</script>"])}</head><body></body></html>`
    expect(checkPosthogConfig({ files: files({ "index.html": html }) }).findings).toEqual([])
  })

  it("drift: only the exact approved restrictive addition may change privacy options", () => {
    const before = readPosthogConfigs(files({ "src/ph.ts": "posthog.init('phc_abcdefghijklmnop', { api_host: 'https://us.i.posthog.com' })" }))
    const after = readPosthogConfigs(files({ "src/ph.ts": "posthog.init('phc_abcdefghijklmnop', { api_host: '/ingest', autocapture: false })" }))
    expect(posthogConfigDrift(before, after).map((finding) => finding.code)).toEqual(["INF_SETUP_POSTHOG_PRIVACY_CHANGED"])
    expect(posthogConfigDrift(before, after, { sensitivePagesApproved: true })).toMatchObject([{ state: "problem" }])
    // Negative: only the proxy changed.
    const proxyOnly = readPosthogConfigs(files({ "src/ph.ts": "posthog.init('phc_abcdefghijklmnop', { api_host: '/ingest' })" }))
    expect(posthogConfigDrift(before, proxyOnly)).toEqual([])
  })

  it.each([
    "autocapture: true, disable_session_recording: false,",
    "autocapture: false, disable_session_recording: true,",
    "autocapture: false,",
    "disable_session_recording: true,",
    "...existing,",
    ""
  ])("preserves every existing privacy option around the approved addition: %s", options => {
    const base = `posthog.init('phc_fixture', { ${options} api_host: '/ingest' });`
    const paste = sensitivePosthogOptions(base, ["/login", "/checkout"]) ?? sensitivePosthogOptions(undefined, ["/login", "/checkout"])!
    const amended = base.replace(" });", `, ${paste} });`)
    const reads = (source: string) => readPosthogConfigs(files({ "src/ph.ts": source }))
    expect(posthogConfigDrift(reads(base), reads(amended), { sensitivePaths: ["/login", "/checkout"] })).toEqual([])
    expect(posthogConfigDrift(reads(amended), reads(amended), { sensitivePaths: ["/login", "/checkout"] })).toEqual([])
    for (const wrong of [amended.replace("autocapture: false", "autocapture: true"), amended.replace("disable_session_recording: true", "disable_session_recording: false"), amended.replace('"/checkout"', '"/public"'), amended.replace("} : {}", "} : { autocapture: true }")]) {
      if (wrong === amended) continue
      expect(posthogConfigDrift(reads(base), reads(wrong), { sensitivePaths: ["/login", "/checkout"] })).toMatchObject([{ state: "problem" }])
    }
  })

  it("groups the same finding across pages into one line", () => {
    const html = (n: number) => `<html><head><script>posthog.init('phc_abcdefghijklmnop', { api_host: 'https://us.i.posthog.com' })</script></head><body>${n}</body></html>`
    const result = checkPosthogConfig({ files: files({ "a.html": html(1), "b.html": html(2) }) })
    expect(result.findings.map((finding) => finding.code)).toEqual(["INF_SETUP_POSTHOG_NOT_PROXIED"])
    expect(result.findings[0]!.message).toContain("The same applies at b.html:1.")
  })
})
