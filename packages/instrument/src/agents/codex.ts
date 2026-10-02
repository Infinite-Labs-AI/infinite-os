// Codex (0.159.2) argv builders and the JSONL reader (§3f.3 + the §3f.7 amendment, which wins).
//
// The read confinement IS the sandbox selection: the `-c default_permissions=…` + `-c permissions.<p>.
// filesystem={…}` pair from F0's `codexPermissionArgs` (`$HOME` = none, every sensitive path outside
// `$HOME` = none, Codex's own binary dir and install root re-allowed READ, `:project_roots` = write for the
// worker, read for the reviewer). NEVER `-s` / `--sandbox` / `sandbox_mode`: `-s` silently drops the
// profile (L7). Every role disables every feature in `CODEX_DISABLED_FEATURES` (browser, computer use,
// in-app browser, image generation, code-mode host, apps, plugins, hooks, memories, shell snapshot, skill
// search, view_image, goals, multi_agent) and carries `--ignore-user-config --strict-config`, so a renamed
// feature fails loudly. Each argv is checked with F0's `agentArgvViolations` before it is returned.
import {
  agentArgvViolations,
  CODEX_DISABLED_FEATURES,
  CODEX_REQUIRED_CONFIG,
  MCP_ENV
} from "../wizard/contracts/agents.js"
import { CLAIM_TOOL_NAMES, MCP_SERVER_NAME } from "../wizard/contracts/jobs.js"
import type { ModelChoice } from "./claude.js"
import { isRecord, modelRejectedText } from "./claude.js"

/** TOML value encodings for `-c key=value`. */
const tomlString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
const tomlArray = (values: readonly string[]) => `[${values.map(tomlString).join(",")}]`

