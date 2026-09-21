import { describe, expect, it } from "vitest"

import { checkClickIdCapture, isSharedEntry } from "./click-id-capture.js"

const PIXEL = "fbq('init', '914812061724377');\nfbq('track', 'PageView');"
const PAGE = (body: string) => `<html><head>${body}</head><body><h1>Hi</h1></body></html>`

function check(files: Record<string, string>) {
  return checkClickIdCapture({ files: new Map(Object.entries(files)) })
}

describe("_fbc capture at the landing page", () => {
  /** THE FIXTURE FOR THE DEFECT: the pixel boots only where the visitor ALREADY converted. */
  it("catches a pixel that only initialises on a conversion page", () => {
    const result = check({
      "src/app/layout.tsx": "export default function Layout({ children }) { return children }",
      "src/app/thank-you/page.tsx": `<script>${PIXEL}</script>`
    })
    expect(result.state).toBe("problem")
    const finding = result.findings[0]!
    expect(finding.code).toBe("INF_SETUP_CLICK_ID_NOT_AT_LANDING")
    expect(finding.confidence).toBe("certain")
    expect(finding.message).toContain("src/app/thank-you/page.tsx")
    expect(finding.message).toContain("an ad click puts `fbclid` on the LANDING url only")
    expect(finding.message).toContain("do not retrieve them only from down-funnel events")
    expect(finding.message).toContain("src/app/layout.tsx")
  })

  it("catches a multi-page site where only some landing pages boot the pixel", () => {
    const result = check({
      "index.html": PAGE(`<script>${PIXEL}</script>`),
      "pricing/index.html": PAGE(""),
      "guides/seo/index.html": PAGE("")
    })
    expect(result.state).toBe("problem")
    const finding = result.findings[0]!
    expect(finding.code).toBe("INF_SETUP_CLICK_ID_NOT_AT_LANDING")
    expect(finding.message).toContain("pricing/index.html")
    expect(finding.message).toContain("guides/seo/index.html")
    expect(finding.message).toContain("ads link deep")
  })

  it("passes a pixel in a shared entry, without claiming a cookie was written", () => {
    const result = check({ "src/app/layout.tsx": `<script>${PIXEL}</script>` })
    expect(result.state).toBe("ok")
    expect(result.findings[0]!.code).toBe("INF_SETUP_CLICK_ID_PRESENT")
    expect(result.findings[0]!.message).toContain("it is not proof a cookie was written")
  })

  it("passes a single static page that carries the pixel", () => {
    expect(check({ "index.html": PAGE(`<script>${PIXEL}</script>`) }).state).toBe("ok")
  })

  it("says undetermined — never ok — when no pixel is in the source at all", () => {
    const result = check({ "src/app/layout.tsx": "export default function Layout() {}" })
    expect(result.state).toBe("undetermined")
    expect(result.findings[0]!.code).toBe("INF_SETUP_CLICK_ID_UNDETERMINED")
    expect(result.findings[0]!.message).toContain('this is "not checked", not "not needed"')
  })

  it("does not count an html fragment as a landing page", () => {
    const result = check({
      "index.html": PAGE(`<script>${PIXEL}</script>`),
      "partials/footer.html": "<footer>© Infinite</footer>"
    })
    expect(result.state).toBe("ok")
  })

  it("knows the entries every route loads", () => {
    expect(isSharedEntry("index.html")).toBe(true)
    expect(isSharedEntry("app/layout.tsx")).toBe(true)
    expect(isSharedEntry("pages/_app.jsx")).toBe(true)
    expect(isSharedEntry("lib/infinite-analytics.ts")).toBe(true)
    expect(isSharedEntry("src/main.tsx")).toBe(true)
    expect(isSharedEntry("app/thank-you/page.tsx")).toBe(false)
  })
})
