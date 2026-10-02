import { describe, expect, it } from "vitest"

import { buildAnalyticsModuleSource } from "../frameworks/managed-files.js"
import { buildManagedHtmlBlock } from "../frameworks/managed-html.js"
import { extractMetaPixelIds } from "../meta-live/config-probe.js"
import { metaProviderAdapter } from "../providers/meta.js"
import type { InstallPlan } from "../types.js"

import { checkClickIdCapture } from "./click-id-capture.js"
import { checkMetaPixelConfig, metaSourceUnits } from "./meta-pixel-config.js"

const PIXEL = "1234567890123456"
const ADOPTED = "914812061724377"

/** A page carrying the managed block infinite-tag writes for static-html. */
function managedPage(extraHead = ""): string {
  const plan = metaProviderAdapter.plan("static-html", { pixelId: PIXEL, advancedMatching: true } as never)
  const block = buildManagedHtmlBlock([plan.instructions[0]!.snippet])
  return `<html><head>\n${extraHead}\n${block}\n</head><body><h1>Hi</h1></body></html>`
}

/** `lib/infinite-analytics.ts` exactly as infinite-tag writes it for Next. */
function managedNextModule(): string {
  const plan = metaProviderAdapter.plan("next-app-router", { pixelId: PIXEL } as never)
  return buildAnalyticsModuleSource({ instructions: plan.instructions } as InstallPlan)
}

function check(files: Record<string, string>) {
  return checkMetaPixelConfig({ files: new Map(Object.entries(files)) })
}

