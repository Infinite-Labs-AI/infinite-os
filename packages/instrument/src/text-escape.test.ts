import { describe, expect, it } from "vitest"

import { escapeMarkdownCell, escapeRegExp } from "./text-escape.js"

describe("escapeRegExp", () => {
  it("escapes every metacharacter, the backslash included, so the value matches only itself", () => {
    const hostile = String.raw`a\d$.*+?^{}()|[]b`
    const pattern = new RegExp(`^${escapeRegExp(hostile)}$`)
    expect(pattern.test(hostile)).toBe(true)
    // negative: a backslash left raw would turn `\d` into "a digit" and match this instead
    expect(pattern.test(String.raw`a7$.*+?^{}()|[]b`)).toBe(false)
    expect(escapeRegExp("\\")).toBe("\\\\")
  })
})

describe("escapeMarkdownCell", () => {
  it("escapes backslashes before pipes, so an input `\\|` cannot open a new column", () => {
    expect(escapeMarkdownCell(String.raw`a\|b`)).toBe(String.raw`a\\\|b`)
    expect(escapeMarkdownCell("a|b")).toBe(String.raw`a\|b`)
    expect(escapeMarkdownCell("one\r\ntwo\nthree")).toBe("one two three")
    // negative: escaping pipes alone turned `a\|b` into `a\\|b`, an escaped backslash then a LIVE pipe.
    // A pipe is live when an EVEN run of backslashes precedes it.
    const livePipes = (text: string) => [...text.matchAll(/(\\*)\|/g)].filter((match) => match[1]!.length % 2 === 0).length
    expect(livePipes(String.raw`a\\|b`)).toBe(1)
    expect(livePipes(escapeMarkdownCell(String.raw`a\|b`))).toBe(0)
    expect(livePipes(escapeMarkdownCell(String.raw`a\\|b|c`))).toBe(0)
  })
})

