/** The owner's consent boundary is a byte freeze of top-level source units, not a control-flow model. */
import { createHash } from "node:crypto"

export const CONSENT_CALL_PATTERNS: readonly RegExp[] = [
  /[([,]\s*['"`]consent['"`]\s*,\s*['"`](?:default|update|grant|revoke)['"`]/,
  /(?:\b(?:gtag|fbq)\b|\[\s*['"`](?:gtag|fbq)['"`]\s*\])\s*(?:\?\.\s*)?\(\s*['"`]consent['"`]/,
  /(?:\b(?:opt_in_capturing|opt_out_capturing|has_opted_in_capturing|has_opted_out_capturing|clear_opt_in_out_capturing)\b|\[\s*['"`](?:opt_in_capturing|opt_out_capturing)['"`]\s*\])\s*(?:\?\.\s*)?\(/,
  /\b(?:__tcfapi|__uspapi|__gpp|__cmp|OneTrust|Optanon\w*|Cookiebot|CookieConsent|Didomi\w*|UC_UI|usercentrics|klaro)\b/i,
  /['"`]consent['"`]\s*,\s*['"`](?:default|update)['"`]/,
  /\b(?:ad_storage|analytics_storage|ad_user_data|ad_personalization|functionality_storage|personalization_storage|security_storage|wait_for_update)\b/,
  /cdn\.cookielaw\.org|otSDKStub\.js|consent\.cookiebot\.com|usercentrics\.eu/,
  /\bOnetrustActiveGroups\b/i,
  /\bdata-cookieconsent\b|<script(?=\s|\/?>)(?:[^<>"']|"[^"]*"|'[^']*')*?\stype\s*=\s*(?:"text\/plain"|'text\/plain'|text\/plain(?=[\s/>]))/i,
]

/** Raw comments are call-token whitespace, including when syntax elsewhere is uncertain. Each
 * trivia suffix is computed once, so failed candidates never re-scan a long or unclosed comment. */
function hasCommentSeparatedConsent(text: string): boolean {
  if ((!text.includes("/*") && !text.includes("//")) || !/consent|capturing/.test(text)) return false
  const ends = new Uint32Array(text.length + 1)
  ends[text.length] = text.length
  let blockClose = -1; let lineEnd = text.length
  for (let i = text.length - 1; i >= 0; i--) {
    ends[i] = i
    if (text.startsWith("*/", i)) blockClose = i
    if (text[i] === "\r" || text[i] === "\n") lineEnd = i
    if (/\s/.test(text[i]!)) ends[i] = ends[i + 1]!
    else if (text.startsWith("//", i)) ends[i] = ends[lineEnd]!
    else if (text.startsWith("/*", i) && blockClose >= i + 2) ends[i] = ends[blockClose + 2]!
  }
  for (const match of text.matchAll(/[([,]|\b(?:opt_in_capturing|opt_out_capturing|has_opted_in_capturing|has_opted_out_capturing|clear_opt_in_out_capturing)\b/g)) {
    let at = ends[match.index! + match[0].length]!
    if (match[0].length > 1) {
      if (text.startsWith("?.", at)) at = ends[at + 2]!
      if (text[at] === "(") return true
      continue
    }
    if (!/['"`]/.test(text[at] ?? "") || text.slice(at + 1, at + 8) !== "consent" || !/['"`]/.test(text[at + 8] ?? "")) continue
    at = ends[at + 9]!
    if (text[at] !== ",") continue
    at = ends[at + 1]!
    if (/['"`]/.test(text[at] ?? "") && /^(?:default|update|grant|revoke)['"`]/.test(text.slice(at + 1, at + 9))) return true
  }
  return false
}

/** Recognition deliberately includes comments and prose; uncertain syntax never hides a raw marker. */
export function isConsentText(text: string): boolean {
  return CONSENT_CALL_PATTERNS.some(pattern => pattern.test(text)) || hasCommentSeparatedConsent(text)
}

/** Only the basename is inspected; no directory, importer, reader or caller is followed. */
export function isConsentFile(path: string): boolean {
  return /consent|cookie[-_]?banner/i.test(path.replaceAll("\\", "/").split("/").at(-1) ?? "")
}

interface Token { text: string; start: number; end: number; line: number; depth: number }
export interface SourceUnit {
  start: number; end: number; startLine: number; endLine: number
  text: string; prefix: string; key: string; hash: string; ordinal: number; names: string[]; frozen: boolean
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

function bindingInfo(tokens: Token[]): { key: string; names: string[] } {
  const ts = tokens.map(token => token.text)
  let at = 0
  while (["export", "default", "declare", "async", "abstract"].includes(ts[at] ?? "")) at++
  const kind = ts[at] ?? ""
  const declaration = ["const", "let", "var", "function", "class", "interface", "type", "enum", "namespace", "import"].includes(kind)
  const names: string[] = []
  if (["const", "let", "var"].includes(kind)) {
    const binding = (at: number): number => {
      if (IDENTIFIER.test(ts[at] ?? "")) { names.push(ts[at]!); return at + 1 }
      const close = OPEN[ts[at] ?? ""]
      if (ts[at] !== "{" && ts[at] !== "[") return at + 1
      const depth = tokens[at]!.depth + 1
      const object = ts[at] === "{"
      let i = at + 1
      while (i < ts.length && !(tokens[i]!.depth === depth && ts[i] === close)) {
        if (ts[i] === "," || ts[i] === "...") { i++; continue }
        // Object property keys are not declared names. Only their binding after ':' is.
        if (object && ts[i + 1] === ":") i += 2
        else if (object && ts[i] === "[") {
          while (i < ts.length && !(tokens[i]!.depth === depth + 1 && ts[i] === "]")) i++
          i += 2
        }
        i = binding(i)
        while (i < ts.length && !(tokens[i]!.depth === depth && (ts[i] === "," || ts[i] === close))) i++
      }
      return i + 1
    }
    for (let i = at + 1; i < ts.length;) {
      i = binding(i)
      while (i < ts.length && !(tokens[i]!.depth === 0 && (ts[i] === "," || ts[i] === ";"))) i++
      if (ts[i] !== ",") break
      i++
    }
  } else if (["function", "class", "interface", "type", "enum", "namespace"].includes(kind)) {
    const name = ts[at + (ts[at + 1] === "*" ? 2 : 1)]
    if (name && IDENTIFIER.test(name)) names.push(name)
  } else if (kind === "import") {
    for (let i = at + 1; i < ts.length && ts[i] !== "from"; i++) {
      if (!IDENTIFIER.test(ts[i]!) || ["as", "type"].includes(ts[i]!) || ts[i + 1] === "as") continue
      names.push(ts[i]!)
    }
  }
  const callAt = ts.indexOf("(")
  const firstArgument = callAt >= 0 && /^['"`]/.test(ts[callAt + 1] ?? "") ? ts[callAt + 1] : ""
  const key = declaration && names.length ? `${kind}:${names[0]}` : `statement:${ts.slice(0, callAt < 0 ? Math.min(ts.length, 3) : callAt).join(" ")}:${firstArgument}`
  return { key, names }
}

/** Split only at depth zero. Bracket bodies stay inseparable regardless of the constructs they hold. */
export function sourceUnits(source: string, path = ""): SourceUnits {
  if (isConsentFile(path)) return { confident: false, tail: "", units: source ? [{ start: 0, end: source.length, startLine: 1, endLine: source.split("\n").length,
    text: source, prefix: "", names: [], key: "whole-file", hash: hash(source), ordinal: 0, frozen: true }] : [] }
  const parsed = tokenize(source)
  // The tokenizer is not authoritative about whether raw source contains owner consent. It may
  // stop inside JSX prose, CSS URLs, or a malformed comment before reaching the protected text.
  const rawConsent = isConsentText(source)
  const ts = parsed.tokens
  if (ts.length === 0 && (!parsed.confident || rawConsent)) {
    const info = bindingInfo(ts)
    return { confident: false, tail: "", units: source ? [{ start: 0, end: source.length, startLine: 1, endLine: source.split("\n").length,
      text: source, prefix: "", ...info, key: "whole-file", hash: hash(source), ordinal: 0,
      frozen: rawConsent || info.names.some(name => /consent/i.test(name)) }] : [] }
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
    let start = /^\s*$/.test(source.slice(Math.max(previousEnd, lineStart), firstToken.start)) ? Math.max(previousEnd, lineStart) : firstToken.start
    // A leading comment belongs to the following declaration/statement, including its bytes.
    // Separating blank lines retain their existing role between independently editable units.
    if (source.slice(previousEnd, start).trim()) start = previousEnd
    const nextToken = ts[last + 1]
    const newline = source.indexOf("\n", lastToken.end)
    const end = newline >= 0 && (!nextToken || newline < nextToken.start) ? newline + 1 : lastToken.end
    const text = source.slice(start, end)
    const info = bindingInfo(ts.slice(first, last + 1))
    if (!confident) info.names = spans.flatMap(([from, to]) => bindingInfo(ts.slice(from, to + 1)).names)
    const textHash = hash(text)
    const ordinal = occurrences.get(textHash) ?? 0
    occurrences.set(textHash, ordinal + 1)
    units.push({ start, end, startLine: source.slice(0, start).split("\n").length, endLine: source.slice(0, Math.max(start, end - 1)).split("\n").length,
      text, prefix: source.slice(previousEnd, start), ...info, key: confident ? info.key : "whole-file", hash: textHash, ordinal,
      frozen: isConsentText(source.slice(previousEnd, end)) || info.names.some(name => /consent/i.test(name)) })
    previousEnd = end
  }
  if (!confident && units.length) {
    units[0]!.start = 0; units[0]!.end = source.length; units[0]!.startLine = 1; units[0]!.endLine = source.split("\n").length
    units[0]!.text = source; units[0]!.prefix = ""; units[0]!.hash = hash(source); previousEnd = source.length
  }
  // Repeated statement/declaration identities cannot identify which occurrence moved or changed.
  // Declare the whole file frozen before seeding, rather than overwrite an editable neighbor.
  const counts = new Map<string, number>()
  for (const unit of units) counts.set(unit.key, (counts.get(unit.key) ?? 0) + 1)
  if ((rawConsent && !units.some(unit => unit.frozen)) || units.some(unit => unit.frozen && (counts.get(unit.key) ?? 0) > 1) || ((counts.get("statement::") ?? 0) > 1 && units.some(unit => unit.frozen))) {
    return { confident: false, tail: "", units: [{ ...units[0]!, start: 0, end: source.length, startLine: 1, endLine: source.split("\n").length, prefix: "", text: source, key: "whole-file", hash: hash(source), ordinal: 0, frozen: true, names: units.flatMap(unit => unit.names) }] }
  }
  return { units, tail: source.slice(previousEnd), confident }
}

export interface FrozenUnitChange { before: SourceUnit | null; after: SourceUnit | null }
export interface FrozenUnitRestore { text: string; changes: FrozenUnitChange[]; before: SourceUnits; after: SourceUnits }

/** Ordered alignment preserves editable neighbors. No semantic edit is ever exempt inside a unit. */
export function restoreFrozenUnits(beforeText: string, afterText: string, path = ""): FrozenUnitRestore {
  const beforeBom = beforeText.startsWith("\ufeff"), afterBom = afterText.startsWith("\ufeff")
  if (beforeBom || afterBom) {
    const restored = restoreFrozenUnits(beforeBom ? beforeText.slice(1) : beforeText, afterBom ? afterText.slice(1) : afterText, path)
    const protectedFile = restored.before.units.some(unit => unit.frozen) || restored.after.units.some(unit => unit.frozen)
    if (beforeBom !== afterBom && protectedFile) restored.changes.push({ before: restored.before.units[0] ?? null, after: restored.after.units[0] ?? null })
    return { ...restored, text: ((restored.changes.length > 0 ? beforeBom : afterBom) ? "\ufeff" : "") + restored.text }
  }
  let before = sourceUnits(beforeText, path); let after = sourceUnits(afterText, path)
  if ((!before.confident || !after.confident) && (before.units.some(unit => unit.frozen) || after.units.some(unit => unit.frozen))) {
    const whole = (text: string, model: SourceUnits): SourceUnits => ({ confident: false, tail: "", units: text ? [{ ...(model.units[0] ?? { names: [] }), start: 0, end: text.length, startLine: 1, endLine: text.split("\n").length, text, prefix: "", key: "whole-file", hash: hash(text), ordinal: 0, frozen: true }] : [] })
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
      if ((old.frozen || next.frozen) && old.hash !== next.hash) { changes.push({ before: old, after: next }); output.push(next.prefix + old.text) }
      else output.push(next.prefix + next.text)
      i++; j++
    } else if (old && (!next || scores[(i + 1) * width + j]! >= scores[i * width + j + 1]!)) {
      if (old.frozen) { changes.push({ before: old, after: null }); output.push(old.prefix + old.text) }
      i++
    } else if (next) {
      if (next.frozen) changes.push({ before: null, after: next })
      else output.push(next.prefix + next.text)
      j++
    }
  }
  return { text: output.join("") + after.tail, changes, before, after }
}

export function frozenUnitAt(source: string, line: number, path = ""): SourceUnit | null {
  return sourceUnits(source, path).units.find(unit => unit.frozen && unit.startLine <= line && line <= unit.endLine) ?? null
}

/** Every worker target uses its evidence line. Managed capture is planned at its fixed entry instead. */
export function frozenEditPlace(item: { id: string; jobId: string; trigger: { evidence: readonly ({ file: string; line: number } | { url: string })[] } }, sources: ReadonlyMap<string, string>): { file: string; line: number; unit: SourceUnit } | null {
  for (const entry of item.trigger.evidence) {
    if (!("file" in entry)) continue
    const source = sources.get(entry.file)
    if (source === undefined) continue
    const unit = frozenUnitAt(source, entry.line, entry.file)
    if (unit) return { ...entry, unit }
  }
  return null
}
