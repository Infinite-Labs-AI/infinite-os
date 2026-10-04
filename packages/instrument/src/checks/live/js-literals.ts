// Read the managed Next bootstrap back out of a served JS bundle.
//
// On Next.js, infinite-tag's managed module holds every provider snippet as ONE JSON string literal
// (`const bootstrapSource = "…"`, `frameworks/managed-files.ts`), injected after hydration. The served
// HTML therefore carries no `posthog.init` / `gtag(` / `fbq(` at all, and inside the bundle every
// quote is escaped (`\"phc_…\"`), so a regex over the raw bytes finds nothing (scout S5 fact 21).
// This scanner finds the string literals that carry analytics markers and DECODES them, so the live
// checks read the bootstrap the browser will actually run.
//
// It is a tokenizer over minified JS, not a parser: a regex literal containing a quote can throw it
// off. That can only make it MISS a literal, and a miss is caught by the caller's fallback (an
// expected id present in the raw bundle bytes but not readable as an init → undetermined), never a
// false pass.

/** Markers that make a string literal worth decoding. */
export const ANALYTICS_LITERAL_MARKERS = ["posthog.init", "gtag(", "fbq(", "__infiniteAnalyticsRuntime"] as const

/**
 * Every string literal (single, double, or a template with no `${`) whose RAW text contains one of
 * `markers`, decoded. Line comments and block comments are skipped.
 */
export function decodedLiteralsWith(source: string, markers: readonly string[] = ANALYTICS_LITERAL_MARKERS): string[] {
  const found: string[] = []
  let index = 0
  const length = source.length
  while (index < length) {
    const char = source[index]
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2)
      index = end === -1 ? length : end + 1
      continue
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2)
      index = end === -1 ? length : end + 2
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      const end = literalEnd(source, index)
      if (end === -1) break
      const raw = source.slice(index + 1, end)
      if (markers.some((marker) => raw.includes(marker)) && !(char === "`" && raw.includes("${"))) {
        const decoded = decodeJsStringBody(raw)
        if (decoded !== null) found.push(decoded)
      }
      index = end + 1
      continue
    }
    index += 1
  }
  return found
}

/** Index of the closing quote of the literal opening at `start`, or -1 when it never closes. */
function literalEnd(source: string, start: number): number {
  const quote = source[start]
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === "\\") {
      index += 1
      continue
    }
    if (char === quote) return index
    // A plain string cannot span a raw newline; a template can.
    if (quote !== "`" && (char === "\n" || char === "\r")) return -1
  }
  return -1
}

/** Decode the body of a JS string literal (escapes included). Null when an escape is malformed. */
export function decodeJsStringBody(body: string): string | null {
  let out = ""
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string
    if (char !== "\\") {
      out += char
      continue
    }
    const next = body[index + 1]
    if (next === undefined) return null
    index += 1
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
        out += "\0"
        break
      case "\n":
        break
      case "\r":
        if (body[index + 1] === "\n") index += 1
        break
      case "x": {
        const hex = body.slice(index + 1, index + 3)
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null
        out += String.fromCharCode(Number.parseInt(hex, 16))
        index += 2
        break
      }
      case "u": {
        if (body[index + 1] === "{") {
          const close = body.indexOf("}", index + 2)
          const hex = close === -1 ? "" : body.slice(index + 2, close)
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return null
          out += String.fromCodePoint(Number.parseInt(hex, 16))
          index = close
        } else {
          const hex = body.slice(index + 1, index + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null
          out += String.fromCharCode(Number.parseInt(hex, 16))
          index += 4
        }
        break
      }
      default:
        out += next
    }
  }
  return out
}
