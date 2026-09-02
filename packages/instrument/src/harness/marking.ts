// Conversion marking: propose → confirm → apply (teardown §4.1). The runtime already reads
// `data-analytics-cta-id` / `data-analytics-cta-location`, so the marking step writes exactly
// those two attributes — additively, on the exact element, after a pre-image line-hash check —
// and records every write in `.infinite/conversions.json` so it can be reversed byte-for-byte.
//
// Privacy: the proposal (which quotes visible text and hrefs as evidence) is written LOCALLY to
// `.infinite/conversions.proposed.json`, which the harness gitignores. Nothing in it leaves
// the machine.
import { createHash } from "node:crypto"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { basename, join } from "node:path"

import { assertWriteTargetInsideRoot, writeFileAtomic } from "../frameworks/shared.js"

import { GITIGNORE_FENCE_END, GITIGNORE_FENCE_START, recordGitignoreBlock, recordHarnessFile } from "./outputs.js"
import { readSourceFile, splitLines, walkSourceFiles } from "./scan.js"

export const PROPOSED_CONVERSIONS_RELATIVE_PATH = ".infinite/conversions.proposed.json"
export const CONVERSIONS_MANIFEST_RELATIVE_PATH = ".infinite/conversions.json"
export const CTA_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const MAX_PROPOSED_ROWS = 200


/** Hosts the runtime already buckets as checkout — marking them would double-count. */
const STRIPE_HOSTS = new Set(["buy.stripe.com", "book.stripe.com", "donate.stripe.com", "checkout.stripe.com", "invoice.stripe.com"])

export type MarkableTag = "a" | "button"

export interface ProposedConversion {
  ctaId: string
  ctaLocation: string
  /** App-root-relative. */
  file: string
  /** 1-based line the opening tag starts on. */
  line: number
  /** 0-based offset of the `<` of THIS element within that line — two candidates on one line differ here. */
  column: number
  tag: MarkableTag
  /** href for anchors, the handler attribute name (onClick, type=submit) for buttons. */
  hrefOrHandler: string
  /** Visible text (≤ 80 chars), as read from the file. Local evidence only. */
  textSnippet: string
  /** sha256 of the exact line at proposal time — the pre-image apply asserts. */
  lineHash: string
}

export interface SkippedElement {
  file: string
  line: number
  tag: MarkableTag
  reason: string
}

export interface ConversionProposal {
  version: 1
  generatedAt: string
  appRoot: string
  rows: ProposedConversion[]
  skipped: SkippedElement[]
  /** Server-side checkout recommendation, when a Stripe server checkout/fulfillment was detected. */
  serverCheckout?: ServerCheckoutRecommendation
}

// ---------------------------------------------------------------------------------------------
// Server-side checkout detection (teardown §4.1 addendum): a client-only `checkout_started`
// mark MISSES a desktop-app / server checkout that hits the Stripe API directly, so it
// systematically under-counts multi-surface funnels. This is a read-only DETECTION + a
// propose-step RECOMMENDATION (never an automatic edit): find the server checkout ENTRY
// (`stripe.checkout.sessions.create`) and its verified webhook FULFILLMENT
// (`stripe.webhooks.constructEvent` / `checkout.session.completed`), and recommend emitting the
// funnel's start (`checkout_started`) and end (`purchase`) server-side, as a pair.
// ---------------------------------------------------------------------------------------------

export type ServerCheckoutKind = "session_create" | "webhook_fulfillment"

export interface ServerCheckoutSignal {
  kind: ServerCheckoutKind
  /** App-root-relative source file. */
  file: string
  /** 1-based line the signal was found on. */
  line: number
  /** The structural token matched (never surrounding code). */
  evidence: string
}

export interface ServerCheckoutRecommendation {
  code: "INF_CHECKOUT_SERVER_SIDE"
  /** `stripe.checkout.sessions.create` sites → emit `checkout_started` server-side. */
  sessionCreate: ServerCheckoutSignal[]
  /** Verified webhook fulfillment sites → emit the `purchase` outcome server-side. */
  webhookFulfillment: ServerCheckoutSignal[]
}

const SESSION_CREATE_PATTERN = /\bcheckout\s*\.\s*sessions\s*\.\s*create\b/
const WEBHOOK_CONSTRUCT_PATTERN = /\bwebhooks\s*\.\s*constructEvent\b/
const CHECKOUT_COMPLETED_PATTERN = /checkout\.session\.completed/
export const MAX_SERVER_CHECKOUT_SIGNALS = 20

