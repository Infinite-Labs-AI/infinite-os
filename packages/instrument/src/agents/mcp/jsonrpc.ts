// The MCP subset the claim channel speaks (§3e.3): JSON-RPC 2.0 over stdio lines (the proxy) and over
// loopback HTTP (the bridge), with `initialize` (protocol "2025-06-18"), `notifications/initialized`,
// `tools/list`, `tools/call` and `ping`. Zero dependencies: the package stays dependency-free.
// Pattern credit: PostHog wizard v2.74.1 (MIT) for the tool-surface shape; this is a clean rewrite.
import { MCP_PROTOCOL_VERSION, MCP_SERVER_NAME } from "../../wizard/contracts/jobs.js"

export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** The wizard's bridge refused the token (HTTP 401). */
  unauthorized: -32001,
  /** The wizard's bridge is gone or refused the request for another reason. */
  unavailable: -32002
} as const

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result }
}

export function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

/** The `id` of a raw line, when it has one (for error replies to a line the bridge never answered). */
export function idOf(raw: string): JsonRpcId | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "id" in parsed) {
      const id = (parsed as { id: unknown }).id
      if (typeof id === "string" || typeof id === "number" || id === null) return id
    }
  } catch {
    // unparseable: no id
  }
  return undefined
}

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpToolOutcome {
  /** The structured result (sent as `structuredContent` and as JSON text). */
  result: unknown
  isError: boolean
}

export interface McpServerHandler {
  tools(): McpToolDefinition[]
  call(name: string, args: unknown): Promise<McpToolOutcome>
  /** Bookkeeping hooks (the runner's toolless detection reads them). */
  onInitialize?(): void
  onToolsList?(): void
}

/**
 * Dispatches one decoded message. Returns the response, or null for a notification (no `id`). A batch
 * (array) is refused: the 2025-06-18 protocol has no JSON-RPC batching.
 */
export async function dispatchMcp(message: unknown, handler: McpServerHandler, version: string): Promise<JsonRpcResponse | null> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return rpcError(null, RPC_ERRORS.invalidRequest, "expected one JSON-RPC object")
  }
  const request = message as Partial<JsonRpcRequest>
  const hasId = "id" in request && (typeof request.id === "string" || typeof request.id === "number")
  const id: JsonRpcId = hasId ? (request.id as string | number) : null
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return hasId ? rpcError(id, RPC_ERRORS.invalidRequest, "not a JSON-RPC 2.0 request") : null
  }
  if (!hasId) {
    // Notifications (`notifications/initialized`, `notifications/cancelled`, …) get no reply.
    return null
  }
  switch (request.method) {
    case "initialize":
      handler.onInitialize?.()
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version },
        instructions: "The wizard's checklist. List your jobs with job_list; claim each with job_claim. A claim is not the result: the wizard runs its own checks."
      })
    case "ping":
      return rpcResult(id, {})
    case "tools/list":
      handler.onToolsList?.()
      return rpcResult(id, { tools: handler.tools() })
    case "tools/call": {
      const params = request.params
      if (typeof params !== "object" || params === null || typeof (params as { name?: unknown }).name !== "string") {
        return rpcError(id, RPC_ERRORS.invalidParams, "tools/call needs a tool name")
      }
      const { name, arguments: args } = params as { name: string; arguments?: unknown }
      try {
        const outcome = await handler.call(name, args ?? {})
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(outcome.result) }],
          structuredContent: outcome.result,
          isError: outcome.isError
        })
      } catch (error) {
        return rpcError(id, RPC_ERRORS.internal, error instanceof Error ? error.message : "tool failed")
      }
    }
    default:
      return rpcError(id, RPC_ERRORS.methodNotFound, `unknown method ${request.method}`)
  }
}
