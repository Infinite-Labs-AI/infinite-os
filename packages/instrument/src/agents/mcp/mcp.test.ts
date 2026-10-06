import { request } from "node:http"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"

import { item } from "../../../test/wizard/repo.js"
import { CLAIM_TOOL_NAMES, MCP_PROTOCOL_VERSION, MCP_TOKEN_HEADER, type AgentQuestion, type Claim } from "../../wizard/contracts/jobs.js"
import { startMcpBridge, type McpBridge } from "./bridge.js"
import { RPC_ERRORS } from "./jsonrpc.js"
import { loopbackMcpUrl, runMcpProxy } from "./proxy.js"
import { ClaimChannel, isPlanDecidedTopic } from "./tools.js"

const bridges: McpBridge[] = []
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()))
})

function channel(extra: { claims?: Claim[]; asks?: AgentQuestion[]; progress?: string[] } = {}) {
  return new ClaimChannel({
    items: [item("posthog_improve:proxy", ["app/providers.tsx"]), item("server_conversions:signup", ["app/api/signup/route.ts"])],
    now: () => new Date("2026-10-02T10:00:00.000Z"),
    redact: (text) => text.split("RUN-TOKEN-SECRET").join("[redacted]"),
    onClaim: (claim) => { extra.claims?.push(claim) },
    onAsk: (question) => extra.asks?.push(question),
    onProgress: (progress) => extra.progress?.push(progress.text)
  })
}

async function bridgeFor(handler: ClaimChannel) {
  const bridge = await startMcpBridge({ handler, version: "0.0.0-test" })
  bridges.push(bridge)
  return bridge
}

function post(bridge: McpBridge, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  return new Promise((resolvePost, rejectPost) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: bridge.port,
        path: "/mcp",
        method: "POST",
        headers: { "Content-Type": "application/json", [MCP_TOKEN_HEADER]: bridge.token, ...headers }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => resolvePost({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }))
      }
    )
    req.on("error", rejectPost)
    req.end(text)
  })
}

const call = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })

