// A value as JavaScript source for code the tests build and run in node:vm. JSON.stringify alone leaves `<`,
// `>`, `/` and the U+2028/U+2029 line separators raw, so a value could close a `<script>` element or break a
// pre-ES2019 string literal; each is written as its `\uXXXX` escape instead (inside a JSON string, the only
// place those characters can appear, the escape decodes to the same character).
export function jsSource(value: unknown): string {
  return (JSON.stringify(value) ?? "undefined").replace(/[<>/\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)
}
