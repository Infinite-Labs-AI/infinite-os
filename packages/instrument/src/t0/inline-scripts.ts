// R4-2 (live run 4): the page an ADOPTED tool's job is tested on is the page as the agent left it, never the page
// infinite-tag would write. Run 4's `fbc_capture` check for job 5 (the `_fbc` capture beside the site's own Meta pixel)
// loaded the MANAGED page built from Infinite's keys; Meta was not connected, so that page had no capture at all and
// the check said "a landing with an fbclid wrote no _fbc cookie" while production, running the agent's code, wrote it.
//
// This module reads the inline scripts a file puts on the page, in document order, WITHOUT running the file:
//   - an `.html` file: every `<script>` without `src` whose type is JavaScript;
//   - a component file (`.tsx`, `.jsx`, `.ts`, `.js`, `.mjs`): every `<Script …>` / `<script …>` JSX element whose
//     child is ONE string or template literal (`{`…`}`, `{"…"}`), or whose `dangerouslySetInnerHTML={{ __html: … }}` is
//     one such literal. A template literal is cooked exactly as the JS engine would (its escapes), and one holding
//     `${…}` cannot be known without running the file, so the whole read is refused with the line that holds it.
// A `src` script is listed as an external loader (the T0 engine stubs or blocks it as for any page).
//
// LF4-P2-1: the page is only as complete as what this reads. A `src` script that is not a vendor loader the engine
// stubs (e.g. `<Script src="/fbc-capture.js">`), or a component imported from the site's own code and rendered
// (`<FbcCapture />`, a client component writing `_fbc` in an effect), runs in production but not here. Such a file is
// listed as `unmodeled`, and `pageSourceFromFiles` refuses the page with that reason (undetermined), so a partial page
// is never graded `problem`. Infinite's own managed client (its import path names `infinite-analytics`) is known code.
// LF4 round 1 (P3): a rendered local component is followed into its file when the repo can be read
// (`pageSourceFromRepo`): its own inline scripts go on the page in render order; only a component whose code runs in the
// browser (an effect, a `window` / `document` access, a local hook), or one that cannot be found, still refuses the page.
// Next layouts render `<Header />`-style markup components almost always; those no longer make T0 undetermined.
import { posix } from "node:path"

import type { T0PageSource } from "./protocol.js"
import { exportedDefinition, fileRoots, renderWalkOn, scanSource } from "./jsx-render.js"
import { classifyLoader } from "./stubs.js"
import { escapeRegExp } from "../text-escape.js"

export interface InlineScript {
  /** The script's code as the browser runs it. */
  code: string
  /** `<file>:<line>` of the element. */
  label: string
}

export type InlineScriptRead =
  | { ok: true; scripts: InlineScript[]; externals: string[]; unmodeled: string[] }
  | { ok: false; reason: string }

const COMPONENT_FILE = /\.(?:[cm]?[jt]sx?)$/i
const HTML_FILE = /\.html?$/i
const JS_TYPES = /^(?:|text\/javascript|application\/javascript|module|text\/ecmascript|application\/ecmascript)$/i

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length
}

/**
 * The cooked value of a template literal body (between the backticks), or null when it holds a substitution or an
 * escape the engine would reject. Mirrors the spec's escapes: `\n \r \t \b \f \v \0`, `\xHH`, `\uHHHH`, `\u{…}`, a line
 * continuation, and `\<other>` = `<other>`.
 */