export interface DetectServerCheckoutInput {
  root: string
  appRoot: string
}

/** Read-only: scan the app's source for the server checkout entry + webhook fulfillment. */
export function detectServerCheckout(input: DetectServerCheckoutInput): ServerCheckoutRecommendation | null {
  const appRootAbsolute = input.appRoot === "." ? input.root : join(input.root, input.appRoot)
  const sessionCreate: ServerCheckoutSignal[] = []
  const webhookFulfillment: ServerCheckoutSignal[] = []
  const total = () => sessionCreate.length + webhookFulfillment.length
  for (const file of walkSourceFiles(appRootAbsolute)) {
    if (total() >= MAX_SERVER_CHECKOUT_SIGNALS) break
    const contents = readSourceFile(appRootAbsolute, file)
    if (contents === null) continue
    const lines = splitLines(contents)
    for (let index = 0; index < lines.length; index += 1) {
      if (total() >= MAX_SERVER_CHECKOUT_SIGNALS) break
      const text = lines[index]
      if (SESSION_CREATE_PATTERN.test(text)) {
        sessionCreate.push({ kind: "session_create", file, line: index + 1, evidence: "stripe.checkout.sessions.create" })
      } else if (WEBHOOK_CONSTRUCT_PATTERN.test(text)) {
        webhookFulfillment.push({ kind: "webhook_fulfillment", file, line: index + 1, evidence: "stripe.webhooks.constructEvent" })
      } else if (CHECKOUT_COMPLETED_PATTERN.test(text)) {
        webhookFulfillment.push({ kind: "webhook_fulfillment", file, line: index + 1, evidence: "checkout.session.completed" })
      }
    }
  }
  if (sessionCreate.length === 0 && webhookFulfillment.length === 0) return null
  return { code: "INF_CHECKOUT_SERVER_SIDE", sessionCreate, webhookFulfillment }
}

/**
 * The propose-step recommendation lines: the funnel's start + end belong together, so the entry
 * and the fulfillment are always recommended as a pair (each naming the one that is missing).
 */
export function renderServerCheckoutRecommendation(rec: ServerCheckoutRecommendation): string[] {
  const start = rec.sessionCreate[0]
  const end = rec.webhookFulfillment[0]
  const lines: string[] = []
  if (start) {
    lines.push(
      `Server-side checkout detected at ${start.file}:${start.line} (${start.evidence}). Emit \`checkout_started\` server-side there so web + desktop-app + every surface is counted — a client-only button mark misses non-web checkouts.`
    )
  }
  if (end) {
    lines.push(
      `Verified Stripe webhook fulfillment detected at ${end.file}:${end.line} (${end.evidence}). Emit the \`purchase\` outcome server-side there — the funnel's end pairs with the server-side \`checkout_started\` start above.`
    )
  }
  if (start && !end) {
    lines.push(
      "No verified Stripe webhook fulfillment handler was found — add one (stripe.webhooks.constructEvent → checkout.session.completed) and emit `purchase` there so the payment funnel's end is counted too."
    )
  }
  if (!start && end) {
    lines.push(
      "A Stripe webhook fulfillment handler was found but no stripe.checkout.sessions.create — emit `checkout_started` at your server checkout entry point to pair with the `purchase` outcome."
    )
  }
  return lines
}

export interface ApprovedConversions {
  rows: ProposedConversion[]
}

export interface MarkedConversion {
  file: string
  line: number
  /** Offset of the element's `<` in the line as it stood BEFORE any insert on that line. */
  column: number
  ctaId: string
  ctaLocation: string
  beforeHash: string
  afterHash: string
  /** The exact text inserted, so unmark can remove it and nothing else. */
  inserted: string
}

export interface ConversionsManifest {
  version: 1
  appRoot: string
  marked: MarkedConversion[]
}

export interface StaleElement {
  file: string
  line: number
  ctaId: string
  code: "INF_MARK_STALE_ELEMENT"
  message: string
}

export interface ApplyConversionsResult {
  marked: MarkedConversion[]
  skipped: Array<{ file: string; line: number; ctaId: string; reason: string }>
  stale: StaleElement[]
  manifestPath: string
}

export function lineHash(line: string): string {
  return createHash("sha256").update(line).digest("hex")
}

// ---------------------------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------------------------

