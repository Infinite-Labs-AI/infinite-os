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

  it("emits a raw (unwrapped) snippet for JS frameworks folded into the module", () => {
    const ok = metaProviderAdapter.plan("vite-react", { pixelId: "1234567890123456" })
    expect(ok.instructions[0]!.path).toBe("src/lib/infinite-analytics.ts")
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
})
