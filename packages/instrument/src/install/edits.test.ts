import { describe, expect, it } from "vitest"

import { applyTextEdits, reverseTextEdits } from "../server-lane/text-edits.js"

import { beforeTextOf, makeEditRecord, refreshFromHead, reverseEditRecord, sha256Tagged, textEditsBetween } from "./edits.js"

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

  it("is empty for equal texts and one hunk for one changed region", () => {
    expect(textEditsBetween("x", "x")).toEqual([])
    expect(textEditsBetween("abc", "aXc")).toEqual([{ offset: 1, removed: "b", inserted: "X" }])
  })

  it("a lockfile changed near its top and its bottom records small hunks, never the whole file (P2-13)", () => {
    const body = Array.from({ length: 20_000 }, (_, index) => `  /pkg-${index}@1.0.${index}:\n    resolution: {integrity: sha512-${index}}\n`).join("")
    const before = `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      next: 16.0.0\n${body}snapshots:\n  next@16.0.0: {}\n`
    const after = before
      .replace("      next: 16.0.0\n", "      next: 16.0.0\n      '@vercel/functions': 3.1.0\n")
      .replace("snapshots:\n  next@16.0.0: {}\n", "snapshots:\n  '@vercel/functions@3.1.0': {}\n  next@16.0.0: {}\n")
    const edits = textEditsBetween(before, after)
    expect(edits).toHaveLength(2)
    expect(JSON.stringify(edits).length).toBeLessThan(400)
    expect(applyTextEdits(before, edits)).toBe(after)
    expect(reverseTextEdits(after, edits)).toBe(before)
    // NEGATIVE: the old single first-to-last hunk carried the whole file between the two changes.
    expect(JSON.stringify(edits).length).toBeLessThan(before.length / 1000)
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

  it("leaves records whose committed blob already matches", () => {
    const result = refreshFromHead([first], { readHead: () => mid, beforeOf: (record) => befores.get(record.id) })
    expect(result.refreshed).toEqual([])
    expect(result.records).toEqual([first])
  })

  it("beforeTextOf derives a record's before from the file it produced (and refuses a mismatch)", () => {
    expect(beforeTextOf("<head>\n<x/>\n<y/>\n</head>\n", second)).toBe(mid)
    expect(beforeTextOf("something else", second)).toBeUndefined()
  })

  it("NEGATIVE: an unknown or wrong 'before' is never papered over", () => {
    const unknown = refreshFromHead([first, second], { readHead: () => "rewritten\n", beforeOf: () => undefined })
    expect(unknown).toMatchObject({ refreshed: [], unverifiable: ["index.html"] })
    const wrong = refreshFromHead([first, second], { readHead: () => "rewritten\n", beforeOf: () => "not the before\n" })
    expect(wrong.unverifiable).toEqual(["index.html"])
    expect(wrong.records[1]).toEqual(second)
  })
})
