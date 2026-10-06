/** Small source reader for the fence. Tokens and governing conditions matter; whitespace does not. */
import { escapeForTemplateLiteral } from "../text-escape.js"
interface Token { text: string; start: number; end: number }
export type ConsentRange = [number, number]
interface Call { signature: string; ranges: ConsentRange[] }

function tokens(source: string): Token[] {
  const result: Token[] = []
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i]!)) { i++; continue }
    if (source.startsWith("//", i)) { const end = source.indexOf("\n", i); i = end < 0 ? source.length : end; continue }
    if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; continue }
    const start = i
    if (source[i] === "'" || source[i] === '"') {
      const quote = source[i++]
      while (i < source.length && source[i] !== quote) i += source[i] === "\\" ? 2 : 1
      i = Math.min(source.length, i + 1)
    } else {
      // Template script bodies are executable source, so read their contents too.
      const word = /^[\w$]+|^(?:=>|&&|\|\||===|!==|==|!=|\?\.)/.exec(source.slice(i))
      i += word?.[0].length ?? 1
    }
    result.push({ text: source.slice(start, i), start, end: i })
  }
  return result
}

function model(source: string, expectedGuard: string | null): Call[] {
  const ts = tokens(source)
  const pair = new Map<number, number>()
  const stack: number[] = []
  const closers: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
  ts.forEach((token, i) => {
    if (closers[token.text]) stack.push(i)
    else if ([")", "]", "}"].includes(token.text) && closers[ts[stack.at(-1) ?? -1]?.text ?? ""] === token.text) {
      const open = stack.pop()!
      pair.set(open, i)
      pair.set(i, open)
    }
  })
  const text = (start: number, end: number) => ts.slice(start, end + 1).map((t) => t.text).join(" ")
  const lineStarts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1)
  const line = (offset: number) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) { const mid = (low + high + 1) >> 1; if (lineStarts[mid]! <= offset) low = mid; else high = mid - 1 }
    return low + 1
  }
  const range = (start: number, end: number): ConsentRange => [line(ts[start]?.start ?? 0), line(ts[end]?.end ?? source.length)]
  const stripParens = (start: number, end: number): [number, number] => {
    while (ts[start]?.text === "(" && pair.get(start) === end) { start++; end-- }
    return [start, end]
  }
  const guardTokens = expectedGuard ? [expectedGuard, escapeForTemplateLiteral(expectedGuard)].map(value => tokens(value).map(t => t.text).join(" ")) : []
  const sanctioned = (start: number, end: number) => {
    ;[start, end] = stripParens(start, end)
    if (ts[start]?.text !== "!") return false
    ;[start, end] = stripParens(start + 1, end)
    return guardTokens.includes(text(start, end))
  }
  const endStatement = (start: number): number => {
    if (ts[start]?.text === "{") return pair.get(start) ?? ts.length - 1
    for (let i = start; i < ts.length; i++) {
      if (ts[i]!.text === ";") return i
      if (ts[i]!.text === "}") return i - 1
      if (pair.has(i) && pair.get(i)! > i) i = pair.get(i)!
      else if (i > start && line(ts[i]!.start) > line(ts[i - 1]!.end) && /^[\w$'"]/.test(ts[i]!.text) && /^(?:[\w$]+|['"][\s\S]*|\)|\])$/.test(ts[i - 1]!.text)) return i - 1
    }
    return ts.length - 1
  }
  const functionRanges: Array<[number, number]> = []
  ts.forEach((token, i) => {
    if (token.text !== "function" && token.text !== "=>") return
    let body = i + 1
    if (token.text === "function") {
      while (body < ts.length && ts[body]!.text !== "(") body++
      body = (pair.get(body) ?? body) + 1
    }
    if (ts[body]?.text === "{") functionRanges.push([body, pair.get(body) ?? ts.length - 1])
  })
  const fn = (at: number) => functionRanges.filter(([a, b]) => a < at && at < b).sort((a, b) => b[0] - a[0])[0]?.[0] ?? -1
  const calls: Call[] = []
  for (let at = 0; at < ts.length; at++) {
    if (ts[at + 1]?.text !== "(") continue
    const name = ts[at]!.text
    const open = at + 1
    const close = pair.get(open)
    if (close === undefined) continue
    const firstArg = ts[open + 1]?.text.replace(/^['"]|['"]$/g, "")
    const consent = ((name === "gtag" || name === "fbq") && firstArg === "consent") ||
      ["__tcfapi", "__uspapi", "__gpp", "opt_in_capturing", "opt_out_capturing"].includes(name) ||
      (name === "push" && /['"]consent['"]\s*,\s*['"](?:default|update)['"]/.test(source.slice(ts[open]!.start, ts[close]!.end)))
    if (!consent) continue
    const conditions: string[] = [`function-depth:${functionRanges.filter(([a, b]) => a < at && at < b).length}`]
    const ranges = [range(at, close), ...functionRanges.filter(([a, b]) => a < at && at < b).flatMap(([a, b]) => [range(a, a), range(b, b)])]
    for (let i = 0; i < ts.length; i++) {
      if (ts[i]!.text !== "if" || ts[i + 1]?.text !== "(") continue
      const condEnd = pair.get(i + 1)
      if (condEnd === undefined) continue
      const body = condEnd + 1
      const bodyEnd = endStatement(body)
      const condition = text(i + 2, condEnd - 1)
      if (at >= body && at <= bodyEnd) { conditions.push(`if:${condition}`); ranges.push(range(i, body), range(bodyEnd, bodyEnd)); continue }
      const elseAt = bodyEnd + 1
      if (ts[elseAt]?.text === "else" && at > elseAt && at <= endStatement(elseAt + 1)) {
        conditions.push(`else:${condition}`); ranges.push(range(i, body), range(elseAt, elseAt + 1), range(endStatement(elseAt + 1), endStatement(elseAt + 1))); continue
      }
    }
    // Every preceding return in this function can prevent the call, including nested if branches.
    for (let r = 0; r < at; r++) {
      if (ts[r]!.text !== "return" || fn(r) !== fn(at)) continue
      const controls: string[] = []
      const returnRanges = [range(r, endStatement(r))]
      let approvedPreview = false
      for (let i = 0; i < r; i++) {
        if (ts[i]!.text !== "if" || ts[i + 1]?.text !== "(") continue
        const condEnd = pair.get(i + 1)
        if (condEnd === undefined) continue
        const body = condEnd + 1
        const end = endStatement(body)
        const elseAt = end + 1
        if (r >= body && r <= end) {
          if (sanctioned(i + 2, condEnd - 1) && (/^return\b/.test(text(body, end)) || /^\{\s*return\b[^{}]*\}$/.test(text(body, end)))) approvedPreview = true
          controls.push(`if:${text(i + 2, condEnd - 1)}`)
          returnRanges.push(range(i, body), range(end, end))
        } else if (ts[elseAt]?.text === "else" && r > elseAt && r <= endStatement(elseAt + 1)) {
          controls.push(`else:${text(i + 2, condEnd - 1)}`)
          returnRanges.push(range(i, body), range(elseAt, elseAt + 1))
        }
      }
      if (!approvedPreview) { conditions.push(`return:${JSON.stringify(controls)}`); ranges.push(...returnRanges) }
    }
    for (let op = 0; op < at; op++) {
      if (ts[op]!.text !== "&&" && ts[op]!.text !== "||") continue
      if (fn(op) !== fn(at) || endStatement(op + 1) < at) continue
      let start = op - 1
      while (start >= 0 && ![";", "{", "(", "=", "return", ",", "?", ":"].includes(ts[start]!.text)) {
        if (pair.has(start) && pair.get(start)! < start) start = pair.get(start)!
        start--
      }
      conditions.push(`short-${ts[op]!.text}:${text(start + 1, op - 1)}`)
      ranges.push(range(start + 1, op))
    }
    // Ternary conditions. Jump nested bracket groups while finding expression boundaries.
    for (let q = 0; q < at; q++) {
      if (ts[q]!.text !== "?") continue
      let colon = q + 1
      let nested = 0
      for (; colon < ts.length; colon++) {
        if (pair.has(colon) && pair.get(colon)! > colon) { colon = pair.get(colon)!; continue }
        if (ts[colon]!.text === "?") nested++
        if (ts[colon]!.text === ":") { if (nested === 0) break; nested-- }
        if ([";", "}"].includes(ts[colon]!.text)) break
      }
      if (ts[colon]?.text !== ":") continue
      let start = q - 1
      while (start >= 0 && ![";", "{", "=", "return", ",", "?", ":"].includes(ts[start]!.text)) {
        if (pair.has(start) && pair.get(start)! < start) start = pair.get(start)!
        start--
      }
      let end = colon + 1
      for (; end < ts.length; end++) {
        if (pair.has(end) && pair.get(end)! > end) { end = pair.get(end)!; continue }
        if ([";", "}", ")", "]", ","].includes(ts[end]!.text)) break
      }
      if (at > q && at < end) { conditions.push(`ternary-${at < colon ? "yes" : "no"}:${text(start + 1, q - 1)}`); ranges.push(range(start + 1, end - 1)) }
    }
    let callStart = at
    while (ts[callStart - 1]?.text === "." && /^[\w$]+$/.test(ts[callStart - 2]?.text ?? "")) callStart -= 2
    calls.push({ signature: JSON.stringify([text(callStart, close), conditions.sort()]), ranges })
  }
  return calls
}

export function changedConsentRanges(before: string, after: string, expectedGuard: string | null = null): { before: ConsentRange[]; after: ConsentRange[]; recognized: boolean } {
  const a = model(before, expectedGuard)
  const b = model(after, expectedGuard)
  const result: { before: ConsentRange[]; after: ConsentRange[]; recognized: boolean } = { before: [], after: [], recognized: a.length > 0 || b.length > 0 }
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]?.signature === b[i]?.signature) continue
    result.before.push(...a[i]?.ranges ?? [])
    result.after.push(...b[i]?.ranges ?? [])
  }
  return result
}
