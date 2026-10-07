import { expect, it } from "vitest"
import { isPolicyPath } from "./owner-boundary.js"

it.each([
  "terms-and-conditions.html", "tos.html", "cookies.html", "product-terms-of-use.html",
  "app/privacy/PrivacyContent.tsx", "components/legal/TermsOfService.tsx", "src/routes/privacy.tsx",
  "src/views/Terms.tsx", "src/pages/terms.astro", "content/privacy.md", "app/imprint/page.tsx",
  "content/GDPRNotice.md", "components/CCPASettings.vue", "app/dpa/DpaDetails.tsx"
])("protects policy source and content: %s", path => expect(isPolicyPath(path)).toBe(true))

it.each(["pages/api/terms.ts", "src/api/privacy.ts", "src/search/terms.ts", "src/views/Terms.test.tsx", "content/privacy.spec.md", "lib/termstore.ts", "src/cookiejar.ts"])("allows explicit non-policy or unbounded-name code: %s", path => expect(isPolicyPath(path)).toBe(false))