describe("meta_pixel_config: automatic events + managed-snippet census", () => {
  it("passes infinite-tag's own static block", () => {
    const result = check({ "index.html": managedPage() })
    expect(result.state).toBe("ok")
    expect(result.findings.map((finding) => finding.code)).toEqual(["INF_SETUP_META_AUTOCONFIG_OFF"])
    expect(result.findings[0]!.message).toContain("123456…3456")
    expect(result.findings[0]!.message).not.toContain(PIXEL)
  })

  it("reads the Next module's DECODED literal — raw, its escaped quotes hide the pixel", () => {
    const source = managedNextModule()
    expect(extractMetaPixelIds(source)).toEqual([])
    const result = check({ "lib/infinite-analytics.ts": source })
    expect(result.findings.map((finding) => [finding.code, finding.file])).toEqual([
      ["INF_SETUP_META_AUTOCONFIG_OFF", "lib/infinite-analytics.ts"]
    ])
    expect(metaSourceUnits("lib/infinite-analytics.ts", source)[0]!.managed).toBe(true)
  })

  it("a managed block that lost its opt-out is a PROBLEM in our own code", () => {
    const edited = managedPage().replace(`fbq('set', 'autoConfig', 'false', "${PIXEL}");`, "")
    const result = check({ "index.html": edited })
    expect(result.state).toBe("problem")
    expect(result.findings[0]!.code).toBe("INF_SETUP_META_AUTOCONFIG_MANAGED_ON")
    expect(result.findings[0]!.confidence).toBe("certain")
  })

  it("an ADOPTED pixel with automatic events on is INFO, never a problem, and points at its own line", () => {
    const adopted = `<script>\nfbq('init', '${ADOPTED}');\nfbq('track', 'PageView');\n</script>`
    const result = check({ "index.html": `<html><head>\n${adopted}\n</head><body></body></html>` })
    expect(result.state).toBe("info")
    const finding = result.findings[0]!
    expect(finding.code).toBe("INF_SETUP_META_AUTOCONFIG_ADOPTED_ON")
    expect(finding.state).toBe("info")
    expect(finding.message).toMatch(/^Worth checking:/)
    expect(finding.message).toContain("Manual Advanced Matching is")
    expect(finding.line).toBe(3)
  })

  it("splits one page into managed and adopted bytes and judges each by its own owner", () => {
    const adopted = `<script>fbq('init', '${ADOPTED}');</script>`
    const result = check({ "index.html": managedPage(adopted) })
    expect(result.findings.map((finding) => finding.code).sort()).toEqual([
      "INF_SETUP_META_AUTOCONFIG_ADOPTED_ON",
      "INF_SETUP_META_AUTOCONFIG_OFF"
    ])
    expect(result.state).toBe("info")
  })

  it("a doubled managed block fails the census", () => {
    const plan = metaProviderAdapter.plan("static-html", { pixelId: PIXEL } as never)
    const snippet = plan.instructions[0]!.snippet
    const doubled = `<html><head>\n${buildManagedHtmlBlock([snippet, snippet])}\n</head><body></body></html>`
    const result = check({ "index.html": doubled })
    expect(result.state).toBe("problem")
    const census = result.findings.find((finding) => finding.code === "INF_SETUP_META_SNIPPET_CENSUS")!
    expect(census.message).toContain("initialised 2 times")
    expect(census.message).toContain("2 click-id captures")
  })

  it("cannot tell → UNDETERMINED, never ok: a computed autoConfig call, or no pixel in source at all", () => {
    const computed = check({ "index.html": `<script>fbq('set', 'autoConfig', false, ID); fbq('init', '${ADOPTED}');</script>` })
    expect(computed.state).toBe("undetermined")
    // No pixel anywhere: the CHECK says undetermined, but adds no line of its own — the click-id
    // check's one "no fbq('init') found" line already names both open questions.
    const none = check({ "src/app/page.tsx": "<main>Nothing here</main>" })
    expect(none.state).toBe("undetermined")
    expect(none.findings).toEqual([])
  })

  it("infinite-tag's capture with no readable init beside it is UNDETERMINED with its own line", () => {
    const plan = metaProviderAdapter.plan("static-html", { pixelId: PIXEL } as never)
    const block = buildManagedHtmlBlock([plan.instructions[0]!.snippet])
    const capture = `<html><head>\n${block}\n</head><body></body></html>`.replace(`fbq('init', "${PIXEL}");`, "fbq('init', window.PIXEL);")
    expect(capture).toContain("fbq('init', window.PIXEL);")
    const result = check({ "index.html": capture })
    expect(result.state).toBe("undetermined")
    expect(result.findings.map((finding) => finding.code)).toEqual(["INF_SETUP_META_AUTOCONFIG_UNDETERMINED"])
  })

  // The 849ccf1 shape: a merge that kept both sides leaves the managed block on the page TWICE. Each
  // block is well-formed on its own, so only a census over the whole page sees two inits.
  it("a page carrying the managed block TWICE fails the census (two inits = every page view counted twice)", () => {
    const plan = metaProviderAdapter.plan("static-html", { pixelId: PIXEL } as never)
    const block = buildManagedHtmlBlock([plan.instructions[0]!.snippet])
    const page = `<html><head>\n${block}\n</head><body>\n<h1>Hi</h1>\n${block}\n</body></html>`
    expect(metaSourceUnits("index.html", page).filter((unit) => unit.managed)).toHaveLength(2)
    const result = check({ "index.html": page })
    expect(result.state).toBe("problem")
    const census = result.findings.find((finding) => finding.code === "INF_SETUP_META_SNIPPET_CENSUS")!
    expect(census.message).toContain("initialised 2 times")
    expect(census.message).toContain("2 click-id captures")
    expect(census.line).toBe(2)
    // The second block is infinite-tag's own, never read as the site's (adopted) pixel.
    expect(result.findings.map((finding) => finding.code)).not.toContain("INF_SETUP_META_AUTOCONFIG_ADOPTED_ON")
    // One block on the page stays clean.
    expect(check({ "index.html": managedPage() }).state).toBe("ok")
  })

  it("one finding per verdict, not one per page: a 31-page site with its own pixel gets ONE line naming 5 pages and a count", () => {
    const adopted = `<script>\nfbq('init', '${ADOPTED}');\nfbq('track', 'PageView');\n</script>`
    const files: Record<string, string> = {}
    for (let page = 1; page <= 31; page += 1) {
      files[`page-${String(page).padStart(2, "0")}.html`] = `<html><head>\n${adopted}\n</head><body></body></html>`
    }
    const result = check(files)
    expect(result.state).toBe("info")
    expect(result.findings).toHaveLength(1)
    const finding = result.findings[0]!
    expect(finding.code).toBe("INF_SETUP_META_AUTOCONFIG_ADOPTED_ON")
    expect(finding.file).toBe("page-01.html")
    expect(finding.line).toBe(3)
    expect(finding.message).toContain("page-01.html, page-02.html, page-03.html, page-04.html, page-05.html and 26 more")
    expect(finding.message).not.toContain("page-06.html")
  })

  it("different verdicts stay separate findings: two pixels, or the same pixel managed here and adopted there", () => {
    const other = "555666777888999"
    const result = check({
      "a.html": `<script>fbq('init', '${ADOPTED}');</script>`,
      "b.html": `<script>fbq('init', '${ADOPTED}');</script>`,
      "c.html": `<script>fbq('init', '${other}');</script>`,
      "index.html": managedPage()
    })
    expect(result.findings.map((finding) => [finding.code, finding.file]).sort()).toEqual([
      ["INF_SETUP_META_AUTOCONFIG_ADOPTED_ON", "a.html"],
      ["INF_SETUP_META_AUTOCONFIG_ADOPTED_ON", "c.html"],
      ["INF_SETUP_META_AUTOCONFIG_OFF", "index.html"]
    ])
  })

  // infinite-tag < 0.7 (before a36660c) wrote the Next module as a String.raw template, quotes
  // unescaped, and before the autoConfig opt-out existed. That module is OUR code: a problem with a
  // re-install fix, never "the pixel already on your site".
  it("a pre-0.7 String.raw managed Next module is infinite-tag's own pixel, not the site's", () => {
    const oldModule = [
      "// Managed by Infinite. Public install artifacts only.",
      "",
      "const bootstrapSource = String.raw`",
      "!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){};}(window, document,'script','https://connect.facebook.net/en_US/fbevents.js');",
      `fbq('init', '${PIXEL}');`,
      "fbq('track', 'PageView');",
      "`",
      "",
      "export function installInfiniteInstrumentation(): void {}"
    ].join("\n")
    const units = metaSourceUnits("lib/infinite-analytics.ts", oldModule)
    expect(units).toHaveLength(1)
    expect(units[0]!.managed).toBe(true)
    const result = check({ "lib/infinite-analytics.ts": oldModule })
    expect(result.state).toBe("problem")
    expect(result.findings.map((finding) => finding.code)).toEqual(["INF_SETUP_META_AUTOCONFIG_MANAGED_ON"])
    expect(result.findings[0]!.line).toBe(5)
    expect(result.findings[0]!.message).toContain("infinite-tag installed")
    // And a managed file in a shape this build cannot decode is still ours, never adopted.
    const unknownShape = `// Managed by Infinite. Public install artifacts only.\nconst other = 1; fbq('init', '${PIXEL}');`
    expect(check({ "lib/infinite-analytics.ts": unknownShape }).findings[0]!.code).toBe("INF_SETUP_META_AUTOCONFIG_MANAGED_ON")
  })

  it("an adopted opt-out that is commented out is UNDETERMINED, never ok", () => {
    const commented = `<script>\n// fbq('set', 'autoConfig', false, '${ADOPTED}');\nfbq('init', '${ADOPTED}');\n</script>`
    const result = check({ "index.html": `<html><head>${commented}</head><body></body></html>` })
    expect(result.state).toBe("undetermined")
    expect(result.findings[0]!.message).toContain("inside a comment")
  })
})

describe("click_id_capture recognises infinite-tag's managed capture", () => {
  it("a managed Next install is PRESENT with the managed-capture copy — not 'not checked'", () => {
    const result = checkClickIdCapture({ files: new Map([["lib/infinite-analytics.ts", managedNextModule()]]) })
    expect(result.state).toBe("ok")
    expect(result.findings[0]!.code).toBe("INF_SETUP_CLICK_ID_PRESENT")
    expect(result.findings[0]!.message).toContain("managed click-id capture")
    // Negative: the same file read raw (the old behaviour) finds no pixel and no capture.
    expect(extractMetaPixelIds(managedNextModule())).toEqual([])
  })

  it("a static managed block reads as the managed capture too", () => {
    const result = checkClickIdCapture({ files: new Map([["index.html", managedPage()]]) })
    expect(result.findings[0]!.message).toContain("managed click-id capture")
  })

  it("an adopted pixel alone keeps the plain copy, which does not claim a capture we did not install", () => {
    const result = checkClickIdCapture({
      files: new Map([["index.html", `<html><head><script>fbq('init', '${ADOPTED}');</script></head><body></body></html>`]])
    })
    expect(result.findings[0]!.message).not.toContain("managed click-id capture")
  })
})