export interface ProposeConversionsInput {
  root: string
  appRoot: string
  /** The workspace's download destination; anchors to it are the runtime's own conversion. */
  downloadDestinationPath?: string
  now?: () => string
}

function tokenFrom(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
    .replace(/_+$/g, "")
}

function stripMarkup(inner: string): string {
  return inner
    .replace(/<[^>]*>/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function attribute(openingTag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*["'\`]([^"'\`]*)["'\`]\\s*\\})`).exec(openingTag)
  if (!match) return undefined
  return match[1] ?? match[2] ?? match[3]
}

function hasAttribute(openingTag: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(openingTag)
}

function normalizePath(value: string): string {
  const withoutQuery = value.split(/[?#]/)[0]
  const collapsed = withoutQuery.replace(/\/{2,}/g, "/")
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed
}

/** Landmark element the candidate sits in, by scanning the file before it (local text heuristic). */
function locationFor(contents: string, offset: number, file: string): string {
  const before = contents.slice(0, offset)
  const landmarks = ["nav", "header", "footer", "aside", "main"]
  let best: { name: string; index: number } | null = null
  for (const name of landmarks) {
    const opens = [...before.matchAll(new RegExp(`<${name}\\b`, "g"))].map((match) => match.index ?? 0)
    const closes = [...before.matchAll(new RegExp(`</${name}\\s*>`, "g"))].map((match) => match.index ?? 0)
    if (opens.length > closes.length) {
      const index = opens[opens.length - 1]
      if (!best || index > best.index) best = { name, index }
    }
  }
  if (best) return best.name
  const stem = tokenFrom(basename(file).replace(/\.[^.]+$/, ""))
  return stem === "" ? "page" : stem
}

function skipReason(
  tag: MarkableTag,
  openingTag: string,
  href: string | undefined,
  downloadDestinationPath: string
): string | null {
  if (hasAttribute(openingTag, "data-analytics-cta-id")) return "already marked (data-analytics-cta-id)"
  if (hasAttribute(openingTag, "data-conversion")) return "already marked (data-conversion)"
  if (tag === "a") {
    if (href === undefined || href.trim() === "" || href.trim() === "#" || /^javascript:/i.test(href.trim())) {
      return "no destination"
    }
    const trimmed = href.trim()
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const host = new URL(trimmed).hostname.toLowerCase().replace(/^www\./, "")
        if (STRIPE_HOSTS.has(host)) return "Stripe host (the runtime already counts it)"
      } catch {
        return "no destination"
      }
    } else if (trimmed.startsWith("/") && normalizePath(trimmed) === normalizePath(downloadDestinationPath)) {
      return "download destination (the runtime already counts it)"
    }
  }
  return null
}

const OPENING_TAG_START = /<(a|Link|button)\b/g

/**
 * End offset (exclusive) of the opening tag starting at `start`, honouring JSX expression
 * braces and quoted attribute values so an `onClick={() => x()}` never ends the tag early.
 */
function openingTagEnd(contents: string, start: number): number | null {
  let depth = 0
  let quote: string | null = null
  for (let index = start; index < contents.length; index += 1) {
    const char = contents[index]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (depth === 0 && (char === '"' || char === "'")) {
      quote = char
      continue
    }
    if (char === "{") depth += 1
    else if (char === "}") depth = Math.max(0, depth - 1)
    else if (char === ">" && depth === 0) return index + 1
  }
  return null
}

/**
 * Read-only: scan the app's source for anchors and buttons, derive a cta id from the visible
 * text (then the href, then the tag), and quote the evidence. Never proposes an element the
 * runtime already treats specially, never proposes what is already marked.
 */
export function proposeConversions(input: ProposeConversionsInput): ConversionProposal {
  const appRootAbsolute = input.appRoot === "." ? input.root : join(input.root, input.appRoot)
  const downloadDestinationPath = input.downloadDestinationPath ?? "/download"
  const rows: ProposedConversion[] = []
  const skipped: SkippedElement[] = []
  const usedIds = new Set<string>()

  for (const file of walkSourceFiles(appRootAbsolute)) {
    if (rows.length >= MAX_PROPOSED_ROWS) break
    const contents = readSourceFile(appRootAbsolute, file)
    if (contents === null) continue
    const lines = splitLines(contents)
    OPENING_TAG_START.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = OPENING_TAG_START.exec(contents)) !== null) {
      if (rows.length >= MAX_PROPOSED_ROWS) break
      const rawTag = match[1]
      const tag: MarkableTag = rawTag === "button" ? "button" : "a"
      const offset = match.index
      const end = openingTagEnd(contents, offset)
      if (end === null) break
      const openingTag = contents.slice(offset, end)
      OPENING_TAG_START.lastIndex = end
      const line = contents.slice(0, offset).split("\n").length
      const column = offset - (contents.lastIndexOf("\n", offset - 1) + 1)
      const href = tag === "a" ? attribute(openingTag, "href") : undefined
      const reason = skipReason(tag, openingTag, href, downloadDestinationPath)
      if (reason) {
        skipped.push({ file, line, tag, reason })
        continue
      }
      const closeTag = new RegExp(`</${rawTag}\\s*>`, "g")
      closeTag.lastIndex = offset + openingTag.length
      const close = closeTag.exec(contents)
      const inner = close ? contents.slice(offset + openingTag.length, close.index) : ""
      const text = stripMarkup(inner).slice(0, 80)

      let base = tokenFrom(text)
      if (base === "" && href) base = tokenFrom(normalizePath(href).split("/").filter(Boolean).pop() ?? "")
      if (base === "") base = tag === "button" ? "button" : "link"
      let ctaId = base
      let suffix = 2
      while (usedIds.has(ctaId)) {
        ctaId = `${base.slice(0, 64 - `_${suffix}`.length)}_${suffix}`
        suffix += 1
      }
      usedIds.add(ctaId)

      const handler =
        tag === "a"
          ? (href ?? "")
          : hasAttribute(openingTag, "onClick")
            ? "onClick"
            : (attribute(openingTag, "type") ?? "button")
      rows.push({
        ctaId,
        ctaLocation: locationFor(contents, offset, file),
        file,
        line,
        column,
        tag,
        hrefOrHandler: handler,
        textSnippet: text,
        lineHash: lineHash(lines[line - 1] ?? "")
      })
    }
  }

  return {
    version: 1,
    generatedAt: (input.now ?? (() => new Date().toISOString()))(),
    appRoot: input.appRoot,
    rows,
    skipped
  }
}

