// Agent detection (§3f.1 `detect`, §3f.2 who pays, §3d.7 nested mode). Spends NO prompt: only
// `--version`, `claude auth status --json` and `codex login status`, run under the same env (nesting
// markers and `INFINITE_TAG_*` stripped) and cwd as the real spawn, with the binaries resolved from PATH
// so a wrapper that picks the account (e.g. a `CLAUDE_CONFIG_DIR` switcher) is kept.
//
// Claude `auth status --json` carries `email`, `orgId` and `orgName`: they are read past and never
// logged, stored or shown. The Codex "Logged in using an API key - …" line can carry a masked key: only
// the credential KIND is kept.
import { access, open, realpath } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import type { AgentDetectResult, AgentInfo, AgentKind, WhoPays } from "../wizard/contracts/agents.js"
import { nestingMarker, strippedEnv } from "./env.js"
import { runProbe } from "./process.js"
import { whichAll } from "./paths.js"

const PROVIDER_LABELS: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
  anthropicAws: "Anthropic on AWS",
  anthropicGoogleCloud: "Anthropic on Google Cloud",
  mantle: "Mantle",
  gateway: "your AI gateway"
}

/** §3f.2 from `claude auth status --json` (logged in = exit 0). Never reads email/org fields. */
export function claudeWhoPays(status: unknown): WhoPays {
  const record = typeof status === "object" && status !== null ? (status as Record<string, unknown>) : {}
  const method = record.authMethod
  const provider = typeof record.apiProvider === "string" ? record.apiProvider : null
  const keySource = record.apiKeySource
  if (method === "third_party" || (provider !== null && provider !== "firstParty")) {
    const label = provider && PROVIDER_LABELS[provider] ? PROVIDER_LABELS[provider] : "another provider's"
    return { payer: "third_party", label: `billed to your ${label} account` }
  }
  if (method === "api_key" || method === "api_key_helper" || (typeof keySource === "string" && keySource !== "" && keySource !== "none")) {
    return { payer: "api_key", label: "billed per token to your Anthropic API key" }
  }
  if (method === "claude.ai" && provider === "firstParty") {
    const plan = typeof record.subscriptionType === "string" && /^[a-z0-9_-]{1,32}$/i.test(record.subscriptionType) ? ` (${record.subscriptionType})` : ""
    return { payer: "plan", label: `your Claude plan${plan} pays` }
  }
  return { payer: "unknown", label: "Claude Code is logged in; check which account it bills" }
}

/** §3f.2 from `codex login status` text. Returns null when Codex is not logged in. */
export function codexWhoPays(text: string): WhoPays | null {
  if (/not logged in/i.test(text)) return null
  if (/logged in using chatgpt/i.test(text)) return { payer: "plan", label: "your ChatGPT plan pays" }
  if (/bedrock/i.test(text)) return { payer: "api_key", label: "billed per token to your Amazon Bedrock credentials" }
  if (/personal access token|access token/i.test(text)) return { payer: "api_key", label: "billed per token to your OpenAI access token" }
  if (/api key/i.test(text)) return { payer: "api_key", label: "billed per token to your OpenAI API key" }
  if (/workload identity/i.test(text)) return { payer: "api_key", label: "billed to your workload identity" }
  if (/logged in/i.test(text)) return { payer: "unknown", label: "Codex is logged in; check which account it bills" }
  return null
}

/**
 * Does `claude`'s `system/init.apiKeySource` match what the plan line said (§3f.2)? Plan billing shows the
 * STRING "none" (L4); a key shows its source. Unknown/third-party payers are not checked here.
 */
export function apiKeySourceMatches(whoPays: WhoPays, apiKeySource: string | null): boolean {
  if (whoPays.payer === "plan") return apiKeySource === "none"
  if (whoPays.payer === "api_key") return apiKeySource !== null && apiKeySource !== "none"
  return true
}

export function parseVersion(text: string): string {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text)
  return match ? match[1]! : "unknown"
}

export interface DetectOptions {
  env: Readonly<Record<string, string | undefined>>
  cwd: string
  /** stdin AND stdout are a TTY (the wizard's own check). */
  isTTY: boolean
  /** `--worker claude|codex`; `--no-agent` → "none". */
  preferWorker?: "claude" | "codex" | "none" | null
  probeTimeoutMs?: number
}

export interface DetectedAgents extends AgentDetectResult {
  /** Every usable agent, in preference order. */
  available: AgentInfo[]
}

