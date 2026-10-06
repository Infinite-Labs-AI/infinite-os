import { expect, it } from "vitest"
import { buildHostGuardExpression } from "../host-guard.js"
import { changedConsentRanges } from "./consent-model.js"
import { escapeForTemplateLiteral } from "../text-escape.js"

const call = "fbq('consent', 'grant');"
const base = `function boot() {\n${call}\n}`
const changed = (after: string, expected: string | null = null) => changedConsentRanges(base, after, expected).after.length > 0

it("compares consent tokens and if, ternary and early-return conditions", () => {
  expect(changed(`function boot() {\n  ${call}\n}`)).toBe(false)
  expect(changed(`function boot() {\nif (enabled) {\n${call}\n}\n}`)).toBe(true)
  expect(changed(`function boot() {\nif (disabled) return;\n${call}\n}`)).toBe(true)
  expect(changed(`function boot() {\nif (outer) { if(inner) return; }\n${call}\n}`)).toBe(true)
  expect(changed(`function boot() {\nenabled ? ${call.slice(0, -1)} : null;\n}`)).toBe(true)
  expect(changed(`function boot() {\nenabled ? null : ${call}\n}`)).toBe(true)
  expect(changed(`function boot() {\nwindow.${call}\n}`)).toBe(true)
  expect(changed(`function boot() {\nenabled && ${call}\n}`)).toBe(true)
  expect(changed(`function boot() {\nenabled || ${call}\n}`)).toBe(true)
  expect(changed(`function boot() { button.onclick = () => { ${call} } }`)).toBe(true)
  expect(changed(`function boot() {\nfbq('consent', 'revoke');\n}`)).toBe(true)
})

it("does not assign a semicolon-free preceding statement's condition to consent", () => {
  const a = `function boot(){\nif(a) foo()\n${call}\n}`
  expect(changedConsentRanges(a, a.replace("if(a)", "if(b)")).after).toEqual([])
})

it("allows only the approved emitted early-return preview expression", () => {
  const guard = buildHostGuardExpression({ mode: "allow", hosts: ["example.com"] })
  expect(changed(`function boot() {\nif (!(${guard})) return;\n${call}\n}`, guard)).toBe(false)
  expect(changed(`function boot() {\nif (!(${guard.replace("example.com", "other.test")})) return;\n${call}\n}`, guard)).toBe(true)
  expect(changed(`function boot() {\nif (${guard}) {\n${call}\n}\n}`, guard)).toBe(true)
  const script = `<Script>{\`function boot(){\n${call}\n}\`}</Script>`
  const guarded = script.replace(call, `if (!(${escapeForTemplateLiteral(guard)})) return;\n${call}`)
  expect(changedConsentRanges(script, guarded, guard).after).toEqual([])
})

it("detects changes to existing conditions and ignores whitespace inside their code", () => {
  const a = `function boot(){if (a && b) { ${call} }}`
  expect(changedConsentRanges(a, a.replace("a && b", "a || b")).after.length).toBeGreaterThan(0)
  expect(changedConsentRanges(a, a.replace("a && b", " a  &&  b ")).after).toEqual([])
})
