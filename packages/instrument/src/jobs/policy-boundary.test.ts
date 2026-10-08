import { expect, it } from "vitest"
import { isPolicyPath } from "./owner-boundary.js"

it("exports the direct page classifier through the owner boundary", () => {
  expect(isPolicyPath("app/(marketing)/[locale]/privacy/page.tsx")).toBe(true)
  expect(isPolicyPath("components/Policy.tsx")).toBe(false)
})
