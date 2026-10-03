// The site's identity on the link card (§3a.3): a normalised remote label and a fingerprint.
//
// `normalizeRemote(url)` strips userinfo, query, fragment and `.git`, lowercases the host, and turns
// `git@host:a/b` into `host/a/b`. The RAW remote is never sent, stored or hashed: a credentialed remote
// (`https://user:ghp_x@github.com/a/b.git`) becomes `github.com/a/b` before anything else sees it.
//
// `repoFingerprint` = sha256(normalized remote + "\n" + appRoot), or sha256("path:" + realpath + "\n" + appRoot)
// when there is no usable remote.
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { isAbsolute, relative, sep } from "node:path"

import { trimTrailingSlashes } from "../text-escape.js"
import type { LinkSite } from "../wizard/contracts/bridge.js"

const DEFAULT_PORTS: Record<string, string> = { "https:": "443", "http:": "80", "ssh:": "22", "git:": "9418" }

/** `host/owner/repo` (host lowercased, port kept only when non-default), or null when the remote cannot be read safely. */
export function normalizeRemote(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null

  // scp-like: [userinfo@]host:path (no scheme, no "//"). The userinfo runs to the LAST "@" before the host,
  // and the host can never hold an "@", so no part of a credential reaches the label or the fingerprint.
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

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** `sha256:<64 hex>`. */
export function repoFingerprint(input: { normalizedRemote: string | null; realRoot: string; appRoot: string }): string {
  const material = input.normalizedRemote !== null ? `${input.normalizedRemote}\n${input.appRoot}` : `path:${input.realRoot}\n${input.appRoot}`
  return `sha256:${sha256Hex(material)}`
}

/** `~/Github/acme-store` (the home prefix shortened), never more than the folder path. */
export function folderLabel(realRoot: string, home: string = homedir()): string {
  if (home && (realRoot === home || realRoot.startsWith(home + sep))) {
    const rest = relative(home, realRoot)
    return rest ? `~/${rest.split(sep).join("/")}` : "~"
  }
  return realRoot
}

/** The app root as the card shows it: repo-relative, `.` for the repo root. */
export function appRootLabel(root: string, appRoot: string): string {
  if (!appRoot) return "."
  const rel = isAbsolute(appRoot) ? relative(root, appRoot) : appRoot
  const clean = trimTrailingSlashes(rel.split(sep).join("/").replace(/^\.\/+/, ""))
  return clean || "."
}

export interface RepoIdentityInput {
  /** The repo's raw `origin` URL (or null). Only its normalised form leaves this function. */
  rawRemote: string | null
  /** realpath of the repo root. */
  realRoot: string
  root: string
  appRoot: string
  productionHostHint: string | null
  homeDir?: string
}

/** Everything the link request's `site` carries. */
export function linkSiteFor(input: RepoIdentityInput): LinkSite {
  const normalized = input.rawRemote !== null ? normalizeRemote(input.rawRemote) : null
  const appRoot = appRootLabel(input.root, input.appRoot)
  return {
    repoFingerprint: repoFingerprint({ normalizedRemote: normalized, realRoot: input.realRoot, appRoot }),
    repoLabel: normalized ?? folderLabel(input.realRoot, input.homeDir),
    appRoot,
    folderLabel: folderLabel(input.realRoot, input.homeDir),
    productionHostHint: input.productionHostHint
  }
}
