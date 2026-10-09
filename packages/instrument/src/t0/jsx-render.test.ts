// Live-fix 4 final round (P2): the render walk reads JSX without a parser dependency. These pin the shapes a text scan
// gets wrong: JSX text holding an apostrophe or a URL (not a string, not a comment), TypeScript generics (not JSX), a
// commented-out element, and a helper nothing renders.
import { describe, expect, it } from "vitest"

import { fileRoots, renderWalk, scanSource } from "./jsx-render.js"

const names = (file: string, source: string) => {
  const scan = scanSource(source)
  return renderWalk(file, source, fileRoots(source, scan.mask)).map((node) => `${node.kind}:${node.kind === "script" ? node.element.name : node.name}`)
}

describe("scanSource", () => {
  it("JSX text with an apostrophe or a URL never hides the elements after it; generics and comparisons are not JSX", () => {
    const source = [
      'import { Pixel } from "./pixel"',
      "export default function Layout() {",
      "  const [open] = useState<boolean>(false)",
      "  const few = 1 < 2",
      "  return (",
      "    <main>",
      "      <p>We're open — see https://acme.com/hours</p>",
      "      {/* <Old /> */}",
      "      <Pixel />",
      "    </main>",
      "  )",
      "}"
    ].join("\n")
    expect(scanSource(source).elements.map((element) => element.name)).toEqual(["main", "p", "Pixel"])
    expect(names("app/layout.tsx", source)).toEqual(["follow:Pixel"])
  })
})

describe("renderWalk", () => {
  it("walks the default export only; a nested helper is reached only when the render refers to it", () => {
    const source = [
      'import Script from "next/script"',
      "function Unused() { return <Script id=\"a\">{`1`}</Script> }",
      "function Used() { return <Script id=\"b\">{`2`}</Script> }",
      "export default function Layout() {",
      "  const never = <Script id=\"c\">{`3`}</Script>",
      "  return <html><Used /></html>",
      "}"
    ].join("\n")
    const scan = scanSource(source)
    const nodes = renderWalk("app/layout.tsx", source, fileRoots(source, scan.mask))
    expect(nodes.map((node) => source.slice(node.element.start, node.element.start + 16))).toEqual(['<Script id="b">{'])
  })
})
