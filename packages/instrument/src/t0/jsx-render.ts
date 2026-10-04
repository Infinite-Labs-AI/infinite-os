// Live-fix 4 final round (P2): the page an adopted job is tested on is what the file's exported component RENDERS,
// never every `<Script>` in the file's text. A `<Script>` in a helper nothing renders never runs; a namespace import
// (`<Analytics.Fbc />`), a `next/dynamic` or `React.lazy` component, or a package component runs code the text scan
// never saw. Either way the old page model graded the wrong page (a false `no_fbc_capture` or a false pass).
//
// This module reads a component file WITHOUT running it, with no parser dependency (the package has none):
//   - `scanSource`: one pass that finds every JSX element (name, where its opening tag ends, where it closes) and a
//     `mask` of the file where comments, string and template bodies, regex literals and JSX text are blanked (same
//     length, newlines kept), so brackets and code can be read on it without a string or a comment confusing them;
//   - `componentDefinitions`: the components the file defines (function, class, `const X = …`) with their spans, and
//     which ones it exports (`default` and named);
//   - `renderWalk`: from the root components, the elements the render reaches in render order, following components
//     defined in the same file and resolving each other capitalised element to an import (local file, namespace member,
//     `next/dynamic` / `lazy`), a known framework component, a slot (a prop such as `_app`'s `Component`), or nothing
//     (unresolvable: the page cannot be known). Elements inside a helper the render never reaches are never visited.

import { escapeRegExp } from "../text-escape.js"

export interface JsxElement {
  /** The tag name as written (`Script`, `Analytics.Fbc`, `div`); "" for a fragment. */
  name: string
  start: number
  /** Index of the opening tag's closing `>`. */
  openEnd: number
  selfClosing: boolean
  /** Index just past the element (its closing tag, or `/>`). */
  end: number
}

export interface SourceScan {
  elements: JsxElement[]
  /** The source with comments, string / template bodies, regex literals and JSX text blanked (same length). */
  mask: string
}

const EXPRESSION_KEYWORDS = new Set(["return", "yield", "default", "case", "else", "do", "in", "of", "typeof", "void", "await", "throw", "new", "delete"])
/** Characters after which `/` starts a regex literal and `<` may start a JSX element. */
const EXPRESSION_START = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "kw"])