export function cookTemplateLiteral(raw: string): string | null {
  let out = ""
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (ch === "$" && raw[i + 1] === "{") return null
    if (ch === "`") return null
    if (ch !== "\\") {
      // A CRLF inside a template literal is normalised to LF by the engine.
      if (ch === "\r") {
        out += "\n"
        if (raw[i + 1] === "\n") i += 1
        continue
      }
      out += ch
      continue
    }
    const next = raw[i + 1]
    if (next === undefined) return null
    i += 1
    switch (next) {
      case "n":
        out += "\n"
        break
      case "r":
        out += "\r"
        break
      case "t":
        out += "\t"
        break
      case "b":
        out += "\b"
        break
      case "f":
        out += "\f"
        break
      case "v":
        out += "\v"
        break
      case "0":
        if (/[0-9]/.test(raw[i + 1] ?? "")) return null
        out += "\0"
        break
      case "x": {
        const hex = raw.slice(i + 1, i + 3)
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null
        out += String.fromCharCode(parseInt(hex, 16))
        i += 2
        break
      }
      case "u": {
        if (raw[i + 1] === "{") {
          const end = raw.indexOf("}", i + 2)
          const hex = end < 0 ? "" : raw.slice(i + 2, end)
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return null
          out += String.fromCodePoint(parseInt(hex, 16))
          i = end
        } else {
          const hex = raw.slice(i + 1, i + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null
          out += String.fromCharCode(parseInt(hex, 16))
          i += 4
        }
        break
      }
      case "\r":
        if (raw[i + 1] === "\n") i += 1
        break
      case "\n":
      case " ":
      case " ":
        break
      default:
        if (/[1-9]/.test(next)) return null
        out += next
    }
  }
  return out
}

/** The literal starting at `source[start]` (a quote or a backtick): its cooked value and where it ends, or null. */
function readLiteral(source: string, start: number): { value: string; end: number } | null {
  const quote = source[start]
  if (quote === "`") {
    let i = start + 1
    for (; i < source.length; i += 1) {
      if (source[i] === "\\") {
        i += 1
        continue
      }
      if (source[i] === "`") break
    }
    if (i >= source.length) return null
    const cooked = cookTemplateLiteral(source.slice(start + 1, i))
    return cooked === null ? null : { value: cooked, end: i + 1 }
  }
  if (quote === '"' || quote === "'") {
    let i = start + 1
    for (; i < source.length; i += 1) {
      if (source[i] === "\\") {
        i += 1
        continue
      }
      if (source[i] === quote || source[i] === "\n") break
    }
    if (source[i] !== quote) return null
    try {
      const text = source.slice(start, i + 1)
      // A single-quoted literal is re-quoted for JSON (its escapes are a subset JSON can read once quotes swap).
      const json = quote === '"' ? text : singleQuotedAsJson(text)
      const value = JSON.parse(json) as unknown
      return typeof value === "string" ? { value, end: i + 1 } : null
    } catch {
      return null
    }
  }
  return null
}

function skipSpace(source: string, index: number): number {
  let i = index
  while (i < source.length && /\s/.test(source[i]!)) i += 1
  return i
}

/** The end of a JSX opening tag starting at `start` (`<Script`), honouring quoted and braced attribute values. */
function openingTagEnd(source: string, start: number): number {
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!
    if (ch === "{") depth += 1
    else if (ch === "}") depth -= 1
    else if ((ch === '"' || ch === "'" || ch === "`") && depth >= 0) {
      const literal = ch === "`" ? readRawTemplateEnd(source, i) : source.indexOf(ch, i + 1)
      if (literal < 0) return -1
      i = literal
    } else if (ch === ">" && depth === 0) return i
  }
  return -1
}

function readRawTemplateEnd(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === "\\") {
      i += 1
      continue
    }
    if (source[i] === "`") return i
  }
  return -1
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*["'\`]([^"'\`]*)["'\`]\\s*\\})`).exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null
}

/** A binding a file imports from the site's OWN code (relative or alias paths): its local name, path and exported name. */
interface LocalImport {
  local: string
  from: string
  /** The name the other file exports it under (`default` for a default import, `*` for a namespace import). */
  imported: string
}