export function writeProposal(root: string, proposal: ConversionProposal): string {
  const absolutePath = join(root, PROPOSED_CONVERSIONS_RELATIVE_PATH)
  assertWriteTargetInsideRoot(root, absolutePath)
  writeFileAtomic(absolutePath, `${JSON.stringify(proposal, null, 2)}\n`)
  recordHarnessFile(root, PROPOSED_CONVERSIONS_RELATIVE_PATH)
  return absolutePath
}

/**
 * The proposal quotes DOM text and hrefs, so it must never be committed: append a fenced
 * ignore block to .gitignore (creating the file when absent). Returns what happened.
 */
export function ensureProposedIgnored(root: string): "present" | "appended" | "created" {
  const absolutePath = join(root, ".gitignore")
  const block = [GITIGNORE_FENCE_START, PROPOSED_CONVERSIONS_RELATIVE_PATH, GITIGNORE_FENCE_END].join("\n")
  if (!existsSync(absolutePath)) {
    assertWriteTargetInsideRoot(root, absolutePath)
    writeFileAtomic(absolutePath, `${block}\n`)
    recordGitignoreBlock(root, block, true)
    return "created"
  }
  const current = readFileSync(absolutePath, "utf8")
  if (current.split(/\r?\n/).some((line) => line.trim() === PROPOSED_CONVERSIONS_RELATIVE_PATH)) {
    return "present"
  }
  const separator = current === "" || current.endsWith("\n") ? "" : "\n"
  writeFileAtomic(absolutePath, `${current}${separator}${block}\n`)
  recordGitignoreBlock(root, block, false)
  return "appended"
}

