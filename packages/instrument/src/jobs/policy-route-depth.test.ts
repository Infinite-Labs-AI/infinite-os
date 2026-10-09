import { expect, it } from "vitest"
import { isPolicyPath } from "./policy-pages.js"

it("does not match a single policy word in an ordinary route", () => {
  for (const path of ["chocolate-cookies.html", "payment-terms.html", "blog/gdpr.html", "features/privacy/index.html", "api/privacy/index.html", "app/test/privacy/page.tsx"]) {
    expect(isPolicyPath(path), path).toBe(false)
  }
})

it("matches an exact single name only at depth one or directly under legal/policies or a locale segment", () => {
  for (const name of ["privacy", "cookies", "impressum"]) {
    for (const prefix of ["", "legal/", "policies/", "en/", "pt-BR/", "[lang]/", "[[lang]]/", "app/(marketing)/[language]/"]) {
      const path = prefix.startsWith("app/") ? `${prefix}${name}/page.tsx` : `${prefix}${name}.html`
      expect(isPolicyPath(path), path).toBe(true)
    }
    for (const path of [`features/${name}.html`, `product-${name}.html`, `legal/news/${name}.html`, `app/[...slug]/${name}/page.tsx`]) {
      expect(isPolicyPath(path), path).toBe(false)
    }
  }
})

it("matches a multiword name or its product suffix at any route depth", () => {
  for (const name of ["privacy-policy", "terms-of-service"]) {
    for (const path of [`${name}.html`, `docs/archive/${name}.html`, `features/product-${name}.html`, `app/shop/${name}/page.tsx`]) {
      expect(isPolicyPath(path), path).toBe(true)
    }
  }
})

it("counts route depth from the selected app root", () => {
  expect(isPolicyPath("apps/store/en/privacy/index.html", "apps/store")).toBe(true)
  expect(isPolicyPath("apps/store/en/privacy/index.html")).toBe(false)
  expect(isPolicyPath("apps/store/src/app/(public)/[market]/terms/page.tsx", "apps/store")).toBe(true)
})
