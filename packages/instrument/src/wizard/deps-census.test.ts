// Review P3-3: the brief's adopted-init sites never read "none" because the census failed.
import { describe, expect, it, vi } from "vitest"

vi.mock("../checks/census.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../checks/census.js")>()),
  runCensus: () => {
    throw new Error("EACCES: permission denied, scandir 'app'")
  }
}))

const { adoptedInitSites } = await import("./deps.js")

describe("adoptedInitSites (review P3-3)", () => {
  it("a census that cannot run is a named failure, never an empty list", () => {
    expect(() => adoptedInitSites("/repo", ".")).toThrow(
      "the code census could not run (EACCES: permission denied, scandir 'app'), so the brief cannot say where your existing tags are"
    )
  })
})
