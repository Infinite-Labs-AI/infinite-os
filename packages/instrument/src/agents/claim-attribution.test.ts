// Attribution by claim (live run 2): the change between one `job_claim` and the next is the claiming job's, so two jobs
// that share a page no longer co-own every block on it.
import { describe, expect, it } from "vitest"

import { BASE_PAGE, leadPage, silentFormPage } from "../../test/wizard/live-run-2.js"
import { claimOwners, nearestOwner, type ClaimMark } from "./claim-attribution.js"
import { hunksOf, splitLines } from "./line-diff.js"

function owners(before: string, marks: Array<{ jobId: string; text: string; credit?: boolean }>, after: string): Array<{ added: string[]; owners: string[] }> {
  const a = splitLines(before)
  const b = splitLines(after)
  const hunks = hunksOf(a, b)
  const claimMarks: ClaimMark[] = marks.map((mark) => ({ jobId: mark.jobId, lines: splitLines(mark.text), credit: mark.credit ?? true }))
  const result = claimOwners(a, b, claimMarks, hunks)
  return hunks.map((hunk, index) => ({ added: b.slice(hunk.bStart, hunk.bEnd).map((line) => line.trim()), owners: result[index]! }))
}

describe("attribution by claim", () => {
  it("live run 2: the lead's blocks on the shared page are the lead's alone; only the adjacent import lines are shared", () => {
    const lead = leadPage()
    const final = silentFormPage(lead)
    const got = owners(BASE_PAGE, [{ jobId: "server_conversions:lead", text: lead }, { jobId: "setup_check_fixes:silent_form", text: final }], final)
    const of = (needle: string) => got.find((hunk) => hunk.added.some((line) => line.includes(needle)))?.owners
    // The two new imports sit on adjacent lines, so they are one block: each job wrote one line of it.
    expect(of("getConsent } from")).toEqual(["server_conversions:lead", "setup_check_fixes:silent_form"])
    expect(of("adMatch: getConsent()")).toEqual(["server_conversions:lead"])
    expect(of('infiniteTrack("lead")')).toEqual(["setup_check_fixes:silent_form"])
    expect(of('data-conversion="lead"')).toEqual(["setup_check_fixes:silent_form"])
  })

  it("a later job that rewrites an earlier job's lines makes the block shared (it builds on them)", () => {
    const before = "a\nb\nc\n"
    const first = "a\nB1\nc\n"
    const second = "a\nB2\nc\n"
    expect(owners(before, [{ jobId: "one", text: first }, { jobId: "two", text: second }], second).map((hunk) => hunk.owners)).toEqual([["one", "two"]])
  })

  it("edits after the last claim, and a claim by a job whose files do not cover the file, credit nobody (the caller picks ONE nearest job)", () => {
    const before = "a\nb\nc\nd\n"
    const claimed = "a\nB\nc\nd\n"
    const after = "a\nB\nc\nD\n"
    const got = owners(before, [{ jobId: "one", text: claimed }], after)
    expect(got.map((hunk) => hunk.owners)).toEqual([["one"], []])
    expect(owners(before, [{ jobId: "elsewhere", text: claimed, credit: false }], claimed).map((hunk) => hunk.owners)).toEqual([[]])
  })

  it("a deletion is credited to the claim that made it", () => {
    const before = "a\nb\nc\nd\n"
    const first = "a\nc\nd\n"
    const second = "a\nc\nD\n"
    expect(owners(before, [{ jobId: "one", text: first }, { jobId: "two", text: second }], second).map((hunk) => hunk.owners)).toEqual([["one"], ["two"]])
  })

  it("with no claim at all, a hunk goes to ONE job: the nearest evidence line, else the last claim naming the file, else the first", () => {
    const candidates = [
      { itemId: "far", evidence: [{ file: "page.tsx", line: 40 }] },
      { itemId: "near", evidence: [{ file: "page.tsx", line: 12 }] },
      { itemId: "route", evidence: [{ file: "route.ts", line: 3 }] }
    ]
    expect(nearestOwner("page.tsx", { aStart: 9, aEnd: 10, bStart: 9, bEnd: 11 }, candidates)).toBe("near")
    expect(nearestOwner("other.tsx", { aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 }, candidates, ["route", "far"])).toBe("far")
    expect(nearestOwner("other.tsx", { aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 }, candidates)).toBe("far")
  })
})
