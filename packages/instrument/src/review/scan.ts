// The secret / PII scan (lane O4, §3g.5). It runs over every commit, every GitHub post (review, reply, final
// comment, PR body) and every agent claim note and `report_progress` text before it reaches the terminal or
// GitHub.
//
// - Literal values: the repo's `.env*` values (≥ 8 chars; read by the wizard only), the bridge token, the MCP
//   token, and any `Authorization` value seen.
// - Shapes: Stripe, GitHub, Slack, AWS, Google API keys, PEM blocks, JWTs (the desktop bearer is one), PostHog
//   personal keys, Meta access tokens.
// - Paths: `.growth-os` and `Application Support/Infinite`.
// - PII: emails (except noreply / example.*) everywhere; phone-like digit runs ONLY in text posted to GitHub or
//   shown from agents. In commits, the Meta pixel id (a 15–16 digit literal in managed code, R2-09) and any
//   value already at HEAD are never a hit.
//
// A post or agent text is REDACTED (`[redacted: <kind>]`); a commit hit is REPORTED (the step blocks the job).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { maskIdentifier } from "../checks/result.js"

export type ScanKind =
  | "bridge_token"
  | "mcp_token"
  | "env_value"
  | "authorization"
  | "stripe_key"
  | "github_token"
  | "slack_token"
  | "aws_key"
  | "google_api_key"
  | "private_key"
  | "jwt"
  | "posthog_personal_key"
  | "meta_token"
  | "private_path"
  | "email"
  | "phone"

export interface ScanHit {
  kind: ScanKind
  /** Where in a commit (null for post text). */
  file?: string
  line?: number
}

export interface ScanLiteral {
  value: string
  kind: "bridge_token" | "mcp_token" | "env_value" | "authorization"
}

export interface ScannerOptions {
  literals: readonly ScanLiteral[]
  /**
   * The public ids the run knows (the connections' and the ids read from the site's own code: Meta pixel ids, GA4
   * ids, …), in full: never a phone or an env-value hit, and neither is their masked form.
   */
  allowedIds: readonly string[]
}

