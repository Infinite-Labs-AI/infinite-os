import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type {
  InfiniteOsModelClient,
  ModelRequest,
  ModelUsage
} from "@infinite-os/llm-controller";
import {
  readTerminalModelFile,
  type TerminalModelSelection
} from "@infinite-os/config";

// Same subscription detection and process-group conventions as instrument's agents/detect.ts,
// agents/process.ts and Desktop's claude-code.ts. No account fields are retained or logged.
function subscriptionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "SHELL",
    "CLAUDE_CONFIG_DIR",
    "XDG_CONFIG_HOME"
  ]) {
    if (env[key]) clean[key] = env[key];
  }
  clean.HOME ??= homedir();
  return clean;
}
interface ProcessOptions {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void | Promise<void>;
}
async function runProcess(
  options: ProcessOptions
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.binary, options.args, {
      env: subscriptionEnv(options.env),
      cwd: options.cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let output = "",
      pending = "",
      done = false;
    let lines = Promise.resolve();
    let reason: Error | undefined;
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* already exited */
        }
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* already exited */
          }
        }, 1000);
        timer.unref();
      }
    };
    const abort = () => {
      reason = new Error("Claude turn cancelled.");
      kill();
    };
    const timer = setTimeout(() => {
      reason = new Error("Claude CLI timed out.");
      kill();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    const finish = (code: number | null, error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      kill();
      if (pending.trim()) lines = lines.then(() => options.onLine?.(pending));
      void lines.then(
        () =>
          reason || error ? reject(reason ?? error) : resolve({ code, output }),
        reject
      );
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      if (reason) return;
      output += text;
      if (output.length > 16_000_000) {
        reason = new Error("Claude output exceeded the turn limit.");
        kill();
        return;
      }
      pending += text;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        lines = lines
          .then(() => options.onLine?.(line))
          .catch((error) => {
            reason =
              error instanceof Error
                ? error
                : new Error("Claude stream failed.");
            kill();
          });
      }
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
    if (options.signal?.aborted) abort();
  });
}
export async function claudeCliReadiness(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ ready: boolean; detail?: string }> {
  const binary = env.GROWTH_OS_CLAUDE_BIN ?? "claude";
  try {
    const version = await runProcess({
      binary,
      args: ["--version"],
      env,
      timeoutMs: 5000
    });
    if (version.code !== 0)
      return {
        ready: false,
        detail: "Install or update Claude Code, then run claude auth login."
      };
    const auth = await runProcess({
      binary,
      args: ["auth", "status", "--json"],
      env,
      timeoutMs: 5000
    });
    const value = JSON.parse(auth.output) as Record<string, unknown>;
    const ready =
      auth.code === 0 &&
      value.loggedIn !== false &&
      value.authMethod === "claude.ai" &&
      value.apiProvider === "firstParty" &&
      (!value.apiKeySource || value.apiKeySource === "none");
    return ready
      ? { ready: true }
      : {
          ready: false,
          detail:
            "Run claude auth login and sign in with your Claude subscription."
        };
  } catch {
    return {
      ready: false,
      detail:
        "Install Claude Code and run claude auth login with your Claude subscription."
    };
  }
}
/** Only an explicit file choice selects this client; the environment pair still wins. */
export function terminalClaudeSelection(
  env: NodeJS.ProcessEnv
): TerminalModelSelection | undefined {
  if (
    (env.GROWTH_OS_MODEL_PROVIDER === "codex" ||
      env.GROWTH_OS_MODEL_PROVIDER === "claude") &&
    env.GROWTH_OS_MODEL_NAME
  )
    return undefined;
  const selection = readTerminalModelFile(env);
  return selection?.provider === "claude" ? selection : undefined;
}
export function claudeCliArgs(
  config: string,
  selection: TerminalModelSelection,
  systemPrompt: string
): string[] {
  return [
    "-p",
    "--model",
    selection.model,
    ...(selection.effort ? ["--effort", selection.effort] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--restricted",
    "--max-turns",
    "16",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--mcp-config",
    config,
    "--allowedTools",
    "mcp__infinite_engine__*",
    "--append-system-prompt",
    systemPrompt,
    "--no-session-persistence",
    "--disable-slash-commands",
    "--no-chrome"
  ];
}
export function createClaudeCliModelClient(options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  selection: TerminalModelSelection;
  timeoutMs?: number;
}): InfiniteOsModelClient & { close(): void } {
  const cancellation = new AbortController();
  return {
    nativeToolExecution: true,
    modelMetadata: () => ({
      provider: "claude",
      model: options.selection.model,
      authSource: "claude-cli-subscription"
    }),
    close: () => cancellation.abort(),
    async complete(request: ModelRequest) {
      const ready = await claudeCliReadiness(options.env);
      if (!ready.ready) throw new Error(ready.detail);
      if (
        request.tools.length &&
        request.toolChoice !== "none" &&
        !request.executeTools
      )
        throw new Error("Claude engine tool execution is unavailable.");
      const tools = request.toolChoice === "none" ? [] : request.tools;
      const token = randomBytes(32).toString("hex");
      const replay = new Map<
        string,
        { body: string; result: Promise<unknown> }
      >();
      let serial = Promise.resolve();
      let confirmationPending = false;
      const confirmationStop = new AbortController();
      const server = createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/mcp") {
          res.writeHead(405).end();
          return;
        }
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401).end();
          return;
        }
        let body = "";
        try {
          for await (const chunk of req) {
            body += String(chunk);
            if (body.length > 1_048_576) {
              res.writeHead(413).end();
              return;
            }
          }
          const rpc = JSON.parse(body) as {
            id?: string | number;
            method?: string;
            params?: Record<string, unknown>;
          };
          if (rpc.id === undefined) {
            res.writeHead(202).end();
            return;
          }
          let result: unknown;
          if (rpc.method === "initialize")
            result = {
              protocolVersion: rpc.params?.protocolVersion ?? "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "infinite-engine", version: "1" }
            };
          else if (rpc.method === "ping") result = {};
          else if (rpc.method === "tools/list")
            result = {
              tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.summary,
                inputSchema: tool.inputSchema
              }))
            };
          else if (rpc.method === "tools/call") {
            const name = rpc.params?.name;
            if (
              typeof name !== "string" ||
              !tools.some((tool) => tool.name === name) ||
              !request.executeTools
            )
              throw new Error("Tool is not available for this turn.");
            const key = `${typeof rpc.id}:${rpc.id}`;
            const previous = replay.get(key);
            if (previous && previous.body !== body)
              throw new Error("Tool request identity was reused.");
            if (previous) result = await previous.result;
            else {
              if (replay.size >= 64)
                throw new Error("Tool call limit reached.");
              const operation = serial.then(async () => {
                const results = await request.executeTools!([
                  {
                    id: `claude-${randomUUID()}`,
                    name,
                    input: rpc.params?.arguments ?? {}
                  }
                ]);
                confirmationPending ||= results.some(
                  (result) => result.result.status === "requires_confirmation"
                );
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(results[0]?.result ?? {})
                    }
                  ],
                  ...(results[0]?.result.status === "error"
                    ? { isError: true }
                    : {})
                };
              });
              replay.set(key, { body, result: operation });
              serial = operation.then(
                () => {},
                () => {}
              );
              result = await operation;
            }
          } else throw new Error("Unsupported MCP method.");
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
          if (confirmationPending)
            setTimeout(() => confirmationStop.abort(), 0);
        } catch (error) {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: (() => {
                try {
                  return JSON.parse(body).id ?? null;
                } catch {
                  return null;
                }
              })(),
              error: {
                code: -32602,
                message:
                  error instanceof Error ? error.message : "Tool call failed."
              }
            })
          );
        }
      });
      const dir = mkdtempSync(join(tmpdir(), "infinite-claude-"));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve());
        });
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Could not start the engine tool bridge.");
        const config = join(dir, "mcp.json");
        writeFileSync(
          config,
          JSON.stringify({
            mcpServers: {
              infinite_engine: {
                type: "http",
                url: `http://127.0.0.1:${address.port}/mcp`,
                headers: { Authorization: `Bearer ${token}` }
              }
            }
          }),
          { mode: 0o600 }
        );
        let message = "";
        let usage: ModelUsage | undefined;
        let failed = false;
        const result = await runProcess({
          binary: options.env.GROWTH_OS_CLAUDE_BIN ?? "claude",
          args: claudeCliArgs(config, options.selection, request.systemPrompt),
          env: options.env,
          cwd: options.cwd,
          input: request.toolResults.length
            ? `${request.userMessage}\n\nTool results:\n${JSON.stringify(request.toolResults)}`
            : request.userMessage,
          timeoutMs: options.timeoutMs ?? 180_000,
          signal: AbortSignal.any([
            cancellation.signal,
            confirmationStop.signal
          ]),
          onLine: async (line) => {
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(line);
            } catch {
              return;
            }
            if (
              event.type === "system" &&
              event.subtype === "init" &&
              typeof event.model === "string" &&
              event.model !== options.selection.model
            )
              throw new Error(
                "Claude CLI selected a different model. Choose /model again."
              );
            if (event.type === "assistant") {
              const content = (
                event.message as
                  | { content?: Array<{ type: string; text?: string }> }
                  | undefined
              )?.content;
              for (const block of content ?? [])
                if (block.type === "text" && block.text) {
                  message = block.text;
                  await request.onMessageDelta?.(block.text);
                }
            }
            if (event.type === "result") {
              failed = event.is_error === true;
              if (typeof event.result === "string") message = event.result;
              const u = event.usage as Record<string, unknown> | undefined;
              if (u)
                usage = {
                  ...(typeof u.input_tokens === "number"
                    ? { promptTokens: u.input_tokens }
                    : {}),
                  ...(typeof u.output_tokens === "number"
                    ? { completionTokens: u.output_tokens }
                    : {}),
                  ...(typeof u.cache_read_input_tokens === "number"
                    ? { cacheReadTokens: u.cache_read_input_tokens }
                    : {}),
                  ...(typeof u.cache_creation_input_tokens === "number"
                    ? { cacheCreationTokens: u.cache_creation_input_tokens }
                    : {})
                };
            }
          }
        }).catch((error) => {
          if (confirmationPending) return { code: 0, output: "" };
          throw error;
        });
        await serial;
        if (confirmationPending)
          return {
            message:
              "This request includes an operator action that requires confirmation before execution.",
            ...(usage ? { usage } : {})
          };
        if (result.code !== 0 || failed)
          throw new Error(
            "Claude CLI could not finish the turn. Check your Claude subscription login and try again."
          );
        if (!message) throw new Error("Claude CLI returned no answer.");
        return { message, ...(usage ? { usage } : {}) };
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
    }
  };
}