describe("the MCP bridge (§3e.3, §3a.2 origin rule)", () => {
  it("serves initialize, tools/list (the 4 tools) and notifications", async () => {
    const handler = channel()
    const bridge = await bridgeFor(handler)
    expect(bridge.url).toBe(`http://127.0.0.1:${bridge.port}/mcp`)
    expect(bridge.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const init = JSON.parse((await post(bridge, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION } })).body)
    expect(init.result.protocolVersion).toBe("2025-06-18")
    expect(init.result.serverInfo.name).toBe("infinite_tag")
    expect((await post(bridge, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202)
    const list = JSON.parse((await post(bridge, { jsonrpc: "2.0", id: 2, method: "tools/list" })).body)
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual([...CLAIM_TOOL_NAMES])
    expect(handler.initialized).toBe(1)
    expect(handler.listed).toBe(1)
    expect(JSON.parse((await post(bridge, { jsonrpc: "2.0", id: 3, method: "ping" })).body).result).toEqual({})
  })

  it("answers 401 to a bad token and the proxy turns it into a JSON-RPC error", async () => {
    const bridge = await bridgeFor(channel())
    const refused = await post(bridge, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { [MCP_TOKEN_HEADER]: "wrong" })
    expect(refused.status).toBe(401)
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const out: string[] = []
    stdout.on("data", (chunk: Buffer) => out.push(chunk.toString("utf8")))
    const done = runMcpProxy({ stdin, stdout, stderr: new PassThrough(), env: { INFINITE_TAG_MCP_URL: bridge.url, INFINITE_TAG_MCP_TOKEN: "wrong" } })
    stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} })}\n`)
    expect(await done).toBe(0)
    const reply = JSON.parse(out.join("").trim())
    expect(reply).toEqual({ jsonrpc: "2.0", id: 7, error: { code: RPC_ERRORS.unauthorized, message: "the wizard's claim channel refused this token" } })
  })

  it("refuses an Origin header or a wrong Host with 403 even with the right token (negative)", async () => {
    const handler = channel()
    const bridge = await bridgeFor(handler)
    const body = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }
    expect((await post(bridge, body, { Origin: "http://evil.example" })).status).toBe(403)
    expect((await post(bridge, body, { Origin: "null" })).status).toBe(403)
    expect((await post(bridge, body, { Host: `localhost:${bridge.port}` })).status).toBe(403)
    expect((await post(bridge, body, { Host: "127.0.0.1" })).status).toBe(403)
    expect(handler.initialized).toBe(0)
    expect((await post(bridge, body)).status).toBe(200)
  })

  it("refuses a body over 64 KB and a non-JSON content type", async () => {
    const bridge = await bridgeFor(channel())
    expect((await post(bridge, JSON.stringify({ pad: "x".repeat(70_000) }))).status).toBe(413)
    expect((await post(bridge, "{}", { "Content-Type": "text/plain" })).status).toBe(400)
  })

  it("relays a full session through the stdio proxy, in order", async () => {
    const claims: Claim[] = []
    const bridge = await bridgeFor(channel({ claims }))
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const out: string[] = []
    stdout.on("data", (chunk: Buffer) => out.push(chunk.toString("utf8")))
    const done = runMcpProxy({ stdin, stdout, stderr: new PassThrough(), env: { INFINITE_TAG_MCP_URL: bridge.url, INFINITE_TAG_MCP_TOKEN: bridge.token } })
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`)
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    stdin.write(`${JSON.stringify(call(2, "job_claim", { job_id: "posthog_improve:proxy", status: "done", note: "proxy wired" }))}\n`)
    stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })}\n`)
    await done
    const replies = out.join("").trim().split("\n").map((line) => JSON.parse(line))
    expect(replies.map((reply) => reply.id)).toEqual([1, 2, 3])
    expect(claims).toHaveLength(1)
  })

  it("the proxy refuses a non-loopback URL before sending anything (negative)", async () => {
    expect(loopbackMcpUrl("http://127.0.0.1:4000/mcp")).not.toBeNull()
    expect(loopbackMcpUrl("http://localhost:4000/mcp")).toBeNull()
    expect(loopbackMcpUrl("https://127.0.0.1:4000/mcp")).toBeNull()
    expect(loopbackMcpUrl("http://evil.example:4000/mcp")).toBeNull()
    expect(loopbackMcpUrl("http://u:p@127.0.0.1:4000/mcp")).toBeNull()
    const stderr = new PassThrough()
    const code = await runMcpProxy({ stdin: new PassThrough(), stdout: new PassThrough(), stderr, env: { INFINITE_TAG_MCP_URL: "http://evil.example:1/mcp", INFINITE_TAG_MCP_TOKEN: "t" } })
    expect(code).toBe(2)
  })
})

describe("the claim tools", () => {
  it("returns a static check failure inside the claim turn so the agent can fix and reclaim", async () => {
    let attempts = 0
    const tools = new ClaimChannel({
      items: [item("server_conversions:signup", ["app/api/signup/route.ts"])],
      now: () => new Date("2026-10-02T10:00:00.000Z"),
      redact: (value) => value,
      onClaim: async () => {
        attempts += 1
        return attempts === 1 ? { state: "problem" as const, problems: ["outcome call missing"] } : { state: "pass" as const, problems: [] }
      }
    })
    const claimArgs = { job_id: "server_conversions:signup", status: "done", note: "done" }
    expect((await tools.call("job_claim", claimArgs)).result).toMatchObject({ staticChecks: { state: "problem", problems: ["outcome call missing"] } })
    expect((await tools.call("job_claim", claimArgs)).result).toMatchObject({ staticChecks: { state: "pass", problems: [] } })
    expect(tools.claims).toHaveLength(2)
  })
  it("job_list returns this turn's items only", async () => {
    const outcome = await channel().call("job_list", {})
    const jobs = (outcome.result as { jobs: Array<{ id: string; allow: unknown; rules: string[] }> }).jobs
    expect(jobs.map((job) => job.id)).toEqual(["posthog_improve:proxy", "server_conversions:signup"])
    expect(jobs[0]!.allow).toEqual({ files: ["app/providers.tsx"], create: [] })
    expect(jobs[0]!.rules.length).toBeGreaterThan(0)
  })

  it("job_claim records a claim and never says verified", async () => {
    const claims: Claim[] = []
    const tools = channel({ claims })
    const outcome = await tools.call("job_claim", { job_id: "server_conversions:signup", status: "done", note: "added \u001b[31mevent RUN-TOKEN-SECRET", files: ["app/api/signup/route.ts"] })
    expect(outcome.isError).toBe(false)
    expect(outcome.result).toEqual({ recorded: true, next: "the wizard will run its own checks" })
    expect(JSON.stringify(outcome.result)).not.toMatch(/verified/i)
    expect(claims).toEqual([{ jobId: "server_conversions:signup", status: "done", note: "added event [redacted]", files: ["app/api/signup/route.ts"], at: "2026-10-02T10:00:00.000Z" }])
  })

  it("rejects an unknown id, a bad status, an over-long note and an unknown field (negatives)", async () => {
    const claims: Claim[] = []
    const tools = channel({ claims })
    for (const args of [
      { job_id: "nope:1", status: "done", note: "x" },
      { job_id: "posthog_improve:proxy", status: "verified", note: "x" },
      { job_id: "posthog_improve:proxy", status: "done", note: "x".repeat(501) },
      { job_id: "posthog_improve:proxy", status: "done", note: "x", state: "proven" }
    ]) {
      const outcome = await tools.call("job_claim", args)
      expect(outcome.isError).toBe(true)
    }
    expect(claims).toEqual([])
    expect((await tools.call("no_such_tool", {})).isError).toBe(true)
  })

  it("ask_user parks a question (non-blocking) and refuses plan-decided topics", async () => {
    const asks: AgentQuestion[] = []
    const tools = channel({ asks })
    const parked = await tools.call("ask_user", { job_id: "server_conversions:signup", question: "Is /api/register or /api/signup the real sign-up route?", options: [{ label: "register", value: "/api/register" }], why: "Both create users." })
    expect(parked.result).toEqual({ parked: true, note: "continue other jobs; the wizard will ask and resume you" })
    expect(asks).toHaveLength(1)
    for (const question of ["Should I add a cookie banner?", "What should the conversion name be?", "Can I npm install posthog-node?", "Which privacy text do you want?"]) {
      const decided = await tools.call("ask_user", { job_id: "server_conversions:signup", question, why: "x" })
      expect(decided.result).toEqual({ parked: false, reason: "decided by the plan" })
    }
    expect(asks).toHaveLength(1)
    expect(isPlanDecidedTopic("Which file holds the checkout handler?")).toBe(false)
    // Decisions the plan made are refused; ordinary questions that share a word are not (review O3 F23).
    for (const decided of [
      "Should the consent default be granted?",
      "Can I change the cookie banner text?",
      "Should I reword the privacy paragraph?",
      "What should the conversion name be?",
      "Can I run npm install @vercel/functions?",
      "Should I add a dependency for this?"
    ]) {
      expect(isPlanDecidedTopic(decided)).toBe(true)
    }
    for (const open of ["Which file is the privacy page?", "Which cookie holds the session id?", "Is the hero banner on /pricing a landing page?", "Is this a pnpm workspace?"]) {
      expect(isPlanDecidedTopic(open)).toBe(false)
    }
  })

  it("report_progress is sanitised and capped at 120 characters", async () => {
    const progress: string[] = []
    const tools = channel({ progress })
    expect((await tools.call("report_progress", { job_id: "posthog_improve:proxy", text: `\u001b[2J${"y".repeat(200)}` })).result).toEqual({ ok: true })
    expect(progress[0]!.length).toBe(120)
    expect(progress[0]).not.toContain("\u001b")
  })
})
