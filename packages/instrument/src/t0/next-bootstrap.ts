// Decode the Next.js managed module's `const bootstrapSource = "…"` (lane O6).
//
// On Next.js the managed install puts every provider's bytes inside ONE JSON-escaped string literal in
// `lib/infinite-analytics.ts` (`frameworks/managed-files.ts` `buildAnalyticsModuleSource`), which a
// client component appends as an inline `<script>` from `useEffect`. T0 runs exactly those bytes: it
// decodes the literal the way the JS engine would (JSON.parse of a double-quoted literal), and never
// evaluates the module itself. Precedent: `providers/meta-browser/pixel-snippet.test.ts` L113-119 and
// `setup-checks/meta-pixel-config.ts`.

const BOOTSTRAP_LITERAL = /const\s+bootstrapSource\s*=\s*("(?:[^"\\\n]|\\.)*")/

export type DecodedBootstrap = { ok: true; source: string; line: number } | { ok: false; reason: "no_bootstrap_literal" | "undecodable_literal" }

/** The decoded `bootstrapSource` of a managed Next module, with the line it is declared on. */
export function decodeNextBootstrap(moduleSource: string): DecodedBootstrap {
  const match = BOOTSTRAP_LITERAL.exec(moduleSource)
  if (!match) return { ok: false, reason: "no_bootstrap_literal" }
  try {
    const source = JSON.parse(match[1]!) as unknown
    if (typeof source !== "string") return { ok: false, reason: "undecodable_literal" }
    return { ok: true, source, line: moduleSource.slice(0, match.index).split("\n").length }
  } catch {
    return { ok: false, reason: "undecodable_literal" }
  }
}
