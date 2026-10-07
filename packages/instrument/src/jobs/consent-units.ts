/** The owner's consent boundary is a byte freeze of top-level source units, not a control-flow model. */
import { createHash } from "node:crypto"
import { hunksOf, splitLines } from "../agents/line-diff.js"

export const CONSENT_API_NAMES = ["gtag", "fbq", "posthog", "dataLayer", "__tcfapi", "__uspapi", "__gpp", "__cmp", "OneTrust", "Optanon", "Cookiebot", "CookieConsent", "Didomi", "UC_UI", "usercentrics", "klaro"] as const
const API_NAMES = new Set<string>(CONSENT_API_NAMES)
// Scan the complete raw source even when a glob or malformed construct stops tokenization.
const RAW_TRIVIA = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n]*(?:\r?\n|$))*`
const API_WORD = `(?:${CONSENT_API_NAMES.join("|")}|Optanon[A-Za-z0-9_$]*|Didomi[A-Za-z0-9_$]*)`
const API_LITERAL = `['\"\x60]${API_WORD}['\"\x60]`
const API_TARGET = `(?:\\b${API_WORD}\\b|\\[\\s*${API_LITERAL}\\s*\\])`
const API_RECEIVER = `(?:(?:[\\w$]+|\\([^;\\n)]*\\))\\s*(?:\\?\\.|\\.)\\s*)*`
// Comments are JavaScript whitespace; this raw scan must not depend on tokenizer confidence.
const apiWritePattern = (pattern: string) => new RegExp(pattern.replaceAll(String.raw`\s*`, RAW_TRIVIA).replaceAll(String.raw`\s+`, `${RAW_TRIVIA.slice(0, -1)}+`), "g")
/** Syntactic writes/definitions/aliases only; this does not evaluate or model control flow. */
const API_WRITE_PATTERNS = [
  apiWritePattern(`${API_TARGET}\\s*(?:=(?!=|>)|[+*/%&|^-]=|&&=|\\|\\|=|\\?\\?=|\\+\\+|--)`),
  apiWritePattern(`\\bdelete\\b[^;]*${API_TARGET}`),
  apiWritePattern(`\\b(?:const|let|var|function|class|interface|type|enum|namespace)\\s+(?:${API_WORD}\\b|[\\[{][^;=]*\\b${API_WORD}\\b)`),
  apiWritePattern(`\\b(?:const|let|var)\\b[^;]*?,\\s*${API_TARGET}(?=\\s*[,;=:)}])`),
  apiWritePattern(`\\bfunction\\b[^;{}(]*\\([^;)]*\\b${API_WORD}\\b`),
  // Match binding clauses, never an exported function's body or an options-object closing brace.
  apiWritePattern(`\\bimport\\s+(?=[^;()]*\\b${API_WORD}\\b[^;()]*\\bfrom\\b)(?:type\\s+)?(?:[\\w$]+\\s*,?\\s*)?(?:\\{[^}]*\\}|\\*\\s+as\\s+[\\w$]+)?\\s*from\\b`),
  apiWritePattern(`\\bexport\\s+(?:type\\s+)?(?:\\{[^}]*\\b${API_WORD}\\b[^}]*\\}|\\*\\s+as\\s+${API_WORD}\\b)`),
  apiWritePattern(`\\b(?:Object|Reflect)\\s*(?:\\.\\s*(?:defineProperty|defineProperties|set)|\\[\\s*['\"\x60](?:defineProperty|defineProperties|set)['\"\x60]\\s*\\])\\s*\\([^;]*?${API_LITERAL}`),
  apiWritePattern(`(?:\\b${API_WORD}\\b|${API_LITERAL})\\s*:(?!:)`),
  apiWritePattern(`[{,]\\s*${API_WORD}\\s*(?=[,}])`),
  apiWritePattern(`${API_TARGET}\\s*\\([^;{}]*\\)\\s*(?::[^;{}]*)?\\{`),
  apiWritePattern(`=\\s*(?:\\(\\s*)*${API_RECEIVER}${API_TARGET}(?![\\w$]|\\s*(?:\\?\\.)?\\()`),
  apiWritePattern(`=\\s*${API_RECEIVER}[\\w$]+\\s*(?:\\?\\.)?\\s*\\[\\s*${API_LITERAL}\\s*\\]`)
]
export const CONSENT_CALL_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`[([,]${RAW_TRIVIA}['"]consent['"]${RAW_TRIVIA}(?:[,\])]|$)`),
  /(?:\b(?:gtag|fbq)\b|\[\s*['"`](?:gtag|fbq)['"`]\s*\])\s*(?:\?\.\s*)?\(\s*['"`]consent['"`]/,
  new RegExp("(?:\\b(?:opt_in_capturing|opt_out_capturing|has_opted_in_capturing|has_opted_out_capturing|clear_opt_in_out_capturing)\\b|\\[\\s*['\"`](?:opt_in_capturing|opt_out_capturing)['\"`]\\s*\\])" + RAW_TRIVIA + "(?:\\?\\." + RAW_TRIVIA + ")?\\("),
  /\b(?:__tcfapi|__uspapi|__gpp|__cmp|OneTrust|Optanon\w*|Cookiebot|CookieConsent|Didomi\w*|UC_UI|usercentrics|klaro)\b/i,
  /['"`]consent['"`]\s*,\s*['"`](?:default|update)['"`]/,
  /\b(?:ad_storage|analytics_storage|ad_user_data|ad_personalization|functionality_storage|personalization_storage|security_storage|wait_for_update)\b/,
  /cdn\.cookielaw\.org|otSDKStub\.js|consent\.cookiebot\.com|usercentrics\.eu/
]
export function isConsentText(text: string): boolean {
  if (CONSENT_CALL_PATTERNS.some(pattern => pattern.test(text))) return true
  const code = tokenize(text).tokens.map(token => token.text).join(" ")
  return CONSENT_CALL_PATTERNS.some(pattern => pattern.test(code))
}
interface Token { text: string; start: number; end: number; line: number; depth: number }
export interface SourceUnit {
  start: number; end: number; startLine: number; endLine: number
  text: string; prefix: string; key: string; hash: string; ordinal: number; names: string[]; references: Set<string>; frozen: boolean; apiBinding: boolean; apiBindings: string[]
}
export interface SourceUnits { units: SourceUnit[]; tail: string; confident: boolean }
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
const CLOSE = new Set(Object.values(OPEN))

/** Strings/comments/regex are opaque bracket-wise. Uncertain syntax makes the file one unit. */
function tokenize(source: string): { tokens: Token[]; confident: boolean } {
  const tokens: Token[] = []; const stack: string[] = []
  let line = 1; let confident = true
  for (let i = 0; i < source.length;) {
    const c = source[i]!
    if (/\s/.test(c)) { if (c === "\n") line++; i++; continue }
    if (source.startsWith("//", i)) { const end = source.indexOf("\n", i); i = end < 0 ? source.length : end; continue }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2)
      if (end < 0) return { tokens, confident: false }
      line += source.slice(i, end + 2).split("\n").length - 1; i = end + 2; continue
    }
    const start = i; const firstLine = line; const depth = stack.length
    if (c === "'" || c === '"' || c === "`") {
      i++
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\") { if (source[i + 1] === "\n") line++; i += 2; continue }
        if (source[i] === "\n") { if (c !== "`") confident = false; line++ }
        if (c === "`" && source.startsWith("${", i)) confident = false
        i++
      }
      if (source[i] !== c) confident = false
      else i++
    } else if (c === "/" && /^(?:|[=(,:;!&|?{}]|return|throw|=>)$/.test(tokens.at(-1)?.text ?? "")) {
      i++; let inClass = false
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue }
        if (source[i] === "\n") { confident = false; break }
        if (source[i] === "[") inClass = true
        if (source[i] === "]") inClass = false
        if (source[i] === "/" && !inClass) break
        i++
      }
      if (source[i] !== "/") confident = false
      else { i++; while (i < source.length && /[a-z]/i.test(source[i]!)) i++ }
    } else {
      const word = /^(?:[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|===|!==|=>|\?\.|&&|\|\||\?\?|==|!=|<=|>=|\+\+|--|\+=|-=|\*\*|\.\.\.)/.exec(source.slice(i))
      if (word) i += word[0].length
      else {
        if (!/[{}()[\];,.?:~!+\-*/%&|^=<>]/.test(c)) confident = false
        // JSX/HTML and angle assertions need a full language parser. They freeze as a whole file.
        if (c === "<" && /[A-Za-z/!>]/.test(source[i + 1] ?? "")) confident = false
        i++
      }
      const text = source.slice(start, i)
      if (OPEN[text]) stack.push(text)
      else if (CLOSE.has(text) && OPEN[stack.pop() ?? ""] !== text) confident = false
    }
    tokens.push({ text: source.slice(start, i), start, end: i, line: firstLine, depth })
  }
  return { tokens, confident: confident && stack.length === 0 }
}

