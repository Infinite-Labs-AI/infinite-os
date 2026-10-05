import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  resolveTerminalModelSelection,
  writeInfiniteOsAuthRecord,
  writeInfiniteOsModelSelection,
  writeTerminalModelSelection
} from "@infinite-os/config";
import { createConfiguredModelClient } from "../src/model-client.js";
const dirs: string[] = [];
afterEach(() =>
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "terminal-client-"));
  dirs.push(dir);
  const env = { HOME: dir, GROWTH_OS_HOME: dir };
  writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.5" }, env);
  writeInfiniteOsAuthRecord(
    {
      provider: "codex",
      source: "test",
      authMode: "test",
      token: "test-token"
    },
    env
  );
  const bodies: any[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ output: [], content: [] }));
  };
  return { env, bodies, fetch };
}
const request = {
  systemPrompt: "s",
  userMessage: "u",
  tools: [],
  toolResults: []
};
it("terminal selection changes requests while a daemon-style client ignores the terminal file", async () => {
  const f = fixture();
  writeTerminalModelSelection(
    { provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
    f.env
  );
  const terminal = createConfiguredModelClient({
    ...f,
    selection: () => resolveTerminalModelSelection(f.env).selection
  });
  await terminal.complete(request);
  expect(f.bodies[0]).toMatchObject({
    model: "gpt-6.1-sol",
    reasoning: { effort: "xhigh" }
  });
  await createConfiguredModelClient(f).complete(request);
  expect(f.bodies[1].model).toBe("gpt-5.5");
  expect(f.bodies[1]).not.toHaveProperty("reasoning");
  writeTerminalModelSelection({ provider: "codex", model: "gpt-5.4" }, f.env);
  await terminal.complete(request);
  expect(f.bodies[2].model).toBe("gpt-5.4");
  expect(f.bodies[2]).not.toHaveProperty("reasoning");
});
it("explicit turn override wins over env and terminal selection", async () => {
  const f = fixture();
  const env = {
    ...f.env,
    GROWTH_OS_MODEL_PROVIDER: "codex",
    GROWTH_OS_MODEL_NAME: "gpt-5.4"
  };
  const client = createConfiguredModelClient({
    ...f,
    env,
    selection: { provider: "claude", model: "claude-opus-5-5", effort: "max" }
  });
  await client.complete(request);
  expect(f.bodies[0].model).toBe("gpt-5.4");
  expect(f.bodies[0]).not.toHaveProperty("output_config");
  await client.complete({
    ...request,
    model: { modelId: "gpt-5.5", effort: "low" }
  });
  expect(f.bodies[1]).toMatchObject({
    model: "gpt-5.5",
    reasoning: { effort: "low" }
  });
});

it("without a terminal file a shared Claude default has identical request bytes", async () => {
  const f = fixture();
  writeInfiniteOsModelSelection(
    { provider: "claude", model: "claude-sonnet-4-6" },
    f.env
  );
  const env = { ...f.env, ANTHROPIC_TOKEN: "fixture-bearer" };
  const calls: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    calls.push(init);
    return new Response(JSON.stringify({ content: [] }));
  };
  await createConfiguredModelClient({ env, fetch }).complete(request);
  await createConfiguredModelClient({
    env,
    fetch,
    selection: resolveTerminalModelSelection(env).selection
  }).complete(request);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
});