/** One pass over a JS/TS(X) file: its JSX elements and its code mask. */
export function scanSource(source: string): SourceScan {
  const blank = source.split("")
  const elements: JsxElement[] = []
  const blanks: Array<[number, number]> = []
  const mark = (from: number, to: number) => {
    if (to > from) blanks.push([from, to])
  }

  const skipQuoted = (start: number): number => {
    const quote = source[start]
    for (let i = start + 1; i < source.length; i += 1) {
      if (source[i] === "\\") {
        i += 1
        continue
      }
      if (source[i] === quote) return i + 1
      if (source[i] === "\n") return i
    }
    return source.length
  }

  const skipTemplate = (start: number): number => {
    let textFrom = start + 1
    for (let i = start + 1; i < source.length; i += 1) {
      if (source[i] === "\\") {
        i += 1
        continue
      }
      if (source[i] === "`") {
        mark(textFrom, i)
        return i + 1
      }
      if (source[i] === "$" && source[i + 1] === "{") {
        mark(textFrom, i)
        const close = code(i + 2, true)
        if (close < 0) return source.length
        i = close
        textFrom = close + 1
      }
    }
    mark(textFrom, source.length)
    return source.length
  }

  /** A regex literal starting at `start` (on one line), or -1 when it is not one. */
  const skipRegex = (start: number): number => {
    let inClass = false
    for (let i = start + 1; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === "\n") return -1
      if (ch === "\\") {
        i += 1
        continue
      }
      if (ch === "[") inClass = true
      else if (ch === "]") inClass = false
      else if (ch === "/" && !inClass) {
        let end = i + 1
        while (end < source.length && /[a-z]/i.test(source[end]!)) end += 1
        return end
      }
    }
    return -1
  }

  /**
   * Code from `start`: returns the index of the `}` that closes it (`toBrace`), or the source length; -1 when a
   * brace-delimited expression never closes.
   */
  function code(start: number, toBrace: boolean): number {
    let depth = 0
    let prev = ""
    let i = start
    while (i < source.length) {
      const ch = source[i]!
      const next = source[i + 1]
      if (/\s/.test(ch)) {
        i += 1
        continue
      }
      if (ch === "/" && next === "/") {
        const end = source.indexOf("\n", i)
        const stop = end < 0 ? source.length : end
        mark(i, stop)
        i = stop
        continue
      }
      if (ch === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2)
        const stop = end < 0 ? source.length : end + 2
        mark(i, stop)
        i = stop
        continue
      }
      if (ch === "'" || ch === '"') {
        const end = skipQuoted(i)
        mark(i + 1, Math.max(i + 1, end - 1))
        i = end
        prev = "a"
        continue
      }
      if (ch === "`") {
        i = skipTemplate(i)
        prev = "a"
        continue
      }
      if (ch === "/" && EXPRESSION_START.has(prev)) {
        const end = skipRegex(i)
        if (end > 0) {
          mark(i + 1, end)
          i = end
          prev = "a"
          continue
        }
      }
      if (ch === "<" && EXPRESSION_START.has(prev) && next !== undefined && /[A-Za-z_$>]/.test(next)) {
        const keepElements = elements.length
        const keepBlanks = blanks.length
        const end = element(i)
        if (end > 0) {
          i = end
          prev = "a"
          continue
        }
        elements.length = keepElements
        blanks.length = keepBlanks
      }
      if (ch === "{" || ch === "(" || ch === "[") {
        depth += 1
        prev = ch
        i += 1
        continue
      }
      if (ch === "}" || ch === ")" || ch === "]") {
        if (depth === 0 && toBrace && ch === "}") return i
        depth -= 1
        prev = ch === "}" ? "}" : "a"
        i += 1
        continue
      }
      const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i, i + 64))
      if (word) {
        prev = EXPRESSION_KEYWORDS.has(word[0]) ? "kw" : "a"
        i += word[0].length
        continue
      }
      if (/[0-9]/.test(ch)) {
        while (i < source.length && /[\w.]/.test(source[i]!)) i += 1
        prev = "a"
        continue
      }
      prev = ch
      i += 1
    }
    return toBrace ? -1 : source.length
  }

  const skipSpace = (index: number): number => {
    let i = index
    while (i < source.length && /\s/.test(source[i]!)) i += 1
    return i
  }

  /** A JSX element starting at `start` (`<`): the index just past it, or -1 when it is not one. */
  function element(start: number): number {
    let i = start + 1
    let name = ""
    if (source[i] !== ">") {
      const match = /^[A-Za-z_$][\w$-]*(?:[.:][A-Za-z_$][\w$-]*)*/.exec(source.slice(i, i + 200))
      if (!match) return -1
      name = match[0]
      i += name.length
    }
    const entry: JsxElement = { name, start, openEnd: -1, selfClosing: false, end: -1 }
    elements.push(entry)
    if (name !== "") {
      for (;;) {
        i = skipSpace(i)
        if (i >= source.length) return -1
        if (source.startsWith("/>", i)) {
          entry.openEnd = i + 1
          entry.selfClosing = true
          entry.end = i + 2
          return entry.end
        }
        if (source[i] === ">") break
        if (source[i] === "{") {
          const close = code(i + 1, true)
          if (close < 0) return -1
          i = close + 1
          continue
        }
        const attribute = /^[A-Za-z_$][\w$:.-]*/.exec(source.slice(i, i + 200))
        if (!attribute) return -1
        i = skipSpace(i + attribute[0].length)
        if (source[i] !== "=") continue
        i = skipSpace(i + 1)
        const ch = source[i]
        if (ch === '"' || ch === "'") {
          const close = source.indexOf(ch, i + 1)
          if (close < 0) return -1
          mark(i + 1, close)
          i = close + 1
        } else if (ch === "{") {
          const close = code(i + 1, true)
          if (close < 0) return -1
          i = close + 1
        } else if (ch === "<") {
          const end = element(i)
          if (end < 0) return -1
          i = end
        } else return -1
      }
    }
    entry.openEnd = i
    i += 1
    // Children: text, `{expression}`, nested elements, then the closing tag.
    let textFrom = i
    while (i < source.length) {
      const ch = source[i]
      if (ch === "<") {
        mark(textFrom, i)
        if (source[i + 1] === "/") {
          const close = /^<\/\s*([A-Za-z_$][\w$:.-]*)?\s*>/.exec(source.slice(i, i + 220))
          if (!close || (close[1] ?? "") !== name) return -1
          entry.end = i + close[0].length
          return entry.end
        }
        const end = element(i)
        if (end < 0) return -1
        i = end
        textFrom = i
        continue
      }
      if (ch === "{") {
        mark(textFrom, i)
        const close = code(i + 1, true)
        if (close < 0) return -1
        i = close + 1
        textFrom = i
        continue
      }
      i += 1
    }
    return -1
  }

  code(0, false)
  for (const [from, to] of blanks) {
    for (let index = from; index < to; index += 1) if (blank[index] !== "\n") blank[index] = " "
  }
  elements.sort((a, b) => a.start - b.start)
  return { elements, mask: blank.join("") }
}

