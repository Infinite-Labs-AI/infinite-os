// §3a.3 `repoFingerprint`, for the run record the `agent` step starts (POST /v1/runs). It MUST equal the
// link's fingerprint (O2 `bridge/repo-identity.ts` `linkSiteFor`), or the desktop/cloud files the run under
// another site (review O3 F13). So this is a byte-for-byte port of O2's rule, pinned by a shared vector
// test; I1 keeps ONE copy (O2's) and points this module at it.
//
// The raw remote is never sent: userinfo, query, fragment and `.git` are stripped, the path is
// percent-decoded, the host is lowercased (a non-default port kept), `git@host:a/b` → `host/a/b`, and only
// https/http/ssh/git remotes count (a `file://` or unknown scheme falls back to the path). The app root is
// repo-relative (`.` for the root; an absolute app root is made relative, a trailing "/" dropped).
//   fingerprint = sha256(normalized remote + "\n" + appRoot), or sha256("path:" + realpath + "\n" + appRoot)
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isAbsolute, relative, sep } from "node:path"

const DEFAULT_PORTS: Record<string, string> = { "https:": "443", "http:": "80", "ssh:": "22", "git:": "9418" }

/** `host/owner/repo` (host lowercased, port kept only when non-default), or null when the remote cannot be read safely. */
export function normalizeRemote(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  // scp-like: [userinfo@]host:path (no scheme, no "//"). The userinfo runs to the LAST "@" before the host.
  const scp = /^(?:[^/\s]*@)?([^@:/\s]+):(?!\/\/)(.+)$/.exec(trimmed)
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const host = scp[1]!.toLowerCase()
    const path = cleanPath(scp[2]!)
    return path ? `${host}/${path}` : null
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(parsed.protocol)) return null
  const host = parsed.hostname.toLowerCase()
  if (!host) return null
  const port = parsed.port && parsed.port !== DEFAULT_PORTS[parsed.protocol] ? `:${parsed.port}` : ""
  const path = cleanPath(decodeSafe(parsed.pathname))
  return path ? `${host}${port}/${path}` : null
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function cleanPath(raw: string): string {
  let path = raw.split(/[?#]/, 1)[0] ?? ""
  path = path.replace(/^\/+/, "").replace(/\/+$/, "")
  path = path.replace(/\.git$/i, "").replace(/\/+$/, "")
  return path
}

/** The app root as the link card shows it: repo-relative, `.` for the repo root. */
export function appRootLabel(root: string, appRoot: string): string {
  if (!appRoot) return "."
  const rel = isAbsolute(appRoot) ? relative(root, appRoot) : appRoot
  const clean = rel.split(sep).join("/").replace(/^\.\/+/, "").replace(/\/+$/, "")
  return clean || "."
}

export async function repoFingerprint(input: { remoteUrl: string | null; root: string; appRoot: string }): Promise<string> {
  const normalized = input.remoteUrl !== null ? normalizeRemote(input.remoteUrl) : null
  const appRoot = appRootLabel(input.root, input.appRoot)
  const material = normalized !== null ? `${normalized}\n${appRoot}` : `path:${await realpath(input.root)}\n${appRoot}`
  return `sha256:${createHash("sha256").update(material, "utf8").digest("hex")}`
}
