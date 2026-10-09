import { expect, it } from "vitest"
import { isPolicyPath } from "./policy-pages.js"

// One row per framework page convention / naming shape.
const positive = [
  "privacy.html", "eula.htm", "public/privacy.php", "product-terms-of-use.html", "legal/cookies.html",
  "app/privacy/page.tsx", "pages/terms.tsx", "src/app/(marketing)/[locale]/privacy/page.tsx",
  "app/routes/terms-of-service.tsx", "src/routes/privacy/+page.svelte", "src/pages/terms.astro",
  "views/PrivacyPolicy.vue", "content/policies/privacy-policy.mdx", "datenschutzerklaerung.php",
  "mentions-legales.html", "app/legal/page.tsx", "app/[product]/legal/page.tsx"
]
// The distinct "ordinary path is NOT a policy page" shapes: code modules, components, API routes,
// tests, templates, blog posts, feature pages, and the depth / page-kind limits.
const negative = [
  "lib/cookies.ts", "components/CookieBanner.tsx", "components/TermsCheckbox.tsx",
  "blog/our-privacy-first-approach.html", "recipes/cookies.html", "app/features/privacy-controls/page.tsx",
  "pages/api/terms.ts", "app/privacy/route.ts", "app/privacy/PrivacyContent.tsx", "src/views/Terms.test.tsx",
  "templates/privacy.njk", "src/routes/privacy/+page.server.ts", "policy.html", "packages/legal/index.ts",
  "legal/news/cookies.html", "app/(marketing)/[locale]/features/cookies/page.tsx", "docs/privacy.md"
]
const names = ["privacy", "privacy-policy", "privacypolicy", "terms", "terms-of-use", "terms-of-service", "terms-and-conditions", "termsofservice", "tos", "cookie-policy", "cookies-policy", "cookies", "legal", "eula", "disclaimer", "impressum", "imprint", "datenschutz", "datenschutzerklaerung", "data-protection", "gdpr", "ccpa", "dpa", "agb", "mentions-legales", "politica-de-privacidad"]

it("protects the explicitly named policy page in each framework convention", () => {
  for (const path of positive) expect(isPolicyPath(path), path).toBe(true)
})

it("protects every listed policy name", () => {
  for (const name of names) expect(isPolicyPath(`pages/${name}.tsx`), name).toBe(true)
})

it("does not treat the ordinary path as a policy page", () => {
  for (const path of negative) expect(isPolicyPath(path), path).toBe(false)
})

it("normalizes separators and an explicitly selected application root without scanning other prefixes", () => {
  expect(isPolicyPath("frontend/site/src/app/(public)/[locale]/Privacy_Policy/page.tsx", "frontend/site")).toBe(true)
  expect(isPolicyPath("frontend/site/src/app/(public)/[locale]/Privacy_Policy/page.tsx")).toBe(false)
  expect(isPolicyPath("src\\pages\\Terms_Of_Service.tsx")).toBe(true)
  expect(isPolicyPath("public/cookies/index.html")).toBe(true)
  expect(isPolicyPath("public/recipes/cookies/index.html")).toBe(false)
})