function localImports(source: string): LocalImport[] {
  const out: LocalImport[] = []
  const statement = /\bimport\s+(?!type\b)([^;'"]*?)\s+from\s+["']([^"']+)["']/g
  for (let match = statement.exec(source); match !== null; match = statement.exec(source)) {
    const clause = match[1]!
    const from = match[2]!
    if (!/^(?:\.{1,2}\/|@\/|~\/|\/)/.test(from) || /infinite-analytics/.test(from)) continue
    const named = /\{([^}]*)\}/.exec(clause)
    if (named) {
      for (const part of named[1]!.split(",")) {
        const [imported, local] = part.replace(/^\s*type\s+/, "").split(/\s+as\s+/).map((name) => name.trim())
        if (imported) out.push({ local: local ?? imported, from, imported })
      }
    }
    const rest = clause.replace(/\{[^}]*\}/, "")
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(rest)
    if (namespace) out.push({ local: namespace[1]!, from, imported: "*" })
    const head = rest.replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, "").split(",")[0]?.trim()
    if (head) out.push({ local: head, from, imported: "default" })
  }
  return out
}

/** The vendor loaders the T0 engine stubs; any other `src` script runs in production but not on the offline page. */
function isStubbedLoader(src: string): boolean {
  return classifyLoader(src) !== null
}

/** A component from the site's own code that a file renders, at its render (render order). */
interface RenderedComponent {
  name: string
  from: string
  /** The name its file must define it under (`default` for a default import, or a namespace import's member). */
  imported: string
  label: string
  index: number
}

function unmodeledComponent(component: RenderedComponent, why = "which the offline page cannot run"): string {
  return `${component.label}: renders <${component.name}> from ${component.from}, ${why}`
}

function componentScripts(file: string, source: string): InlineScriptRead {
  const read = orderedComponentScripts(file, source)
  if (!read.ok) return read
  return {
    ok: true,
    scripts: read.entries.flatMap((entry) => ("code" in entry ? [{ code: entry.code, label: entry.label }] : [])),
    externals: read.externals,
    unmodeled: [...read.entries.flatMap((entry) => ("code" in entry ? [] : [unmodeledComponent(entry)])), ...read.unmodeled]
  }
}

/** One `<Script>` / `<script>` element the render reaches: its inline code, an external loader, nothing, or why it cannot be read. */
function readScriptElement(
  file: string,
  source: string,
  start: number,
  tagName: string
): { kind: "inline"; script: InlineScript & { index: number } } | { kind: "external"; src: string; label: string } | { kind: "none" } | { kind: "error"; reason: string } {
  const end = openingTagEnd(source, start)
  if (end < 0) return { kind: "error", reason: `${file}:${lineAt(source, start)}: a <${tagName}> tag the wizard cannot read to its end` }
  const tag = source.slice(start, end + 1)
  const label = `${file}:${lineAt(source, start)}`
  const src = attribute(tag, "src")
  if (src !== null) return { kind: "external", src, label }
  const type = attribute(tag, "type")
  if (type !== null && !JS_TYPES.test(type.trim())) return { kind: "none" }
  const inner = /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*/.exec(tag)
  if (inner) {
    const literal = readLiteral(tag, inner.index + inner[0].length)
    if (!literal) return { kind: "error", reason: `${label}: its __html is not one plain literal, so the wizard cannot know what runs without running the file` }
    return { kind: "inline", script: { code: literal.value, label, index: start } }
  }
  if (tag.endsWith("/>")) return { kind: "none" }
  let i = skipSpace(source, end + 1)
  if (source[i] !== "{") return { kind: "error", reason: `${label}: its body is not one {…} literal, so the wizard cannot know what runs without running the file` }
  i = skipSpace(source, i + 1)
  const literal = readLiteral(source, i)
  if (!literal) return { kind: "error", reason: `${label}: its body holds \${…} or is not one plain literal, so the wizard cannot know what runs without running the file` }
  i = skipSpace(source, literal.end)
  if (source[i] !== "}") return { kind: "error", reason: `${label}: its body is more than one literal` }
  i = skipSpace(source, i + 1)
  if (!source.startsWith(`</${tagName}>`, i)) return { kind: "error", reason: `${label}: its body is more than one literal` }
  return { kind: "inline", script: { code: literal.value, label, index: start } }
}