function bindingInfo(tokens: Token[]): { key: string; names: string[]; apiBinding: boolean; apiBindings: string[] } {
  const ts = tokens.map(token => token.text)
  let at = 0
  while (["export", "default", "declare", "async", "abstract"].includes(ts[at] ?? "")) at++
  const kind = ts[at] ?? ""
  const typeOnly = ts.slice(0, at).includes("declare") || kind === "type" || kind === "interface" || (kind === "import" && ts[at + 1] === "type")
  const declaration = ["const", "let", "var", "function", "class", "interface", "type", "enum", "namespace", "import"].includes(kind)
  const names: string[] = []
  if (["const", "let", "var"].includes(kind)) {
    let binding = true
    for (let i = at + 1; i < ts.length; i++) {
      if (tokens[i]!.depth === 0 && ts[i] === ",") { binding = true; continue }
      if (tokens[i]!.depth === 0 && ts[i] === "=") { binding = false; continue }
      if (binding && IDENTIFIER.test(ts[i]!) && ts[i - 1] !== ":") names.push(ts[i]!)
    }
  } else if (["function", "class", "interface", "type", "enum", "namespace"].includes(kind)) {
    const name = ts[at + (ts[at + 1] === "*" ? 2 : 1)]
    if (name && IDENTIFIER.test(name)) names.push(name)
  } else if (kind === "import") {
    for (const token of ts.slice(at + 1)) { if (token === "from") break; if (IDENTIFIER.test(token) && token !== "as" && token !== "type") names.push(token) }
  }
  // Parameters are part of the declaration header; recognizing a name here does not analyze its use.
  const parameterStart = ts.indexOf("(", at + 1)
  const parameterEnd = parameterStart < 0 ? -1 : tokens.findIndex((token, index) => index > parameterStart && token.text === ")" && token.depth === tokens[parameterStart]!.depth + 1)
  const header = kind === "function" ? ts.slice(at + 1, parameterEnd < 0 ? ts.length : parameterEnd) : []
  // Type-only/ambient declarations supply no runtime binding. A later value declaration is new.
  let runtimeNames = names
  if (kind === "import") {
    const from = ts.indexOf("from", at + 1)
    const specifiers = ts.slice(at + 1, from < 0 ? ts.length : from).filter(token => token !== "{" && token !== "}").join(" ").split(",").map(part => part.trim().split(/\s+/))
    runtimeNames = specifiers.filter(parts => parts[0] !== "type").map(parts => parts.includes("as") ? parts[parts.lastIndexOf("as") + 1]! : parts[0]!).filter(name => IDENTIFIER.test(name))
  }
  const apiBindings = typeOnly ? [] : [...new Set([...runtimeNames, ...header].filter(name => API_NAMES.has(name)))]
  for (let i = 0; !typeOnly && i < ts.length; i++) if (ts[i] === "=>") {
    if (API_NAMES.has(ts[i - 1] ?? "")) apiBindings.push(ts[i - 1]!)
    if (ts[i - 1] === ")") {
      let j = i - 2; let depth = 1
      for (; j >= 0; j--) { if (ts[j] === ")") depth++; if (ts[j] === "(" && --depth === 0) break }
      apiBindings.push(...ts.slice(j + 1, i - 1).filter(name => API_NAMES.has(name)))
    }
  }
  const apiBinding = apiBindings.length > 0
  const callAt = ts.indexOf("(")
  const firstArgument = callAt >= 0 && /^['"`]/.test(ts[callAt + 1] ?? "") ? ts[callAt + 1] : ""
  const key = declaration && names.length ? `${kind}:${names[0]}` : `statement:${ts.slice(0, callAt < 0 ? Math.min(ts.length, 3) : callAt).join(" ")}:${firstArgument}`
  return { key, names, apiBinding, apiBindings }
}

/** Split only at depth zero. Bracket bodies stay inseparable regardless of the constructs they hold. */
export function sourceUnits(source: string): SourceUnits {
  const parsed = tokenize(source)
  // The tokenizer is not authoritative about whether raw source contains owner consent. It may
  // stop inside JSX prose, CSS URLs, or a malformed comment before reaching the protected text.
  const rawConsent = CONSENT_CALL_PATTERNS.some(pattern => pattern.test(source))
  const ts = parsed.tokens
  if (!parsed.confident || (ts.length === 0 && rawConsent)) {
    const info = bindingInfo(ts)
    return { confident: false, tail: "", units: source ? [{ start: 0, end: source.length, startLine: 1, endLine: source.split("\n").length,
      text: source, prefix: "", ...info, key: "whole-file", hash: hash(source), ordinal: 0,
      references: new Set(source.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []), frozen: rawConsent || info.names.some(name => /consent/i.test(name)) }] : [] }
  }
  const spans: Array<[number, number]> = []
  let from = 0
  const finish = (to: number) => { if (from <= to) spans.push([from, to]); from = to + 1 }
  const blockedBefore = new Set(["export", "default", "declare", "const", "let", "var", "function", "class", "new", "typeof", "void", "delete", "extends", "implements", "import", "from", "as", "satisfies", "await", "yield", "throw", "instanceof", "in", "of"])
  const blockedAfter = new Set(["from", "as", "satisfies", "else", "catch", "finally", "extends", "implements", "instanceof", "in", "of"])
  for (let i = 0; i < ts.length; i++) {
    const current = ts[i]!; const next = ts[i + 1]
    const depthAfter = current.depth + (OPEN[current.text] ? 1 : CLOSE.has(current.text) ? -1 : 0)
    if (depthAfter !== 0) continue
    if (current.text === "do" || (current.text === "else" && next && next.text !== "{" && next.text !== "if")) parsed.confident = false
    if (current.text === ")" && next && next.text !== "{") {
      const open = ts.slice(from, i).map(token => token.text === "(" && token.depth === 0).lastIndexOf(true) + from
      if (open >= from && ["if", "while", "for", "with"].includes(ts[open - 1]?.text ?? "")) parsed.confident = false
    }
    if (next && next.line > current.line && next.text.startsWith("`") && (IDENTIFIER.test(current.text) || CLOSE.has(current.text))) parsed.confident = false
    if (current.text === ";") { finish(i); continue }
    const lead = ts.slice(from, Math.min(i + 1, from + 5)).map(token => token.text).join(" ")
    const blockStatement = /^(?:(?:export|default|declare|async|abstract) )*(?:function\b|class\b|interface\b|namespace\b|enum\b|if\b|for\b|while\b|switch\b|try\b|with\b)/.test(lead)
    if (current.text === "}" && blockStatement && next?.text !== ";" && !["else", "catch", "finally"].includes(next?.text ?? "")) { finish(i); continue }
    if (next && next.line > current.line && !blockedBefore.has(current.text) && !blockedAfter.has(next.text) &&
      (IDENTIFIER.test(current.text) || /^[\d'"`]/.test(current.text) || CLOSE.has(current.text)) &&
      (IDENTIFIER.test(next.text) || /^[\d'"`]/.test(next.text))) finish(i)
  }
  if (from < ts.length) finish(ts.length - 1)
  const confident = parsed.confident && spans.length <= 750
  const actual = confident ? spans : ts.length ? [[0, ts.length - 1] as [number, number]] : []
  const units: SourceUnit[] = []
  let previousEnd = 0
  const occurrences = new Map<string, number>()
  for (const [first, last] of actual) {
    const firstToken = ts[first]!, lastToken = ts[last]!
    const lineStart = source.lastIndexOf("\n", firstToken.start - 1) + 1
    const start = /^\s*$/.test(source.slice(Math.max(previousEnd, lineStart), firstToken.start)) ? Math.max(previousEnd, lineStart) : firstToken.start
    const nextToken = ts[last + 1]
    const newline = source.indexOf("\n", lastToken.end)
    const end = newline >= 0 && (!nextToken || newline < nextToken.start) ? newline + 1 : lastToken.end
    const text = source.slice(start, end)
    const info = bindingInfo(ts.slice(first, last + 1))
    const textHash = hash(text)
    const ordinal = occurrences.get(textHash) ?? 0
    occurrences.set(textHash, ordinal + 1)
    units.push({ start, end, startLine: source.slice(0, start).split("\n").length, endLine: source.slice(0, Math.max(start, end - 1)).split("\n").length,
      text, prefix: source.slice(previousEnd, start), ...info, key: confident ? info.key : "whole-file", hash: textHash, ordinal,
      references: new Set((text.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [])), frozen: isConsentText(text) || info.names.some(name => /consent/i.test(name)) })
    previousEnd = end
  }
  if (!confident && units.length) {
    units[0]!.start = 0; units[0]!.end = source.length; units[0]!.startLine = 1; units[0]!.endLine = source.split("\n").length
    units[0]!.text = source; units[0]!.prefix = ""; units[0]!.hash = hash(source); previousEnd = source.length
  }
  markReferences(units)
  if (rawConsent) {
    // In a consent-bearing file, keep the API definitions/aliases beside the calls inseparable too.
    // This is the same raw syntactic rule used for additions, with no alias or flow evaluation.
    for (const unit of units) if (API_WRITE_PATTERNS.some(pattern => { pattern.lastIndex = 0; return pattern.test(unit.text) })) unit.frozen = true
    markReferences(units)
  }
  // Repeated statement/declaration identities cannot identify which occurrence moved or changed.
  // Declare the whole file frozen before seeding, rather than overwrite an editable neighbor.
  const counts = new Map<string, number>()
  for (const unit of units) counts.set(unit.key, (counts.get(unit.key) ?? 0) + 1)
  if ((rawConsent && !units.some(unit => unit.frozen)) || units.some(unit => unit.frozen && (counts.get(unit.key) ?? 0) > 1) || ((counts.get("statement::") ?? 0) > 1 && units.some(unit => unit.frozen))) {
    return { confident: false, tail: "", units: [{ ...units[0]!, start: 0, end: source.length, startLine: 1, endLine: source.split("\n").length, prefix: "", text: source, key: "whole-file", hash: hash(source), ordinal: 0, frozen: true, names: units.flatMap(unit => unit.names), references: new Set(units.flatMap(unit => [...unit.references])) }] }
  }
  return { units, tail: source.slice(previousEnd), confident }
}

/** A lexical binding-reference closure: a constant map and its readers/callers are frozen together. */
function markReferences(units: SourceUnit[], initial: readonly string[] = []): string[] {
  const names = new Set(initial)
  let changed = true
  while (changed) {
    changed = false
    const usedApis = new Set(units.filter(unit => unit.frozen).flatMap(unit => [...unit.references].filter(name => API_NAMES.has(name))))
    for (const unit of units) {
      // Freeze a referenced API's runtime binding header/initializer mechanically. Replacing its
      // import or initializer changes the binding the unchanged owner unit calls.
      if (!unit.frozen && ([...names].some(name => unit.references.has(name)) || unit.apiBindings.some(name => usedApis.has(name)))) { unit.frozen = true; changed = true }
      if (unit.frozen) for (const name of unit.names) if (!names.has(name)) { names.add(name); changed = true }
    }
  }
  return [...names]
}

export interface FrozenUnitChange { before: SourceUnit | null; after: SourceUnit | null }
export interface FrozenUnitRestore { text: string; changes: FrozenUnitChange[]; before: SourceUnits; after: SourceUnits }

export interface FrozenUnitOptions {
  /** Exact bytes produced by the trusted deterministic emitter. Never supplied to a worker fence. */
  trustedGenerated?: readonly string[]
}

function freezeAddedApiWrites(before: string, after: string, units: SourceUnit[], trusted: readonly string[]): void {
  const lines = splitLines(after)
  const offsets = [0]
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length)
  const added = hunksOf(splitLines(before), lines).filter(hunk => hunk.bEnd > hunk.bStart).map(hunk => [offsets[hunk.bStart]!, offsets[hunk.bEnd]!] as const)
  const allowed = [...new Set(trusted)].filter(Boolean).flatMap(text => { const start = after.indexOf(text); return start < 0 ? [] : [[start, start + text.length] as const] })
  const changed = (unit: SourceUnit) => added.some(([a, b]) => unit.start < b && unit.end > a)
  // A changed RHS or descriptor continuation belongs to its complete assignment unit.
  for (const unit of units) if (unit.apiBinding && changed(unit) && !allowed.some(([a, b]) => a <= unit.start && unit.end <= b)) unit.frozen = true
  for (const pattern of API_WRITE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of after.matchAll(pattern)) {
      const start = match.index!, end = start + match[0].length
      if (allowed.some(([a, b]) => a <= start && end <= b)) continue
      for (const unit of units) if (unit.start < end && unit.end > start && changed(unit)) unit.frozen = true
    }
  }
}

/** Ordered alignment preserves editable neighbors. No semantic edit is ever exempt inside a unit. */
export function restoreFrozenUnits(beforeText: string, afterText: string, options: FrozenUnitOptions = {}): FrozenUnitRestore {
  const beforeBom = beforeText.startsWith("\ufeff"), afterBom = afterText.startsWith("\ufeff")
  if (beforeBom || afterBom) {
    const restored = restoreFrozenUnits(beforeBom ? beforeText.slice(1) : beforeText, afterBom ? afterText.slice(1) : afterText, options)
    const protectedFile = restored.before.units.some(unit => unit.frozen) || restored.after.units.some(unit => unit.frozen)
    if (beforeBom !== afterBom && protectedFile) restored.changes.push({ before: restored.before.units[0] ?? null, after: restored.after.units[0] ?? null })
    return { ...restored, text: ((restored.changes.length > 0 ? beforeBom : afterBom) ? "\ufeff" : "") + restored.text }
  }
  let before = sourceUnits(beforeText); let after = sourceUnits(afterText)
  freezeAddedApiWrites(beforeText, afterText, after.units, options.trustedGenerated ?? [])
  const names = markReferences(before.units)
  markReferences(after.units, names)
  const existingReferences = new Set(before.units.flatMap(unit => [...unit.references]))
  const shadows = (unit: SourceUnit, previous?: SourceUnit) => unit.apiBindings.some(name => existingReferences.has(name) && !previous?.apiBindings.includes(name))
  if ((!before.confident || !after.confident) && (before.units.some(unit => unit.frozen) || after.units.some(unit => unit.frozen))) {
    const whole = (text: string, model: SourceUnits): SourceUnits => ({ confident: false, tail: "", units: text ? [{ ...(model.units[0] ?? { names: [], references: new Set<string>(), apiBinding: false, apiBindings: [] }), start: 0, end: text.length, startLine: 1, endLine: text.split("\n").length, text, prefix: "", key: "whole-file", hash: hash(text), ordinal: 0, frozen: true }] : [] })
    before = whole(beforeText, before); after = whole(afterText, after)
  }
  const a = before.units, b = after.units
  const width = b.length + 1
  const scores = new Uint32Array((a.length + 1) * width)
  // Editable existing units are anchors: moving a frozen unit across one is restored to its old side.
  const weight = (unit: SourceUnit) => unit.frozen ? 1 : a.length + b.length + 1
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    scores[i * width + j] = Math.max(scores[(i + 1) * width + j]!, scores[i * width + j + 1]!, a[i]!.key === b[j]!.key ? weight(a[i]!) + scores[(i + 1) * width + j + 1]! : 0)
  }
  const changes: FrozenUnitChange[] = []; const output: string[] = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    const old = a[i], next = b[j]
    if (old && next && old.key === next.key && scores[i * width + j] === weight(old) + scores[(i + 1) * width + j + 1]!) {
      if ((old.frozen || next.frozen || shadows(next, old)) && old.hash !== next.hash) { changes.push({ before: old, after: next }); output.push(next.prefix + old.text) }
      else output.push(next.prefix + next.text)
      i++; j++
    } else if (old && (!next || scores[(i + 1) * width + j]! >= scores[i * width + j + 1]!)) {
      if (old.frozen) { changes.push({ before: old, after: null }); output.push(old.prefix + old.text) }
      i++
    } else if (next) {
      if (next.frozen || shadows(next)) changes.push({ before: null, after: next })
      else output.push(next.prefix + next.text)
      j++
    }
  }
  return { text: output.join("") + after.tail, changes, before, after }
}

export function frozenUnitAt(source: string, line: number): SourceUnit | null {
  return sourceUnits(source).units.find(unit => unit.frozen && unit.startLine <= line && line <= unit.endLine) ?? null
}

/** Every worker target uses its evidence line. Managed capture is planned at its fixed entry instead. */
export function frozenEditPlace(item: { id: string; jobId: string; trigger: { evidence: readonly ({ file: string; line: number } | { url: string })[] } }, sources: ReadonlyMap<string, string>): { file: string; line: number; unit: SourceUnit } | null {
  for (const entry of item.trigger.evidence) {
    if (!("file" in entry)) continue
    const source = sources.get(entry.file)
    if (source === undefined) continue
    const unit = frozenUnitAt(source, entry.line)
    if (unit) return { ...entry, unit }
  }
  return null
}
