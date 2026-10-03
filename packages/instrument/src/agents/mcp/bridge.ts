// The wizard's side of the claim channel (§3e.3): a loopback HTTP endpoint `http://127.0.0.1:<random>/mcp`
// guarded by a per-run 32-byte token in `x-infinite-tag-token`. The agent's `mcp-proxy` child relays its
// stdio JSON-RPC here.
//
// Order of checks (§3a.2 rule, applied to this bridge too; R2-23): a request carrying ANY `Origin`
// header, or whose `Host` is not exactly `127.0.0.1:<port>`, is refused 403 BEFORE the token is looked at
// (DNS rebinding); then a wrong or missing token → 401 (timing-safe compare of SHA-256 digests); only
// `POST /mcp` with `Content-Type: application/json` and a body ≤ 64 KB is served.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import { MCP_TOKEN_HEADER } from "../../wizard/contracts/jobs.js"
import { dispatchMcp, RPC_ERRORS, rpcError, type McpServerHandler } from "./jsonrpc.js"

export const MCP_BRIDGE_MAX_BODY_BYTES = 64 * 1024
export const MCP_BRIDGE_PATH = "/mcp"

export interface McpBridge {
  url: string
  token: string
  port: number
  close(): Promise<void>
}

export function newMcpToken(): string {
  return randomBytes(32).toString("base64url")
}

export async function startMcpBridge(input: { handler: McpServerHandler; version: string; token?: string }): Promise<McpBridge> {
  const token = input.token ?? newMcpToken()
  const expected = digest(token)
  let port = 0
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, { error: { code: "internal" } })
    })
  })

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin !== undefined) return send(response, 403, { error: { code: "origin_refused" } })
    if (request.headers.host !== `127.0.0.1:${port}`) return send(response, 403, { error: { code: "origin_refused" } })
    const given = request.headers[MCP_TOKEN_HEADER]
    if (typeof given !== "string" || !timingSafeEqual(digest(given), expected)) {
      response.setHeader("WWW-Authenticate", `Token header="${MCP_TOKEN_HEADER}"`)
      return send(response, 401, { error: { code: "unauthorized" } })
    }
    const path = (request.url ?? "").split("?")[0]
    if (path !== MCP_BRIDGE_PATH) return send(response, 404, { error: { code: "route_not_found" } })
    if (request.method !== "POST") return send(response, 405, { error: { code: "method_not_allowed" } })
    if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) {
      return send(response, 400, { error: { code: "invalid_request", field: "content-type" } })
    }
    const body = await readBody(request)
    if (body === null) return send(response, 413, { error: { code: "body_too_large" } })
    let message: unknown
    try {
      message = JSON.parse(body)
    } catch {
      return send(response, 200, rpcError(null, RPC_ERRORS.parse, "invalid JSON"))
    }
    const reply = await dispatchMcp(message, input.handler, input.version)
    if (reply === null) {
      response.writeHead(202, { "Cache-Control": "no-store" })
      response.end()
      return
    }
    send(response, 200, reply)
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen)
      resolveListen()
    })
  })
  port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}${MCP_BRIDGE_PATH}`,
    token,
    port,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      })
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest()
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) })
  response.end(text)
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MCP_BRIDGE_MAX_BODY_BYTES) {
        tooLarge = true
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolveBody(tooLarge ? null : Buffer.concat(chunks).toString("utf8")))
    request.on("error", () => resolveBody(null))
  })
}