/**
 * Live-fix 4 final round (P2): the file's inline scripts and the components from the site's own code that its RENDER
 * reaches, in render order, from `roots` (the file's exported component by default; `jsx-render.ts`). A script in a
 * helper nothing renders is dropped; an element the wizard cannot resolve (a package component other than the known
 * framework ones, a name it cannot find) is `unmodeled`, so the page is refused (undetermined), never graded partial.
 */
function orderedComponentScripts(
  file: string,
  source: string,
  roots?: readonly string[] | "whole_file"
): { ok: true; entries: Array<(InlineScript & { index: number }) | RenderedComponent>; externals: string[]; unmodeled: string[]; mask: string } | { ok: false; reason: string } {
  const scan = scanSource(source)
  const entries: Array<(InlineScript & { index: number }) | RenderedComponent> = []
  const externals: string[] = []
  const unmodeled: string[] = []
  for (const node of renderWalkOn(file, source, scan, roots ?? fileRoots(source, scan.mask))) {
    const label = `${file}:${lineAt(source, node.element.start)}`
    if (node.kind === "follow") {
      entries.push({ name: node.name, from: node.from, imported: node.imported, label, index: node.element.start })
      continue
    }
    if (node.kind === "unresolvable") {
      unmodeled.push(`${label}: renders <${node.name}>, ${node.why}`)
      continue
    }
    const read = readScriptElement(file, source, node.element.start, node.element.name)
    if (read.kind === "error") return { ok: false, reason: read.reason }
    if (read.kind === "external") {
      externals.push(read.src)
      if (!isStubbedLoader(read.src)) unmodeled.push(`${read.label}: loads ${read.src.slice(0, 120)}, which the offline page cannot run`)
    } else if (read.kind === "inline") entries.push(read.script)
  }
  return { ok: true, entries, externals, unmodeled, mask: scan.mask }
}

function htmlScripts(file: string, source: string): InlineScriptRead {
  const scripts: InlineScript[] = []
  const externals: string[] = []
  const unmodeled: string[] = []
  const tag = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi
  for (let match = tag.exec(source); match !== null; match = tag.exec(source)) {
    const attributes = match[1] ?? ""
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes)
    if (src) {
      const url = src[1] ?? src[2] ?? ""
      externals.push(url)
      if (!isStubbedLoader(url)) unmodeled.push(`${file}:${lineAt(source, match.index)}: loads ${url.slice(0, 120)}, which the offline page cannot run`)
      continue
    }
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes)
    if (type && !JS_TYPES.test((type[1] ?? type[2] ?? "").trim())) continue
    scripts.push({ code: match[2] ?? "", label: `${file}:${lineAt(source, match.index)}` })
  }
  return { ok: true, scripts, externals, unmodeled }
}

/** The inline scripts `file` puts on the page, in document order, or why they cannot be known without running it. */
export function inlineScriptsOf(file: string, source: string): InlineScriptRead {
  if (HTML_FILE.test(file)) return htmlScripts(file, source)
  if (COMPONENT_FILE.test(file)) return componentScripts(file, source)
  return { ok: false, reason: `${file} is neither a page nor a component the wizard can read scripts from` }
}

/** A repo file for the page builder: its text, null when it does not exist, undefined while it is not read yet. */
type RepoRead = (path: string) => string | null | undefined

/** How deep the builder follows components rendering components (the layout's own components are depth 1). */
const MAX_COMPONENT_DEPTH = 4

/**
 * LF4 round 1 (P3): code a component runs in the browser that the offline page cannot run — an effect, a direct
 * `window` / `document` / storage access, or a hook from the site's own code (which may run either). Read outside the
 * component's inline `<Script>` bodies (those ARE modeled: they go on the page).
 */
