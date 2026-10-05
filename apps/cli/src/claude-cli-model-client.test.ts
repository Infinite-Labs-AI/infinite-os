import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createClaudeCliModelClient,
  claudeCliReadiness,
  claudeCliArgs
} from "./claude-cli-model-client.js";
import { writeTerminalModelSelection } from "@infinite-os/config";
import { readSetupReadiness } from "./index.js";
const dirs: string[] = [];
afterEach(() =>
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
);
function fixture(signedIn = true) {
  const dir = mkdtempSync(join(tmpdir(), "claude-subscription-"));
  dirs.push(dir);
  const binary = join(dir, "claude");
  const evidence = join(dir, "evidence.json");
  const authEvidence = join(dir, "auth-evidence.json");
  writeFileSync(
    binary,
    `#!/usr/bin/env node\n(async()=>{const fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='--version'){console.log('2.1.287');return;}if(args[0]==='auth'){fs.writeFileSync(${JSON.stringify(authEvidence)},JSON.stringify(process.env));console.log(JSON.stringify({loggedIn:${signedIn} && process.env.USER==='fixture-user',authMethod:${signedIn ? "'claude.ai'" : "'none'"},apiProvider:'firstParty',apiKeySource:'none'}));return;}let prompt='';for await(const c of process.stdin)prompt+=c;const path=args[args.indexOf('--mcp-config')+1];const config=JSON.parse(fs.readFileSync(path));const server=config.mcpServers.infinite_engine;const call=async(id,method,params)=>fetch(server.url,{method:'POST',headers:{...server.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})}).then(r=>r.json());await call(1,'initialize',{});const list=await call(2,'tools/list',{});const result=await call(3,'tools/call',{name:'list_metrics',arguments:{}});await call(3,'tools/call',{name:'list_metrics',arguments:{}});fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({args,env:Object.keys(process.env),tools:list.result.tools,result,mode:fs.statSync(path).mode&511}));console.log(JSON.stringify({type:'result',result:'Fixture answer',usage:{input_tokens:2,output_tokens:4}}));})().catch(()=>process.exit(1));`
  );
  chmodSync(binary, 0o700);
  return {
    dir,
    binary,
    evidence,
    authEvidence,
    env: {
      HOME: dir,
      USER: "fixture-user",
      LOGNAME: "fixture-login",
      ANTHROPIC_API_KEY: "fixture-not-forwarded",
      ANTHROPIC_AUTH_TOKEN: "fixture-not-forwarded",
      CLAUDE_CONFIG_DIR: join(dir, "user-config"),
      PATH: process.env.PATH!,
      GROWTH_OS_CLAUDE_BIN: binary,
      UNTRUSTED_SECRET: "do-not-forward"
    }
  };
}
it("uses subscription CLI and exact model/effort, exposes only controller tools, and deduplicates calls", async () => {
  const f = fixture();
  expect(await claudeCliReadiness(f.env)).toMatchObject({ ready: true });
  const executeTools = vi.fn(async (calls) =>
    calls.map((call: { id: string; name: string }) => ({
      id: call.id,
      name: call.name,
      result: { status: "ok", data: { metrics: [] } }
    }))
  );
  const client = createClaudeCliModelClient({
    env: f.env,
    cwd: f.dir,
    selection: { provider: "claude", model: "claude-opus-5-5", effort: "high" }
  });
  const response = await client.complete({
    systemPrompt: "s",
    userMessage: "u",
    tools: [
      {
        name: "list_metrics",
        title: "Metrics",
        summary: "List",
        authority: "tool_agent",
        inputSchema: { type: "object" }
      }
    ],
    toolResults: [],
    executeTools
  });
  expect(response).toMatchObject({
    message: "Fixture answer",
    usage: { promptTokens: 2, completionTokens: 4 }
  });
  expect(executeTools).toHaveBeenCalledTimes(1);
  const evidence = JSON.parse(readFileSync(f.evidence, "utf8"));
  expect(evidence.args).toEqual(
    expect.arrayContaining([
      "--model",
      "claude-opus-5-5",
      "--effort",
      "high",
      "--strict-mcp-config",
      "--restricted"
    ])
  );
  expect(evidence.env).not.toContain("UNTRUSTED_SECRET");
  expect(evidence.env).toEqual(expect.arrayContaining(["USER", "LOGNAME"]));
  expect(evidence.env).not.toContain("ANTHROPIC_API_KEY");
  expect(evidence.env).toContain("CLAUDE_CONFIG_DIR");
  expect(evidence.env.some((key: string) => key.startsWith("ANTHROPIC_"))).toBe(false);
  const authEnv = JSON.parse(readFileSync(f.authEvidence, "utf8"));
  expect(authEnv).toMatchObject({ USER: "fixture-user", LOGNAME: "fixture-login" });
  expect(authEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(authEnv.CLAUDE_CONFIG_DIR).toBe(f.env.CLAUDE_CONFIG_DIR);
  expect(Object.keys(authEnv).some(key => key.startsWith("ANTHROPIC_"))).toBe(false);
  expect(evidence.mode).toBe(0o600);
  expect(evidence.tools.map((t: { name: string }) => t.name)).toEqual([
    "list_metrics"
  ]);
  client.close();
});
it("Default omits --effort and signed-out users receive subscription login guidance", async () => {
  const f = fixture(false);
  expect(await claudeCliReadiness(f.env)).toMatchObject({
    ready: false,
    detail: expect.stringContaining("claude auth login")
  });
  const client = createClaudeCliModelClient({
    env: f.env,
    cwd: f.dir,
    selection: { provider: "claude", model: "claude-opus-5-5" }
  });
  await expect(
    client.complete({
      systemPrompt: "s",
      userMessage: "u",
      tools: [],
      toolResults: []
    })
  ).rejects.toThrow("claude auth login");
  client.close();
});

it("Default omits the flag, and confirmation stops the native tool loop", async () => {
  expect(
    claudeCliArgs(
      "fixture.json",
      { provider: "claude", model: "claude-opus-5-5" },
      "s"
    )
  ).not.toContain("--effort");
  const f = fixture();
  const client = createClaudeCliModelClient({
    env: f.env,
    cwd: f.dir,
    selection: { provider: "claude", model: "claude-opus-5-5" }
  });
  const executeTools = vi.fn(async (calls) =>
    calls.map((call: { id: string; name: string }) => ({
      id: call.id,
      name: call.name,
      result: {
        status: "requires_confirmation",
        actionId: call.name,
        input: {},
        confirmationId: "test-confirm"
      }
    }))
  );
  const result = await client.complete({
    systemPrompt: "s",
    userMessage: "u",
    tools: [
      {
        name: "list_metrics",
        title: "Metrics",
        summary: "List",
        authority: "tool_agent",
        inputSchema: { type: "object" }
      }
    ],
    toolResults: [],
    executeTools
  });
  expect(result.message).toContain("requires confirmation");
  expect(executeTools).toHaveBeenCalledTimes(1);
  client.close();
});

it("renders signed-out subscription guidance with one final period", async () => {
  const f = fixture(false);
  const env = { ...f.env, GROWTH_OS_HOME: f.dir, GROWTH_OS_WORKSPACE_ROOT: f.dir };
  writeTerminalModelSelection({ provider: "claude", model: "claude-opus-5-5", effort: "medium" }, env);
  const readiness = await readSetupReadiness(env, true);
  expect(readiness.blockingReasons).toContain("model_auth_incomplete: claude auth is not ready: Run claude auth login and sign in with your Claude subscription.");
});

it("does not invent a Claude config directory when the user has not set one", async () => {
  const f = fixture();
  const { CLAUDE_CONFIG_DIR: _configDir, ...env } = f.env;
  expect(await claudeCliReadiness(env)).toEqual({ ready: true });
  expect(JSON.parse(readFileSync(f.authEvidence, "utf8"))).not.toHaveProperty("CLAUDE_CONFIG_DIR");
});
