import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

function safeDirectory(cache: string, dir: string): boolean {
  try {
    if (lstatSync(cache).isSymbolicLink()) return false
    const physicalCache = realpathSync(cache)
    const lexicalRelative = relative(resolve(cache), resolve(dir))
    const candidate = lexicalRelative !== ".." && !lexicalRelative.startsWith(`..${sep}`) && !isAbsolute(lexicalRelative) ? join(physicalCache, lexicalRelative) : resolve(dir)
    const rel = relative(physicalCache, candidate)
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
    let cursor = physicalCache
    for (const part of rel.split(sep)) {
      cursor = join(cursor, part)
      const info = lstatSync(cursor)
      if (!info.isDirectory() || info.isSymbolicLink()) return false
    }
    return true
  } catch { return false }
}
function cacheKey(cache: string, create: boolean): Buffer {
  const path = join(cache, ".baseline-owner-key")
  if (create) {
    mkdirSync(cache, { recursive: true, mode: 0o700 })
    try { writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
  }
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Invalid baseline ownership key")
  const key = readFileSync(path)
  if (key.length !== 32) throw new Error("Invalid baseline ownership key")
  return key
}
/** Written only for a worktree the wizard just created; the signed marker alone cannot authorize another path. */
export function markBaseline(cache: string, dir: string, root: string, pid = process.pid): void {
  if (!safeDirectory(cache, dir)) throw new Error("Baseline directory is outside the physical wizard cache")
  const record = { schema: "infinite-tag.baseline.v2", dir: realpathSync(dir), root: realpathSync(root), pid }
  const signature = createHmac("sha256", cacheKey(cache, true)).update(JSON.stringify(record)).digest("hex")
  writeFileSync(`${dir}.baseline.json`, JSON.stringify({ ...record, signature }), { mode: 0o600, flag: "wx" })
}
export function ownsBaseline(cache: string, dir: string, root: string): boolean {
  if (!safeDirectory(cache, dir) || !/^baseline-/.test(relative(dirname(dir), dir))) return false
  try {
    const marker = `${dir}.baseline.json`
    if (!lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) return false
    const saved = JSON.parse(readFileSync(marker, "utf8"))
    const { signature, ...record } = saved
    if (record.schema !== "infinite-tag.baseline.v2" || record.dir !== realpathSync(dir) || record.root !== realpathSync(root)) return false
    const expected = createHmac("sha256", cacheKey(cache, false)).update(JSON.stringify(record)).digest()
    const actual = Buffer.from(typeof signature === "string" ? signature : "", "hex")
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch { return false }
}
