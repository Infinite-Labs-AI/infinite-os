import { expect, it } from "vitest"
import { isPolicyPath } from "./policy-pages.js"

const positive = [
  "privacy.html", "terms-and-conditions.html", "tos.html", "cookies.html", "product-terms-of-use.html",
  "api/privacy-policy/index.html", "docs/api/privacy-policy.html", "test/privacy-policy.html", "public/privacy.php",
  "app/privacy/page.tsx", "pages/terms.tsx", "app/test/privacy-policy/page.tsx", "pages/test/privacy-policy.tsx",
  "src/app/(marketing)/[locale]/privacy/page.tsx", "app/(legal)/[locale]/cookies/page.tsx",
  "app/routes/privacy.tsx", "app/routes/terms-of-service.tsx", "src/routes/privacy/+page.svelte",
  "src/pages/terms.astro", "src/routes/privacy.tsx", "views/PrivacyPolicy.vue", "src/views/TermsOfService.vue",
  "content/privacy.md", "content/policies/privacy-policy.mdx", "legal/cookies.html", "policies/cookies.html",
  "src/app/legal/cookies/page.tsx", "src/app/policies/cookies/page.tsx", "datenschutzerklaerung.php",
  "pages/datenschutz.tsx", "pages/data-protection.tsx", "eula.htm", "disclaimer.html", "agb.html",
  "mentions-legales.html", "politica-de-privacidad.html", "app/legal/page.tsx", "pages/product-privacy-policy.tsx",
  "app/[product]/legal/page.tsx"
]
const negative = [
  "recipes/cookies.html", "services/legal/index.html", "blog/our-privacy-first-approach.html",
  "insurance/policies/index.html", "app/features/privacy-controls/page.tsx", "content/blog/gdpr-for-startups.md",
  "lib/cookies.ts", "src/lib/auth/cookies.ts", "lib/session-cookie.ts", "src/hooks/useCookies.ts",
  "src/middleware/cookies.ts", "components/TermsCheckbox.tsx", "components/CookieBanner.tsx",
  "lib/i18n/terms.json", "docs/glossary-of-terms.md", "src/legal-entity/index.ts", "src/legal-entity/Card.tsx",
  "PaymentTerms.tsx", "SearchTerms.tsx", "src/gdpr/export-user-data.ts", "src/lib/privacy-mode.ts",
  "packages/legal/index.ts", "packages/legal/components/Card.tsx", "packages/legal/app/layout.tsx",
  "pages/api/terms.ts", "app/privacy/route.ts", "src/api/privacy.ts", "src/search/terms.ts",
  "src/views/Terms.test.tsx", "content/privacy.spec.md", "lib/termstore.ts", "src/cookiejar.ts",
  "app/privacy/PrivacyContent.tsx", "components/legal/TermsOfService.tsx", "src/views/Terms.tsx",
  "components/CCPASettings.vue", "app/dpa/DpaDetails.tsx", "components/Privacy.astro",
  "app/privacy/features/page.tsx", "app/legal/product/page.tsx", "legal/product.html",
  "policy.html", "policies.html",
  "templates/privacy.njk", "views/terms.ejs", "src/routes/privacy/+page.server.ts"
]
it.each(positive)("protects the explicitly named page: %s", path => expect(isPolicyPath(path)).toBe(true))
it.each(negative)("does not treat the ordinary path as a policy page: %s", path => expect(isPolicyPath(path)).toBe(false))

const names = ["privacy", "privacy-policy", "privacypolicy", "terms", "terms-of-use", "terms-of-service", "terms-and-conditions", "termsofservice", "tos", "cookie-policy", "cookies-policy", "cookies", "legal", "eula", "disclaimer", "impressum", "imprint", "datenschutz", "datenschutzerklaerung", "data-protection", "gdpr", "ccpa", "dpa", "agb", "mentions-legales", "politica-de-privacidad"]
const frameworkCases = names.flatMap(name => [
  `app/(marketing)/[locale]/${name}/page.tsx`, `pages/${name}.tsx`, `src/pages/${name}.astro`,
  `app/routes/${name}.tsx`, `src/routes/${name}/+page.svelte`,
  `src/views/${name.split("-").map(part => part[0]!.toUpperCase() + part.slice(1)).join("")}.vue`,
  `${name}.html`, `${name}.php`, `content/${name}.md`, `content/${name}.mdx`, ...(name.includes("-") ? [`product-${name}.html`] : [])
])
it.each(frameworkCases)("supports an explicit listed name in its page convention: %s", path => expect(isPolicyPath(path)).toBe(true))

it.each([
  "recipes/product-cookies.html", "legal/news/cookies.html", "services/product-legal.html",
  "app/(marketing)/[locale]/features/cookies/page.tsx",
  "legal/features.html", "policies/product.html", "packages/legal/app/page.tsx",
  "packages/legal/lib/infinite-analytics-client.tsx", "docs/privacy.md"
])("keeps the explicit depth and page-kind limits: %s", path => expect(isPolicyPath(path)).toBe(false))

it("normalizes separators and an explicitly selected application root without scanning other prefixes", () => {
  expect(isPolicyPath("frontend/site/src/app/(public)/[locale]/Privacy_Policy/page.tsx", "frontend/site")).toBe(true)
  expect(isPolicyPath("frontend/site/src/app/(public)/[locale]/Privacy_Policy/page.tsx")).toBe(false)
  expect(isPolicyPath("src\\pages\\Terms_Of_Service.tsx")).toBe(true)
  expect(isPolicyPath("public/cookies/index.html")).toBe(true)
  expect(isPolicyPath("public/recipes/cookies/index.html")).toBe(false)
})