async function probeClaude(binPath: string, options: DetectOptions): Promise<AgentInfo | "logged_out"> {
  const env = strippedEnv(options.env)
  const version = await runProbe({ command: binPath, args: ["--version"], cwd: options.cwd, env, timeoutMs: options.probeTimeoutMs })
  const status = await runProbe({ command: binPath, args: ["auth", "status", "--json"], cwd: options.cwd, env, timeoutMs: options.probeTimeoutMs })
  if (status.code !== 0) return "logged_out"
  let parsed: unknown = null
  try {
    parsed = JSON.parse(status.stdout)
  } catch {
    parsed = null
  }
  if (parsed && typeof parsed === "object" && (parsed as { loggedIn?: unknown }).loggedIn === false) return "logged_out"
  return { kind: "claude_code", binPath, version: parseVersion(version.stdout || version.stderr), whoPays: claudeWhoPays(parsed) }
}

async function probeCodex(binPath: string, options: DetectOptions): Promise<AgentInfo | "logged_out"> {
  const env = strippedEnv(options.env)
  const version = await runProbe({ command: binPath, args: ["--version"], cwd: options.cwd, env, timeoutMs: options.probeTimeoutMs })
  const status = await runProbe({ command: binPath, args: ["login", "status"], cwd: options.cwd, env, timeoutMs: options.probeTimeoutMs })
  const whoPays = codexWhoPays(`${status.stdout}\n${status.stderr}`)
  if (status.code !== 0 || whoPays === null) return "logged_out"
  return { kind: "codex", binPath, version: parseVersion(version.stdout || version.stderr), whoPays }
}

export async function detectAgents(options: DetectOptions): Promise<DetectedAgents> {
  const marker = nestingMarker(options.env)
  const nested = marker !== null && !options.isTTY ? { marker } : null
  const unavailable: NonNullable<AgentDetectResult["unavailable"]> = []
  const found: Partial<Record<AgentKind, AgentInfo>> = {}
  for (const [kind, name, probe] of [
    ["claude_code", "claude", probeClaude],
    ["codex", "codex", probeCodex]
  ] as const) {
    const [binPath] = await whichAll(name, options.env.PATH)
    if (!binPath) {
      unavailable.push({ kind, reason: "not_installed" })
      continue
    }
    const info = await probe(binPath, options)
    if (info === "logged_out") unavailable.push({ kind, reason: "logged_out" })
    else found[kind] = info
  }
  const preference: AgentKind[] = options.preferWorker === "codex" ? ["codex", "claude_code"] : ["claude_code", "codex"]
  const available = preference.map((kind) => found[kind]).filter((info): info is AgentInfo => info !== undefined)
  if (options.preferWorker === "none" || nested) {
    // No agent is spawned: deterministic lanes only, or the parent agent does the jobs (§3d.7).
    return { worker: null, reviewer: null, nested, unavailable, available }
  }
  const worker = available[0] ?? null
  const reviewer = available.find((info) => info.kind !== worker?.kind) ?? null
  return { worker, reviewer, nested, unavailable, available }
}

/**
 * The two read re-allows Codex needs under the `$HOME` deny (§3f.7): the dir of the codex path that is
 * exec'd (after a wrapper script) and the install root (realpath). Without them Codex cannot start ("fs
 * sandbox helper … execvp … Operation not permitted"). A wrapper script is skipped to the next `codex` on
 * PATH (what a wrapper execs); an npm-installed JS launcher re-allows its package root.
 */
export async function resolveCodexRuntime(binPath: string, pathEnv: string | undefined): Promise<{ codexBinDir: string; codexInstallRoot: string }> {
  const candidates = await whichAll("codex", pathEnv)
  const ordered = [binPath, ...candidates.filter((candidate) => candidate !== binPath)]
  let exec = binPath
  if (await isScript(binPath)) {
    for (const candidate of ordered.slice(1)) {
      if (!(await isScript(candidate))) {
        exec = candidate
        break
      }
    }
  }
  const real = await realpath(exec)
  const codexBinDir = await realpath(dirname(exec))
  let codexInstallRoot = dirname(real)
  if (basename(codexInstallRoot) === "bin") codexInstallRoot = dirname(codexInstallRoot)
  if (await isScript(real)) {
    let dir = dirname(real)
    while (dir !== dirname(dir)) {
      try {
        await access(join(dir, "package.json"))
        codexInstallRoot = dir
        break
      } catch {
        dir = dirname(dir)
      }
    }
  }
  return { codexBinDir, codexInstallRoot: await realpath(codexInstallRoot) }
}

/** A `#!` script (a wrapper or a JS launcher), read from its first two bytes only. */
async function isScript(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, "r")
    const head = Buffer.alloc(2)
    await handle.read(head, 0, 2, 0)
    return head.toString("latin1") === "#!"
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}
