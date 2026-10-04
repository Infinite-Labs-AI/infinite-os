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

  it("blanks string, template and comment bodies on the mask (same length, newlines kept)", () => {
    const source = 'const a = "x{"\n// }\nconst b = `y${c}`\n'
    const { mask } = scanSource(source)
    expect(mask).toHaveLength(source.length)
    expect(mask.split("\n")).toHaveLength(source.split("\n").length)
    expect(mask).not.toContain("x{")
    expect(mask).toContain("${c}")
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

  it("a file with no component at all is read whole; one that defines components but exports none renders nothing", () => {
    expect(names("app/x.tsx", '<Script id="x">{`1`}</Script>')).toEqual(["script:Script"])
    expect(names("app/x.tsx", 'function Hidden() { return <Script id="x">{`1`}</Script> }\n')).toEqual([])
  })

  it("a context Provider and React's own members are known; a package member (motion.div) is not", () => {
    expect(names("app/x.tsx", 'import { Ctx } from "./ctx"\nexport default function X() { return <Ctx.Provider value={1}><React.Fragment /></Ctx.Provider> }\n')).toEqual([])
    expect(names("app/x.tsx", 'import { motion } from "framer-motion"\nexport default function X() { return <motion.div /> }\n')).toEqual(["unresolvable:motion.div"])
  })
})
