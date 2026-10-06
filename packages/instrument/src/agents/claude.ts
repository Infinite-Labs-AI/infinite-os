// Claude Code (2.1.287) argv builders and the stream-json reader (§3f.3 + the §3f.7 amendment, which wins
// where they differ). The argv is built ONLY here and checked with F0's `agentArgvViolations` before any
// spawn, so a forbidden flag can never reach a child.
//
// Both roles run `--restricted` (L4b: file tools confined to cwd, symlink escapes included; no user hooks
// or plugins; plan billing kept, `apiKeySource === "none"`), which replaces `--setting-sources user`. The
// SENSITIVE_DENIES stay as defence in depth: `Read(//<abs>/**) Edit(…) Write(…)` for every RESOLVED path
// (realpath; L3b proved the denies match after tilde, `/tmp` and symlink resolution). The worker has no
// Bash and no Web tools; the reviewer has Read/Glob/Grep only. Never `--bare`, `--safe-mode`,
// `--approve-for-me` or `--dangerously*`.
import {
  agentArgvViolations,
  CLAUDE_REVIEWER_TOOLS,
  CLAUDE_WORKER_TOOLS
} from "../wizard/contracts/agents.js"
import { claudeToolId, CLAIM_TOOL_NAMES, MCP_SERVER_NAME } from "../wizard/contracts/jobs.js"
import type { SensitivePath } from "./paths.js"

export interface ModelChoice {
  /** null = the user's default model (the one-time fallback when the plan or CLI rejects ours). */
  model: string | null
  effort: string
}

export interface ClaudeWorkerArgvInput {
  sensitive: readonly SensitivePath[]
  /** The 0600 `tag.mcp.json` under the run's 0700 scratch dir. */
  mcpConfigPath: string
  /** The operator rules + job blocks (O8's brief), appended to the system prompt. */
  systemPrompt: string
  /** `claims.schema.json` as JSON text. */
  claimsSchema: string
  maxTurns: number
  session: { mode: "new"; sessionId: string } | { mode: "resume"; sessionId: string }
  model: ModelChoice
}

export interface ClaudeReviewerArgvInput {
  sensitive: readonly SensitivePath[]
  systemPrompt: string
  reviewSchema: string
  maxTurns: number
  model: ModelChoice
}

/**
 * Secrets that live INSIDE the repo beyond `.env*` (review O3 F12): `.git/config` (a credentialed remote,
 * an `http.extraheader` bearer from actions/checkout) and a repo `.npmrc` / `.netrc` (`_authToken`). No job
 * needs to read any of them; both roles get these Read denies.
 */
export const REPO_SECRET_DENIES = ["Read(./.git/**)", "Read(**/.npmrc)", "Read(**/.netrc)"] as const

/** `Read(//<abs>/**) Edit(//<abs>/**) Write(//<abs>/**)` (a file gets no `/**`). */
export function sensitiveDenies(paths: readonly SensitivePath[], tools: readonly ("Read" | "Edit" | "Write")[]): string[] {
  const out: string[] = []
  for (const entry of paths) {
    if (!entry.path.startsWith("/")) throw new Error(`sensitive path is not absolute: ${entry.path}`)
    const target = entry.kind === "dir" ? `/${entry.path}/**` : `/${entry.path}`
    for (const tool of tools) out.push(`${tool}(${target})`)
  }
  return out
}

/**
 * The sensitive path whose `Read(//…)` deny would cover the reviewer's own cwd, or null (review I1 P1-4: a
 * reviewer denied its own worktree reviews nothing). Both sides are realpaths.
 */
export function reviewerDenyCoveringCwd(paths: readonly SensitivePath[], cwd: string): string | null {
  for (const entry of paths) {
    if (cwd === entry.path || (entry.kind === "dir" && cwd.startsWith(entry.path.endsWith("/") ? entry.path : `${entry.path}/`))) return entry.path
  }
  return null
}

/** Repo-secret file names a reviewer is denied on purpose (B20); a denial of anything else in its worktree means it was blind. */
const EXPECTED_REVIEWER_DENIALS = /(?:^|\/)(?:\.env[^/]*|\.npmrc|\.netrc)$/

/**
 * True when a Claude reviewer's `permission_denials` hit its own worktree on a file it needed (anything but
 * the repo secrets it is denied on purpose): the review it returns was made blind and is not posted.
 */
export function reviewerWasBlind(denials: ReadonlyArray<{ toolName: string; path: string | null }>, worktree: string): boolean {
  return denials.some((denial) => {
    if (denial.path === null) return false
    const inside = !denial.path.startsWith("/") || denial.path === worktree || denial.path.startsWith(`${worktree}/`)
    return inside && !EXPECTED_REVIEWER_DENIALS.test(denial.path)
  })
}

