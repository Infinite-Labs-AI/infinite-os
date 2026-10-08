/* global process, Buffer, setTimeout */
// Shared engine for the fake `claude` and `codex` binaries (test-only, never published). A fake:
//   - records its argv, cwd, stdin and the env keys that matter to FAKE_AGENT_RECORD (JSONL, sync writes,
//     so a kill never loses a record);
//   - answers the zero-prompt probes (`--version`, `auth status --json`, `login status`) from the scenario;
//   - for a run, plays the scenario turn selected by how many runs it already recorded: it starts the REAL
//     `mcp-proxy` exactly as the real CLI would (Claude: from `--mcp-config`; Codex: from the `-c
//     mcp_servers.infinite_tag.*` flags with `env_vars` forwarded from its OWN env), performs scripted file
//     edits, makes scripted MCP tool calls, replays JSONL fixtures, and emits the CLI's own event stream.
// No network, no model: the only process it talks to is the wizard's loopback bridge through the proxy.
import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
export const FIXTURES = resolve(here, "../fixtures/agents")

const RECORDED_ENV = [
  "INFINITE_TAG_MCP_URL",
  "INFINITE_TAG_MCP_TOKEN",
  "ENABLE_TOOL_SEARCH",
  "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_CHILD_SESSION",
  "AI_AGENT",
  "CODEX_THREAD_ID",
  "CODEX_SANDBOX",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR"
]

/**
 * The scenario for one fake CLI. A file may hold one scenario for both (the runner tests), or one per CLI
 * under `claude` / `codex` (the offline E2E, where the wizard spawns both from one environment).
 */
export function loadScenario(agent) {
  const path = process.env.FAKE_AGENT_SCENARIO
  if (!path) return {}
  const scenario = JSON.parse(readFileSync(path, "utf8"))
  return agent && scenario[agent] && typeof scenario[agent] === "object" ? scenario[agent] : scenario
}

export function record(entry) {
  const path = process.env.FAKE_AGENT_RECORD
  if (!path) return
  appendFileSync(path, `${JSON.stringify(entry)}\n`)
}

export function priorRuns(agent) {
  const path = process.env.FAKE_AGENT_RECORD
  if (!path || !existsSync(path)) return 0
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === "run" && entry.agent === agent).length
}

export function envSnapshot() {
  const out = {}
  for (const key of RECORDED_ENV) if (process.env[key] !== undefined) out[key] = process.env[key]
  out.INFINITE_TAG_KEYS = Object.keys(process.env).filter((key) => key.startsWith("INFINITE_TAG_")).sort()
  return out
}

export function readStdin() {
  return new Promise((resolveStdin) => {
    const chunks = []
    process.stdin.on("data", (chunk) => chunks.push(chunk))
    process.stdin.on("end", () => resolveStdin(Buffer.concat(chunks).toString("utf8")))
    process.stdin.on("error", () => resolveStdin(""))
  })
}

export function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

export function replay(name) {
  const text = readFileSync(join(FIXTURES, name), "utf8")
  for (const line of text.split("\n")) if (line.trim() !== "") process.stdout.write(`${line}\n`)
}

