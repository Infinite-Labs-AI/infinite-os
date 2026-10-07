// Live run 4's "what happened" comment, replayed (R4-4, R4-9). The fixtures are the comment as the wizard posted it at
// the merge card (`merge-comment-body.md`), the final report (`report.md`) and the comment after the live check, as it
// was on GitHub (`final-comment-body.md`: two headlines, and "Meta [redacted: phone]").
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { maskIdentifier } from "../checks/result.js"
import { withFinalReport } from "./post.js"
import { createScanner } from "./scan.js"

const RUN4 = join(__dirname, "../../test/wizard/fixtures/run4/wizard")
const fixture = (name: string) => readFileSync(join(RUN4, name), "utf8")
const HEADLINE = /^\*\*shop\.examplebrand\.com[^\n]*\*\*$/gm
const META_PIXEL = "7777000011112222"

describe("R4-4: the final comment carries ONE headline, the final verdict", () => {
  it("the merge-time headline and its reasons are replaced together with the table", () => {
    const merged = withFinalReport(fixture("merge-comment-body.md"), fixture("report.md"))
    expect(merged).not.toBeNull()
    const headlines = merged!.match(HEADLINE) ?? []
    expect(headlines).toEqual([
      "**shop.examplebrand.com does not collect properly yet: 1 problem on the live site (spa page views) · 1 approved fix is not in the code (Improve the existing Meta pixel)**"
    ])
    expect(merged).not.toContain("not checked live yet")
    // Everything around the report is kept as posted.
    expect(merged!.startsWith("**infinite-tag: what happened**\n\nReviewed by Codex (incomplete: R15 not checked).")).toBe(true)
    expect(merged).toContain("**Checklist (the wizard's own checks, never the agent's word)**")
    expect(merged).toContain("Updated after the live check: the table above is the run's final report")
    expect(merged).toContain("<!-- infinite-tag:final v1 run=85483904-c9a1-4125-bb85-8fd66e709247 -->")
  })

  it("negative: the comment live run 4 left on GitHub held two contradicting headlines", () => {
    expect(fixture("final-comment-body.md").match(HEADLINE)).toHaveLength(2)
  })

  it("a body not in the comment's shape is left alone (nothing guessed)", () => {
    expect(withFinalReport("### Before and after\n\n| a |", fixture("report.md"))).toBeNull()
  })
})

describe("public ids and phone-like values remain readable", () => {
  const line = `- Sending, but its ID is not checked (not connected in Infinite): Meta ${maskIdentifier(META_PIXEL)}`

  it("the masked id of a pixel the run read from the site's code stays readable", () => {
    const scanner = createScanner({ literals: [], allowedIds: [META_PIXEL] })
    expect(scanner.redact(line)).toEqual({ text: line, hits: [] })
    expect(scanner.redact(fixture("report.md")).hits.map(hit => hit.kind)).not.toContain("phone")
  })

  it("the same line stays readable without known ids", () => {
    expect(createScanner({ literals: [], allowedIds: [] }).redact(line).text).toBe(line)
  })

  it("phone-like values stay readable beside the allowed pixel, in every written shape", () => {
    const scanner = createScanner({ literals: [], allowedIds: [META_PIXEL] })
    for (const phone of ["+44 20 7946 0958", "(415) 555-0123", "415-555-0123", "+1 415 555 0123", "777700...2223"]) {
      expect(scanner.redact(`call ${phone} now`).text, phone).toBe(`call ${phone} now`)
    }
  })
})