const LOAD_TIME_CODE = /\buse(?:Layout|Insertion)?Effect\s*\(|\b(?:document|window|globalThis|navigator|localStorage|sessionStorage)\s*(?:\.|\[)/

function localHookImports(source: string): string[] {
  return localImports(source)
    .map((entry) => entry.local)
    .filter((local) => /^use[A-Z]/.test(local))
}

/**
 * LF4 close round 2 (P2-1): a function from the site's own code the component CALLS (`writeFbc()`, `utils.capture()`),
 * read outside its inline `<Script>` bodies. Its body is in another file the page model never runs, so what it does in
 * the browser is unknown: the page is undetermined, never graded as if the call did nothing.
 */
function calledLocalFunctions(outside: string, source: string): LocalImport[] {
  return localImports(source).filter((entry) => {
    if (/^use[A-Z]/.test(entry.local)) return false
    const name = escapeRegExp(entry.local)
    return new RegExp(`(?<![\\w$.])${name}\\s*(?:\\(|\\.\\s*[A-Za-z_$][\\w$]*\\s*\\()`).test(outside)
  })
}

/**
 * LF4 close round 2 (P2-1): `source` itself defines the component `imported` (`default` or a named export), with its
 * body in this file. A file that only re-exports it (`export { X } from "./x"`, `export { default } from "./y"`, a barrel
 * `index.ts`) or exports a name it does not define here never holds the component's code: the page model refuses it.
 */
export function definesComponent(source: string, imported: string): boolean {
  const masked = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1")
  const definedHere = (name: string) =>
    new RegExp(`(?:^|[\\s;])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s*|class\\s+|const\\s+|let\\s+|var\\s+)${escapeRegExp(name)}(?![\\w$])`).test(masked)
  // `export { A, B as C }` WITHOUT `from`: the local each exported name stands for.
  const exportedLocals = new Map<string, string>()
  for (const clause of masked.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from\b)/g)) {
    for (const part of clause[1]!.split(",")) {
      const [local, exported] = part.trim().split(/\s+as\s+/).map((name) => name.trim())
      if (local) exportedLocals.set(exported ?? local, local)
    }
  }
  if (imported === "default") {
    if (/\bexport\s+default\s+(?:async\s+)?(?:function|class)\b/.test(masked) || /\bexport\s+default\s+\(/.test(masked)) return true
    const named = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|\n|$)/.exec(masked)
    if (named) return definedHere(named[1]!)
    const local = exportedLocals.get("default")
    return local !== undefined && definedHere(local)
  }
  const exportedName = escapeRegExp(imported)
  if (new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function\\s*\\*?\\s*|class\\s+|const\\s+|let\\s+|var\\s+)${exportedName}(?![\\w$])`).test(masked)) return true
  const local = exportedLocals.get(imported)
  return local !== undefined && definedHere(local)
}

/**
 * The repo files an import of `spec` from `fromFile` can be (`./x` relative to it, `@/x` / `~/x` from the repo root or
 * its `src/`), with the extensions a bundler tries. A bare package or an absolute path has none: never modeled.
 */
export function localImportCandidates(fromFile: string, spec: string): string[] {
  let bases: string[]
  if (spec.startsWith("./") || spec.startsWith("../")) bases = [posix.normalize(posix.join(posix.dirname(fromFile), spec))]
  else if (spec.startsWith("@/") || spec.startsWith("~/")) bases = [spec.slice(2), `src/${spec.slice(2)}`]
  else return []
  const exts = [".tsx", ".jsx", ".ts", ".js", ".mjs", "/index.tsx", "/index.jsx", "/index.ts", "/index.js"]
  return bases.filter((base) => !base.startsWith("../") && base !== "..").flatMap((base) => (COMPONENT_FILE.test(base) ? [base] : exts.map((ext) => `${base}${ext}`)))
}

/** A job file that is the app's own entry (a Next layout, `_app` / `_document`, an HTML page): its render goes first. */
const ENTRY_FILE = /(?:^|\/)(?:src\/)?app\/(?:.*\/)?layout\.[cm]?[jt]sx?$|(?:^|\/)(?:src\/)?pages\/_(?:app|document)\.[cm]?[jt]sx?$|\.html?$/i

/**
 * The page's scripts, in render order: each file's render (its exported component, `orderedComponentScripts`), and —
 * LF4 round 1 (P3) — every component from the site's own code that render reaches, followed into that component's file
 * and walked from the definition the import names (live-fix 4 final round, P2: never the followed file's other code).
 * A component whose file holds code the browser runs that this page cannot (an effect, a `window` / `document` access,
 * a local hook), one whose file cannot be found, or one nested deeper than `MAX_COMPONENT_DEPTH` still makes the page
 * unknown (never partial). The app's entry files are walked first, and a component already on the page (rendered by
 * the layout) is never put on it twice when it is also one of the job's files.
 */
function buildPage(files: ReadonlyArray<{ file: string; source: string }>, read: RepoRead): { ok: true; source: T0PageSource } | { ok: false; reason: string } | { need: string[] } {
  const bodies: string[] = []
  const need = new Set<string>()
  /** `file#definition` already on the page. */
  const placed = new Set<string>()
  const push = (script: InlineScript): string | null => {
    if (/<\/script/i.test(script.code)) return `${script.label}: the script holds "</script", which the offline page cannot carry`
    bodies.push(`<script>${script.code}</script>`)
    return null
  }
  const visit = (file: string, source: string, depth: number, chain: readonly string[], roots?: readonly string[] | "whole_file"): string | null => {
    if (!COMPONENT_FILE.test(file)) {
      const html = inlineScriptsOf(file, source)
      if (!html.ok) return html.reason
      // LF4-P2-1: never a partial page: what production runs and this page cannot is said, never graded.
      if (html.unmodeled.length > 0) return html.unmodeled[0]!
      for (const script of html.scripts) {
        const refused = push(script)
        if (refused) return refused
      }
      return null
    }
    const ordered = orderedComponentScripts(file, source, roots)
    if (!ordered.ok) return ordered.reason
    if (ordered.unmodeled.length > 0) return ordered.unmodeled[0]!
    for (const entry of ordered.entries) {
      if ("code" in entry) {
        const refused = push(entry)
        if (refused) return refused
        continue
      }
      if (depth >= MAX_COMPONENT_DEPTH) return unmodeledComponent(entry, `nested deeper than the ${MAX_COMPONENT_DEPTH} levels the wizard reads`)
      let found: { file: string; source: string } | null = null
      let waiting = false
      for (const candidate of localImportCandidates(file, entry.from)) {
        const text = read(candidate)
        if (text === undefined) {
          need.add(candidate)
          waiting = true
          continue
        }
        if (text !== null && !waiting) {
          found = { file: candidate, source: text }
          break
        }
      }
      if (waiting) continue
      if (found === null) return unmodeledComponent(entry)
      if (chain.includes(found.file)) continue
      // LF4 close round 2 (P2-1): the file must hold the component's own code. A barrel or a re-export (`export { X }
      // from "./x"`) was read as an inert file and the page graded without the capture it really renders.
      if (!definesComponent(found.source, entry.imported)) {
        return `${entry.label}: <${entry.name}> is not defined in ${found.file} (it is re-exported or built elsewhere), which the offline page does not follow`
      }
      const mask = scanSource(found.source).mask
      const definition = exportedDefinition(found.source, mask, entry.imported)
      if (definition === null) return `${entry.label}: <${entry.name}> is defined in ${found.file} in a way the wizard cannot read`
      if (placed.has(`${found.file}#${definition}`)) continue
      placed.add(`${found.file}#${definition}`)
      // Read on the mask: a `<Script>` body or a string is never the component's own load-time code.
      const hooks = localHookImports(found.source)
      const called = calledLocalFunctions(mask, found.source)
      if (LOAD_TIME_CODE.test(mask) || hooks.length > 0 || called.length > 0) {
        const what = hooks.length > 0 ? `calls the hook ${hooks[0]}` : called.length > 0 ? `calls ${called[0]!.local} from ${called[0]!.from}` : "runs browser code"
        return `${entry.label}: <${entry.name}> (${found.file}) ${what}, which the offline page cannot run`
      }
      const reason = visit(found.file, found.source, depth + 1, [...chain, found.file], [definition])
      if (reason !== null) return reason
    }
    return null
  }
  const ordered = [...files.filter((entry) => ENTRY_FILE.test(entry.file)), ...files.filter((entry) => !ENTRY_FILE.test(entry.file))]
  for (const { file, source } of ordered) {
    let roots: readonly string[] | "whole_file" | undefined
    if (COMPONENT_FILE.test(file)) {
      const all = fileRoots(source, scanSource(source).mask)
      if (all !== "whole_file") {
        roots = all.filter((root) => !placed.has(`${file}#${root}`))
        if (all.length > 0 && roots.length === 0) continue
        for (const root of roots) placed.add(`${file}#${root}`)
      }
    }
    const reason = visit(file, source, 0, [file], roots)
    if (reason !== null && need.size === 0) return { ok: false, reason }
  }
  if (need.size > 0) return { need: [...need] }
  if (bodies.length === 0) return { ok: false, reason: `no inline script in ${files.map((entry) => entry.file).join(", ")}` }
  return { ok: true, source: { html: `<!doctype html><html><head>${bodies.join("")}</head><body><main><h1>T0</h1></main></body></html>` } }
}

