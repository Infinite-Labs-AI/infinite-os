import { describe, expect, it } from "vitest"

import { checkClickIdCapture } from "./click-id-capture.js"
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

  it("refuses capture text in a comment, string or dead function", () => {
    const capture = buildMetaClickIdCaptureTypescript({ gate: { kind: "infinite-consent", mode: "not_required" } })
    for (const source of [`/*\n${capture}\n*/\n${pixel}`, `const example = \`${capture}\`;\n${pixel}`, `function neverCalled() {\n${capture}\n}\n${pixel}`]) {
      expect(check(moduleSite(source)).state).toBe("problem")
    }
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
    expect(finding.message).toContain("could not prove")
    expect(finding.message).toContain("does not follow imports")
    expect(finding.message).not.toContain("initialises only in page-scoped files")
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

  it("says undetermined — never ok — when no pixel is in the source at all", () => {
    const result = check({ "src/app/layout.tsx": "export default function Layout() {}" })
    expect(result.state).toBe("undetermined")
    expect(result.findings[0]!.code).toBe("INF_SETUP_CLICK_ID_UNDETERMINED")
    expect(result.findings[0]!.message).toContain('this is "not checked", not "not needed"')
  })
})

it.each([
  'const example = "fbq(\'init\', \'555500001111222\');";',
])("does not count a comment, quoted example, or loader alone as an init: %s", source => {
  const html = source.startsWith("<script") ? source : `<script>${source}</script>`
  expect(check({ "index.html": PAGE(html) }).state).toBe("undetermined")
})
