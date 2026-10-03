// §3f.3 env rules for every agent child (worker, reviewer, and the zero-prompt probes, which run under
// the same env as the spawn so a wrapper picks the same account).
//
// Strip ONLY the nesting markers and every inherited `INFINITE_TAG_*` (a stale MCP token from a parent
// run must never reach a child). Keep everything else, `ANTHROPIC_*`, `CLAUDE_CONFIG_DIR` and the proxy
// variables included: the user's own setup pays, so the wizard detects and discloses instead of
// rerouting billing (the opposite of PostHog's wizard, whose own gateway pays).
//
// Then, for the CODEX process only, set this run's two MCP variables: Codex hands an MCP server its env
// from its own environment (`mcp_servers.infinite_tag.env_vars`), so stripping them would make every
// Codex run toolless; `shell_environment_policy.exclude=["INFINITE_TAG_*"]` keeps them out of Codex's
// sandboxed shell. Claude gets them only through the 0600 `tag.mcp.json`.
import { INFINITE_TAG_ENV_PREFIX, MCP_ENV, NESTING_ENV_MARKERS, type AgentKind } from "../wizard/contracts/agents.js"

export type AgentEnv = Record<string, string>

export interface AgentEnvOptions {
  kind: AgentKind
  /** This run's claim channel. Applied to a Codex child only. */
  mcp?: { url: string; token: string } | null
}

/** The base env with the nesting markers and every `INFINITE_TAG_*` removed (undefined values dropped). */
export function strippedEnv(base: Readonly<Record<string, string | undefined>>): AgentEnv {
  const out: AgentEnv = {}
  const markers = new Set<string>(NESTING_ENV_MARKERS)
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (markers.has(key)) continue
    if (key.startsWith(INFINITE_TAG_ENV_PREFIX)) continue
    out[key] = value
  }
  return out
}

export function buildAgentEnv(base: Readonly<Record<string, string | undefined>>, options: AgentEnvOptions): AgentEnv {
  const env = strippedEnv(base)
  if (options.kind === "claude_code") {
    // Load-bearing: MCP tools must not be deferred behind tool search, or `job_claim` is not in init.tools.
    env.ENABLE_TOOL_SEARCH = "false"
    // The repo's CLAUDE.md is not loaded as instructions (§3e.4); its facts reach the agent as data.
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1"
    return env
  }
  if (options.mcp) {
    env[MCP_ENV.url] = options.mcp.url
    env[MCP_ENV.token] = options.mcp.token
  }
  return env
}

/** The nesting marker that is set, if any (§3d.7: nested = a marker is set AND there is no TTY). */
export function nestingMarker(base: Readonly<Record<string, string | undefined>>): string | null {
  for (const marker of NESTING_ENV_MARKERS) {
    const value = base[marker]
    if (value !== undefined && value !== "") return marker
  }
  return null
}
