import { createHash } from "node:crypto"
import { webcrypto } from "node:crypto"
import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { buildMetaPixelSnippet, metaProviderAdapter } from "./meta.js"

describe("meta provider plan", () => {
  it("blocks a missing pixel id (no instructions)", () => {
    const blocked = metaProviderAdapter.plan("static-html", { pixelId: "" })
    expect(blocked.blockers.length).toBeGreaterThan(0)
    expect(blocked.blockers[0]).toContain("Meta requires a public pixelId")
    expect(blocked.instructions).toHaveLength(0)
  })

  it("blocks a non-numeric / hostile pixel id", () => {
    const blocked = metaProviderAdapter.plan("static-html", { pixelId: "</script>" })
    expect(blocked.blockers.length).toBeGreaterThan(0)
    expect(blocked.instructions).toHaveLength(0)
  })

  it("emits the standard fbevents bootstrap with init + PageView for static-html", () => {
    const ok = metaProviderAdapter.plan("static-html", { pixelId: "1234567890123456" })
    expect(ok.blockers).toEqual([])
    const snippet = ok.instructions[0]!.snippet
    expect(ok.instructions[0]!.path).toBe("index.html")
    expect(ok.instructions[0]!.provider).toBe("meta")
    expect(snippet).toContain("connect.facebook.net/en_US/fbevents.js")
    expect(snippet).toContain('fbq(\'init\', "1234567890123456")')
    expect(snippet).toContain("fbq('track', 'PageView')")
    // static-html snippet is wrapped in a <script> tag.
    expect(snippet.startsWith("<script>")).toBe(true)
    expect(snippet.trimEnd().endsWith("</script>")).toBe(true)
  })

  it("emits a raw (unwrapped) snippet for JS-module frameworks folded into the module", () => {
    // Next uses the JS module; Vite now injects the wrapped <script> into index.html like static-html.
    const ok = metaProviderAdapter.plan("next-app-router", { pixelId: "1234567890123456" })
    expect(ok.instructions[0]!.path).toBe("lib/infinite-analytics.ts")
    const snippet = ok.instructions[0]!.snippet
    expect(snippet.startsWith("<script>")).toBe(false)
    expect(snippet).toContain("fbevents.js")
    // Must be safe to fold into the module's String.raw`…` bootstrap template.
    expect(snippet).not.toContain("`")
    expect(snippet).not.toContain("${")
  })

  it("turns Meta's Automatic Configuration OFF before init so no button clicks or page metadata go to Meta", () => {
    const snippet = buildMetaPixelSnippet("1234567890123456")
    const setLine = `fbq('set', 'autoConfig', 'false', "1234567890123456");`
    const initLine = `fbq('init', "1234567890123456");`
    expect(snippet).toContain(setLine)
    expect(snippet).toContain(initLine)
    // Order is load-bearing: Meta only honours autoConfig when it is set BEFORE init.
    expect(snippet.indexOf("fbevents.js")).toBeLessThan(snippet.indexOf(setLine))
    expect(snippet.indexOf(setLine)).toBeLessThan(snippet.indexOf(initLine))
    expect(snippet.indexOf(initLine)).toBeLessThan(snippet.indexOf("fbq('track', 'PageView')"))
    // The id literal in the set call is the same escaped literal as init (no second path for escaping).
    const hostile = buildMetaPixelSnippet("</script>")
    expect(hostile).toContain(`fbq('set', 'autoConfig', 'false', "\\u003c/script>");`)
    expect(hostile).not.toContain("</script>")
  })

  it("records no env keys (the pixel id is an inlined public value)", () => {
    expect(metaProviderAdapter.envKeys("next-app-router")).toEqual([])
  })

  it("builder escapes a would-be breakout in the pixel id", () => {
    const snippet = buildMetaPixelSnippet("</script>")
    expect(snippet).not.toContain("</script>")
    expect(snippet).toContain("\\u003c")
  })

  it("does NOT install Manual Advanced Matching unless the customer explicitly turned it on", () => {
    // DEFAULT OFF is the whole posture. Sending a visitor's hashed contact details from a
    // CUSTOMER's pages is their decision, exactly like the autoConfig opt-out beside it, so the
    // accessor must not exist on the page unless they asked for it.
    for (const artifact of [
      { pixelId: "1234567890123456" },
      { pixelId: "1234567890123456", advancedMatching: false },
      // Truthy-but-not-true must NOT be an opt-in: this switch decides what happens to other
      // people's contact details, so it takes an unambiguous boolean or nothing.
      { pixelId: "1234567890123456", advancedMatching: "on" },
      { pixelId: "1234567890123456", advancedMatching: 1 }
    ]) {
      const plan = metaProviderAdapter.plan("static-html", artifact as never)
      expect(plan.instructions[0]!.snippet).not.toContain("infiniteMetaAdvancedMatch")
      expect(plan.assumptions.join(" ")).toContain("Manual Advanced Matching is OFF (default)")
    }
    expect(buildMetaPixelSnippet("1234567890123456")).not.toContain("infiniteMetaAdvancedMatch")
  })

  it("installs the accessor on an explicit opt-in, and never turns Automatic Advanced Matching on to do it", () => {
    const snippet = buildMetaPixelSnippet("1234567890123456", { advancedMatching: true })
    expect(snippet).toContain("window.infiniteMetaAdvancedMatch = function (identity)")
    // The opt-out is what keeps Meta from scraping the customer's forms. Manual matching is
    // unaffected by it, so there is never a reason to flip it — and this proves we did not.
    expect(snippet).toContain(`fbq('set', 'autoConfig', 'false', "1234567890123456");`)
    expect(snippet).not.toContain("'true'")
    // No scraping of any kind: the values arrive as an argument or not at all. Scoped to the
    // accessor, because Meta's own bootstrap legitimately uses getElementsByTagName to insert
    // its script tag — that is not DOM harvesting.
    const accessorSource = snippet.slice(snippet.indexOf("\n(function () {"))
    for (const forbidden of ["querySelector", "getElementsBy", "addEventListener", "document", "localStorage", "sessionStorage"]) {
      expect(accessorSource).not.toContain(forbidden)
    }
    // The bootstrap init is untouched, so the live config probe still finds the pixel id.
    expect(snippet).toContain(`fbq('init', "1234567890123456");`)
    // Foldable into the Next module's String.raw template, and never closes the script element.
    expect(snippet).not.toContain("`")
    expect(snippet).not.toContain("${")
    expect(snippet).not.toContain("</script>")
    const plan = metaProviderAdapter.plan("static-html", {
      pixelId: "1234567890123456",
      advancedMatching: true
    } as never)
    expect(plan.assumptions.join(" ")).toContain("Manual Advanced Matching is ON")
    expect(plan.instructions[0]!.snippet).toContain("infiniteMetaAdvancedMatch")
  })

  it("hashes RAW values exactly once, per Meta's normalisation, and refuses an already-hashed one", async () => {
    // Every rule here fails SILENTLY in production: a double-hashed or wrongly-normalised value is
    // accepted by Meta and matches nobody, dragging Event Match Quality DOWN rather than up. The
    // expected digests are computed independently with node:crypto, so the snippet is checked
    // against Meta's documented rule rather than against itself.
    const EM = createHash("sha256").update("founder@example.com", "utf8").digest("hex")
    const EXTERNAL_ID = createHash("sha256").update("acct_42", "utf8").digest("hex")

    const run = async (identity: unknown) => {
      const calls: unknown[][] = []
      const context: Record<string, unknown> = {
        crypto: webcrypto,
        TextEncoder,
        Uint8Array,
        Promise,
        window: { fbq: (...args: unknown[]) => calls.push(args) }
      }
      context.globalThis = context
      // Run the accessor exactly as it ships. Meta's own loader is sliced off because it would
      // try to reach connect.facebook.net; everything below is byte-for-byte what a customer gets.
      const full = buildMetaPixelSnippet("1234567890123456", { advancedMatching: true })
      runInNewContext(full.slice(full.indexOf("\n(function () {")), context)
      const accessor = (context.window as { infiniteMetaAdvancedMatch: (value: unknown) => Promise<boolean> })
        .infiniteMetaAdvancedMatch
      const attached = await accessor(identity)
      return { attached, calls }
    }

    // Meta: "Trim any leading and trailing spaces. Convert all characters to lowercase."
    const matched = await run({ email: "  Founder@Example.COM ", externalId: " acct_42 " })
    expect(matched.attached).toBe(true)
    expect(matched.calls).toEqual([["init", "1234567890123456", { em: EM, external_id: EXTERNAL_ID }]])
    // A RAW email in `em` is the classic PII leak — Meta rejects it and we never send it.
    expect(JSON.stringify(matched.calls)).not.toContain("@")
    expect(JSON.stringify(matched.calls)).not.toContain("acct_42")
    for (const digest of [EM, EXTERNAL_ID]) expect(digest).toMatch(/^[a-f0-9]{64}$/)

    // RAW IN, ALWAYS. An already-hashed value is REFUSED, not hashed a second time — "sometimes
    // hashed" is exactly how double-hashing ships.
    const prehashed = await run({ email: EM, externalId: EXTERNAL_ID })
    expect(prehashed.attached).toBe(false)
    expect(prehashed.calls).toEqual([])

    // Partial identity is fine. Nothing at all is a no-op, never an empty user_data object.
    const emailOnly = await run({ email: "founder@example.com" })
    expect(emailOnly.calls).toEqual([["init", "1234567890123456", { em: EM }]])
    expect((await run({})).calls).toEqual([])
    expect((await run({ email: "not-an-email" })).calls).toEqual([])
    expect((await run(undefined)).calls).toEqual([])
  })
})
