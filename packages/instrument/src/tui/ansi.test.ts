import { describe, expect, it } from "vitest"

import { colorEnabled, fit, makeStyles, stripAnsi, truncate, visibleWidth, wrapText } from "./ansi.js"
import { exitLine } from "./exit-line.js"
import { parseKeys } from "./keys.js"

describe("colour", () => {
  it("NO_COLOR wins over a TTY; FORCE_COLOR forces it on or off", () => {
    expect(colorEnabled({}, true)).toBe(true)
    expect(colorEnabled({}, false)).toBe(false)
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false)
    expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(true)
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true)
    expect(colorEnabled({ FORCE_COLOR: "0" }, true)).toBe(false)
    expect(colorEnabled({ TERM: "dumb" }, true)).toBe(false)
  })

  it("disabled styles add nothing", () => {
    expect(makeStyles(false).ok("x")).toBe("x")
    expect(makeStyles(true).ok("x")).toBe("\x1b[32mx\x1b[39m")
  })
})

describe("width", () => {
  it("measures and cuts without counting escapes, and never bleeds colour", () => {
    const s = makeStyles(true)
    const text = `${s.ok("■")} ${s.bold("Link to Infinite")}`
    expect(visibleWidth(text)).toBe(18)
    const cut = truncate(text, 8)
    expect(visibleWidth(cut)).toBe(8)
    expect(stripAnsi(cut)).toBe("■ Link …")
    expect(cut.endsWith("\x1b[0m")).toBe(true)
    expect(fit("ab", 4)).toBe("ab  ")
    expect(visibleWidth("漢字")).toBe(4)
  })

  it("wraps words", () => {
    expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"])
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
  })
})

describe("keys", () => {
  it("parses the keys the wizard uses", () => {
    expect(parseKeys("\r\x1b[A\x1b[B\x1b E q\x03\x7f\t").map((key) => (key.name === "char" ? key.char : key.name))).toEqual([
      "enter",
      "up",
      "down",
      "escape",
      "space",
      "E",
      "space",
      "q",
      "ctrl_c",
      "backspace",
      "tab"
    ])
    expect(parseKeys("\x1b[15~")).toEqual([])
  })
})

describe("exit line", () => {
  it("names the run, the PR and the report", () => {
    const line = exitLine({ displayId: "r-7f3c", exitCode: 3, prUrl: "https://github.com/a/b/pull/1", reportPath: ".infinite/REPORT.md" }, makeStyles(false))
    expect(line).toBe("◆ infinite-tag run r-7f3c: paused (run npx infinite-tag again to continue) · PR https://github.com/a/b/pull/1 · report .infinite/REPORT.md")
    expect(exitLine({ displayId: "r-1", exitCode: 4, prUrl: null, reportPath: null }, makeStyles(false))).toBe("◆ infinite-tag run r-1: needs the Infinite app")
  })
})
