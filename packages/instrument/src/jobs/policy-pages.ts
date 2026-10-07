/** Policy scope follows pages/content and their direct components, not utility-directory names. */
import { posix } from "node:path"
import { maskCommentsAndStrings } from "../frameworks/shared.js"

const sourcePath = /\.(?:[cm]?[jt]sx?|html?|mdx?|astro|vue|svelte|liquid|php|ejs|njk)$/i
const testPath = /(?:^|\/)(?:__tests__|tests?|specs?|fixtures?|__fixtures__)\/|\.(?:test|spec)\.[^/]+$/i
const testBasename = /\.(?:test|spec)\.[^/]+$/i
const componentPath = /\.(?:[cm]?[jt]sx|vue|svelte|astro|mdx)$/i
const pageExtension = /\.(?:[cm]?[jt]sx?|mdx?|astro|vue|svelte)$/i
const vocabulary = /(?:^|[^a-z0-9])(?:privacy(?:[-_ ]?(?:policy|notice))?|terms(?:[-_ ]?(?:of[-_ ]?(?:service|use)|and[-_ ]?conditions|conditions))?|tos|cookies?(?:[-_ ]?(?:policy|notice))?|legal|gdpr|ccpa|dpa|imprint|impressum|datenschutz|data[-_ ]protection|eula|disclaimer|polic(?:y|ies)|agb|mentions[-_ ]legales|politica[-_ ]de[-_ ]privacidad)(?:$|[^a-z0-9])/i

