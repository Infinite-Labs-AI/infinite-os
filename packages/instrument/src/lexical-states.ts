// One lexer state per offset, shared by the census and the provider scan (§3x.6, one detector): a call inside a
// template literal is usually an inline `<Script>{…}</Script>` body, which runs; one inside a quoted string is
// an example, which does not.
/** Lexical state per offset: 0 code, 1 a quoted string, 2 a template literal, 3 a comment. */
export function lexicalStates(source: string): Uint8Array {
  const states = new Uint8Array(source.length)
  let state: 0 | 1 | 2 | 3 = 0
  let closer = ""
  let lineComment = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!
    const next = source[i + 1]
    if (state === 0) {
      if (ch === "/" && next === "/") {
        state = 3
        lineComment = true
        states[i] = 3
        continue
      }
      if (ch === "/" && next === "*") {
        state = 3
        lineComment = false
        states[i] = 3
        continue
      }
      if (ch === "'" || ch === '"') {
        state = 1
        closer = ch
      } else if (ch === "`") {
        state = 2
        closer = "`"
      }
      states[i] = 0
      continue
    }
    states[i] = state
    if (state === 3) {
      if (lineComment && ch === "\n") state = 0
      if (!lineComment && ch === "*" && next === "/") {
        states[i + 1] = 3
        i += 1
        state = 0
      }
      continue
    }
    if (ch === "\\") {
      if (i + 1 < source.length) states[i + 1] = state
      i += 1
      continue
    }
    if (ch === closer) {
      states[i] = 0
      state = 0
    }
  }
  return states
}
