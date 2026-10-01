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
    const none = check({ "src/app/page.tsx": "<main>Nothing here</main>" })
    expect(none.state).toBe("undetermined")
    expect(none.findings[0]!.message).toContain('"not checked", not "off"')
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
