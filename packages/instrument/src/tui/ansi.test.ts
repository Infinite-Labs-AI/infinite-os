import { describe, expect, it } from "vitest"

import { colorEnabled, fit, makeStyles, stripAnsi, truncate, visibleWidth } from "./ansi.js"
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

