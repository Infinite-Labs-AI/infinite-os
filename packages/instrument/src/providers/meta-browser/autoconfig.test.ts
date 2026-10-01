// Ported from infinite-site @ 9f65b47: `checkMetaAutoConfigOptOut` (scripts/verify-live-analytics.mjs
// L265-283) with the cases its test drives (.github/scripts/test-verify-live-analytics.mjs L27-29,
// L173, L301-310), and the injector census (.github/scripts/test-inject-analytics.mjs L88-135).
// Every passing case sits beside the bad bytes that must not pass.
import { describe, expect, it } from "vitest"

import { buildMetaPixelSnippet } from "../meta.js"

import { censusManagedMetaSnippet, checkMetaAutoConfigOptOut } from "./autoconfig.js"

const ID = "111222333444555"
const page = (autoConfig: string, order: "before" | "after" = "before") => {
  const set = autoConfig ? `fbq("set", "autoConfig", ${autoConfig}, "${ID}");` : ""
  const init = `fbq("init", "${ID}"); fbq("track", "PageView");`
  return `<script>${order === "before" ? set + init : init + set}</script>`
}

describe("checkMetaAutoConfigOptOut (ported from infinite.fast's live guardrail)", () => {
  it("passes the opt-out before init, quoted or boolean — fbevents reads both as opt-out", () => {
    for (const value of ['"false"', "'false'", "false"]) {
      expect(checkMetaAutoConfigOptOut(page(value), ID, "managed")).toMatchObject({ state: "ok", reason: "opted_out_before_init" })
    }
  })

  it("a managed pixel that opts IN, lacks the opt-out, or sets it after init is a PROBLEM", () => {
    expect(checkMetaAutoConfigOptOut(page('"true"'), ID, "managed")).toMatchObject({ state: "problem", reason: "opted_in" })
    expect(checkMetaAutoConfigOptOut(page("true"), ID, "managed")).toMatchObject({ state: "problem", reason: "opted_in" })
    expect(checkMetaAutoConfigOptOut(page(""), ID, "managed")).toMatchObject({ state: "problem", reason: "opt_out_missing" })
    expect(checkMetaAutoConfigOptOut(page('"false"', "after"), ID, "managed")).toMatchObject({ state: "problem", reason: "opt_out_after_init" })
    // An opt-in anywhere wins over an opt-out beside it (the site's rule order).
    expect(checkMetaAutoConfigOptOut(page('"false"') + page('"true"'), ID, "managed").state).toBe("problem")
  })

  it("an ADOPTED pixel with automatic events on is INFO — a plan line, never a problem and never a pass", () => {
    for (const bytes of [page('"true"'), page(""), page('"false"', "after")]) {
      const verdict = checkMetaAutoConfigOptOut(bytes, ID, "adopted")
      expect(verdict.state).toBe("info")
    }
    expect(checkMetaAutoConfigOptOut(page('"false"'), ID, "adopted").state).toBe("ok")
  })

  it("an opt-out for a DIFFERENT pixel does not cover this one", () => {
    const bytes = `fbq("set", "autoConfig", "false", "999888777666555"); fbq("init", "${ID}");`
    expect(checkMetaAutoConfigOptOut(bytes, ID, "managed")).toMatchObject({ state: "problem", reason: "opt_out_missing" })
  })

  it("says UNDETERMINED when the bytes cannot settle it — never ok", () => {
    // A computed pixel id or value: the call might be this pixel's opt-out.
    const computed = `fbq("set", "autoConfig", false, PIXEL_ID); fbq("init", "${ID}");`
    expect(checkMetaAutoConfigOptOut(computed, ID, "managed")).toMatchObject({ state: "undetermined", reason: "autoconfig_unreadable" })
    // An opt-out with no literal init for this pixel to order it against.
    const noInit = `fbq("set", "autoConfig", "false", "${ID}"); fbq("init", window.PIXEL);`
    expect(checkMetaAutoConfigOptOut(noInit, ID, "managed")).toMatchObject({ state: "undetermined", reason: "pixel_not_initialised" })
    expect(checkMetaAutoConfigOptOut(page('"false"'), "abc", "managed")).toMatchObject({ state: "undetermined", reason: "invalid_pixel_id" })
  })

  it("passes the snippet infinite-tag actually writes, with and without Advanced Matching", () => {
    for (const advancedMatching of [false, true]) {
      const snippet = buildMetaPixelSnippet("1234567890123456", { advancedMatching })
      expect(checkMetaAutoConfigOptOut(snippet, "1234567890123456", "managed").state).toBe("ok")
    }
  })
})

describe("censusManagedMetaSnippet (the 849ccf1 near-miss)", () => {
  const PIXEL = "1234567890123456"
  const SNIPPET = buildMetaPixelSnippet(PIXEL, { advancedMatching: true })

  it("the snippet infinite-tag writes: one bootstrap init, one capture, one matching accessor, capture first", () => {
    // The matching re-init `fbq('init', id, userData)` is a different call and is not counted.
    expect(SNIPPET).toMatch(/window\.fbq\('init', "1234567890123456", userData\)/)
    expect(censusManagedMetaSnippet(SNIPPET)).toEqual([])
  })

  it("a doubled block is caught on every count", () => {
    expect(censusManagedMetaSnippet(`${SNIPPET}\n${SNIPPET}`)).toEqual([
      { code: "capture_count", count: 2 },
      { code: "matching_count", count: 2 },
      { code: "init_count", pixelId: PIXEL, count: 2 }
    ])
  })

  it("a capture moved after init is caught", () => {
    const capture = SNIPPET.slice(0, SNIPPET.indexOf("!function(f,b,e,v,n,t,s)"))
    const rest = SNIPPET.slice(capture.length)
    expect(censusManagedMetaSnippet(`${rest}\n${capture}`)).toEqual([{ code: "capture_after_init", pixelId: PIXEL }])
  })

  it("a block whose init was stripped is caught", () => {
    const stripped = SNIPPET.replace(`fbq('init', "${PIXEL}");`, "").replace(`fbq('set', 'autoConfig', 'false', "${PIXEL}");`, "")
    // The pixel id still appears in the matching re-init, so it is found — and has no bootstrap init.
    expect(censusManagedMetaSnippet(stripped)).toEqual([{ code: "init_count", pixelId: PIXEL, count: 0 }])
  })
})
