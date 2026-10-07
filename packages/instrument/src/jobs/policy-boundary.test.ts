import { expect, it } from "vitest"
import { isPolicyPath } from "./owner-boundary.js"

it.each(["privacy.html", "terms-of-use.php", "app/(marketing)/[locale]/privacy/page.tsx", "app/routes/privacy.tsx", "views/PrivacyPolicy.vue"])("exports the direct page classifier through the owner boundary: %s", path => {
  expect(isPolicyPath(path)).toBe(true)
})
it.each(["components/Policy.tsx", "components/Policy.mdx", "templates/privacy.njk", "views/terms.ejs", "docs/privacy.md"])("does not infer policy scope for components, templates or docs: %s", path => {
  expect(isPolicyPath(path)).toBe(false)
})
