import { describe, expect, it } from "vitest"

import { checkClickIdCapture, isSharedEntry } from "./click-id-capture.js"
import { buildMetaClickIdCaptureTypescript } from "../providers/meta-browser/click-id.js"

const PIXEL = "fbq('init', '555500001111222');\nfbq('track', 'PageView');"
const PAGE = (body: string) => `<html><head>${body}</head><body><h1>Hi</h1></body></html>`

function check(files: Record<string, string>) {
  return checkClickIdCapture({ files: new Map(Object.entries(files)) })
}

describe("_fbc capture at the landing page", () => {
  const modulePath = "src/common/tracking.ts"
  const app = "import Consent from '../components/Consent'; export default function App() { return <Consent /> }"
  const consent = "import { boot } from '../src/common/tracking'; export default function Consent() { boot(); return null }"
  const pixel = "export function boot() { fbq('init', '555500001111222'); }"
  const moduleSite = (source: string) => ({ "pages/_app.tsx": app, "components/Consent.tsx": consent, [modulePath]: source })

  it("keeps an imported pixel with no capture, including a submit-only init, off the landing-time pass path", () => {
    for (const source of [pixel, "export function submit() { fbq('init', '555500001111222'); }"]) {
      expect(check(moduleSite(source))).toMatchObject({ state: "problem", findings: [{ code: "INF_SETUP_CLICK_ID_NOT_AT_LANDING" }] })
    }
  })

  it("does not execute an import type edge", () => {
    const capture = buildMetaClickIdCaptureTypescript({ gate: { kind: "infinite-consent", mode: "not_required" } })
    for (const imported of ["import type { boot } from '../src/common/tracking'", "import { type boot } from '../src/common/tracking'"]) {
      const files = { "pages/_app.tsx": `${imported}; export default function App() { return null }`, [modulePath]: `${capture}\n${pixel}` }
      expect(check(files).state).toBe("problem")
    }
  })

  it("refuses capture text in a comment, string or dead function", () => {
    const capture = buildMetaClickIdCaptureTypescript({ gate: { kind: "infinite-consent", mode: "not_required" } })
    for (const source of [`/*\n${capture}\n*/\n${pixel}`, `const example = \`${capture}\`;\n${pixel}`, `function neverCalled() {\n${capture}\n}\n${pixel}`]) {
      expect(check(moduleSite(source)).state).toBe("problem")
    }
  })

  it("recognises the same module statements after re-indentation and CRLF conversion", () => {
    const capture = buildMetaClickIdCaptureTypescript({ gate: { kind: "infinite-consent", mode: "not_required" } })
    const indented = capture.split("\n").map((line) => `  ${line}`).join("\r\n")
    expect(check(moduleSite(`${indented}\r\n${pixel}`)).findings[0]?.message).toContain("managed click-id capture")
  })

  it("recognises the exact module capture imported through the shared app entry", () => {
    const capture = buildMetaClickIdCaptureTypescript({ gate: { kind: "infinite-consent", mode: "not_required" } })
    const files = {
      "pages/_app.tsx": "import '../components/MarketingConsent'; export default function App() { return null }",
      "components/MarketingConsent.tsx": "import '../src/common/tracking'; export function MarketingConsent() { return null }",
      "src/common/tracking.ts": `${capture}\nexport function startMeta() { fbq('init', '555500001111222'); }`
    }
    const result = check(files)
    expect(result.state).toBe("ok")
    expect(result.findings[0]?.message).toContain("managed click-id capture")
    const broken = check({ ...files, "src/common/tracking.ts": files["src/common/tracking.ts"].replace('document.cookie = "_fbc=" + value', 'void "_fbc=" + value') })
    expect(broken.state).toBe("problem")
  })
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
