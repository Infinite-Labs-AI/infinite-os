import { describe, expect, it } from "vitest"
import { checksSummary, checkPolicy } from "./checks.js"

describe("PR check classification", () => {
  it("keeps a cancelled first poll pending for another read", () => {
    expect(checksSummary([{ name: "test", bucket: "cancel", state: "CANCELLED" }])).toEqual({ pass: 0, fail: 0, pending: 1, total: 1 })
  })

  it("treats a blocked hosting preview as not measured", () => {
    expect(checksSummary([{ name: "Vercel", bucket: "fail", state: "FAILURE", description: "Deployment was blocked" }])).toEqual({ pass: 0, fail: 0, pending: 0, total: 1 })
  })
})

describe("base comparison policy", () => {
  const red = { name: "test", bucket: "fail", state: "FAILURE" }
  it("allows only failures known to be red on the base", () => {
    expect(checkPolicy([red], [red]).existing).toEqual([red])
    expect(checkPolicy([red], [{ ...red, bucket: "pass" }]).failing).toEqual([red])
    expect(checkPolicy([red], null).failing).toEqual([red])
    expect(checkPolicy([red], []).failing).toEqual([red])
    expect(checkPolicy([red], [red, { ...red, bucket: "pass" }]).failing).toEqual([red])
  })
  it("does not hide an ordinary hosting failure or unrelated blocked test", () => {
    expect(checkPolicy([{ ...red, name: "Vercel", description: "Build failed" }], []).failing).toHaveLength(1)
    expect(checkPolicy([{ ...red, name: "Vercel", description: "Build failed: permission denied reading a file" }], []).failing).toHaveLength(1)
    expect(checkPolicy([{ ...red, description: "Deployment was blocked" }], []).failing).toHaveLength(1)
  })
})
