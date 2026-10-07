import { expect, it } from "vitest"
import { isPolicyPath } from "./owner-boundary.js"

const pages = [
  "terms-and-conditions.html", "tos.html", "cookies.html", "product-terms-of-use.html",
  "api/privacy/index.html", "docs/api/privacy.html", "test/privacy.html",
  "app/privacy/page.tsx", "pages/terms.tsx", "src/routes/privacy.tsx", "src/pages/terms.astro",
  "src/routes/privacy/+page.svelte", "content/privacy.md", "content/GDPRNotice.md",
  "app/imprint/page.tsx", "app/dpa/page.tsx", "app/privacypolicy/page.tsx", "pages/privacynotice.tsx",
  "cookiepolicy.html", "cookiesnotice.htm", "pages/termsofservice.tsx", "src/app/termsofuse/page.mdx",
  "apps/web/pages/termsconditions.tsx", "datenschutz.html", "pages/data-protection.tsx",
  "eula.htm", "disclaimer.html", "policy.html", "policies.html", "agb.html",
  "mentions-legales.html", "politica-de-privacidad.html", "content/policies/privacy-notice.mdx",
]
it.each(pages)("protects a policy page or page content: %s", path => expect(isPolicyPath(path)).toBe(true))

const ordinary = [
  "lib/cookies.ts", "src/lib/auth/cookies.ts", "lib/session-cookie.ts", "src/hooks/useCookies.ts",
  "src/middleware/cookies.ts", "components/TermsCheckbox.tsx", "components/CookieBanner.tsx",
  "lib/i18n/terms.json", "docs/glossary-of-terms.md", "src/legal-entity/index.ts",
  "src/legal-entity/Card.tsx", "PaymentTerms.tsx", "SearchTerms.tsx", "src/gdpr/export-user-data.ts",
  "src/lib/privacy-mode.ts", "packages/legal/index.ts", "packages/legal/components/Card.tsx",
  "packages/legal/app/layout.tsx", "packages/legal/app/page.tsx", "packages/legal/lib/infinite-analytics-client.tsx",
  "pages/api/terms.ts", "app/privacy/route.ts", "src/api/privacy.ts", "src/search/terms.ts",
  "src/views/Terms.test.tsx", "content/privacy.spec.md", "lib/termstore.ts", "src/cookiejar.ts",
  "app/privacy/PrivacyContent.tsx", "components/legal/TermsOfService.tsx", "src/views/Terms.tsx",
  "components/CCPASettings.vue", "app/dpa/DpaDetails.tsx", "components/Privacy.astro",
]
it.each(ordinary)("does not infer a policy page from an ordinary module path: %s", path => expect(isPolicyPath(path)).toBe(false))

it("protects a component only when its direct importers are all policy pages", () => {
  const sources = new Map([
    ["app/privacy/page.tsx", 'import Policy from "../../components/Policy"; export default Policy'],
    ["app/terms/page.tsx", 'import Policy from "@/components/Policy"; export default Policy'],
    ["components/Policy.tsx", 'import Detail from "./Detail"; export default function Policy() { return <Detail /> }'],
    ["components/Detail.tsx", 'export default function Detail() { return <p>Policy detail</p> }'],
  ])
  expect(isPolicyPath("components/Policy.tsx", ".", sources)).toBe(true)
  expect(isPolicyPath("components/Detail.tsx", ".", sources)).toBe(false)
  sources.set("app/page.tsx", 'import Policy from "../components/Policy"; export default Policy')
  expect(isPolicyPath("components/Policy.tsx", ".", sources)).toBe(false)
})

it("uses explicit URL metadata or a render call for otherwise unproven templates and docs", () => {
  const sources = new Map([
    ["docs/privacy.md", "---\npermalink: /privacy/\n---\nPolicy text"],
    ["templates/privacy.njk", "---\npermalink: /privacy/\n---\n<p>Policy</p>"],
    ["views/terms.ejs", "<p>Terms</p>"],
    ["server.ts", "app.get('/terms', (req, res) => res.render('terms'));"],
    ["templates/cookie-helper.liquid", "Cookie helper"],
  ])
  expect(isPolicyPath("docs/privacy.md", ".", sources)).toBe(true)
  expect(isPolicyPath("templates/privacy.njk", ".", sources)).toBe(true)
  expect(isPolicyPath("views/terms.ejs", ".", sources)).toBe(true)
  expect(isPolicyPath("templates/cookie-helper.liquid", ".", sources)).toBe(false)
})
