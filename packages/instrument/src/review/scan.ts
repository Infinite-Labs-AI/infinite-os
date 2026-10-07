// The secret / PII scan (lane O4, §3g.5). It runs over every commit, every GitHub post (review, reply, final
// comment, PR body) and every agent claim note and `report_progress` text before it reaches the terminal or
// GitHub.
//
// - Literal values: the repo's `.env*` values (≥ 8 chars; read by the wizard only), the bridge token, the MCP
//   token, and any `Authorization` value seen.
// - Shapes: Stripe, GitHub, Slack, AWS, Google API keys, private PEM blocks, JWTs (the desktop bearer is one), PostHog
//   personal keys, Meta access tokens.
// - Paths: `.growth-os` and `Application Support/Infinite`.
// - Emails (except noreply / example.*) are redacted; phone-like numbers are ordinary data.
//
// A post or agent text is REDACTED (`[redacted: <kind>]`); a commit hit is REPORTED (the step blocks the job).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

export type ScanKind =
  | "bridge_token"
  | "mcp_token"
  | "env_value"
  | "authorization"
  | "stripe_key"
  | "supabase_key"
  | "anthropic_key"
  | "openai_key"
  | "generic_secret"
  | "url_password"
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
  | "sendgrid_key"
  | "npm_token"
  | "vercel_token"
  | "resend_key"
  | "webhook_url"

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
   * ids, …), in full: never a generic named-value or env-value hit.
   */
  allowedIds: readonly string[]
}

