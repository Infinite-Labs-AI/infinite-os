import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { PackageManager } from "../types.js"
import type { SandboxedSpawnFn, DenyReadSet } from "../t0/sandbox.js"

/** Read only a public cache path from config; never forward config files or credentials to a child. */
export function npmrcPathValue(value: string): string {
  let quote: string | null = null
  let out = ""
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!
    if (char === "\\" && ["#", ";", "\\", '"', "'"].includes(value[i + 1] ?? "")) { out += value[++i]; continue }
    if (quote) { if (char === quote) quote = null; else out += char; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === "#" || char === ";") break
    out += char
  }
  if (quote) throw new Error("The package store path has an unterminated quote")
  return out.trim()
}

function pnpmStoreSetting(root: string, appRoot: string, home: string): string | null {
  let found: string | null = process.env.npm_config_store_dir ?? process.env.NPM_CONFIG_STORE_DIR ?? process.env.PNPM_STORE_DIR ?? null
  if (found) return resolve(found)
  for (const base of [home, root, appRoot]) {
    try {
      const text = readFileSync(join(base, ".npmrc"), "utf8")
      for (const match of text.matchAll(/^\s*store-dir\s*=\s*([^\r\n]+)$/gm)) {
        const raw = npmrcPathValue(match[1]!)
        if (!raw) continue
        const expanded = raw.replace(/\$\{([^}]+)\}/g, (_whole, variable: string) => {
          if (variable === "HOME") return home
          if (["XDG_DATA_HOME", "XDG_CACHE_HOME", "PNPM_HOME", "PNPM_STORE_DIR"].includes(variable) && process.env[variable]) return process.env[variable]!
          throw new Error("The configured pnpm store path cannot be resolved without forwarding unrelated environment values")
        }).replace(/^~(?=\/)/, home)
        found = resolve(base, expanded)
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  return found
}

export async function stablePackageCache(input: {
  manager: PackageManager; root: string; appRoot: string; spawn: SandboxedSpawnFn; deny: DenyReadSet; platform?: NodeJS.Platform; signal?: AbortSignal
}): Promise<{ args: string[]; env: Record<string, string>; writable: string[] }> {
  if (input.manager === "npm") return { args: [], env: {}, writable: [] }
  const home = homedir()
  const setting = input.manager === "pnpm" ? pnpmStoreSetting(input.root, input.appRoot, home) : null
  const safeCache = (directory: string): string => {
    let canonical = directory
    try { canonical = realpathSync(directory) } catch { /* The package manager may create a new cache. */ }
    for (const protectedRoot of [input.root, home]) {
      const rel = relative(canonical, protectedRoot)
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("A package cache cannot be a parent of the repository or home directory")
    }
    return directory
  }
  if (setting) safeCache(setting)
  const query = input.manager === "pnpm" ? ["store", "path", ...(setting ? ["--store-dir", setting] : [])]
    : input.manager === "yarn" ? ["config", "get", "globalFolder"] : ["pm", "cache"]
  // Bun opens a manifest read/write even for `pm cache`. Query with a disposable empty manifest;
  // the customer's package.json remains outside every writable scope.
  const queryRoot = input.manager === "bun" ? mkdtempSync(join(tmpdir(), "infinite-tag-cache-query-")) : null
  if (queryRoot) writeFileSync(join(queryRoot, "package.json"), '{"private":true}\n', { mode: 0o600 })
  const result = await input.spawn(input.manager, query, {
    cwd: queryRoot ?? input.appRoot, env: { HOME: home, CI: "1", NO_UPDATE_NOTIFIER: "1" }, network: false,
    denyReads: [...input.deny.paths, join(home, ".yarnrc.yml"), join(home, ".bunfig.toml")], denyReadPrefixes: input.deny.prefixes,
    denyWrites: [join(input.root, ".git"), join(input.root, ".husky"), join(input.root, ".infinite"), join(input.root, "package.json"), join(input.appRoot, "package.json")],
    // pnpm probes whether its normal store is writable; denying that probe makes it silently choose
    // a different project-local store. Permit only its configured/default cache subtree.
    allowWrites: queryRoot ? [queryRoot] : input.manager === "pnpm" ? [setting ?? (process.platform === "darwin" ? join(home, "Library/pnpm") : join(process.env.XDG_DATA_HOME ?? join(home, ".local/share"), "pnpm"))] : [],
    packageManagerTempDirs: [input.appRoot], timeoutMs: 15_000, platform: input.platform, signal: input.signal
  }).finally(() => { if (queryRoot) rmSync(queryRoot, { recursive: true, force: true }) })
  const path = result.stdout.split(/\r?\n/).map(line => line.trim().replace(/^"|"$/g, "")).find(line => isAbsolute(line) && !/[\u0000-\u001f]/.test(line))
  if (result.exitCode !== 0 || result.timedOut || result.aborted || !path || path === "/" || path === home) throw new Error(`Could not resolve ${input.manager}'s persistent package cache`)
  if (input.manager === "pnpm") {
    // `store path` includes the format-version suffix; --store-dir expects its parent.
    const store = safeCache(/\/v\d+$/.test(path) ? path.replace(/\/v\d+$/, "") : path)
    let reinstall = false
    try {
      const recorded = /^storeDir:\s*(.+)$/m.exec(readFileSync(join(input.appRoot, "node_modules/.modules.yaml"), "utf8"))?.[1]?.replace(/^['"]|['"]$/g, "")
      reinstall = !!recorded && recorded !== path
    } catch { /* No previous installation. */ }
    return { args: ["--store-dir", store, ...(reinstall ? ["--force"] : [])], env: {}, writable: [store] }
  }
  if (input.manager === "yarn") return { args: [], env: { YARN_GLOBAL_FOLDER: safeCache(path) }, writable: [path] }
  return { args: [], env: { BUN_INSTALL_CACHE_DIR: safeCache(path) }, writable: [path] }
}

/** Bun opens its manifest read/write when creating a lock. Resolve in a disposable manifest copy,
 * then create only the approved new lock in the site; the site's package.json stays read-only. */
export async function createBunLockfile(input: {
  appRoot: string; lockfile: string; spawn: SandboxedSpawnFn; deny: DenyReadSet; env: Record<string, string>; writableCache: string[];
  platform?: NodeJS.Platform; signal?: AbortSignal; onOutput?: (line: string) => void
}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "infinite-tag-lock-"))
  try {
    writeFileSync(join(dir, "package.json"), readFileSync(join(input.appRoot, "package.json")), { mode: 0o600 })
    for (const entry of readdirSync(input.appRoot)) {
      if (entry.startsWith(".") || ["package.json", "node_modules", "bun.lock", "bun.lockb"].includes(entry)) continue
      symlinkSync(join(input.appRoot, entry), join(dir, entry))
    }
    const result = await input.spawn("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
      cwd: dir, env: input.env, network: true, denyReads: input.deny.paths, denyReadPrefixes: input.deny.prefixes,
      allowWrites: [dir, ...input.writableCache], timeoutMs: 120_000, signal: input.signal, platform: input.platform,
      onOutput: chunk => input.onOutput?.(chunk)
    })
    if (result.exitCode !== 0 || result.timedOut || result.aborted) throw new Error("Bun could not create the approved lockfile without changing the site's manifest")
    writeFileSync(input.lockfile, readFileSync(join(dir, "bun.lock")), { flag: "wx", mode: 0o644 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
