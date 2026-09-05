import { maskCommentsAndStrings } from "./frameworks/shared.js"
import type { ProviderId } from "./types.js"

export interface ProviderInstallEvidence {
  provider: ProviderId
  via: "snippet" | "gtm"
  offset: number
  key?: string
}

/** Preserve offsets for evidence lines while removing HTML comments as well as JS comments. */
export function installationSource(source: string): string {
  const code = maskCommentsAndStrings(source, true)
  return source.replace(/<!--[\s\S]*?-->/g, (text, offset: number) =>
    code.slice(offset, offset + 4) === "<!--" ? text.replace(/[^\n]/g, " ") : text
  )
}

/** Installation evidence, not proof of execution or receipt. Event calls alone never qualify. */
export function providerInstallEvidence(source: string): ProviderInstallEvidence[] {
  let raw = installationSource(source)
  if (/^\s*(?:<!doctype\s+html|<html\b|<script\b)/i.test(raw)) {
    // HTML body text is not executable JavaScript. Keep script elements and offsets only.
    const original = raw
    const regions = [...original.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)]
    const masked: string[] = original.split("").map((char) => (char === "\n" ? char : " "))
    for (const region of regions) {
      for (let i = 0; i < region[0].length; i++) masked[region.index + i] = region[0][i]
    }
    raw = masked.join("")
  }
  const code = maskCommentsAndStrings(raw, true)
  const text = maskCommentsAndStrings(raw, false)
  const found: ProviderInstallEvidence[] = []
  const add = (
    provider: ProviderId,
    offset: number,
    key?: string,
    via: "snippet" | "gtm" = "snippet"
  ) => {
    if (!found.some((item) => item.provider === provider && item.via === via && item.key === key)) {
      found.push({ provider, via, offset, ...(key ? { key } : {}) })
    }
  }
  const calls: Array<[ProviderId, RegExp]> = [
    [
      "ga4",
      /\b(?:window\.)?gtag\s*\(\s*["']config["']\s*,\s*(?:["'](G-[A-Z0-9]+)["']|[A-Za-z_$])/g
    ],
    ["ga4", /\b(?:window\.)?gtag\s*\(\s*["']js["']\s*,/g],
    ["ga4", /\bReactGA\.initialize\s*\(\s*["'](G-[A-Z0-9]+)["']/g],
    ["posthog", /\bposthog\.init\s*\(\s*(?:["'](phc_[A-Za-z0-9_]+)["']|[A-Za-z_$])/g],
    ["meta", /\b(?:window\.)?fbq\s*\(\s*["']init["']\s*,\s*(?:["'](\d+)["']|[A-Za-z_$])/g],
    [
      "x",
      /\b(?:window\.)?twq\s*\(\s*["'](?:config|init)["']\s*,\s*(?:["']([A-Za-z0-9]+)["']|[A-Za-z_$])/g
    ]
  ]
  for (const [provider, pattern] of calls) {
    for (const match of text.matchAll(pattern)) {
      // Matching the callable prefix in string-masked code rejects examples stored in strings.
      const prefix = match[0].slice(0, match[0].indexOf("("))
      if (code.slice(match.index, match.index + prefix.length) === prefix)
        add(provider, match.index, match[1])
    }
  }
  if (/\bReactGA\.initialize\s*\(/.test(code)) add("ga4", code.search(/\bReactGA\.initialize\s*\(/))

  // Official integrations must actually be imported, not merely mentioned as a string.
  const modules: Array<[ProviderId, string[]]> = [
    [
      "ga4",
      [
        "react-ga4",
        "vue-gtag",
        "nuxt-gtag",
        "@analytics/google-analytics",
        "@next/third-parties/google"
      ]
    ],
    ["posthog", ["posthog-js/react", "@posthog/nextjs"]]
  ]
  for (const match of text.matchAll(
    /\b(?:import\s+(?:(?:[A-Za-z_$][\w$]*\s*,?\s*)?(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*)?\s*from\s*)?|require\s*\(|import\s*\()\s*["']([^"']+)["']/g
  )) {
    if (!/^(?:import|require)\b/.test(code.slice(match.index))) continue
    for (const [provider, names] of modules) {
      if (names.includes(match[1])) {
        const defaultBinding =
          match[0].match(/^import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/)?.[1] ??
          code.slice(0, match.index).match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/)?.[1]
        const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const mounted = (exported: string) => {
          const named = new RegExp(`\\b${exported}(?:\\s+as\\s+([A-Za-z_$][\\w$]*))?\\b`).exec(
            match[0]
          )
          const namespace = match[0].match(/^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/)?.[1]
          const local = named
            ? (named[1] ?? exported)
            : namespace
              ? `${namespace}.${exported}`
              : defaultBinding
          if (!local) return false
          const name = escape(local)
          return new RegExp(
            `<${name}(?=[\\s/>])|\\bcreateElement\\s*\\(\\s*${name}(?=[\\s,)])`
          ).test(code)
        }
        if (/^import\s+type\b/.test(code.slice(match.index))) continue
        if (provider === "posthog" && !mounted("PostHogProvider")) continue
        if (
          match[1] === "react-ga4" &&
          (!defaultBinding ||
            !new RegExp(`\\b${escape(defaultBinding)}\\.initialize\\s*\\(`).test(code))
        )
          continue
        if (
          match[1] === "vue-gtag" &&
          (!defaultBinding ||
            !new RegExp(`\\.use\\s*\\(\\s*${escape(defaultBinding)}(?=[\\s,)])`).test(code))
        )
          continue
        if (
          match[1] === "nuxt-gtag" &&
          (!defaultBinding ||
            !new RegExp(`\\bmodules\\s*:\\s*\\[[^\\]]*\\b${escape(defaultBinding)}\\b`).test(code))
        )
          continue
        if (
          match[1] === "@analytics/google-analytics" &&
          (!defaultBinding || !new RegExp(`\\b${escape(defaultBinding)}\\s*\\(`).test(code))
        )
          continue
        if (match[1] === "@next/third-parties/google") {
          if (mounted("GoogleTagManager")) {
            const key = [...text.matchAll(/\bgtmId\s*[:=]\s*["'](GTM-[A-Z0-9]+)["']/g)].find(
              (value) => /^gtmId\b/.test(code.slice(value.index))
            )?.[1]
            add("ga4", match.index, key, "gtm")
          }
          if (!mounted("GoogleAnalytics")) continue
        }
        const keyPattern =
          provider === "ga4"
            ? /\b(?:gaId|id)\s*[:=]\s*["'](G-[A-Z0-9]+)["']/g
            : /\bapiKey\s*[:=]\s*["'](phc_[A-Za-z0-9_]+)["']/g
        const key = [...text.matchAll(keyPattern)].find((value) =>
          /^(?:gaId|id|apiKey)\b/.test(code.slice(value.index))
        )?.[1]
        add(provider, match.index, key)
      }
    }
  }

  for (const match of text.matchAll(/\bmodules\s*:\s*\[[^\]]*["']nuxt-gtag["']/g)) {
    if (/^modules\s*:/.test(code.slice(match.index))) add("ga4", match.index)
  }

  const loader = (url: string, offset: number) => {
    let parsed: URL
    try {
      parsed = new URL(url, "https://local.invalid")
    } catch {
      return
    }
    const host = parsed.hostname,
      path = parsed.pathname
    if (host === "www.googletagmanager.com" || host === "googletagmanager.com") {
      if (path === "/gtag/js")
        add("ga4", offset, parsed.searchParams.get("id")?.match(/^G-[A-Z0-9]+$/)?.[0])
      if (path === "/gtm.js")
        add("ga4", offset, parsed.searchParams.get("id")?.match(/^GTM-[A-Z0-9]+$/)?.[0], "gtm")
    }
    if (/(?:^|\.)posthog\.com$/.test(host) && /\/(?:static\/)?(?:array|decide)/.test(path))
      add("posthog", offset)
    if (host === "connect.facebook.net" && path.endsWith("/fbevents.js")) add("meta", offset)
    if (host === "static.ads-twitter.com" && path.endsWith("/uwt.js")) add("x", offset)
    if (path.endsWith("/tracking/standalone.js")) add("infinite", offset)
  }

  for (const match of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    if (code.slice(match.index, match.index + 7).toLowerCase() === "<script")
      loader(match[1], match.index)
  }
  for (const match of text.matchAll(/\b[A-Za-z_$][\w$]*\.src\s*=\s*["']([^"']+)["']/g)) {
    if (/^[A-Za-z_$][\w$]*\.src\s*=/.test(code.slice(match.index))) loader(match[1], match.index)
  }
  for (const match of text.matchAll(
    /<script\b[^>]*data-infinite-runtime=["']managed["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    if (code.slice(match.index, match.index + 7).toLowerCase() !== "<script") continue
    const config = match[1].match(/\}\)\((\{[\s\S]*\})\);?\s*$/)
    if (!config) continue
    try {
      const parsed = JSON.parse(config[1]) as { siteSourceKey?: unknown }
      if (
        typeof parsed.siteSourceKey === "string" &&
        /^site_[A-Za-z0-9_-]+$/.test(parsed.siteSourceKey)
      )
        add("infinite", match.index, parsed.siteSourceKey)
    } catch {
      /* An example or malformed script cannot prove an installed runtime. */
    }
  }
  if (/\b(?:window\.)?_1BU_CONFIG\s*=/.test(code))
    add("infinite", code.search(/\b(?:window\.)?_1BU_CONFIG\s*=/))
  const order: ProviderId[] = ["ga4", "posthog", "x", "meta", "infinite"]
  return found
    .filter(
      (item) =>
        item.key ||
        !found.some(
          (other) => other.provider === item.provider && other.via === item.via && other.key
        )
    )
    .sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider) || a.offset - b.offset)
}
