// Repo-relative glob matching for the allowlist's global deny (§3e.2) and allowlists. Patterns are
// anchored at the repo root and use POSIX separators: `*` and `?` stay inside one path segment, `**/`
// matches zero or more whole segments, a trailing `/**` matches everything beneath. Pure.

const cache = new Map<string, RegExp>()

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern)
  if (cached) return cached
  let source = "^"
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const atStart = index === 0 || pattern[index - 1] === "/"
        const followedBySlash = pattern[index + 2] === "/"
        if (atStart && followedBySlash) {
          source += "(?:[^/]+/)*"
          index += 2
          continue
        }
        if (atStart && index + 2 === pattern.length) {
          source += ".*"
          index += 1
          continue
        }
        source += "[^/]*"
        index += 1
        continue
      }
      source += "[^/]*"
      continue
    }
    if (char === "?") {
      source += "[^/]"
      continue
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  const regexp = new RegExp(`${source}$`)
  cache.set(pattern, regexp)
  return regexp
}

/** Normalises a repo-relative path: POSIX separators, no leading `./`, no trailing `/`. */
export function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "")
}

export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  const normalized = normalizeRelPath(path)
  return patterns.some((pattern) => globToRegExp(normalizeRelPath(pattern)).test(normalized))
}
