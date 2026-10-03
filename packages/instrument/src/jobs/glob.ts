// A tiny, dependency-free glob matcher for the allowlist rules (§3e.2). The package supports Node 18,
// which has no `path.matchesGlob`, so the few glob forms the rules use are compiled here:
//   `**/` (zero or more directories), a trailing `/**` (anything below), `**` alone, `*` (within one
//   segment), `?` (one character within a segment), and literal text.
// Paths are repo-root-relative POSIX paths (`apps/web/app/layout.tsx`); a glob without a slash-led
// `**/` is anchored at the repo root, exactly as the deny list is written.

const cache = new Map<string, RegExp>()

function escapeLiteral(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

/** Compiles one glob to an anchored RegExp (cached). */
export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob)
  if (cached) return cached
  let source = ""
  let index = 0
  while (index < glob.length) {
    if (glob.startsWith("**/", index)) {
      source += "(?:.*/)?"
      index += 3
    } else if (glob.startsWith("/**", index) && index + 3 === glob.length) {
      source += "(?:/.*)?"
      index += 3
    } else if (glob.startsWith("**", index)) {
      source += ".*"
      index += 2
    } else if (glob[index] === "*") {
      source += "[^/]*"
      index += 1
    } else if (glob[index] === "?") {
      source += "[^/]"
      index += 1
    } else {
      source += escapeLiteral(glob[index]!)
      index += 1
    }
  }
  const compiled = new RegExp(`^${source}$`)
  cache.set(glob, compiled)
  return compiled
}

/** True when the repo-relative path matches the glob. */
export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path)
}

/** The first glob in the list the path matches, or null. */
export function firstMatchingGlob(path: string, globs: readonly string[]): string | null {
  for (const glob of globs) if (matchesGlob(path, glob)) return glob
  return null
}