/**
 * The page T0 loads for an adopted tool's job: the inline scripts of the job's files, in order, as they are NOW (the
 * agent's edit included). A script holding `</script` cannot be put in a page's markup as-is, so it is refused too.
 * With no repo to read, a rendered local component is unknown code (the page is refused, naming it).
 */
export function pageSourceFromFiles(files: ReadonlyArray<{ file: string; source: string }>): { ok: true; source: T0PageSource } | { ok: false; reason: string } {
  const built = buildPage(files, () => null)
  return "need" in built ? { ok: false, reason: "the page needs files the wizard did not read" } : built
}

/**
 * LF4 round 1 (P3): `pageSourceFromFiles`, following each rendered local component into its file in the repo
 * (`readFile`: a repo-relative path → its text, or null when it does not exist).
 */
export async function pageSourceFromRepo(
  files: ReadonlyArray<{ file: string; source: string }>,
  readFile: (path: string) => Promise<string | null>
): Promise<{ ok: true; source: T0PageSource } | { ok: false; reason: string }> {
  const cache = new Map<string, string | null>()
  for (let round = 0; round <= MAX_COMPONENT_DEPTH * 2; round += 1) {
    const built = buildPage(files, (path) => (cache.has(path) ? cache.get(path)! : undefined))
    if (!("need" in built)) return built
    for (const path of built.need) cache.set(path, await readFile(path))
  }
  return { ok: false, reason: "the page's components could not all be read" }
}

/**
 * A single-quoted JS string literal (quotes included) as a double-quoted JSON literal, read escape by escape: `\'` becomes
 * `'`, every other escape is kept whole (so an escaped backslash before a quote stays escaped), and a bare `"` is escaped.
 */
function singleQuotedAsJson(text: string): string {
  const body = text.slice(1, -1)
  let out = '"'
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!
    if (char === "\\" && i + 1 < body.length) {
      const next = body[i + 1]!
      out += next === "'" ? "'" : `\\${next}`
      i += 1
    } else if (char === '"') {
      out += '\\"'
    } else {
      out += char
    }
  }
  return `${out}"`
}
