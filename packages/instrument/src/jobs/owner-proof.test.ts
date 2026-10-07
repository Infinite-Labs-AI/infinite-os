import { expect, it } from "vitest"
import { OWNER_BOUNDARY, withOwnerBoundary } from "./owner-boundary.js"
import type { OwnerBoundaryMeasurement } from "./owner-diff.js"

const proof: OwnerBoundaryMeasurement = { state: "checked", scope: "commit", baseSha: "a".repeat(40), headSha: "b".repeat(40), wizardCommits: ["b".repeat(40)], measuredCommitCount: 1, files: ["src/tracking.ts"], issues: [] }

it("states only the recognised-call boundary after a positive measured commit count", () => {
  const output = withOwnerBoundary("Report", false, proof)
  expect(output).toContain("This run did not edit your privacy or terms pages, or any code where it recognised a consent call (checked against the commits it made). Consent and privacy are yours: please review the files this run changed.")
  expect(output).toContain("src/tracking.ts")
  expect(output).not.toContain("changed neither")
})

it.each([undefined, { state: "checked" as const }, { ...proof, measuredCommitCount: 0, wizardCommits: [] }, { ...proof, state: "not_checked" as const, unverifiedReason: "an earlier run has no commit record" }])("never promotes missing, zero or legacy measurement to a full-run claim", measured => {
  const output = withOwnerBoundary("Your consent code and privacy policy are yours; this run changed neither (checked against this run’s recorded commits).", false, measured)
  expect(output).toContain("This run could not check its own commits against your consent code and policy pages (")
  expect(output).not.toContain("changed neither")
  expect(output).not.toContain(OWNER_BOUNDARY)
  if (measured?.unverifiedReason) expect(output).toContain(measured.unverifiedReason)
})

it("bounds and sanitises changed paths and does not duplicate them on re-render", () => {
  const files = ["src/<!--@reviewer-[click](https://example.test)-sk_test_fixtureSecret123456.ts", ...Array.from({ length: 30 }, (_, n) => `src/file-${n}.ts`)]
  const first = withOwnerBoundary("Report", false, { ...proof, files })
  const output = withOwnerBoundary(first, false, { ...proof, files })
  expect(output).toBe(first)
  for (const unsafe of ["<!--", "@reviewer", "[click](", "sk_test_fixtureSecret123456"]) expect(output).not.toContain(unsafe)
  expect(output).toContain("more changed files")
  expect(output).not.toContain("src/file-29.ts")
})
