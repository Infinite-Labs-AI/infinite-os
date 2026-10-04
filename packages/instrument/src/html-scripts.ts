/** Script-element evidence only; never executes or sanitizes HTML for rendering. */
export interface HtmlScript {
  start: number
  bodyStart: number
  bodyEnd: number
  end: number
  attributes: Map<string, string>
}
interface Tag {
  name: string
  closing: boolean
  end: number
  nameEnd: number
  selfClosing: boolean
}
const space = (char: string | undefined) => char !== undefined && " \t\n\r\f".includes(char)
function tagAt(source: string, start: number): Tag | null {
  let at = start + 1
  const closing = source[at] === "/"
  if (closing) at++
  if (!/[A-Za-z]/.test(source[at] ?? "")) return null
  const begin = at
  while (at < source.length && /[A-Za-z0-9:_-]/.test(source[at])) at++
  if (at < source.length && !space(source[at]) && source[at] !== "/" && source[at] !== ">")
    return null
  const name = source.slice(begin, at).toLowerCase(),
    nameEnd = at
  let quote = ""
  for (; at < source.length; at++) {
    const char = source[at]
    if (quote) {
      if (char === quote) quote = ""
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ">")
      return { name, closing, end: at + 1, nameEnd, selfClosing: source[at - 1] === "/" }
  }
  return null
}
function attributes(source: string, tag: Tag): Map<string, string> {
  const result = new Map<string, string>()
  let at = tag.nameEnd
  while (at < tag.end - 1) {
    while (space(source[at]) || source[at] === "/") at++
    const begin = at
    while (at < tag.end - 1 && !space(source[at]) && !"=/>".includes(source[at])) at++
    const name = source.slice(begin, at).toLowerCase()
    if (!name) {
      at++
      continue
    }
    while (space(source[at])) at++
    let value = ""
    if (source[at] === "=") {
      at++
      while (space(source[at])) at++
      const quote = source[at] === '"' || source[at] === "'" ? source[at++] : null
      const valueStart = at
      while (
        at < tag.end - 1 &&
        (quote ? source[at] !== quote : !space(source[at]) && source[at] !== ">")
      )
        at++
      value = source.slice(valueStart, at)
      if (quote && source[at] === quote) at++
    }
    if (!result.has(name)) result.set(name, value)
  }
  return result
}
function closeTag(
  source: string,
  lower: string,
  from: number,
  name: string
): { start: number; end: number } | null {
  let at = from
  while ((at = lower.indexOf("</" + name, at)) >= 0) {
    const tag = tagAt(source, at)
    if (tag?.closing && tag.name === name) return { start: at, end: tag.end }
    at += name.length + 2
  }
  return null
}
export function htmlScripts(
  source: string,
  html: boolean,
  eligible: (start: number) => boolean = () => true
): HtmlScript[] {
  const result: HtmlScript[] = [],
    lower = source.replace(/[A-Z]/g, (char) => char.toLowerCase())
  const rawText = new Set([
    "style",
    "textarea",
    "title",
    "xmp",
    "iframe",
    "noembed",
    "noframes",
    "noscript"
  ])
  let at = 0,
    templates = 0
  while ((at = source.indexOf("<", at)) >= 0) {
    const start = at,
      tag = tagAt(source, at)
    if (!tag) {
      at++
      continue
    }
    if (html && tag.name === "template") templates = Math.max(0, templates + (tag.closing ? -1 : 1))
    if (!tag.closing && tag.name === "script" && eligible(start)) {
      const close =
        !html && tag.selfClosing
          ? { start: tag.end, end: tag.end }
          : closeTag(source, lower, tag.end, "script")
      const bodyEnd = close?.start ?? source.length,
        end = close?.end ?? source.length
      if (!templates)
        result.push({
          start,
          bodyStart: tag.end,
          bodyEnd,
          end,
          attributes: attributes(source, tag)
        })
      at = end
    } else if (html && !tag.closing && rawText.has(tag.name)) {
      at = closeTag(source, lower, tag.end, tag.name)?.end ?? source.length
    } else if (html && !tag.closing && tag.name === "plaintext") {
      break
    } else {
      at = html ? tag.end : start + 1
    }
  }
  return result
}