export const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** A minimal MCP client over the proxy's stdio. */
export class McpClient {
  constructor(command, args, env) {
    this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    this.pending = new Map()
    this.nextId = 1
    this.exited = false
    let buffer = ""
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk
      let index = buffer.indexOf("\n")
      while (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf("\n")
        if (line.trim() === "") continue
        const message = JSON.parse(line)
        const waiter = this.pending.get(message.id)
        if (waiter) {
          this.pending.delete(message.id)
          waiter(message)
        }
      }
    })
    this.child.on("exit", (code) => {
      this.exited = true
      this.exitCode = code
      for (const waiter of this.pending.values()) waiter({ error: { code: -1, message: `proxy exited ${code}` } })
      this.pending.clear()
    })
  }

  request(method, params) {
    if (this.exited) return Promise.resolve({ error: { code: -1, message: "proxy exited" } })
    const id = this.nextId++
    return new Promise((resolveRequest) => {
      this.pending.set(id, resolveRequest)
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  }

  notify(method) {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`)
  }

  async connect() {
    const init = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } })
    if (!init.result) return false
    this.notify("notifications/initialized")
    const list = await this.request("tools/list", {})
    return Boolean(list.result)
  }

  close() {
    try {
      this.child.stdin.end()
    } catch {
      // Already closed.
    }
  }
}

/** Runs the scripted steps of one turn. `onTool(name, args, reply)` lets each CLI echo its own events. */
export async function runSteps(steps, ctx) {
  for (const step of steps ?? []) {
    if (step.emit) emit(step.emit)
    else if (step.replay) replay(step.replay)
    else if (step.edit) {
      const path = join(ctx.cwd, step.edit.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, step.edit.content)
      if (!step.edit.silent) ctx.onEdit?.(step.edit.path)
    } else if (step.append) {
      const path = join(ctx.cwd, step.append.path)
      appendFileSync(path, step.append.text)
      ctx.onEdit?.(step.append.path)
    } else if (step.replace) {
      // An Edit on the file as it is NOW (the installer may have changed it): exactly one occurrence, or the
      // last one when asked; a missing text is a scenario bug and fails the turn loudly.
      const { path: rel, find, replace, occurrence } = step.replace
      const path = join(ctx.cwd, rel)
      const text = readFileSync(path, "utf8")
      const at = occurrence === "last" ? text.lastIndexOf(find) : text.indexOf(find)
      if (at < 0 || (occurrence !== "last" && text.indexOf(find, at + find.length) >= 0)) {
        process.stderr.write(`fake agent: ${rel} does not hold ${JSON.stringify(find.slice(0, 80))} exactly once\n`)
        process.exit(70)
      }
      writeFileSync(path, text.slice(0, at) + replace + text.slice(at + find.length))
      ctx.onEdit?.(rel)
    } else if (step.prepend) {
      const path = join(ctx.cwd, step.prepend.path)
      writeFileSync(path, step.prepend.text + readFileSync(path, "utf8"))
      ctx.onEdit?.(step.prepend.path)
    } else if (step.delete) {
      rmSync(join(ctx.cwd, step.delete), { force: true })
    } else if (step.tool) {
      const reply = ctx.mcp ? await ctx.mcp.request("tools/call", { name: step.tool, arguments: step.args ?? {} }) : { error: { message: "no mcp" } }
      record({ kind: "mcp", agent: ctx.agent, tool: step.tool, reply })
      ctx.onTool?.(step.tool, step.args ?? {}, reply)
    } else if (step.sleep) await sleep(step.sleep)
    else if (step.grandchild) {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
      record({ kind: "grandchild", agent: ctx.agent, pid: child.pid })
    } else if (step.hang) {
      record({ kind: "hanging", agent: ctx.agent, pid: process.pid })
      await new Promise(() => {})
    } else if (step.exit !== undefined) {
      process.exit(step.exit)
    }
  }
}

/**
 * §3y.7: a reviewer that CAN read its folder quotes `.infinite/review/read-check.txt` at the start of its summary,
 * as the brief asks. A turn with `blind: true` reads nothing (the live run's Codex) and answers as scripted.
 */
export function withReadCheck(review, cwd, turn) {
  if (turn.blind || review === null || typeof review !== "object" || typeof review.summary !== "string") return review
  let nonce
  try {
    nonce = readFileSync(join(cwd, ".infinite", "review", "read-check.txt"), "utf8").trim()
  } catch {
    return review
  }
  return { ...review, summary: `read-check: ${nonce} ${review.summary}` }
}

/**
 * The jobs' review (`wizard/steps/jobs-review.ts`): a reviewer run whose output schema answers the jobs' questions
 * (`properties.answers`). It is recorded as `jobs_review`, never as a `run`, so it never shifts the step-9 review's
 * scripted turns. Scenario key `jobsReview: [{ answers?: [{ job?, match?, answer, note?, evidence? }], final?, summary?,
 * blind?, exit?, schemaProblem? }]`, one per jobs review: each question gets the first rule whose `job` equals its job
 * and whose `match` is in its text; a question no rule names is a "pass". `final` replaces the whole answer.
 */
export function isJobsReviewSchema(schema) {
  return !!schema && typeof schema === "object" && !!schema.properties && typeof schema.properties === "object" && "answers" in schema.properties
}

export function priorJobsReviews(agent) {
  const path = process.env.FAKE_AGENT_RECORD
  if (!path || !existsSync(path)) return 0
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.kind === "jobs_review" && entry.agent === agent).length
}

export function jobsReviewTurn(scenario, agent) {
  const turns = scenario.jobsReview ?? [{}]
  return turns[Math.min(priorJobsReviews(agent), turns.length - 1)] ?? {}
}

export function jobsReviewAnswer(turn, cwd) {
  if (turn.final !== undefined) return turn.final
  let jobs = []
  try {
    jobs = JSON.parse(readFileSync(join(cwd, ".infinite", "review", "jobs-questions.json"), "utf8")).jobs ?? []
  } catch {
    jobs = []
  }
  const rules = turn.answers ?? []
  const answers = jobs.flatMap((job) =>
    (job.questions ?? []).map((question) => {
      const rule = rules.find((entry) => (entry.job === undefined || entry.job === job.job) && (entry.match === undefined || String(question.question).includes(entry.match)))
      return { question_id: question.question_id, answer: rule?.answer ?? "pass", evidence: rule?.evidence ?? [], note: rule?.note ?? "Read the code: it does what the question asks." }
    })
  )
  let summary = turn.summary ?? "Answered every question."
  if (!turn.blind) {
    try {
      summary = `read-check: ${readFileSync(join(cwd, ".infinite", "review", "read-check.txt"), "utf8").trim()} ${summary}`
    } catch {
      // no read-check file: the answer says nothing about it
    }
  }
  return { summary, answers }
}