function modelArgs(model: ModelChoice): string[] {
  return [...(model.model ? ["--model", model.model] : []), "--effort", model.effort]
}

export function buildClaudeWorkerArgv(input: ClaudeWorkerArgvInput): string[] {
  const disallowed = [
    "Bash",
    "WebFetch",
    "WebSearch",
    "Read(./.env*)",
    "Read(**/.env*)",
    "Edit(**/.env*)",
    "Write(**/.env*)",
    ...REPO_SECRET_DENIES,
    "Edit(**/.npmrc)",
    "Write(**/.npmrc)",
    ...sensitiveDenies(input.sensitive, ["Read", "Edit", "Write"]),
    // §3y.10 (P3-10): the wizard's own files are never the worker's to read (the brief carries what it needs).
    "Read(./.infinite/**)",
    "Edit(./.infinite/**)",
    "Write(./.infinite/**)",
    "Edit(**/node_modules/**)",
    "Write(**/node_modules/**)",
    "Edit(./.git/**)",
    "Write(./.git/**)",
    "Edit(./.claude/**)",
    "Write(./.claude/**)",
    "Edit(./.codex/**)",
    "Write(./.codex/**)"
  ]
  const argv = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--restricted",
    ...modelArgs(input.model),
    "--permission-mode",
    "acceptEdits",
    "--permission-prompts",
    "none",
    "--tools",
    CLAUDE_WORKER_TOOLS.join(","),
    "--allowedTools",
    `${CLAUDE_WORKER_TOOLS.join(" ")} mcp__${MCP_SERVER_NAME}__*`,
    "--disallowedTools",
    ...disallowed,
    "--strict-mcp-config",
    "--mcp-config",
    input.mcpConfigPath,
    "--append-system-prompt",
    input.systemPrompt,
    "--json-schema",
    input.claimsSchema,
    "--max-turns",
    String(input.maxTurns),
    ...(input.session.mode === "new" ? ["--session-id", input.session.sessionId] : ["--resume", input.session.sessionId]),
    "--disable-slash-commands",
    "--no-chrome"
  ]
  assertAllowed(argv)
  return argv
}

export function buildClaudeReviewerArgv(input: ClaudeReviewerArgvInput): string[] {
  const argv = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--restricted",
    ...modelArgs(input.model),
    "--tools",
    CLAUDE_REVIEWER_TOOLS.join(","),
    "--allowedTools",
    CLAUDE_REVIEWER_TOOLS.join(" "),
    "--disallowedTools",
    "Read(./.env*)",
    "Read(**/.env*)",
    ...REPO_SECRET_DENIES,
    ...sensitiveDenies(input.sensitive, ["Read"]),
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--strict-mcp-config",
    "--json-schema",
    input.reviewSchema,
    "--append-system-prompt",
    input.systemPrompt,
    "--max-turns",
    String(input.maxTurns),
    "--no-session-persistence",
    "--disable-slash-commands",
    "--no-chrome"
  ]
  assertAllowed(argv)
  return argv
}

function assertAllowed(argv: readonly string[]): void {
  const violations = agentArgvViolations("claude_code", argv)
  if (violations.length > 0) throw new Error(`refusing to build a Claude argv: ${violations.join("; ")}`)
}

/** The 0600 `tag.mcp.json` (§3f.3): the run's MCP vars reach Claude ONLY through this file. */
export function claudeMcpConfig(input: { node: string; cliPath: string; url: string; token: string }): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "stdio",
        command: input.node,
        args: [input.cliPath, "mcp-proxy"],
        env: { INFINITE_TAG_MCP_URL: input.url, INFINITE_TAG_MCP_TOKEN: input.token },
        timeout: 900_000,
        alwaysLoad: true
      }
    }
  })
}

// ---- the stream ----

export type ClaudeStreamEvent =
  | {
      kind: "init"
      sessionId: string | null
      apiKeySource: string | null
      mcpConnected: boolean
      hasClaimTool: boolean
      model: string | null
    }
  | { kind: "tool_use"; name: string; input: unknown; id?: string; additional?: Array<{ name: string; input: unknown; id?: string }> }
  /** §3x.3 a tool's result came back to the model (it now thinks until its next event). */
  | { kind: "tool_result"; ids: string[] }
  | { kind: "assistant_error"; error: string }
  | { kind: "rate_limit"; event: Record<string, unknown> }
  | {
      kind: "result"
      subtype: string
      isError: boolean
      sessionId: string | null
      numTurns: number | null
      apiErrorStatus: number | null
      structuredOutput: unknown
      permissionDenials: Array<{ toolName: string; path: string | null }>
      text: string
      raw: Record<string, unknown>
    }
  | { kind: "other" }

