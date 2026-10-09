/** Policy pages are identified only by explicit page paths and their last route segment. */
export const POLICY_PAGE_NAMES = [
  "privacy", "privacy-policy", "privacypolicy", "privacy-notice", "privacynotice",
  "terms", "terms-of-use", "terms-ofuse", "termsof-use", "termsofuse", "terms-of-service",
  "terms-ofservice", "termsof-service", "termsofservice", "terms-and-conditions", "terms-conditions", "termsconditions", "tos",
  "cookie-policy", "cookiepolicy", "cookies-policy", "cookiespolicy", "cookie-notice", "cookienotice", "cookies-notice", "cookiesnotice", "cookies",
  "legal", "eula", "disclaimer", "impressum", "imprint", "datenschutz", "datenschutzerklaerung",
  "data-protection", "gdpr", "ccpa", "dpa", "agb", "mentions-legales", "politica-de-privacidad",
  "refund-policy", "acceptable-use", "acceptable-use-policy", "subprocessors", "cookie-settings"
] as const

const normalizePath = (value: string) => value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")
const normalizeName = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").toLowerCase().replace(/[_.\s-]+/g, "-").replace(/^-|-$/g, "")
const pageExtension = /\.(?:[cm]?[jt]sx?|mdx?|astro|vue|svelte)$/i
const testBasename = /\.(?:test|spec)\.[^/]+$/i

function segments(route: string, framework = false): string[] {
  const parts = route.split("/").filter(part => part && (!framework || (!/^\(.*\)$/.test(part) && !part.startsWith("@"))))
  while (parts.length && /^(?:index|page)$/i.test(parts[parts.length - 1]!)) parts.pop()
  // A single dynamic parameter or locale directory does not add policy route depth. Catch-all
  // parameters still do: they can stand for an arbitrary number of ordinary route segments.
  return parts.filter((part, index) => index === parts.length - 1 || !/^(?:\[[^.[\]]+\]|\[\[[^.[\]]+\]\]|[a-z]{2}(?:-[a-z]{2})?)$/i.test(part)).map(normalizeName)
}

/** No import graph, URL metadata, source inspection or component-to-page inference. */
function pageRoute(path: string): string[] | null {
  // HTML and PHP remain pages under api/, docs/ and test/ as well.
  if (/\.(?:html?|php)$/i.test(path)) return segments(path.replace(/^(?:public|static)\//, "").replace(/\.(?:html?|php)$/i, ""))
  if (testBasename.test(path)) return null
  const relative = path.replace(/^src\//, "")
  if (!pageExtension.test(relative)) return null
  const stem = relative.replace(pageExtension, "")
  // Remix flat routes, including route folders. Match before Next's app directory.
  if (stem.startsWith("app/routes/") && /\.[jt]sx?$/i.test(relative)) {
    const route = stem.slice(11).replace(/(?:^|\/)route$/, "").replace(/\./g, "/")
    return segments(route.split("/").filter(part => !part.startsWith("_")).join("/"), true)
  }
  if (stem.startsWith("app/")) {
    if (!/(?:^|\/)page$/.test(stem) || stem.split("/").some(part => part.startsWith("_"))) return null
    return segments(stem.slice(4), true)
  }
  if (stem.startsWith("pages/")) {
    const route = stem.slice(6)
    if (/^api(?:\/|$)/.test(route) || route.split("/").some(part => part.startsWith("_"))) return null
    return segments(route, true)
  }
  if (stem.startsWith("routes/")) {
    const route = stem.slice(7)
    if (/(?:^|\/)api(?:\/|$)/.test(route)) return null
    if (/\/\+page$/.test(route) && /\.(?:svelte|mdx?)$/i.test(relative)) return segments(route.replace(/\/\+page$/, ""), true)
    if (route.split("/").some(part => part.startsWith("+")) || !/\.[jt]sx?$/i.test(relative)) return null
    return segments(route.replace(/\./g, "/"), true)
  }
  if (stem.startsWith("views/") && /\.vue$/i.test(relative)) return segments(stem.slice(6))
  // Markdown and Astro content are explicit content files, not arbitrary documentation/components.
  if (/\.(?:mdx?|astro)$/i.test(relative)) {
    if (/^(?:content|_content|_posts)\//.test(relative)) return segments(stem.replace(/^(?:content|_content|_posts)\//, ""))
    if (!relative.includes("/") || /^(?:legal|policies)\//.test(relative)) return segments(stem)
  }
  return null
}

export function isPolicyPath(path: string, appRoot = "."): boolean {
  let relative = normalizePath(path)
  const root = normalizePath(appRoot)
  if (root && root !== "." && relative.startsWith(`${root}/`)) relative = relative.slice(root.length + 1)
  const route = pageRoute(relative)
  if (!route?.length) return false
  const last = route[route.length - 1]!
  return POLICY_PAGE_NAMES.some(name => name.includes("-")
    ? last === name || last.endsWith(`-${name}`)
    : last === name && (route.length === 1 || /^(?:legal|policies)$/.test(route[route.length - 2] ?? "")))
}
