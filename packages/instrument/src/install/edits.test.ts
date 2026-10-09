import { describe, expect, it } from "vitest"

import { applyTextEdits, reverseTextEdits } from "../server-lane/text-edits.js"

import { makeEditRecord, refreshFromHead, reverseEditRecord, sha256Tagged, textEditsBetween } from "./edits.js"

describe("textEditsBetween (exact, minimal, reversible)", () => {
  const cases: Array<[string, string]> = [
    ["", "created\n"],
    ["<head>\n</head>", "<head>\n<script>x</script>\n</head>"],
  ]
  it.each(cases)("round-trips %j → %j", (before, after) => {
    const edits = textEditsBetween(before, after)
    expect(applyTextEdits(before, edits)).toBe(after)
    expect(reverseTextEdits(after, edits)).toBe(before)
  })

  it("round-trips interleaved changes, a missing final newline and pure deletions", () => {
    const pairs: Array<[string, string]> = [
      ["a\nb\nc\nd\ne\n", "a\nB\nc\nD\ne\nf"],
      ["one\ntwo\nthree", "one\nthree"],
      ["x\ny\n", ""],
      ["keep\n", "new\nkeep\nnew\n"]
    ]
    for (const [before, after] of pairs) {
      const edits = textEditsBetween(before, after)
      expect(applyTextEdits(before, edits)).toBe(after)
      expect(reverseTextEdits(after, edits)).toBe(before)
    }
  })
})

describe("reverseEditRecord", () => {
  const record = makeEditRecord({ file: "index.html", before: "one\n", after: "one\ntwo\n", jobId: null, planLineId: "l1", by: "wizard", runId: "run-1" })

  it("NEGATIVE: leaves a file that changed since alone", () => {
    expect(reverseEditRecord("one\ntwo\nthree\n", record)).toEqual({ ok: false, reason: "changed_since" })
    expect(reverseEditRecord(null, record)).toEqual({ ok: false, reason: "missing" })
  })

  it("a record that created the file reverses to removal", () => {
    const created = makeEditRecord({ file: "new.ts", before: null, after: "export {}\n", jobId: "csp", planLineId: null, by: "agent", runId: "run-1" })
    expect(created.beforeHash).toBeNull()
    expect(reverseEditRecord("export {}\n", created)).toEqual({ ok: true, content: null })
  })
})

describe("refreshFromHead (§3e.6: a hook rewrote a recorded file)", () => {
  const base = "<head>\n</head>\n"
  const mid = "<head>\n<x/>\n</head>\n"
  const first = makeEditRecord({ file: "index.html", before: base, after: mid, jobId: null, planLineId: "l1", by: "wizard", runId: "r", seq: 0 })
  const second = makeEditRecord({ file: "index.html", before: mid, after: "<head>\n<x/>\n<y/>\n</head>\n", jobId: "csp", planLineId: null, by: "agent", runId: "r", seq: 1 })
  const befores = new Map<string, string | null>([
    [first.id, base],
    [second.id, mid]
  ])

  it("rebases the newest record onto the committed blob, so uninstall still restores the exact pre-edit bytes", () => {
    const hooked = "<head>\n  <x/>\n  <y/>\n</head>\n" // a formatter re-indented the file
    const result = refreshFromHead([first, second], { readHead: () => hooked, beforeOf: (record) => befores.get(record.id) })
    expect(result.refreshed).toEqual(["index.html"])
    const rebased = result.records[1]!
    expect(rebased.afterHash).toBe(sha256Tagged(hooked))
    // Newest first: the rebased record takes the hooked file back to the first record's after...
    const afterFirst = reverseEditRecord(hooked, rebased)
    expect(afterFirst).toEqual({ ok: true, content: mid })
    // ...and the first record takes it back to the base.
    expect(reverseEditRecord(afterFirst.ok ? afterFirst.content : null, result.records[0]!)).toEqual({ ok: true, content: base })
  })
})
