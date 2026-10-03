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
import type { T0PageSource } from "./protocol.js"

export interface InlineScript {
  /** The script's code as the browser runs it. */
  code: string
  /** `<file>:<line>` of the element. */
  label: string
}

export type InlineScriptRead =
  | { ok: true; scripts: InlineScript[]; externals: string[] }
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
      const json = quote === '"' ? text : `"${text.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`
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

function componentScripts(file: string, source: string): InlineScriptRead {
  const scripts: InlineScript[] = []
  const externals: string[] = []
  const opening = /<(Script|script)\b/g
  for (let match = opening.exec(source); match !== null; match = opening.exec(source)) {
    const start = match.index
    const end = openingTagEnd(source, start)
    if (end < 0) return { ok: false, reason: `${file}:${lineAt(source, start)}: a <${match[1]}> tag the wizard cannot read to its end` }
    const tag = source.slice(start, end + 1)
    const label = `${file}:${lineAt(source, start)}`
    const src = attribute(tag, "src")
    if (src !== null) {
      externals.push(src)
      opening.lastIndex = end + 1
      continue
    }
    const type = attribute(tag, "type")
    if (type !== null && !JS_TYPES.test(type.trim())) {
      opening.lastIndex = end + 1
      continue
    }
    const inner = /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*/.exec(tag)
    if (inner) {
      const literal = readLiteral(tag, inner.index + inner[0].length)
      if (!literal) return { ok: false, reason: `${label}: its __html is not one plain literal, so the wizard cannot know what runs without running the file` }
      scripts.push({ code: literal.value, label })
      opening.lastIndex = end + 1
      continue
    }
    if (tag.endsWith("/>")) {
      opening.lastIndex = end + 1
      continue
    }
    let i = skipSpace(source, end + 1)
    if (source[i] !== "{") return { ok: false, reason: `${label}: its body is not one {…} literal, so the wizard cannot know what runs without running the file` }
    i = skipSpace(source, i + 1)
    const literal = readLiteral(source, i)
    if (!literal) return { ok: false, reason: `${label}: its body holds \${…} or is not one plain literal, so the wizard cannot know what runs without running the file` }
    i = skipSpace(source, literal.end)
    if (source[i] !== "}") return { ok: false, reason: `${label}: its body is more than one literal` }
    i = skipSpace(source, i + 1)
    if (!source.startsWith(`</${match[1]}>`, i)) return { ok: false, reason: `${label}: its body is more than one literal` }
    scripts.push({ code: literal.value, label })
    opening.lastIndex = i
  }
  return { ok: true, scripts, externals }
}

function htmlScripts(file: string, source: string): InlineScriptRead {
  const scripts: InlineScript[] = []
  const externals: string[] = []
  const tag = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  for (let match = tag.exec(source); match !== null; match = tag.exec(source)) {
    const attributes = match[1] ?? ""
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes)
    if (src) {
      externals.push(src[1] ?? src[2] ?? "")
      continue
    }
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes)
    if (type && !JS_TYPES.test((type[1] ?? type[2] ?? "").trim())) continue
    scripts.push({ code: match[2] ?? "", label: `${file}:${lineAt(source, match.index)}` })
  }
  return { ok: true, scripts, externals }
}

/** The inline scripts `file` puts on the page, in document order, or why they cannot be known without running it. */
export function inlineScriptsOf(file: string, source: string): InlineScriptRead {
  if (HTML_FILE.test(file)) return htmlScripts(file, source)
  if (COMPONENT_FILE.test(file)) return componentScripts(file, source)
  return { ok: false, reason: `${file} is neither a page nor a component the wizard can read scripts from` }
}

/**
 * The page T0 loads for an adopted tool's job: the inline scripts of the job's files, in order, as they are NOW (the
 * agent's edit included). A script holding `</script` cannot be put in a page's markup as-is, so it is refused too.
 */
export function pageSourceFromFiles(files: ReadonlyArray<{ file: string; source: string }>): { ok: true; source: T0PageSource } | { ok: false; reason: string } {
  const bodies: string[] = []
  for (const { file, source } of files) {
    const read = inlineScriptsOf(file, source)
    if (!read.ok) return read
    for (const script of read.scripts) {
      if (/<\/script/i.test(script.code)) return { ok: false, reason: `${script.label}: the script holds "</script", which the offline page cannot carry` }
      bodies.push(`<script>${script.code}</script>`)
    }
  }
  if (bodies.length === 0) return { ok: false, reason: `no inline script in ${files.map((entry) => entry.file).join(", ")}` }
  return { ok: true, source: { html: `<!doctype html><html><head>${bodies.join("")}</head><body><main><h1>T0</h1></main></body></html>` } }
}
