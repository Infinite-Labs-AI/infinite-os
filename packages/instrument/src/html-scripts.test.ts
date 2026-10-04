import { describe, expect, it } from "vitest"
import { htmlScripts } from "./html-scripts.js"

describe("script tokenization", () => {
  it.each(["</script>", "</SCRIPT >", "</script\t\n bar>", "</script/>", "</script x='>'>"])(
    "recognizes closing form %s",
    (close) => {
      const source = `<html><script title=">">init()</script-x>${close}</html>`
      const scripts = htmlScripts(source, true)
      expect(scripts).toHaveLength(1)
      expect(source.slice(scripts[0].bodyStart, scripts[0].bodyEnd)).toBe("init()</script-x>")
    }
  )
  it.each([
    `<div title="<script>fake()</script>"></div>`,
    `<style>.x { content: '<script>fake()</script>'; }</style>`,
    `<textarea><script>fake()</script></textarea>`,
    `<template><template><script>fake()</script></template></template>`,
    `<noscript><script>fake()</script></noscript>`
  ])("does not treat inert or quoted markup as scripts", (source) => {
    expect(htmlScripts(source + "<script>real()</script>", true)).toHaveLength(1)
  })
  it("reads real attributes without finding src inside another attribute value", () => {
    const scripts = htmlScripts(
      `<script title="src='fake' >" SRC='real.js' data-infinite-runtime=managed></script>`,
      true
    )
    expect(scripts[0].attributes.get("src")).toBe("real.js")
    expect(scripts[0].attributes.get("data-infinite-runtime")).toBe("managed")
  })
})

it("preserves offsets through Unicode whose lowercase expands", () => {
  const source = "<html>İ<script>real()</SCRIPT></html>"
  const [script] = htmlScripts(source, true)
  expect(source.slice(script.bodyStart, script.bodyEnd)).toBe("real()")
})
