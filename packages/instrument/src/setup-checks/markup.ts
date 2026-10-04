// Bounded, read-only structure reading for the setup checks.
//
// PRIVACY, and it is a hard line: everything here reads TAGS and ATTRIBUTE NAMES. It never reads a
// form field's value, never quotes visible copy, and never returns an attribute value except the
// one literal `data-conversion` token the runtime itself switches on. Nothing it produces leaves
// the machine — findings carry a file path and a line number, the same evidence the harness
// already prints for a provider row.
//
// It is a text scan, not a parser. JSX is not HTML and a real parse would need the app's whole
// toolchain, so ambiguity is answered with `undetermined` rather than a guess (see `enclosedBy`).
import { openingTagEnd } from "../harness/marking.js"
import { lineNumberAt } from "../harness/scan.js"

/** One element in a source file, located and identified by tag alone. */
export interface ElementSite {
  /** Lowercased tag as written; a JSX `Link` is reported as `a`, which is what it renders. */
  tag: string
  /** The raw opening tag text, for attribute-NAME tests only. */
  openingTag: string
  offset: number
  end: number
  /** 1-based line of the `<`. */
  line: number
}

/** `Link` renders an anchor; the runtime sees the DOM, so the check must too. */
export function normalizeTag(raw: string): string {
  const lower = raw.toLowerCase()
  return lower === "link" ? "a" : lower
}

/** Every opening tag in the file, in document order. Unterminated tags stop the scan. */
export function elementSites(contents: string): ElementSite[] {
  const sites: ElementSite[] = []
  const pattern = /<([A-Za-z][\w.-]*)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(contents)) !== null) {
    const offset = match.index
    const end = openingTagEnd(contents, offset)
    if (end === null) break
    sites.push({
      tag: normalizeTag(match[1] as string),
      openingTag: contents.slice(offset, end),
      offset,
      end,
      line: lineNumberAt(contents, offset)
    })
    pattern.lastIndex = end
  }
  return sites
}

/**
 * The literal value of an attribute, or `null` when it is present but dynamic.
 *
 * `data-conversion={kind}` is a real and legitimate pattern, and there is no honest way to know
 * from source what it evaluates to — the caller turns `null` into `undetermined`, never into a
 * verdict.
 */
export function literalAttributeValue(openingTag: string, name: string): string | null {
  const literal = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*["'\`]([^"'\`]*)["'\`]\\s*\\})`).exec(openingTag)
  if (literal) return literal[1] ?? literal[2] ?? literal[3] ?? null
  return null
}

export function hasAttributeName(openingTag: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(openingTag)
}

export type Enclosure = "inside" | "outside" | "unreadable"

/**
 * Is `offset` inside an open `<tag>`?
 *
 * Counts opens against closes in the text before it — the same local heuristic `marking.ts` uses
 * to name a CTA's landmark, so the two never disagree about what "inside a nav" means. It answers
 * `unreadable` when the file closes more of the tag than it opens, which is what a fragment or a
 * templating construct looks like: a file we are not reading correctly must not produce a verdict.
 */
export function enclosedBy(contents: string, offset: number, tag: string): Enclosure {
  const before = contents.slice(0, offset)
  const opens = [...before.matchAll(new RegExp(`<${tag}\\b`, "gi"))].length
  const closes = [...before.matchAll(new RegExp(`</${tag}\\s*>`, "gi"))].length
  if (closes > opens) return "unreadable"
  return opens > closes ? "inside" : "outside"
}

export interface FormRegion {
  site: ElementSite
  /** Everything between the opening tag and its `</form>`; "" when the close is missing. */
  inner: string
  /** False when no `</form>` follows — the region could not be bounded. */
  closed: boolean
}

/** Every `<form>` in the file with its contents bounded by the next `</form>`. */
export function formRegions(contents: string): FormRegion[] {
  return elementSites(contents)
    .filter((site) => site.tag === "form")
    .map((site) => {
      const close = contents.indexOf("</form", site.end)
      return close === -1
        ? { site, inner: "", closed: false }
        : { site, inner: contents.slice(site.end, close), closed: true }
    })
}
