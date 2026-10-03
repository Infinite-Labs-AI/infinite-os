// §3f.7 narration: the "a little magical" beats under the jobs step. Sources, in order of trust:
//   1. wizard state changes (the jobs step emits those itself);
//   2. tool names: Claude `tool_use` (Read/Glob/Grep → "Reading <file>", Edit/Write → "Editing <file>",
//      flagged when the file is outside the job's allowed files), Codex `file_change` / `mcp_tool_call` /
//      `tool_search_call`, and a claim → "<agent> says job N is done; checking…";
//   3. the agent's own `report_progress` text.
// Rules: at most one beat per 3 s; every string goes through `sanitizeUntrusted`; `tool_input` CONTENT is
// never printed (only a file path, made repo-relative); never a ✓ from agent text.
import { isAbsolute, relative } from "node:path"

import { AGENT_LIMITS, type AgentKind } from "../wizard/contracts/agents.js"
import type { ClaimStatus } from "../wizard/contracts/jobs.js"
import { sanitizeUntrusted } from "./sanitize.js"

export interface NarrationBeat {
  agent: AgentKind
  role: "worker" | "reviewer"
  text: string
}

export const AGENT_LABEL: Record<AgentKind, string> = { claude_code: "Claude Code", codex: "Codex" }

/** Ticks and crosses the wizard alone may print; stripped from any beat built from agent text. */
const VERDICT_GLYPHS = /[✓✔✅☑✗✘❌]/g

export class Narrator {
  private lastAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly options: {
      agent: AgentKind
      role: "worker" | "reviewer"
      emit: (beat: NarrationBeat) => void
      now?: () => number
      throttleMs?: number
    }
  ) {}

  /** Emits the beat unless one went out less than the throttle window ago. Returns whether it went out. */
  beat(text: string): boolean {
    const now = (this.options.now ?? Date.now)()
    const throttle = this.options.throttleMs ?? AGENT_LIMITS.narrationThrottleMs
    if (now - this.lastAt < throttle) return false
    const clean = sanitizeUntrusted(String(text).replace(VERDICT_GLYPHS, ""), AGENT_LIMITS.narrationMaxChars)
    if (clean === "") return false
    this.lastAt = now
    this.options.emit({ agent: this.options.agent, role: this.options.role, text: clean })
    return true
  }
}

/** A file path for a beat: repo-relative when inside the repo, else its basename-free marker. */
export function displayPath(path: unknown, root: string): string {
  if (typeof path !== "string" || path === "") return "a file"
  if (!isAbsolute(path)) return path
  const rel = relative(root, path)
  if (rel === "" ) return "."
  if (rel.startsWith("..") || isAbsolute(rel)) return "a file outside the repo"
  return rel
}

/** Claude tool name + its input → a beat, or null (Bash, Task lists and unknown tools say nothing). */
export function claudeToolBeat(
  tool: string,
  input: unknown,
  ctx: { root: string; isAllowed: (repoRelPath: string) => boolean; agent: AgentKind; jobNumber: (jobId: string) => number | null }
): string | null {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  const filePath = record.file_path ?? record.path ?? record.notebook_path
  switch (tool) {
    case "Read":
      return `Reading ${displayPath(filePath, ctx.root)}`
    case "Glob":
    case "Grep":
      return "Searching the code"
    case "Edit":
    case "Write":
    case "MultiEdit":
      return editBeat(displayPath(filePath, ctx.root), ctx.isAllowed)
    default: {
      const claim = /^mcp__infinite_tag__(job_claim|job_list|report_progress|ask_user)$/.exec(tool)
      if (!claim) return null
      if (claim[1] === "job_claim") return claimBeat(ctx.agent, record.job_id, record.status, ctx.jobNumber)
      if (claim[1] === "job_list") return "Reading its checklist"
      return null
    }
  }
}

export function editBeat(path: string, isAllowed: (repoRelPath: string) => boolean): string {
  return isAllowed(path) ? `Editing ${path}` : `Editing ${path} (not one of its allowed files; the wizard will undo it)`
}

export function claimBeat(
  agent: AgentKind,
  jobId: unknown,
  status: unknown,
  jobNumber: (jobId: string) => number | null
): string {
  const n = typeof jobId === "string" ? jobNumber(jobId) : null
  const job = n === null ? "a job" : `job ${n}`
  const who = AGENT_LABEL[agent]
  const what = (status as ClaimStatus) === "blocked" ? "is blocked" : (status as ClaimStatus) === "not_needed" ? "isn't needed" : "is done"
  return `${who} says ${job} ${what}; checking…`
}

/** A Codex JSONL item → a beat, or null. `tool_search_*` items are the deferred MCP tool loading (L1). */
export function codexItemBeat(
  item: unknown,
  ctx: { root: string; isAllowed: (repoRelPath: string) => boolean; agent: AgentKind; jobNumber: (jobId: string) => number | null }
): string | null {
  if (typeof item !== "object" || item === null) return null
  const record = item as Record<string, unknown>
  switch (record.type) {
    case "file_change": {
      const changes = Array.isArray(record.changes) ? record.changes : []
      const first = changes.find((change): change is Record<string, unknown> => typeof change === "object" && change !== null)
      return editBeat(displayPath(first?.path, ctx.root), ctx.isAllowed)
    }
    case "command_execution":
      return "Looking through the code"
    case "mcp_tool_call": {
      if (record.server !== "infinite_tag") return null
      const args = typeof record.arguments === "object" && record.arguments !== null ? (record.arguments as Record<string, unknown>) : {}
      if (record.tool === "job_claim") return claimBeat(ctx.agent, args.job_id, args.status, ctx.jobNumber)
      if (record.tool === "job_list") return "Reading its checklist"
      return null
    }
    case "tool_search_call":
      return "Loading its checklist tools"
    default:
      return null
  }
}
