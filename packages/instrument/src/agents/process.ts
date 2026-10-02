// Agent child processes (§3f.3, §3f.4): each agent runs in its OWN process group (detached), so one
// signal reaches the agent and everything it spawned (its MCP proxy, a Codex sandbox helper, a shell).
// Output is streamed line by line; a wall-clock timer ends a run that overstays; a kill is SIGTERM to the
// group, then SIGKILL after 1 s. When the leader exits, the group is swept the same way, so no straggler
// outlives its turn. The registry answers `isAgentAlive()` (the engine invariant, §3a.9.4) and `killAll()`
// (SIGINT, out of usage, abort).
import { spawn, type ChildProcess } from "node:child_process"

import { AGENT_LIMITS } from "../wizard/contracts/agents.js"

/** Longest stdout/stderr line kept (stream-json lines carry tool results, which can be whole files). */
export const MAX_AGENT_LINE_BYTES = 16 * 1024 * 1024

export interface AgentProcessOptions {
  command: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  /** Written to stdin, which is then closed. */
  stdin?: string
  /** Wall-clock limit; on expiry the group is killed and `timedOut` is set. */
  wallMs?: number
  killGraceMs?: number
  onStdoutLine?(line: string): void
  onStderrLine?(line: string): void
}

export interface AgentProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  /** Ended by `kill()` (including the timer). */
  killed: boolean
  spawnError: Error | null
}

export class AgentProcess {
  readonly done: Promise<AgentProcessExit>
  private readonly child: ChildProcess
  private exited = false
  private killed = false
  private timedOut = false
  private timer: NodeJS.Timeout | null = null
  private killing: Promise<void> | null = null
  private readonly grace: number

  constructor(private readonly options: AgentProcessOptions) {
    this.grace = options.killGraceMs ?? AGENT_LIMITS.killGraceMs
    this.child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    })
    this.done = new Promise<AgentProcessExit>((resolveDone) => {
      let spawnError: Error | null = null
      let exitCode: number | null = null
      let exitSignal: NodeJS.Signals | null = null
      let closed = false
      const finish = () => {
        if (this.timer) clearTimeout(this.timer)
        resolveDone({ code: exitCode, signal: exitSignal, timedOut: this.timedOut, killed: this.killed, spawnError })
      }
      this.child.on("error", (error) => {
        spawnError = error
        if (this.child.pid === undefined) {
          this.exited = true
          finish()
        }
      })
      this.child.on("exit", (code, signal) => {
        exitCode = code
        exitSignal = signal
        this.exited = true
        // Sweep the group: anything the agent left behind (its MCP proxy, a helper) dies with the turn.
        this.signalGroup("SIGTERM")
        const sweep = setTimeout(() => {
          this.signalGroup("SIGKILL")
          if (!closed) finish()
        }, this.grace)
        sweep.unref()
        if (closed) {
          clearTimeout(sweep)
          finish()
        } else {
          this.child.once("close", () => {
            clearTimeout(sweep)
            finish()
          })
        }
      })
      this.child.on("close", () => {
        closed = true
      })
    })
    pipeLines(this.child.stdout, options.onStdoutLine)
    pipeLines(this.child.stderr, options.onStderrLine)
    this.child.stdin?.on("error", () => {
      // EPIPE when the agent exits before reading its prompt; the exit tells the story.
    })
    if (this.child.pid !== undefined) {
      this.child.stdin?.end(options.stdin ?? "")
      if (options.wallMs !== undefined && options.wallMs > 0) {
        this.timer = setTimeout(() => {
          this.timedOut = true
          void this.kill()
        }, options.wallMs)
        this.timer.unref()
      }
    }
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get alive(): boolean {
    return this.child.pid !== undefined && !this.exited
  }

  /** SIGTERM to the process group, then SIGKILL after the grace period. Resolves once the leader exited. */
  kill(): Promise<void> {
    if (this.killing) return this.killing
    this.killed = true
    this.killing = (async () => {
      if (!this.alive) return
      this.signalGroup("SIGTERM")
      const hard = setTimeout(() => this.signalGroup("SIGKILL"), this.grace)
      hard.unref()
      await this.done
      clearTimeout(hard)
    })()
    return this.killing
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, signal)
    } catch {
      // ESRCH: the group is already gone.
    }
  }
}

function pipeLines(stream: NodeJS.ReadableStream | null, onLine: ((line: string) => void) | undefined): void {
  if (!stream) return
  let buffer = ""
  let dropping = false
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!dropping) deliver(line)
      dropping = false
      newline = buffer.indexOf("\n")
    }
    if (buffer.length > MAX_AGENT_LINE_BYTES) {
      buffer = ""
      dropping = true
    }
  })
  stream.on("end", () => {
    if (buffer !== "" && !dropping) deliver(buffer)
    buffer = ""
  })
  function deliver(line: string): void {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line
    if (trimmed === "" || !onLine) return
    try {
      onLine(trimmed)
    } catch {
      // A consumer bug must not wedge the stream.
    }
  }
}

/** Every agent child of this run (the engine invariant reads it). */
export class AgentProcessRegistry {
  private readonly live = new Set<AgentProcess>()

  spawn(options: AgentProcessOptions): AgentProcess {
    const child = new AgentProcess(options)
    if (child.pid !== undefined) {
      this.live.add(child)
      void child.done.then(() => this.live.delete(child))
    }
    return child
  }

  /** True while any agent child of this run is running. */
  isAlive(): boolean {
    for (const child of this.live) if (child.alive) return true
    return false
  }

  async killAll(): Promise<void> {
    await Promise.all([...this.live].map((child) => child.kill()))
  }
}

/** Runs a short probe (`--version`, `auth status`) to completion. Never a prompt. */
export async function runProbe(input: {
  command: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  timeoutMs?: number
}): Promise<{ code: number | null; stdout: string; stderr: string; spawnError: Error | null; timedOut: boolean }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const child = new AgentProcess({
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    wallMs: input.timeoutMs ?? 15_000,
    onStdoutLine: (line) => stdout.push(line),
    onStderrLine: (line) => stderr.push(line)
  })
  const exit = await child.done
  return { code: exit.code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), spawnError: exit.spawnError, timedOut: exit.timedOut }
}
