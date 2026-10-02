// §3a.3 `repoFingerprint` and `repoLabel`, for the run record the `agent` step starts. The raw remote is
// never sent: userinfo, query, fragment and `.git` are stripped, the host is lowercased, `git@host:a/b` →
// `host/a/b`, so a credentialed remote never reaches the desktop or the cloud.
//   fingerprint = sha256(normalized remote + "\n" + appRoot), or sha256("path:" + realpath + "\n" + appRoot)
//   when the repo has no remote.
// O2 implements the same rule for the link request (`normalizeRemote`); I1 keeps ONE copy.
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"

export function normalizeRemote(raw: string): string | null {
  const text = raw.trim()
  if (text === "") return null
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(text)
  let host: string
  let path: string
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    host = scp[1]!
    path = scp[2]!
  } else {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return null
    }
    host = url.hostname
    const defaultPort = { "https:": "443", "http:": "80", "ssh:": "22", "git:": "9418" }[url.protocol]
    if (url.port !== "" && url.port !== defaultPort) host = `${host}:${url.port}`
    path = url.pathname
  }
  path = path.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")
  if (path === "") return null
  return `${host.toLowerCase()}/${path}`
}

export async function repoFingerprint(input: { remoteUrl: string | null; root: string; appRoot: string }): Promise<string> {
  const appRoot = input.appRoot === "" ? "." : input.appRoot
  const normalized = input.remoteUrl ? normalizeRemote(input.remoteUrl) : null
  const basis = normalized ?? `path:${await realpath(input.root)}`
  return `sha256:${createHash("sha256").update(`${basis}\n${appRoot}`).digest("hex")}`
}