// ---------------------------------------------------------------------------------------------
// Confirm (non-interactive path): a pre-approved file
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads `--conversions <file>` (the proposal's shape, possibly edited by the founder). */
export function readApprovedConversions(root: string, filePath: string): ApprovedConversions {
  const absolutePath = filePath.startsWith("/") ? filePath : join(root, filePath)
  if (!existsSync(absolutePath)) {
    throw new Error(`Conversions file not found: ${absolutePath}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"))
  } catch (error) {
    throw new Error(`Conversions file ${absolutePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.rows)) {
    throw new Error(`Conversions file ${absolutePath} must be an object with a "rows" array.`)
  }
  const rows: ProposedConversion[] = []
  parsed.rows.forEach((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Conversions row ${index} is not an object.`)
    const ctaId = raw.ctaId
    if (typeof ctaId !== "string" || !CTA_ID_PATTERN.test(ctaId)) {
      throw new Error(`Conversions row ${index}: ctaId must match ${CTA_ID_PATTERN} (got ${JSON.stringify(ctaId)}).`)
    }
    const ctaLocation = typeof raw.ctaLocation === "string" && raw.ctaLocation !== "" ? raw.ctaLocation : "page"
    if (!CTA_ID_PATTERN.test(ctaLocation)) {
      throw new Error(`Conversions row ${index}: ctaLocation must match ${CTA_ID_PATTERN}.`)
    }
    if (typeof raw.file !== "string" || raw.file === "" || raw.file.startsWith("/") || raw.file.includes("..")) {
      throw new Error(`Conversions row ${index}: file must be an app-relative path.`)
    }
    if (typeof raw.line !== "number" || !Number.isInteger(raw.line) || raw.line < 1) {
      throw new Error(`Conversions row ${index}: line must be a positive integer.`)
    }
    if (typeof raw.lineHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.lineHash)) {
      throw new Error(`Conversions row ${index}: lineHash must be the sha256 hex from the proposal.`)
    }
    if (typeof raw.column !== "number" || !Number.isInteger(raw.column) || raw.column < 0) {
      throw new Error(`Conversions row ${index}: column must be the element's offset from the proposal (re-run --plan to re-propose).`)
    }
    rows.push({
      ctaId,
      ctaLocation,
      file: raw.file,
      line: raw.line,
      column: raw.column,
      tag: raw.tag === "button" ? "button" : "a",
      hrefOrHandler: typeof raw.hrefOrHandler === "string" ? raw.hrefOrHandler : "",
      textSnippet: typeof raw.textSnippet === "string" ? raw.textSnippet : "",
      lineHash: raw.lineHash
    })
  })
  return { rows }
}

// ---------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------

export interface ApplyConversionsInput {
  root: string
  appRoot: string
  approved: ApprovedConversions
}

export function readConversionsManifest(root: string): ConversionsManifest | null {
  const absolutePath = join(root, CONVERSIONS_MANIFEST_RELATIVE_PATH)
  if (!existsSync(absolutePath)) return null
  const parsed: unknown = JSON.parse(readFileSync(absolutePath, "utf8"))
  if (!isRecord(parsed) || !Array.isArray(parsed.marked) || typeof parsed.appRoot !== "string") {
    throw new Error("Corrupt .infinite/conversions.json — remove it manually to reset.")
  }
  return parsed as unknown as ConversionsManifest
}

function writeConversionsManifest(root: string, manifest: ConversionsManifest): string {
  const absolutePath = join(root, CONVERSIONS_MANIFEST_RELATIVE_PATH)
  assertWriteTargetInsideRoot(root, absolutePath)
  writeFileAtomic(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`)
  recordHarnessFile(root, CONVERSIONS_MANIFEST_RELATIVE_PATH)
  return absolutePath
}

/**
 * The pre-image is the LINE HASH, not the line number: an install that injects lines above the
 * element (the tag's own <head> block, an import) shifts numbers without changing the element.
 * The recorded line is the first candidate; otherwise the nearest line with the same hash wins.
 */
export function locateLine(lines: readonly string[], row: Pick<ProposedConversion, "line" | "lineHash">): number | null {
  const recorded = lines[row.line - 1]
  if (recorded !== undefined && lineHash(recorded) === row.lineHash) return row.line
  let best: number | null = null
  for (let index = 0; index < lines.length; index += 1) {
    if (lineHash(lines[index]) !== row.lineHash) continue
    const candidate = index + 1
    if (best === null || Math.abs(candidate - row.line) < Math.abs(best - row.line)) best = candidate
  }
  return best
}

export function staleElementMessage(file: string, line: number): string {
  return `Could not mark ${file}:${line} — the element changed since it was proposed. Re-run infinite analytics --plan to re-propose.`
}

/**
 * For each approved row: assert the line still hashes to its pre-image, then insert exactly
 * ` data-analytics-cta-id="…" data-analytics-cta-location="…"` after the tag name on that line.
 * Nothing else on the line — no id, class, href or handler — is touched. Stale rows are
 * reported per row (INF_MARK_STALE_ELEMENT) and the rest still apply.
 */
/** The opening-tag regex the row's `tag` must match at its column. */
function tagPatternFor(tag: MarkableTag): RegExp {
  return tag === "button" ? /^<button\b/ : /^<(a|Link)\b/
}

/**
 * For each approved row: assert the line still hashes to its pre-image, assert the proposed tag
 * sits at the recorded column, then insert exactly
 * ` data-analytics-cta-id="…" data-analytics-cta-location="…"` after that tag name. Rows on one
 * line are applied right-to-left so earlier offsets stay valid; every row of a line shares the
 * line's final after-hash. Nothing else on the line — no id, class, href or handler — is touched.
 * Stale rows (line or element changed) are reported per row (INF_MARK_STALE_ELEMENT) and the
 * rest still apply.
 */
export function applyConversions(input: ApplyConversionsInput): ApplyConversionsResult {
  const appRootAbsolute = input.appRoot === "." ? input.root : join(input.root, input.appRoot)
  const manifest: ConversionsManifest = readConversionsManifest(input.root) ?? {
    version: 1,
    appRoot: input.appRoot,
    marked: []
  }
  const result: ApplyConversionsResult = {
    marked: [],
    skipped: [],
    stale: [],
    manifestPath: join(input.root, CONVERSIONS_MANIFEST_RELATIVE_PATH)
  }
  const stale = (row: ProposedConversion): void => {
    result.stale.push({ file: row.file, line: row.line, ctaId: row.ctaId, code: "INF_MARK_STALE_ELEMENT", message: staleElementMessage(row.file, row.line) })
  }

  // Group by the element's pre-image line so multi-element lines are edited once, right-to-left.
  const groups = new Map<string, ProposedConversion[]>()
  for (const row of input.approved.rows) {
    if (!CTA_ID_PATTERN.test(row.ctaId) || !CTA_ID_PATTERN.test(row.ctaLocation)) {
      result.skipped.push({ file: row.file, line: row.line, ctaId: row.ctaId, reason: "invalid token" })
      continue
    }
    const key = `${row.file}\u0000${row.lineHash}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }

  for (const rows of groups.values()) {
    const { file, lineHash: beforeHash } = rows[0]
    const absolutePath = join(appRootAbsolute, file)
    assertWriteTargetInsideRoot(input.root, absolutePath)
    const contents = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null
    const lines = contents === null ? null : splitLines(contents)

    // Idempotence first: a row already marked (same file, column, cta id) whose line still hashes
    // to the recorded after-image is skipped; the others go on to be applied.
    const pending: ProposedConversion[] = []
    for (const row of rows) {
      const prior = manifest.marked.find(
        (entry) => entry.file === file && entry.column === row.column && entry.ctaId === row.ctaId
      )
      if (prior && lines && lines.some((line) => lineHash(line) === prior.afterHash)) {
        result.skipped.push({ file, line: row.line, ctaId: row.ctaId, reason: "already marked" })
      } else {
        pending.push(row)
      }
    }
    if (pending.length === 0) continue

    const located = lines ? locateLine(lines, pending[0]) : null
    if (lines === null || located === null) {
      for (const row of pending) stale(row)
      continue
    }
    const original = lines[located - 1]
    let current = original
    const applied: MarkedConversion[] = []
    for (const row of [...pending].sort((a, b) => b.column - a.column)) {
      const at = original.slice(row.column)
      const tagMatch = tagPatternFor(row.tag).exec(at)
      if (!tagMatch) {
        stale(row)
        continue
      }
      const tagEnd = openingTagEnd(original, row.column)
      const openingTag = original.slice(row.column, tagEnd ?? original.length)
      if (/\bdata-analytics-cta-id\b|\bdata-conversion\b/.test(openingTag)) {
        result.skipped.push({ file, line: located, ctaId: row.ctaId, reason: "already marked" })
        continue
      }
      const inserted = ` data-analytics-cta-id="${row.ctaId}" data-analytics-cta-location="${row.ctaLocation}"`
      const cut = row.column + tagMatch[0].length
      // Right-to-left: everything before `cut` is still in original coordinates.
      current = `${current.slice(0, cut)}${inserted}${current.slice(cut)}`
      applied.push({ file, line: located, column: row.column, ctaId: row.ctaId, ctaLocation: row.ctaLocation, beforeHash, afterHash: "", inserted })
    }
    if (applied.length === 0) continue
    const nextLines = [...lines]
    nextLines[located - 1] = current
    writeFileAtomic(absolutePath, nextLines.join("\n"))
    const afterHash = lineHash(current)
    // Merge, never replace: an earlier round's marks on this line (their after-image is this
    // round's pre-image) keep their records, keyed by file + column + cta id. Every record of a
    // line then shares ONE pair — beforeHash = the line before ANY mark, afterHash = the line
    // after ALL marks — so unmark can reverse every round and check the original pre-image.
    const carried = manifest.marked
      .filter((entry) => entry.file === file && entry.afterHash === beforeHash)
      .map((entry) => ({ ...entry, line: located, afterHash }))
    const originalBefore = carried[0]?.beforeHash ?? beforeHash
    const marked = applied
      .map((entry) => ({ ...entry, beforeHash: originalBefore, afterHash }))
      .sort((a, b) => a.column - b.column)
    const sameMark = (a: MarkedConversion, b: MarkedConversion): boolean =>
      a.file === b.file && a.column === b.column && a.ctaId === b.ctaId
    manifest.marked = [
      ...manifest.marked.filter(
        (entry) => !(entry.file === file && entry.afterHash === beforeHash) && !marked.some((mark) => sameMark(mark, entry))
      ),
      ...carried.filter((entry) => !marked.some((mark) => sameMark(mark, entry))),
      ...marked
    ]
    result.marked.push(...marked)
  }

  if (manifest.marked.length > 0) {
    writeConversionsManifest(input.root, manifest)
  }
  return result
}

// ---------------------------------------------------------------------------------------------
// Unmark (reverse)
// ---------------------------------------------------------------------------------------------

export interface UnmarkConversionsResult {
  restored: MarkedConversion[]
  skipped: Array<{ file: string; line: number; reason: string }>
}

/** Removes exactly the inserted text from each recorded line, hash-gated on both sides. */
/** Removes exactly the inserted text from each recorded line (right-to-left), hash-gated on both sides. */
export function unmarkConversions(root: string): UnmarkConversionsResult {
  const manifest = readConversionsManifest(root)
  const result: UnmarkConversionsResult = { restored: [], skipped: [] }
  if (!manifest) return result
  const appRootAbsolute = manifest.appRoot === "." ? root : join(root, manifest.appRoot)
  const remaining: MarkedConversion[] = []
  const groups = new Map<string, MarkedConversion[]>()
  for (const entry of manifest.marked) {
    const key = `${entry.file}\u0000${entry.afterHash}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  for (const entries of groups.values()) {
    const { file, afterHash } = entries[0]
    const absolutePath = join(appRootAbsolute, file)
    assertWriteTargetInsideRoot(root, absolutePath)
    const contents = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null
    const lines = contents === null ? null : splitLines(contents)
    const located = lines ? locateLine(lines, { line: entries[0].line, lineHash: afterHash }) : null
    if (lines === null || located === null) {
      for (const entry of entries) result.skipped.push({ file, line: entry.line, reason: "line changed since it was marked; left as is" })
      remaining.push(...entries)
      continue
    }
    // Right-to-left over the CURRENT line: each record's insert is found by its exact text right
    // after a tag name, searching from the end so the rightmost mark comes off first and earlier
    // offsets never move. Records may come from several approval rounds.
    let restored = lines[located - 1]
    let intact = true
    for (const entry of [...entries].sort((a, b) => b.column - a.column)) {
      const at = restored.lastIndexOf(entry.inserted)
      const tagBefore = at > 0 ? /<(a|Link|button)$/.exec(restored.slice(0, at)) : null
      if (at < 0 || !tagBefore) {
        intact = false
        break
      }
      restored = `${restored.slice(0, at)}${restored.slice(at + entry.inserted.length)}`
    }
    // Every record of a line shares its original pre-image (see applyConversions' merge).
    if (!intact || lineHash(restored) !== entries[0].beforeHash) {
      for (const entry of entries) result.skipped.push({ file, line: entry.line, reason: "restored line would not match its pre-image; left as is" })
      remaining.push(...entries)
      continue
    }
    const nextLines = [...lines]
    nextLines[located - 1] = restored
    writeFileAtomic(absolutePath, nextLines.join("\n"))
    result.restored.push(...entries)
  }
  if (remaining.length === 0) {
    rmSync(join(root, CONVERSIONS_MANIFEST_RELATIVE_PATH), { force: true })
  } else {
    writeConversionsManifest(root, { ...manifest, marked: remaining })
  }
  return result
}