export function parseClaudeLine(line: string): ClaudeStreamEvent | null {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(event)) return null
  if (event.type === "system" && event.subtype === "init") {
    const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : []
    const tools = Array.isArray(event.tools) ? event.tools.filter((tool): tool is string => typeof tool === "string") : []
    return {
      kind: "init",
      sessionId: typeof event.session_id === "string" ? event.session_id : null,
      apiKeySource: typeof event.apiKeySource === "string" ? event.apiKeySource : null,
      mcpConnected: servers.some((server) => isRecord(server) && server.name === MCP_SERVER_NAME && server.status === "connected"),
      hasClaimTool: tools.includes(claudeToolId("job_claim")),
      model: typeof event.model === "string" ? event.model : null
    }
  }
  if (event.type === "assistant") {
    const error = typeof event.error === "string" ? event.error : null
    if (error) return { kind: "assistant_error", error }
    const content = isRecord(event.message) && Array.isArray(event.message.content) ? event.message.content : []
    const uses = content.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "tool_use" && typeof block.name === "string")
      .map(block => ({ name: block.name as string, input: block.input, ...(typeof block.id === "string" ? { id: block.id } : {}) }))
    if (uses[0]) return { kind: "tool_use", ...uses[0], ...(uses.length > 1 ? { additional: uses.slice(1) } : {}) }
    return { kind: "other" }
  }
  if (event.type === "user") {
    const content = isRecord(event.message) && Array.isArray(event.message.content) ? event.message.content : []
    if (content.some((block) => isRecord(block) && block.type === "tool_result")) return { kind: "tool_result", ids: content.filter(isRecord).filter(block => block.type === "tool_result" && typeof block.tool_use_id === "string").map(block => block.tool_use_id as string) }
    return { kind: "other" }
  }
  if (event.type === "rate_limit_event") return { kind: "rate_limit", event }
  if (event.type === "result") {
    const denials = Array.isArray(event.permission_denials) ? event.permission_denials : []
    const errors = Array.isArray(event.errors) ? event.errors.filter((entry): entry is string => typeof entry === "string") : []
    return {
      kind: "result",
      subtype: typeof event.subtype === "string" ? event.subtype : "unknown",
      isError: event.is_error === true,
      sessionId: typeof event.session_id === "string" ? event.session_id : null,
      numTurns: typeof event.num_turns === "number" ? event.num_turns : null,
      apiErrorStatus: typeof event.api_error_status === "number" ? event.api_error_status : null,
      structuredOutput: event.structured_output,
      permissionDenials: denials.filter(isRecord).map((denial) => {
        const input = isRecord(denial.tool_input) ? denial.tool_input : {}
        const path = input.file_path ?? input.path ?? input.pattern
        return { toolName: typeof denial.tool_name === "string" ? denial.tool_name : "unknown", path: typeof path === "string" ? path : null }
      }),
      text: [typeof event.result === "string" ? event.result : "", ...errors].join(" ").trim(),
      raw: event
    }
  }
  return { kind: "other" }
}

/** The plan or CLI refused our pinned model (§3f.7: retry ONCE with the user's default model). */
/**
 * The pinned model was refused (§3f.7 fallback). Only when a model was pinned (`modelId`), and only on the
 * CLI's own model-not-found shapes, never on any error that happens to say "model … invalid" (review O3
 * F20): the `model_not_found` assistant error, or a result error that names THE pinned model with a
 * not-found / no-access phrase ("There's an issue with the selected model (<id>). It may not exist or you
 * may not have access to it.").
 */
export function claudeModelRejected(event: ClaudeStreamEvent, modelId: string | null): boolean {
  if (modelId === null) return false
  if (event.kind === "assistant_error") return event.error === "model_not_found"
  if (event.kind === "result" && event.isError) return modelRejectedText(event.text, modelId)
  return false
}

const MODEL_REJECTED_PHRASE = /\b(not found|not available|not supported|is not supported|does not exist|may not exist|do not have access|don't have access|not have access|no access)\b/i

/** True when `text` names the pinned `modelId` together with a not-found / no-access phrase, or the `model_not_found` code. */
export function modelRejectedText(text: string, modelId: string): boolean {
  if (/\bmodel_not_found\b/.test(text)) return true
  return text.toLowerCase().includes(modelId.toLowerCase()) && MODEL_REJECTED_PHRASE.test(text)
}

/** Paths whose read-denial is an incident (the agent reached for a secret), never just a count. */
export const INCIDENT_PATH = /(^|\/)\.env[^/]*$|\.growth-os|Application Support\/Infinite|(^|\/)\.codex(\/|$)|(^|\/)\.ssh(\/|$)|(^|\/)\.aws(\/|$)|\.npmrc$|\.netrc$|\.credentials\.json$|Library\/Caches\/infinite-tag/

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The tool ids Claude must see in `system/init` (the claim tool at least). */
export const CLAUDE_CLAIM_TOOL_IDS = CLAIM_TOOL_NAMES.map((tool) => claudeToolId(tool))
