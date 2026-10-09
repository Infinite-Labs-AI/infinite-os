import { describe, expect, it } from "vitest"

import { classifyReview, quotedReadCheck } from "./brief.js"

describe("the reviewer's read-check", () => {
  it("accepts the nonce with punctuation around it (a live review was thrown away over a full stop)", () => {
    expect(quotedReadCheck("read-check: a01209a6a060ad6c. Server conversion wiring is sound")).toBe("a01209a6a060ad6c")
    expect(quotedReadCheck("read-check: `a01209a6a060ad6c`, then the rest")).toBe("a01209a6a060ad6c")
    expect(quotedReadCheck("read-check: a01209a6a060ad6c\nAll 11 questions pass")).toBe("a01209a6a060ad6c")
  })

  it("still refuses a missing or wrong nonce", () => {
    expect(quotedReadCheck("All good")).toBeNull()
    expect(quotedReadCheck("read-check: .")).toBeNull()
    const review = { verdict: "approve", summary: "read-check: ffffffffffffffff. Looks fine", checklist: [], findings: [] } as never
    expect(classifyReview(review, "a01209a6a060ad6c").unchecked).toContain("read-check missing or incorrect")
  })

  it("classifies a punctuated but correct nonce as read", () => {
    const review = { verdict: "approve", summary: "read-check: a01209a6a060ad6c. Looks fine", checklist: [], findings: [] } as never
    expect(classifyReview(review, "a01209a6a060ad6c").unchecked).not.toContain("read-check missing or incorrect")
  })
})