const SHAPES: ReadonlyArray<{ kind: ScanKind; pattern: RegExp; postOnly?: true }> = [
  { kind: "private_key", pattern: /-----BEGIN [A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g },
  { kind: "stripe_key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g },
  { kind: "github_token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "slack_token", pattern: /\bxox[abpsr]-[A-Za-z0-9-]{10,}/g },
  { kind: "aws_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  { kind: "posthog_personal_key", pattern: /\bphx_[A-Za-z0-9]{20,}/g },
  { kind: "meta_token", pattern: /\bEAA[A-Za-z0-9]{20,}/g },
  // An `Authorization` value seen in text (logs, a quoted request). Post-only: in code, `Authorization:` is
  // followed by an expression (`process.env.X`, a template), never by the secret itself.
  { kind: "authorization", pattern: /\bAuthorization\b\s*["']?\s*[:=]\s*["']?(?:Bearer\s+|Basic\s+|token\s+)?[^\s"'`,;]{6,}/gi, postOnly: true },
  { kind: "private_path", pattern: /[^\s"'`()<>]*\.growth-os[^\s"'`()<>]*/g },
  { kind: "private_path", pattern: /(?:[~/][^\s"'`()<>]*)?Application Support\/Infinite[^\s"'`()<>]*/g }
]

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g
const ISO_DATE_TIME = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g
/** A digit run (optionally with + and phone separators) — post mode. */
const PHONE_LIKE = /(?<![A-Za-z0-9_])\+?\(?\d[\d\s().-]{5,}\d(?![A-Za-z0-9_])/g
/** Formatted phones only — commit mode (bare digit runs in code are ids, sizes and timestamps). */
const PHONE_FORMATTED = /(?<![A-Za-z0-9_])\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b|\(\d{3}\)\s?\d{3}-\d{4}\b|\b\d{3}-\d{3}-\d{4}\b/g

function isExemptEmail(address: string): boolean {
  const lower = address.toLowerCase()
  const domain = lower.slice(lower.indexOf("@") + 1)
  return lower.includes("noreply") || lower.includes("no-reply") || /^example\./.test(domain) || /\.example$/.test(domain) || domain === "example"
}

function spans(text: string, pattern: RegExp): Array<[number, number]> {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map((match) => [match.index!, match.index! + match[0].length])
}

function inside(spansList: ReadonlyArray<[number, number]>, start: number, end: number): boolean {
  return spansList.some(([from, to]) => start >= from && end <= to)
}

function digitsOf(text: string): string {
  return text.replace(/\D/g, "")
}

export interface Scanner {
  /** Post / agent text: every hit replaced by `[redacted: <kind>]`. */
  redact(text: string): { text: string; hits: ScanHit[] }
  /**
   * Commit content: the hits in ADDED lines (nothing is rewritten). `presentAtHead(file, value)` says whether
   * an email or phone was already in that file at HEAD (then it is not this run's doing).
   */
  findInCommit(
    files: ReadonlyArray<{ path: string; added: ReadonlyArray<{ line: number; text: string }> }>,
    presentAtHead: (file: string, value: string) => boolean
  ): ScanHit[]
}

export function createScanner(options: ScannerOptions): Scanner {
  const allowed = new Set(options.allowedIds.filter((id) => id.length > 0))
  const allowedDigits = new Set(options.allowedIds.map(digitsOf).filter((digits) => digits.length >= 7))
  // R4-9 (live run 4): reports show a public id MASKED (`111640...8774`), and that shape — digits around dots — reads as
  // a written phone number; the PR comment printed "Meta [redacted: phone]". Only the masked form of an id the run
  // itself knows (a connection id or an id read from the site's own code) is exempt: exact text, nothing near it.
  const allowedMasked = new Set(options.allowedIds.filter((id) => digitsOf(id).length >= 7).map(maskIdentifier))
  const literals = options.literals
    .filter((literal) => literal.value.length >= 8 && !allowed.has(literal.value))
    .sort((a, b) => b.value.length - a.value.length)

  function redactSecrets(text: string, hits: ScanHit[], mode: "post" | "commit", literalExempt?: (literal: ScanLiteral) => boolean): string {
    let out = text
    for (const literal of literals) {
      if (out.includes(literal.value)) {
        if (literalExempt?.(literal)) continue
        hits.push({ kind: literal.kind })
        out = out.split(literal.value).join(`[redacted: ${literal.kind}]`)
      }
    }
    for (const shape of SHAPES) {
      if (shape.postOnly && mode === "commit") continue
      out = out.replace(new RegExp(shape.pattern.source, shape.pattern.flags), () => {
        hits.push({ kind: shape.kind })
        return `[redacted: ${shape.kind}]`
      })
    }
    return out
  }

  function redactPii(text: string, hits: ScanHit[]): string {
    let out = text.replace(new RegExp(EMAIL.source, "g"), (match) => {
      if (isExemptEmail(match)) return match
      hits.push({ kind: "email" })
      return "[redacted: email]"
    })
    const protectedSpans = [...spans(out, UUID), ...spans(out, ISO_DATE_TIME)]
    out = out.replace(new RegExp(PHONE_LIKE.source, "g"), (match, offset: number) => {
      const digits = digitsOf(match)
      if (digits.length < 7 || digits.length > 16) return match
      if (inside(protectedSpans, offset, offset + match.length)) return match
      if (allowedDigits.has(digits) || allowed.has(match.trim()) || allowedMasked.has(match.trim())) return match
      // A plain run of 15-16 digits with no separators or `+` is an id shape (a Meta pixel or ad id), not a
      // written phone number.
      if (digits.length >= 15 && /^\d+$/.test(match)) return match
      // A numeric range (`lines 1200-1310`): two runs of the same length, ascending.
      const range = /^(\d{1,8})\s*[-–]\s*(\d{1,8})$/.exec(match.trim())
      if (range && range[1]!.length === range[2]!.length && Number(range[1]) < Number(range[2])) return match
      hits.push({ kind: "phone" })
      return "[redacted: phone]"
    })
    return out
  }

  return {
    redact(text) {
      const hits: ScanHit[] = []
      const withoutSecrets = redactSecrets(text, hits, "post")
      return { text: redactPii(withoutSecrets, hits), hits }
    },
    findInCommit(files, presentAtHead) {
      const hits: ScanHit[] = []
      for (const file of files) {
        for (const added of file.added) {
          const local: ScanHit[] = []
          // A `.env` value already in this file at HEAD is not this run's doing (the repo already publishes it).
          redactSecrets(added.text, local, "commit", (literal) => literal.kind === "env_value" && presentAtHead(file.path, literal.value))
          for (const match of added.text.matchAll(new RegExp(EMAIL.source, "g"))) {
            if (!isExemptEmail(match[0]) && !presentAtHead(file.path, match[0])) local.push({ kind: "email" })
          }
          for (const match of added.text.matchAll(new RegExp(PHONE_FORMATTED.source, "g"))) {
            const digits = digitsOf(match[0])
            if (allowedDigits.has(digits) || presentAtHead(file.path, match[0])) continue
            local.push({ kind: "phone" })
          }
          for (const hit of local) hits.push({ ...hit, file: file.path, line: added.line })
        }
      }
      return hits
    }
  }
}

/** True when more than half of the text is redaction markers (a finding that is mostly redacted posts its location only). */
export function mostlyRedacted(original: string, redacted: string): boolean {
  const markers = [...redacted.matchAll(/\[redacted: [a-z_]+\]/g)]
  if (markers.length === 0) return false
  const kept = redacted.replace(/\[redacted: [a-z_]+\]/g, "").replace(/\s+/g, "").length
  const before = original.replace(/\s+/g, "").length
  return before > 0 && kept / before < 0.5
}

/** Committed templates (`.env.example`, `.env.sample`, …) hold placeholders and documented public values, not secrets. */
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults)$/i
/** Build-time public prefixes: these values are inlined into the browser bundle by design, so they are not secrets. */
const PUBLIC_ENV_PREFIX = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|GATSBY_|EXPO_PUBLIC_|NUXT_PUBLIC_|VUE_APP_)/

/** A plain http(s) URL with no credentials, query or fragment (a host such as PostHog's), never a secret. */
function isPlainPublicUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false
  try {
    const url = new URL(value)
    // Origin only: a path can carry a secret (a Slack or Discord webhook URL).
    return url.username === "" && url.password === "" && url.search === "" && url.hash === "" && url.pathname === "/" && !/^https?:\/\/[^/]+\/./i.test(value)
  } catch {
    return false
  }
}

/**
 * Every value ≥ 8 chars from the repo's `.env*` files (the wizard reads them; no agent does), as scan
 * literals. Skipped, because they are settings or public by design, and redacting them would block the wizard's
 * own managed code (the PostHog `/ingest` rewrite names the PostHog host) or garble every post:
 * - plain lowercase words (`production`) and booleans;
 * - committed templates (`.env.example`, `.env.sample`, `.env.template`, …);
 * - values under a browser-public prefix (`NEXT_PUBLIC_*`, `VITE_*`, `PUBLIC_*`, …);
 * - plain http(s) URLs with no credentials, query or fragment.
 * Secret SHAPES (Stripe, GitHub, JWT, …) are still caught wherever they appear. Public connection ids are passed
 * as allowed ids.
 */
export function collectEnvLiterals(dirs: readonly string[]): ScanLiteral[] {
  const out: ScanLiteral[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!/^\.env(\..+)?$/.test(name) || ENV_TEMPLATE.test(name)) continue
      const path = join(dir, name)
      try {
        if (!statSync(path).isFile()) continue
      } catch {
        continue
      }
      let text: string
      try {
        text = readFileSync(path, "utf8")
      } catch {
        continue
      }
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line)
        if (!match) continue
        if (PUBLIC_ENV_PREFIX.test(match[1]!)) continue
        const raw = match[2]!.trim()
        // A quoted value ends at its closing quote (a `# comment` may follow); an unquoted one at ` #`.
        const quoted = /^(["'])(.*?)\1/.exec(raw)
        const value = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, "")
        if (value.length < 8 || /^[a-z]+$/.test(value) || /^(true|false)$/i.test(value) || isPlainPublicUrl(value) || seen.has(value)) continue
        seen.add(value)
        out.push({ value, kind: "env_value" })
      }
    }
  }
  return out
}