/** The index of the bracket closing the one at `open` on a mask (strings and comments already blank), or -1. */
export function closingBracket(mask: string, open: number): number {
  let depth = 0
  for (let i = open; i < mask.length; i += 1) {
    const ch = mask[i]
    if (ch === "(" || ch === "{" || ch === "[") depth += 1
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

export interface ComponentDefinition {
  name: string
  /** The definition's text span (its body, or its whole initializer). */
  start: number
  end: number
  /** Its parameter text (a slot such as `_app`'s `Component` is named here). */
  params: string
  /** The initializer's original text for `const X = …` (a `dynamic(() => import(…))` is read from it). */
  init: string | null
}

export interface FileComponents {
  definitions: Map<string, ComponentDefinition>
  /** The name of the definition the file's default export is ("default" for an anonymous one), or null. */
  defaultExport: string | null
  /** Exported name → local definition name. */
  named: Map<string, string>
}

const STATEMENT_START = /^(?:export|import|const|let|var|function|async\s+function|class|type|interface|enum|declare|if|for|while|return|switch|try)\b|^\}/

/** Where a `const X = <expression>` ends on a mask: a `;`, `,` or closing bracket at depth 0, or a new statement. */
function expressionEnd(mask: string, start: number): number {
  let depth = 0
  for (let i = start; i < mask.length; i += 1) {
    const ch = mask[i]!
    if (ch === "(" || ch === "{" || ch === "[") depth += 1
    else if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) return i
      depth -= 1
    } else if (depth === 0 && (ch === ";" || ch === ",")) return i
    else if (depth === 0 && ch === "\n") {
      const before = mask.slice(start, i).trimEnd()
      // A JSX value ends in `>`, so `<` / `>` never continue a line (only `=>` does).
      if (before === "" || /(?:=>|[=(,?:&|+\-*/!])$/.test(before)) continue
      const rest = mask.slice(i + 1).trimStart()
      if (rest === "" || STATEMENT_START.test(rest) || !/^[.?:&|+\-*/=(`[]/.test(rest)) return i
    }
  }
  return mask.length
}

/** The components (and other top-level bindings) a file defines, and what it exports. */
export function componentDefinitions(source: string, mask: string): FileComponents {
  const definitions = new Map<string, ComponentDefinition>()
  let defaultExport: string | null = null
  const named = new Map<string, string>()

  for (const match of mask.matchAll(/(?<![\w$.])(export\s+)?(default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*(?:<[^>()]*>\s*)?\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1
    const close = closingBracket(mask, open)
    if (close < 0) continue
    const body = mask.indexOf("{", close)
    if (body < 0) continue
    const end = closingBracket(mask, body)
    if (end < 0) continue
    const name = match[3] ?? (match[2] ? "default" : null)
    if (name === null) continue
    if (!definitions.has(name)) definitions.set(name, { name, start: body, end: end + 1, params: source.slice(open + 1, close), init: null })
    if (match[1] && match[2]) defaultExport = name
    else if (match[1] && match[3]) named.set(match[3], match[3])
  }
  for (const match of mask.matchAll(/(?<![\w$.])(export\s+)?(default\s+)?class\s+([A-Za-z_$][\w$]*)?[^{]*\{/g)) {
    const open = (match.index ?? 0) + match[0].length - 1
    const end = closingBracket(mask, open)
    if (end < 0) continue
    const name = match[3] ?? (match[2] ? "default" : null)
    if (name === null) continue
    if (!definitions.has(name)) definitions.set(name, { name, start: open, end: end + 1, params: "", init: null })
    if (match[1] && match[2]) defaultExport = name
    else if (match[1] && match[3]) named.set(match[3], match[3])
  }
  for (const match of mask.matchAll(/(?<![\w$.])(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=(?![=>])/g)) {
    const start = (match.index ?? 0) + match[0].length
    const end = expressionEnd(mask, start)
    const name = match[2]!
    const init = source.slice(start, end)
    const arrow = init.indexOf("=>")
    if (!definitions.has(name)) definitions.set(name, { name, start, end, params: arrow < 0 ? "" : init.slice(0, arrow), init })
    if (match[1]) named.set(name, name)
  }
  // `export default Name` / `export default <expression>`.
  for (const match of mask.matchAll(/(?<![\w$.])export\s+default\s+(?!(?:async\s+)?function\b|class\b)/g)) {
    const start = (match.index ?? 0) + match[0].length
    const identifier = /^([A-Za-z_$][\w$]*)\s*(?:;|\n|$)/.exec(mask.slice(start))
    if (identifier) {
      defaultExport = identifier[1]!
      continue
    }
    const end = expressionEnd(mask, start)
    const init = source.slice(start, end)
    const arrow = init.indexOf("=>")
    definitions.set("default", { name: "default", start, end, params: arrow < 0 ? "" : init.slice(0, arrow), init })
    defaultExport = "default"
  }
  // `export { A, B as C }` (never `export { … } from`).
  for (const clause of mask.matchAll(/(?<![\w$.])export\s*\{([^}]*)\}(?!\s*from\b)/g)) {
    for (const part of clause[1]!.split(",")) {
      const [local, exported] = part.trim().split(/\s+as\s+/).map((name) => name.trim())
      if (!local) continue
      if ((exported ?? local) === "default") defaultExport = local
      else named.set(exported ?? local, local)
    }
  }
  return { definitions, defaultExport, named }
}

/** A binding the file imports: its local name, the module and the name it is exported under there. */
export interface ImportBinding {
  local: string
  from: string
  /** `default`, `*` (a namespace import) or the exported name. */
  imported: string
}

export function importBindings(source: string, mask: string): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>()
  const statement = /\bimport\s+(?!type\b)([^;'"]*?)\s+from\s+["']([^"']+)["']/g
  for (let match = statement.exec(source); match !== null; match = statement.exec(source)) {
    // Only an import in code (never one in a comment or a string).
    if (mask.slice(match.index, match.index + 6) !== "import") continue
    const clause = match[1]!
    const from = match[2]!
    const braces = /\{([^}]*)\}/.exec(clause)
    if (braces) {
      for (const part of braces[1]!.split(",")) {
        const cleaned = part.replace(/^\s*type\s+/, "").trim()
        if (cleaned === "" || /^type\s/.test(part.trim())) continue
        const [imported, local] = cleaned.split(/\s+as\s+/).map((name) => name.trim())
        if (imported) out.set(local ?? imported, { local: local ?? imported, from, imported })
      }
    }
    const rest = clause.replace(/\{[^}]*\}/, "")
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(rest)
    if (namespace) out.set(namespace[1]!, { local: namespace[1]!, from, imported: "*" })
    const head = rest.replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, "").split(",")[0]?.trim()
    if (head) out.set(head, { local: head, from, imported: "default" })
  }
  return out
}

/** A module path from the site's own code (relative, `@/`, `~/`). */
export function isLocalModule(from: string): boolean {
  return /^(?:\.{1,2}\/|@\/|~\/)/.test(from)
}

/**
 * Framework components that render only what the file gives them (markup, children), never code of their own the page
 * would need: React's `Fragment` / `Suspense` / `StrictMode` / `Profiler`, `next/link`, `next/image`, `next/head`,
 * `next/document`'s parts. Keyed by module → exported names (`default` for a default import).
 */
const KNOWN_FRAMEWORK: Record<string, ReadonlySet<string>> = {
  react: new Set(["Fragment", "Suspense", "StrictMode", "Profiler"]),
  "next/link": new Set(["default"]),
  "next/image": new Set(["default"]),
  "next/legacy/image": new Set(["default"]),
  "next/head": new Set(["default"]),
  "next/document": new Set(["Html", "Head", "Main", "NextScript"])
}
const REACT_MEMBERS = KNOWN_FRAMEWORK.react!

/** What one rendered element is. */
export type RenderedNode =
  | { kind: "script"; element: JsxElement; file: string }
  | { kind: "follow"; element: JsxElement; name: string; from: string; imported: string }
  | { kind: "unresolvable"; element: JsxElement; name: string; why: string }

/** The import a `next/dynamic` / `lazy` definition loads (`default` or the `.then((m) => m.X)` member), or null. */
function dynamicTarget(init: string): { from: string; imported: string } | "not_dynamic" | null {
  if (!/^\s*(?:dynamic|lazy|React\s*\.\s*lazy|loadable)\s*(?:<[^>]*>)?\s*\(/.test(init)) return "not_dynamic"
  const spec = /\bimport\s*\(\s*["'`]([^"'`$]+)["'`]\s*\)/.exec(init)
  if (!spec) return null
  const member = /\.then\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\(?\s*\1\s*\.\s*([A-Za-z_$][\w$]*)/.exec(init)
  return { from: spec[1]!, imported: member ? member[2]! : "default" }
}

/**
 * The elements the render of `roots` reaches, in render order: same-file components are walked in place, an element
 * inside a helper the render never reaches is never visited. `Script` / `script` elements are scripts (next/script's
 * `Script`, or a file that imports none); every other capitalised or member element is followed, known, a slot, or
 * unresolvable.
 */
export function renderWalk(file: string, source: string, roots: readonly string[] | "whole_file"): RenderedNode[] {
  const scan = scanSource(source)
  return renderWalkOn(file, source, scan, roots)
}

export function renderWalkOn(file: string, source: string, scan: SourceScan, roots: readonly string[] | "whole_file"): RenderedNode[] {
  const components = componentDefinitions(source, scan.mask)
  const imports = importBindings(source, scan.mask)
  const out: RenderedNode[] = []
  const visited = new Set<string>()
  const definitionList = [...components.definitions.values()]

  const slotIn = (definition: ComponentDefinition | null, head: string): boolean => {
    if (definition === null) return false
    const word = new RegExp(`(?<![\\w$])${escapeRegExp(head)}(?![\\w$])`)
    if (word.test(definition.params)) return true
    // `const { Component, pageProps } = props` / `= this.props` inside the component.
    const body = scan.mask.slice(definition.start, definition.end)
    return [...body.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:this\s*\.\s*)?props\b/g)].some((match) => word.test(match[1]!))
  }

  const referable = definitionList.filter((definition) => definition.name !== "default")
  const reference =
    referable.length === 0 ? null : new RegExp(`(?<![\\w$.])(${referable.map((definition) => escapeRegExp(definition.name)).join("|")})(?![\\w$])`, "g")

  /**
   * One span of the render, in order: its elements, and each same-file definition it refers to by name (a helper it
   * calls, a JSX value it puts in `{…}`), walked where it is referred to. A definition nested in the span that nothing
   * refers to is never walked, so its elements never reach the page.
   */
  const walk = (from: number, to: number, owner: ComponentDefinition | null) => {
    const nested = definitionList.filter((definition) => definition.start > from && definition.end <= to && definition !== owner)
    const inNested = (at: number) => nested.some((definition) => at >= definition.start && at < definition.end)
    const events: Array<{ at: number; element: JsxElement } | { at: number; definition: ComponentDefinition }> = []
    for (const element of scan.elements) {
      if (element.start >= from && element.start < to && !inNested(element.start)) events.push({ at: element.start, element })
    }
    if (reference !== null) {
      for (const match of scan.mask.slice(from, to).matchAll(reference)) {
        const at = from + (match.index ?? 0)
        if (inNested(at)) continue
        const before = scan.mask.slice(Math.max(0, at - 24), at)
        // Its own declaration, or an element's tag name (the element itself is the event).
        if (/(?:function\s*\*?|class|const|let|var)\s+$/.test(before) || /<\/?\s*$/.test(before)) continue
        const definition = components.definitions.get(match[1]!)
        if (definition && definition !== owner) events.push({ at, definition })
      }
    }
    events.sort((a, b) => a.at - b.at)
    for (const event of events) {
      if ("definition" in event) {
        const definition = event.definition
        if (visited.has(definition.name) || (definition.init !== null && dynamicTarget(definition.init) !== "not_dynamic")) continue
        visited.add(definition.name)
        walk(definition.start, definition.end, definition)
        continue
      }
      const element = event.element
      const name = element.name
      if (name === "") continue
      const dotted = name.includes(".")
      const head = name.split(/[.:]/)[0]!
      const member = dotted ? name.slice(head.length + 1) : null
      if (!dotted && /^[a-z]/.test(name)) {
        if (name === "script") out.push({ kind: "script", element, file })
        continue
      }
      const binding = imports.get(head)
      const definition = components.definitions.get(head)
      if (name === "Script" && (binding ? binding.from === "next/script" : definition === undefined)) {
        out.push({ kind: "script", element, file })
        continue
      }
      if (binding) {
        if (isLocalModule(binding.from)) {
          if (/infinite-analytics/.test(binding.from)) continue
          if (member === null) out.push({ kind: "follow", element, name, from: binding.from, imported: binding.imported })
          else if (binding.imported === "*" && !member.includes(".")) out.push({ kind: "follow", element, name, from: binding.from, imported: member })
          else if (member === "Provider" || member === "Consumer") continue
          else out.push({ kind: "unresolvable", element, name, why: `a member of ${binding.from} the wizard does not follow` })
          continue
        }
        const known = KNOWN_FRAMEWORK[binding.from]
        const exported = binding.imported === "*" || (binding.imported === "default" && binding.from === "react") ? member : member === null ? binding.imported : null
        if (known && exported !== null && known.has(exported)) continue
        if (member === "Provider" || member === "Consumer") continue
        out.push({ kind: "unresolvable", element, name, why: `a component of the package ${binding.from}, which the offline page does not run` })
        continue
      }
      if (head === "React" && member !== null && REACT_MEMBERS.has(member)) continue
      if (definition && member === null) {
        const target = definition.init === null ? "not_dynamic" : dynamicTarget(definition.init)
        if (target === null) {
          out.push({ kind: "unresolvable", element, name, why: "a dynamic import the wizard cannot read" })
          continue
        }
        if (target !== "not_dynamic") {
          if (isLocalModule(target.from)) out.push({ kind: "follow", element, name, from: target.from, imported: target.imported })
          else out.push({ kind: "unresolvable", element, name, why: `a dynamic import of the package ${target.from}, which the offline page does not run` })
          continue
        }
        if (visited.has(head)) continue
        visited.add(head)
        walk(definition.start, definition.end, definition)
        continue
      }
      if (definition && (member === "Provider" || member === "Consumer")) continue
      if (slotIn(owner, head)) continue
      out.push({ kind: "unresolvable", element, name, why: "which the wizard cannot find in the file or its imports" })
    }
  }

  if (roots === "whole_file") {
    walk(0, source.length, null)
    return out
  }
  for (const root of roots) {
    const definition = components.definitions.get(root)
    if (!definition || visited.has(root)) continue
    visited.add(root)
    walk(definition.start, definition.end, definition)
  }
  return out
}

/**
 * The components a file's render starts from: its default export; else every exported component (a capitalised name);
 * else, for a file that defines no component at all (markup alone), the whole file. A file that defines components but
 * exports none renders nothing on its own.
 */
export function fileRoots(source: string, mask: string): readonly string[] | "whole_file" {
  const components = componentDefinitions(source, mask)
  if (components.defaultExport !== null) return [components.defaultExport]
  const exported = [...components.named].filter(([name]) => /^[A-Z]/.test(name)).map(([, local]) => local)
  if (exported.length > 0) return exported
  const anyComponent = [...components.definitions.keys()].some((name) => /^[A-Z]/.test(name))
  return anyComponent ? [] : "whole_file"
}

/** The local definition a followed import names (`default` or an exported name), or null when the file has none. */
export function exportedDefinition(source: string, mask: string, imported: string): string | null {
  const components = componentDefinitions(source, mask)
  const local = imported === "default" ? components.defaultExport : (components.named.get(imported) ?? null)
  return local !== null && components.definitions.has(local) ? local : null
}
