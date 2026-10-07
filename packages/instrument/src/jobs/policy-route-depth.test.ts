import { expect, it } from "vitest"
import { isPolicyPath, POLICY_PAGE_NAMES } from "./policy-pages.js"

it.each([
  "chocolate-cookies.html", "payment-terms.html", "glossary-of-terms.html", "blog/gdpr.html",
  "features/privacy/index.html", "pricing/terms.html", "search-terms.html", "blog/privacy.html",
  "api/privacy/index.html", "docs/api/privacy.html", "app/test/privacy/page.tsx", "pages/test/privacy.tsx",
])("does not match a single policy word in an ordinary route: %s", path => {
  expect(isPolicyPath(path)).toBe(false)
})

const singleNames = POLICY_PAGE_NAMES.filter(name => !name.includes("-"))
it.each(singleNames)("matches the exact single name %s only at depth one or directly under legal/policies", name => {
  for (const prefix of ["", "legal/", "policies/", "en/", "de/", "pt-BR/", "[lang]/", "[market]/", "[[lang]]/", "app/(marketing)/[language]/"]) {
    const path = prefix.startsWith("app/") ? `${prefix}${name}/page.tsx` : `${prefix}${name}.html`
    expect(isPolicyPath(path), path).toBe(true)
  }
  for (const path of [`features/${name}.html`, `product-${name}.html`, `legal/news/${name}.html`, `app/[...slug]/${name}/page.tsx`]) {
    expect(isPolicyPath(path), path).toBe(false)
  }
})

it.each(POLICY_PAGE_NAMES.filter(name => name.includes("-")))("matches the multiword name %s or its product suffix at any route depth", name => {
  for (const path of [`${name}.html`, `docs/archive/${name}.html`, `features/product-${name}.html`, `app/shop/${name}/page.tsx`]) {
    expect(isPolicyPath(path), path).toBe(true)
  }
})

it("counts route depth from the selected app root", () => {
  expect(isPolicyPath("apps/store/en/privacy/index.html", "apps/store")).toBe(true)
  expect(isPolicyPath("apps/store/en/privacy/index.html")).toBe(false)
  expect(isPolicyPath("apps/store/src/app/(public)/[market]/terms/page.tsx", "apps/store")).toBe(true)
})
