// `infinite-tag mcp-proxy` (hidden from help): the stdio side of the wizard's claim channel (§3e.3).
// The agent spawns `<node> <cli.js> mcp-proxy` with INFINITE_TAG_MCP_URL and INFINITE_TAG_MCP_TOKEN in its
// env (Claude: from the 0600 `tag.mcp.json`; Codex: forwarded from its own env via `env_vars`), and this
// process relays each stdin JSON-RPC line to the wizard's loopback bridge, in order, writing each reply as
// one stdout line. It holds no state and no secret beyond the run token it was handed.
//
// A wrong token → the bridge answers 401 → the proxy replies with a JSON-RPC error (the agent sees the tool
// as unavailable; the wizard sees no `initialize` and calls the run toolless). The URL must be loopback
// `http://127.0.0.1:<port>/mcp`; anything else is refused before a byte is sent. One stdin listener only
// (a double listener double-writes every reply).
import { request as httpRequest } from "node:http"
import { createInterface } from "node:readline"

import { MCP_ENV } from "../../wizard/contracts/agents.js"
import { WIZARD_EXIT } from "../../wizard/contracts/codes.js"
import { MCP_TOKEN_HEADER } from "../../wizard/contracts/jobs.js"
import { idOf, RPC_ERRORS, rpcError, type JsonRpcResponse } from "./jsonrpc.js"

export interface McpProxyIo {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  env: Readonly<Record<string, string | undefined>>
}

/** Parses and checks the bridge URL: only `http://127.0.0.1:<port>/mcp`. */
export function loopbackMcpUrl(raw: string | undefined): URL | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "" || url.pathname !== "/mcp") return null
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null
  return url
}

export async function runMcpProxy(io: McpProxyIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env }): Promise<number> {
  const url = loopbackMcpUrl(io.env[MCP_ENV.url])
  const token = io.env[MCP_ENV.token]
  if (!url || !token) {
    io.stderr.write("infinite-tag mcp-proxy: no claim channel for this run (missing or non-loopback INFINITE_TAG_MCP_URL / INFINITE_TAG_MCP_TOKEN).\n")
    // A usage/environment exit (2): never a silent 0, so the agent reports the server as failed.
    return WIZARD_EXIT.usage
  }
  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity })
  let queue = Promise.resolve()
  const write = (reply: JsonRpcResponse | string) => {
    io.stdout.write(`${typeof reply === "string" ? reply : JSON.stringify(reply)}\n`)
  }
  lines.on("line", (line) => {
    const trimmed = line.trim()
    if (trimmed === "") return
    queue = queue.then(async () => {
      const id = idOf(trimmed)
      const outcome = await post(url, token, trimmed)
      if (outcome.kind === "reply") {
        write(outcome.body)
        return
      }
      if (id === undefined) return
      if (outcome.kind === "unauthorized") write(rpcError(id, RPC_ERRORS.unauthorized, "the wizard's claim channel refused this token"))
      else if (outcome.kind === "error") write(rpcError(id, RPC_ERRORS.unavailable, outcome.message))
    })
  })
  await new Promise<void>((resolveClosed) => lines.once("close", () => resolveClosed()))
  await queue
  return 0
}

type PostOutcome = { kind: "reply"; body: string } | { kind: "accepted" } | { kind: "unauthorized" } | { kind: "error"; message: string }

function post(url: URL, token: string, body: string): Promise<PostOutcome> {
  return new Promise((resolvePost) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(url.port),
        path: url.pathname,
        method: "POST",
        headers: {
          Host: `127.0.0.1:${url.port}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          [MCP_TOKEN_HEADER]: token
        },
        timeout: 900_000
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          const status = response.statusCode ?? 0
          if (status === 401) return resolvePost({ kind: "unauthorized" })
          if (status === 202 || status === 204) return resolvePost({ kind: "accepted" })
          if (status !== 200) return resolvePost({ kind: "error", message: `the wizard's claim channel answered HTTP ${status}` })
          try {
            resolvePost({ kind: "reply", body: JSON.stringify(JSON.parse(text)) })
          } catch {
            resolvePost({ kind: "error", message: "the wizard's claim channel sent an unreadable reply" })
          }
        })
      }
    )
    request.on("timeout", () => request.destroy(new Error("timeout")))
    request.on("error", () => resolvePost({ kind: "error", message: "the wizard's claim channel is not reachable" }))
    request.end(body)
  })
}
