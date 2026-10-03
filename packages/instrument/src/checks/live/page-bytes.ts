// What a live page actually serves, split into readable units: the HTML (managed blocks apart from
// the site's own bytes) and, on Next.js, the managed bootstrap decoded out of the same-origin JS
// bundles the page loads (scout S5 fact 21: on Next every id sits in an escaped string literal).
//
// Every request goes through `probeFetch`, so every one of them carries `Purpose: prefetch`.
import { metaSourceUnits } from "../../setup-checks/meta-pixel-config.js"

import { decodedLiteralsWith } from "./js-literals.js"
import { probeFetch, type LiveProbeDeps } from "./probe.js"

export interface PageUnit {
  text: string
  /** infinite-tag's own bytes (a managed HTML block, or the managed Next bootstrap). */
  managed: boolean
  /**
   * `html`: the served HTML (managed block or the rest). `bundle`: a decoded literal from a same-origin
   * script. `html_literal`: a decoded literal inside the HTML (e.g. Next's flight data), read ONLY when
   * the other units carry nothing for a tool, because Next can serve the same inline script twice
   * (once as a tag, once escaped in the flight data) and counting both would invent a duplicate.
   */
  source: "html" | "bundle" | "html_literal"
}

export interface PageBytes {
  url: string
  finalUrl: string
  status: number
  html: string
  headers: Headers
  units: PageUnit[]
  /** The raw bytes of every bundle read, for the "the id is in the bundle but unreadable" fallback. */
  bundleText: string
  bundlesRead: number
  /** Same-origin scripts not read (over the cap, too big, or failed). */
  bundlesSkipped: number
}

/** At most this many same-origin scripts are read per page. */
export const MAX_BUNDLES_PER_PAGE = 40

/** The managed Next module's script id; a bundle holding it holds infinite-tag's bootstrap. */
export const MANAGED_NEXT_BOOTSTRAP_ID = "infinite-analytics-bootstrap"

export type PageBytesResult = { ok: true; page: PageBytes } | { ok: false; status: number; detail: string }

export async function readPageBytes(url: string, deps: LiveProbeDeps): Promise<PageBytesResult> {
  const response = await probeFetch(url, deps, { accept: "text/html,application/xhtml+xml" })
  if (!response.ok) return { ok: false, status: response.status, detail: response.detail }
  const html = response.text
  const finalUrl = response.finalUrl
  const units: PageUnit[] = metaSourceUnits(finalUrl, html).map((unit) => ({
    text: unit.text,
    managed: unit.managed,
    source: "html" as const
  }))
  for (const literal of decodedLiteralsWith(html)) units.push({ text: literal, managed: false, source: "html_literal" })

  const scripts = sameOriginScripts(html, finalUrl)
  let bundleText = ""
  let bundlesRead = 0
  let bundlesSkipped = Math.max(0, scripts.length - MAX_BUNDLES_PER_PAGE)
  for (const script of scripts.slice(0, MAX_BUNDLES_PER_PAGE)) {
    const bundle = await probeFetch(script, deps, { accept: "*/*" })
    if (!bundle.ok) {
      bundlesSkipped += 1
      continue
    }
    bundlesRead += 1
    bundleText += `\n${bundle.text}`
    const managed = bundle.text.includes(MANAGED_NEXT_BOOTSTRAP_ID)
    for (const literal of decodedLiteralsWith(bundle.text)) units.push({ text: literal, managed, source: "bundle" })
  }
  return {
    ok: true,
    page: { url, finalUrl, status: response.status, html, headers: response.headers, units, bundleText, bundlesRead, bundlesSkipped }
  }
}

/** Same-origin `<script src>` URLs, de-duplicated, in document order. */
export function sameOriginScripts(html: string, pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin
  const urls: string[] = []
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    let resolved: URL
    try {
      resolved = new URL((match[1] as string).replace(/&amp;/g, "&"), pageUrl)
    } catch {
      continue
    }
    if (resolved.origin !== origin) continue
    if (!/\.m?js$/i.test(resolved.pathname)) continue
    if (!urls.includes(resolved.href)) urls.push(resolved.href)
  }
  return urls
}

/**
 * The units to read for one tool: the primary units (HTML + bundle), or — only when those carry
 * nothing matching `pattern` — the decoded HTML literals.
 */
export function unitsFor(page: PageBytes, pattern: RegExp): PageUnit[] {
  const primary = page.units.filter((unit) => unit.source !== "html_literal")
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
  const probe = new RegExp(pattern.source, flags)
  if (primary.some((unit) => (unit.text.match(probe)?.length ?? 0) > 0)) return primary
  return page.units.filter((unit) => unit.source === "html_literal")
}