function config(pairs: ReadonlyArray<readonly [string, string]>): string[] {
  return pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`])
}

function modelArgs(model: ModelChoice): string[] {
  return [...(model.model ? ["-m", model.model] : []), "-c", `model_reasoning_effort=${tomlString(model.effort)}`]
}

function featureArgs(): string[] {
  return config(CODEX_DISABLED_FEATURES.map((feature) => [`features.${feature}`, "false"] as const))
}

function requiredConfigArgs(): string[] {
  return CODEX_REQUIRED_CONFIG.flatMap((setting) => ["-c", setting])
}

/** The claim channel's MCP server, started by Codex with this run's two vars forwarded from its own env. */
function mcpArgs(node: string, cliPath: string): string[] {
  const server = `mcp_servers.${MCP_SERVER_NAME}`
  return config([
    [`${server}.command`, tomlString(node)],
    [`${server}.args`, tomlArray([cliPath, "mcp-proxy"])],
    [`${server}.env_vars`, tomlArray([MCP_ENV.url, MCP_ENV.token])],
    [`${server}.default_tools_approval_mode`, tomlString("approve")],
    [`${server}.required`, "true"],
    [`${server}.tool_timeout_sec`, "900"],
    [`${server}.startup_timeout_sec`, "20"],
    [`${server}.enabled_tools`, tomlArray(CLAIM_TOOL_NAMES)]
  ])
}

export interface CodexWorkerArgvInput {
  repo: string
  /** From `codexPermissionArgs({role:"worker", …})`. */
  permissionArgs: readonly string[]
  model: ModelChoice
  node: string
  cliPath: string
  /** `-o` (the final message, the ONLY thing parsed for the structured claims; L6). */
  outputPath: string
  schemaPath: string
  /** Resume an earlier thread (after a usage limit, a question or a failed check). */
  resumeThreadId?: string
}

export function buildCodexWorkerArgv(input: CodexWorkerArgvInput): string[] {
  const shared = [
    ...modelArgs(input.model),
    ...input.permissionArgs,
    // approval_policy="never", web_search="disabled", project_doc_max_bytes=0, skills.include_instructions=false
    ...requiredConfigArgs(),
    // Moot under the profile (its network defaults to restricted, L5) but harmless, and proven in the live run.
    ...config([["sandbox_workspace_write.network_access", "false"]]),
    ...featureArgs(),
    ...mcpArgs(input.node, input.cliPath),
    ...config([["shell_environment_policy.exclude", tomlArray(["INFINITE_TAG_*"])]]),
    "-o",
    input.outputPath,
    "--output-schema",
    input.schemaPath
  ]
  // `exec resume` has no -C (cwd = the repo at spawn), no --ignore-rules and no --color (scout S2 §2.1).
  const argv = input.resumeThreadId
    ? ["exec", "resume", input.resumeThreadId, "--json", "--ignore-user-config", "--strict-config", ...shared, "-"]
    : ["exec", "--json", "-C", input.repo, "--ignore-user-config", "--ignore-rules", "--strict-config", "--color", "never", ...shared, "-"]
  assertAllowed(argv)
  return argv
}

export interface CodexReviewerArgvInput {
  worktree: string
  permissionArgs: readonly string[]
  model: ModelChoice
  outputPath: string
  schemaPath: string
}

export function buildCodexReviewerArgv(input: CodexReviewerArgvInput): string[] {
  const argv = [
    "exec",
    "--json",
    "-C",
    input.worktree,
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--ephemeral",
    "--color",
    "never",
    ...modelArgs(input.model),
    ...input.permissionArgs,
    ...featureArgs(),
    ...requiredConfigArgs(),
    "--output-schema",
    input.schemaPath,
    "-o",
    input.outputPath,
    "-"
  ]
  assertAllowed(argv)
  return argv
}

function assertAllowed(argv: readonly string[]): void {
  const violations = agentArgvViolations("codex", argv)
  if (violations.length > 0) throw new Error(`refusing to build a Codex argv: ${violations.join("; ")}`)
}

// ---- the stream ----

export type CodexStreamEvent =
  | { kind: "thread"; threadId: string }
  | { kind: "item"; phase: "started" | "updated" | "completed"; item: Record<string, unknown> }
  | { kind: "error"; message: string; fatal: boolean }
  | { kind: "turn_completed" }
  | { kind: "other" }

export function parseCodexLine(line: string): CodexStreamEvent | null {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(event)) return null
  switch (event.type) {
    case "thread.started":
      return typeof event.thread_id === "string" ? { kind: "thread", threadId: event.thread_id } : { kind: "other" }
    case "item.started":
    case "item.updated":
    case "item.completed": {
      if (!isRecord(event.item)) return { kind: "other" }
      const item = event.item
      if (item.type === "error") {
        const message = typeof item.message === "string" ? item.message : ""
        return { kind: "error", message, fatal: codexUnrecognizedConfig(message) }
      }
      return { kind: "item", phase: event.type.slice(5) as "started" | "updated" | "completed", item }
    }
    case "turn.completed":
      return { kind: "turn_completed" }
    case "turn.failed": {
      const message = isRecord(event.error) && typeof event.error.message === "string" ? event.error.message : "turn failed"
      return { kind: "error", message, fatal: true }
    }
    case "error": {
      // A top-level `error` can be transient ("Reconnecting… 1/5"); the runner decides from its text and the exit.
      const message = typeof event.message === "string" ? event.message : "error"
      return { kind: "error", message, fatal: codexUnrecognizedConfig(message) }
    }
    default:
      return { kind: "other" }
  }
}

/** The pinned model was refused: the message names THE pinned model (`modelId`) with a not-found phrase (F20). */
export function codexModelRejected(message: string, modelId: string | null): boolean {
  return modelId !== null && modelRejectedText(message, modelId)
}

/** "unrecognized configuration setting" → fatal: a safety key was ignored (never run without it). */
export function codexUnrecognizedConfig(message: string): boolean {
  return /unrecognized configuration setting|unknown configuration field/i.test(message)
}
