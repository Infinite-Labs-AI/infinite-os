import { execFile } from "node:child_process"
import { lstat, readFile } from "node:fs/promises"
import { join } from "node:path"
import { git, gitEnv, GIT_HARDENING_ARGS } from "../agents/git-exec.js"
import { isPolicySourceFile } from "./policy-pages.js"

type Snapshot = { sources: Map<string, string>; issue?: { file: string; reason: string } }
const decode = (bytes: Buffer) => bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes) ? null : bytes.toString("utf8")

/** Full source-tree context for one-hop policy imports. Historical checks never consult the cwd. */
export async function policySourceTree(root: string, revision?: string): Promise<Snapshot> {
  const sources = new Map<string, string>()
  if (revision) {
    const tree = await git(root, ["ls-tree", "-r", "-z", revision])
    if (tree.code !== 0) return { sources, issue: { file: "(git)", reason: "the policy source tree could not be read" } }
    const entries = tree.stdout.toString("utf8").split("\0").filter(Boolean).flatMap(line => {
      const tab = line.indexOf("\t"), path = line.slice(tab + 1), [mode, type, sha] = line.slice(0, tab).split(" ")
      if (!isPolicySourceFile(path)) return []
      sources.set(path, "")
      return type === "blob" && /^100[67][0-7]{2}$/.test(mode!) ? [{ path, sha: sha! }] : []
    })
    if (!entries.length) return { sources }
    // One batch reads the exact blob IDs from that tree; paths never become command or input syntax.
    const batch = await new Promise<Buffer | null>(resolve => {
      const child = execFile("git", [...GIT_HARDENING_ARGS, "cat-file", "--batch"], { cwd: root, env: gitEnv(), encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout))
      child.stdin?.on("error", () => {})
      child.stdin?.end(entries.map(entry => entry.sha).join("\n") + "\n")
    })
    if (!batch) return { sources, issue: { file: "(git)", reason: "the policy source blobs could not be read" } }
    let offset = 0
    for (const entry of entries) {
      const end = batch.indexOf(10, offset)
      const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(batch.subarray(offset, end).toString("utf8"))
      if (end < offset || !match || match[1] !== entry.sha) return { sources, issue: { file: entry.path, reason: "an existing source blob could not be read" } }
      const size = Number(match[2]), start = end + 1
      if (!Number.isSafeInteger(size) || start + size >= batch.length) return { sources, issue: { file: entry.path, reason: "an existing source blob could not be read" } }
      const text = decode(batch.subarray(start, start + size))
      if (text === null) return { sources, issue: { file: entry.path, reason: "the policy source could not be decoded" } }
      sources.set(entry.path, text)
      offset = start + size + 1
    }
    return { sources }
  }
  const list = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  if (list.code !== 0) return { sources, issue: { file: "(git)", reason: "the working policy source tree could not be read" } }
  for (const path of new Set(list.stdout.toString("utf8").split("\0").filter(isPolicySourceFile))) {
    try {
      const info = await lstat(join(root, path))
      if (!info.isFile()) { sources.set(path, ""); continue }
      const text = decode(await readFile(join(root, path)))
      if (text === null) return { sources, issue: { file: path, reason: "the policy source could not be decoded" } }
      sources.set(path, text)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { sources, issue: { file: path, reason: "the changed source could not be inspected" } }
    }
  }
  return { sources }
}