export function isPolicySourceFile(path: string): boolean { return sourcePath.test(path) }
const normalize = (path: string) => path.replaceAll("\\", "/").replace(/^\.\//, "")
function appRelative(path: string, appRoot: string): string {
  const root = normalize(appRoot).replace(/\/$/, "")
  if (root && root !== "." && path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  return path.replace(/^(?:apps|packages|sites)\/[^/]+\//, "")
}
function matchesPolicy(value: string): boolean {
  return vocabulary.test(value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase())
}
function visibleRoute(value: string): string {
  return value.split("/").filter(part => part && !/^\(.*\)$/.test(part) && !part.startsWith("@")).join("/").replace(/(?:^|\/)index$/, "")
}
function routedPage(path: string): string | null {
  const relative = path.replace(/^src\//, "")
  if (!pageExtension.test(relative) || testBasename.test(relative)) return null
  const stem = relative.replace(pageExtension, "")
  if (stem.startsWith("app/")) return /(?:^|\/)page$/.test(stem) ? visibleRoute(stem.slice(4).replace(/(?:^|\/)page$/, "")) : null
  if (stem.startsWith("pages/")) {
    const route = stem.slice(6)
    if (/^api(?:\/|$)|(?:^|\/)_[^/]*$/.test(route)) return null
    return visibleRoute(route)
  }
  if (stem.startsWith("routes/")) {
    const route = stem.slice(7)
    if (/(?:^|\/)\+server$/.test(route) || /(?:^|\/)api(?:\/|$)/.test(route)) return null
    if (/(?:^|\/)\+page$/.test(route)) return visibleRoute(route.replace(/(?:^|\/)\+page$/, ""))
    if (/\.(?:jsx?|tsx?)$/i.test(relative)) return visibleRoute(route.replace(/\./g, "/").replace(/(?:^|\/)route$/, ""))
  }
  return null
}
function explicitContentRoute(text: string): string | null {
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]
  return frontmatter ? /^\s*(?:permalink|url|route)\s*:\s*["']?(\/[^\s"']*)/mi.exec(frontmatter)?.[1] ?? null : null
}
function directPolicyPage(path: string, appRoot: string, sources?: ReadonlyMap<string, string>): boolean {
  const relative = appRelative(path, appRoot)
  // HTML is a document even under api/, docs/ or test/. Directory names cannot exempt it.
  if (/\.html?$/i.test(relative)) return matchesPolicy(visibleRoute(relative.replace(/\.html?$/i, "")))
  if (testBasename.test(relative)) return false
  const route = routedPage(relative)
  if (route !== null) return matchesPolicy(route)
  if (testPath.test(relative)) return false
  const text = sources?.get(path) ?? ""
  const mapped = explicitContentRoute(text)
  if (mapped !== null && /\.(?:mdx?|astro|liquid|php|ejs|njk)$/i.test(relative)) return matchesPolicy(mapped) || matchesPolicy(posix.basename(relative))
  if (/\.(?:mdx?|astro)$/i.test(relative) && (/^(?:src\/)?(?:content|_content|_posts)\//.test(relative) || !relative.includes("/"))) return matchesPolicy(relative)
  if (/\.php$/i.test(relative) && /^(?:public|static)\//.test(relative)) return matchesPolicy(relative)
  if (/\.(?:ejs|njk|liquid)$/i.test(relative) && sources) {
    const name = relative.replace(/^(?:src\/)?(?:views|templates)\//, "").replace(/\.(?:ejs|njk|liquid)$/i, "")
    for (const source of sources.values()) {
      const code = maskCommentsAndStrings(source, false)
      for (const match of code.matchAll(/\b(?:render|template)\s*\(\s*['"]([^'"]+)['"]/g)) if (match[1] === name && matchesPolicy(name)) return true
    }
  }
  return false
}

/** Local, static imports only: relative paths and @/ or ~/ root aliases.
 * Custom tsconfig aliases and computed runtime imports are not resolved here. */
function importTargets(importer: string, specifier: string, files: ReadonlyMap<string, string>, appRoot: string): string[] {
  const appPath = appRelative(importer, appRoot)
  const prefix = importer.slice(0, importer.length - appPath.length)
  const bases = specifier.startsWith(".") ? [posix.normalize(posix.join(posix.dirname(importer), specifier))]
    : /^(?:@|~)\//.test(specifier) ? [`${prefix}${specifier.slice(2)}`, `${prefix}src/${specifier.slice(2)}`] : []
  const targets = new Set<string>()
  for (const base of bases) {
    const stems = [base, ...( /\.[cm]?js$/.test(base) ? [base.replace(/\.[cm]?js$/, "")] : [])]
    for (const stem of stems) for (const extension of ["", ".tsx", ".jsx", ".ts", ".js", ".vue", ".svelte", ".astro", "/index.tsx", "/index.jsx", "/index.ts", "/index.js"]) {
      const candidate = stem + extension
      if (files.has(candidate)) targets.add(candidate)
    }
  }
  return [...targets]
}

/** Pure snapshot scope. Callers measuring a diff must union the before and after sets. */
export function policyContentPaths(sources: ReadonlyMap<string, string>, appRoot = "."): Set<string> {
  const pages = new Set([...sources.keys()].filter(path => directPolicyPage(normalize(path), appRoot, sources)))
  const importers = new Map<string, Set<string>>()
  for (const [path, source] of sources) {
    if (!isPolicySourceFile(path) || /\.md$/i.test(path) || (testPath.test(path) && !/\.html?$/i.test(path) && routedPage(appRelative(path, appRoot)) === null)) continue
    const code = maskCommentsAndStrings(source, false)
    const tokens = maskCommentsAndStrings(source, true)
    for (const match of code.matchAll(/\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"\r\n]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"\r\n]+)['"]/g)) {
      if (tokens.slice(match.index, match.index! + 6) !== code.slice(match.index, match.index! + 6)) continue
      for (const target of importTargets(path, match[1] ?? match[2]!, sources, appRoot)) {
        if (!componentPath.test(target)) {
          const body = maskCommentsAndStrings(sources.get(target) ?? "", true)
          const rendersJsx = /\.[cm]?js$/i.test(target) && /(?:return|=>)\s*\(?\s*<[A-Za-z]/.test(body)
          const rendersElement = /\.[cm]?[jt]s$/i.test(target) && /\bcreateElement\s*\(/.test(body)
          if (!rendersJsx && !rendersElement) continue
        }
        const seen = importers.get(target) ?? new Set<string>()
        seen.add(path); importers.set(target, seen)
      }
    }
  }
  const result = new Set(pages)
  for (const [path, users] of importers) if (users.size > 0 && [...users].every(user => pages.has(user))) result.add(path)
  return result
}

export function isPolicyPath(path: string, appRoot = ".", sources?: ReadonlyMap<string, string>): boolean {
  const normalized = normalize(path)
  return sources ? policyContentPaths(sources, appRoot).has(normalized) || directPolicyPage(normalized, appRoot, sources) : directPolicyPage(normalized, appRoot)
}