const SHAPES: ReadonlyArray<{ kind: ScanKind; pattern: RegExp; postOnly?: true }> = [
  { kind: "private_key", pattern: /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g },
  // A remaining PRIVATE KEY footer identifies a body even if its BEGIN line was cut.
  { kind: "private_key", pattern: /(?:[A-Za-z0-9+/=]{16,}\r?\n)+-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { kind: "private_key", pattern: /\bMII[A-Za-z0-9+/]{40,}={0,2}(?:\r?\n[A-Za-z0-9+/]{32,}={0,2})*/g },
  { kind: "stripe_key", pattern: /\b(?:(?:sk|rk)_(?:live|test)_|whsec_)[A-Za-z0-9]{8,}/g },
  { kind: "supabase_key", pattern: /\b(?:sb_secret_|sbp_)[A-Za-z0-9_-]{8,}/g },
  { kind: "anthropic_key", pattern: /\bsk-ant-(?:api\d+|oat\d+)-[A-Za-z0-9_-]{8,}/g },
  { kind: "openai_key", pattern: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{8,}|[A-Za-z0-9]{32,})/g },
  { kind: "github_token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "slack_token", pattern: /\bxox[abpsr]-[A-Za-z0-9-]{10,}/g },
  { kind: "sendgrid_key", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { kind: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{16,}/g },
  { kind: "vercel_token", pattern: /\bvcp_[A-Za-z0-9_-]{16,}/g },
  // Resend's create-key response documents an 8-character id and a 24-character secret.
  // https://resend.com/docs/api-reference/api-keys/create-api-key
  { kind: "resend_key", pattern: /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}\b/g },
  { kind: "webhook_url", pattern: /https:\/\/hooks\.slack\.com\/services\/[^\s/"'`<>]+\/[^\s/"'`<>]+\/[^\s"'`<>]+/g },
  { kind: "webhook_url", pattern: /https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[^\s"'`<>]+/g },
  { kind: "aws_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  { kind: "posthog_personal_key", pattern: /\bphx_[A-Za-z0-9]{20,}/g },
  { kind: "meta_token", pattern: /\bEAA[A-Za-z0-9]{20,}/g },
  { kind: "authorization", pattern: /\bBearer\s+(?!authentication\b)[A-Za-z0-9._~+\/-]{8,}={0,2}/g },
  { kind: "authorization", pattern: /\bAuthorization\b\s*["']?\s*[:=]\s*["']?(?:Bearer\s+|Basic\s+|token\s+)?[^\s"'`,;]{6,}/gi, postOnly: true },
  { kind: "private_path", pattern: /[^\s"'`()<>]*\.growth-os[^\s"'`()<>]*/g },
  { kind: "private_path", pattern: /(?:[~/][^\s"'`()<>]*)?Application Support\/Infinite[^\s"'`()<>]*/g }
]

/** Assignment syntax only; secret names are whole underscore/camelCase words. */
const ASSIGNMENT = /\b([A-Za-z0-9_-]+)(["']?\s*[:=]\s*)(?:(["'`])([^"'`\r\n]*)(?:\3|(?=\r?\n|$))|([^\s"'`<>,;()[\]{}]+))/g
const SECRET_WORD = /^(?:secret|token|password|passwd|apikey|privatekey|auth)$/
const NON_SECRET_QUALIFIER = /^(?:name|path|url|provider|expiry|ttl|algorithm|header|type)$/
const SECRET_KEY_WORD = /^(?:api|session|encryption|signing|master|private)$/
const PUBLIC_NAME = /^(?:NEXT_PUBLIC_|VITE_|PUBLIC_)/
const SOURCE_EXPRESSION_VALUE = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/
const PLACEHOLDER = /^(?:changeme|x{4,}|your_api_key_here|<[^>]*>|\$\{[^}]*\})$/i
const NUMBER_OR_BOOLEAN = /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|true|false)$/i
const PUBLIC_PEM = /-----BEGIN ((?:[A-Z0-9]+ )*(?:PUBLIC KEY|CERTIFICATE))-----[\s\S]*?-----END \1-----/g
// Standard URLs keep the authority boundary; the DB schemes also accept an unescaped slash in a password.
const URL_PASSWORD = /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@"'`<>]*:)([^\s/@"'`<>]+)(?=@)/g
const DB_URL_PASSWORD = /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s/:@"'`<>]*:)([^\s@"'`<>]+)(?=@)/gi
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

interface Span { start: number; end: number }
interface SecretSpan extends Span { kind: ScanKind }
interface Assignment extends Span { name: string; value: string; sourceExpression: boolean }
function assignments(text: string): Assignment[] {
  return [...text.matchAll(ASSIGNMENT)].map(match => {
    const value = match[4] ?? match[5]!
    const valueAt = match[1]!.length + match[2]!.length + (match[3] ? 1 : 0)
    const start = match.index + valueAt
    const end = start + value.length
    const prefix = text.slice(0, match.index)
    const declaration = match[2]!.includes("=") && /\b(?:const|let|var)\s+$/.test(prefix)
    const objectProperty = match[2]!.includes(":") && /(?:[=(]|\breturn)\s*\{\s*["']?$/.test(prefix) && /^\s*\}/.test(text.slice(end))
    const sourceExpression = !match[3] && SOURCE_EXPRESSION_VALUE.test(value) && (declaration || objectProperty)
    return { name: match[1]!, value, sourceExpression, start, end }
  })
}
function isSecretName(name: string): boolean {
  if (/^x-api-key$/i.test(name)) return true
  const words = name.replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split("_")
  const secretAt = words.findIndex((word, index) => SECRET_WORD.test(word) || (SECRET_KEY_WORD.test(word) && words[index + 1] === "key"))
  return secretAt >= 0 && !words.slice(secretAt + 1).some(word => NON_SECRET_QUALIFIER.test(word))
}
function isPublicKey(value: string): boolean {
  return /^(?:phc_|sb_publishable_|pk_(?:live|test)_)[A-Za-z0-9_-]+$/.test(value)
}
function isExemptEmail(address: string, text: string, at: number): boolean {
  const lower = address.toLowerCase()
  if (lower.startsWith("git@") && text[at + address.length] === ":") return true
  if (/@\d+x\.(?:png|jpe?g|gif|webp|avif|svg)$/.test(lower)) return true
  const domain = lower.slice(lower.indexOf("@") + 1)
  return lower.includes("noreply") || lower.includes("no-reply") || /^example\./.test(domain) || /\.example$/.test(domain) || domain === "example"
}

export interface Scanner {
  redact(text: string): { text: string; hits: ScanHit[] }
  /** Scan adjacent ADDED lines only; existing email/env values can be exempted by the caller. */
  findInCommit(
    files: ReadonlyArray<{ path: string; added: ReadonlyArray<{ line: number; text: string }> }>,
    presentAtHead: (file: string, value: string) => boolean
  ): ScanHit[]
}

export function createScanner(options: ScannerOptions): Scanner {
  const allowed = new Set(options.allowedIds.filter(Boolean))
  const literals = options.literals.filter(literal => literal.value.length >= 8 && !allowed.has(literal.value))

  function scan(text: string, mode: "post" | "commit", presentAtHead: (value: string) => boolean): SecretSpan[] {
    const named = assignments(text)
    const publicSpans = named.filter(entry => PUBLIC_NAME.test(entry.name))
    const publicPem = [...text.matchAll(PUBLIC_PEM)].map(match => ({ start: match.index, end: match.index + match[0].length }))
    const matches: SecretSpan[] = []
    const add = (start: number, end: number, kind: ScanKind) => {
      if (publicSpans.some(span => start >= span.start && end <= span.end)) return
      matches.push({ start, end, kind })
    }
    for (const literal of literals) {
      if (literal.kind === "env_value" && presentAtHead(literal.value)) continue
      for (let at = text.indexOf(literal.value); at >= 0; at = text.indexOf(literal.value, at + literal.value.length)) add(at, at + literal.value.length, literal.kind)
    }
    for (const shape of SHAPES) {
      if (shape.postOnly && mode === "commit") continue
      for (const match of text.matchAll(shape.pattern)) {
        if (shape.kind === "private_key" && publicPem.some(span => match.index >= span.start && match.index + match[0].length <= span.end)) continue
        add(match.index, match.index + match[0].length, shape.kind)
      }
    }
    for (const pattern of [URL_PASSWORD, DB_URL_PASSWORD]) {
      for (const match of text.matchAll(pattern)) add(match.index + match[1]!.length, match.index + match[0].length, "url_password")
    }
    for (const entry of named) {
      if (!isSecretName(entry.name) || entry.value.length < 8 || /\s/.test(entry.value) || PLACEHOLDER.test(entry.value) || NUMBER_OR_BOOLEAN.test(entry.value) || allowed.has(entry.value) || isPublicKey(entry.value)) continue
      // URL credentials have their own password-only rule above. Preserve source expressions only
      // with explicit declarations/object delimiters; a standalone env/YAML value may contain dots.
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(entry.value)) continue
      if (entry.sourceExpression) continue
      add(entry.start, entry.end, "generic_secret")
    }
    for (const match of text.matchAll(EMAIL)) {
      if (!isExemptEmail(match[0], text, match.index) && !presentAtHead(match[0])) add(match.index, match.index + match[0].length, "email")
    }
    // Every match uses the original offsets: escaping/truncation cannot hide a key or alter its location.
    // Overlapping explicit shapes are one redaction covering their union, never a partially exposed value.
    const merged: SecretSpan[] = []
    for (const match of matches.sort((a, b) => a.start - b.start || b.end - a.end)) {
      const previous = merged.at(-1)
      if (previous && match.start < previous.end) previous.end = Math.max(previous.end, match.end)
      else merged.push({ ...match })
    }
    return merged
  }
  return {
    redact(text) {
      const matches = scan(text, "post", () => false)
      let redacted = text
      for (const match of [...matches].reverse()) redacted = `${redacted.slice(0, match.start)}[redacted: ${match.kind}]${redacted.slice(match.end)}`
      return { text: redacted, hits: matches.map(({ kind }) => ({ kind })) }
    },
    findInCommit(files, presentAtHead) {
      const hits: ScanHit[] = []
      for (const file of files) {
        const blocks: Array<Array<{ line: number; text: string }>> = []
        for (const line of file.added) {
          const previous = blocks.at(-1)
          if (previous && previous.at(-1)!.line + 1 === line.line) previous.push(line)
          else blocks.push([line])
        }
        for (const block of blocks) {
          const text = block.map(line => line.text).join("\n")
          for (const match of scan(text, "commit", value => presentAtHead(file.path, value))) {
            hits.push({ kind: match.kind, file: file.path, line: block[0]!.line + text.slice(0, match.start).split("\n").length - 1 })
          }
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
    return url.username === "" && url.password === "" && url.search === "" && url.hash === ""
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
 * Secret shapes (Stripe, GitHub, JWT, …) are still caught outside explicitly public assignments.
 * Public connection ids are passed as allowed ids.
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
