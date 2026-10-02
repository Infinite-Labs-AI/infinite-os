import { describe, expect, it } from "vitest"

import { applyTextEdits, reverseTextEdits } from "../server-lane/text-edits.js"

import { makeEditRecord, refreshFromHead, reverseEditRecord, sha256Tagged, textEditsBetween } from "./edits.js"

describe("textEditsBetween (exact, minimal, reversible)", () => {
  const cases: Array<[string, string]> = [
    ["", "created\n"],
    ["a\nb\nc\n", "a\nB\nc\n"],
    ["<head>\n</head>", "<head>\n<script>x</script>\n</head>"],
    ["same", "same"],
    ["aaaa", "aa"],
    ["prefix-tail", "prefix-middle-tail"]
  ]
  it.each(cases)("round-trips %j → %j", (before, after) => {
    const edits = textEditsBetween(before, after)
    expect(applyTextEdits(before, edits)).toBe(after)
    expect(reverseTextEdits(after, edits)).toBe(before)
  })

  it("is empty for equal texts and one hunk otherwise", () => {
    expect(textEditsBetween("x", "x")).toEqual([])
    expect(textEditsBetween("abc", "aXc")).toEqual([{ offset: 1, removed: "b", inserted: "X" }])
  })
})

describe("reverseEditRecord", () => {
  const record = makeEditRecord({ file: "index.html", before: "one\n", after: "one\ntwo\n", jobId: null, planLineId: "l1", by: "wizard", runId: "run-1" })

  it("records sha256:<hex> hashes and exact text edits", () => {
    expect(record.beforeHash).toBe(sha256Tagged("one\n"))
    expect(record.afterHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(record.textEdits).toEqual([{ offset: 4, removed: "", inserted: "two\n" }])
    expect(record.id).toMatch(/^ed_[0-9a-f]{16}$/)
  })

  it("restores the before bytes when the file still hashes to afterHash", () => {
    expect(reverseEditRecord("one\ntwo\n", record)).toEqual({ ok: true, content: "one\n" })
  })

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
  const first = makeEditRecord({ file: "index.html", before: base, after: "<head>\n<x/>\n</head>\n", jobId: null, planLineId: "l1", by: "wizard", runId: "r", seq: 0 })
  const second = makeEditRecord({ file: "index.html", before: "<head>\n<x/>\n</head>\n", after: "<head>\n<x/>\n<y/>\n</head>\n", jobId: "csp", planLineId: null, by: "agent", runId: "r", seq: 1 })

  it("rebases the newest record onto the committed blob, so uninstall still restores the exact pre-edit bytes", () => {
    const hooked = "<head>\n  <x/>\n  <y/>\n</head>\n" // a formatter re-indented the file
    const result = refreshFromHead([first, second], { readHead: () => hooked, readBase: () => base })
    expect(result.refreshed).toEqual(["index.html"])
    const rebased = result.records[1]!
    expect(rebased.afterHash).toBe(sha256Tagged(hooked))
    // Newest first: the rebased record takes the hooked file back to the first record's after...
    const afterFirst = reverseEditRecord(hooked, rebased)
    expect(afterFirst).toEqual({ ok: true, content: "<head>\n<x/>\n</head>\n" })
    // ...and the first record takes it back to the base.
    expect(reverseEditRecord(afterFirst.ok ? afterFirst.content : null, result.records[0]!)).toEqual({ ok: true, content: base })
  })

  it("leaves records whose committed blob already matches", () => {
    const result = refreshFromHead([first], { readHead: () => "<head>\n<x/>\n</head>\n", readBase: () => base })
    expect(result.refreshed).toEqual([])
    expect(result.records).toEqual([first])
  })

  it("NEGATIVE: a chain that does not start at the base is never papered over", () => {
    const result = refreshFromHead([first, second], { readHead: () => "rewritten\n", readBase: () => "something else\n" })
    expect(result.refreshed).toEqual([])
    expect(result.unverifiable).toEqual(["index.html"])
    expect(result.records[1]).toEqual(second)
  })
})
