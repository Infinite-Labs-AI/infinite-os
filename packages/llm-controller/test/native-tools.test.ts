import { expect, it, vi } from "vitest";
import { createEnvelope, createInfiniteOsRegistry } from "@infinite-os/runtime";
import { createLlmController, type ModelRequest } from "../src/index.js";
const input = {
  message: "List metrics",
  sessionId: "test-session",
  workspaceId: "test-workspace",
  actorId: "test-actor",
  surface: "cli" as const,
  progressMode: "rich" as const
};
it("native tool callback uses the same execution, progress, provenance and action recording", async () => {
  const action = vi.fn((_args, context) =>
    createEnvelope({
      actionId: "list_metrics",
      authority: context.authority,
      data: { metrics: [] },
      provenance: ["test-metrics"]
    })
  );
  const registry = createInfiniteOsRegistry({ list_metrics: action });
  const events: unknown[] = [];
  const controller = createLlmController({
    registry,
    modelClient: {
      nativeToolExecution: true,
      complete: async (request) => {
        expect(request.executeTools).toBeTypeOf("function");
        const results = await request.executeTools!([
          { id: "native-call", name: "list_metrics", input: {} }
        ]);
        expect(results[0]?.name).toBe("list_metrics");
        return { message: "Done" };
      }
    }
  });
  const result = await controller.chat({
    ...input,
    onProgress: (event) => {
      events.push(event);
    }
  });
  expect(action).toHaveBeenCalledTimes(1);
  expect(result.actionCalls).toHaveLength(1);
  expect(result.provenance).toContain("test-metrics");
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "tool.start" }),
      expect.objectContaining({ type: "tool.complete" })
    ])
  );
});
it("without native opt-in the request shape and ordinary tool loop remain unchanged", async () => {
  const requests: ModelRequest[] = [];
  const registry = createInfiniteOsRegistry({
    list_metrics: (_args, ctx) =>
      createEnvelope({
        actionId: "list_metrics",
        authority: ctx.authority,
        data: {},
        provenance: []
      })
  });
  const controller = createLlmController({
    registry,
    modelClient: {
      complete: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? {
              toolCalls: [
                { id: "regular-call", name: "list_metrics", input: {} }
              ]
            }
          : { message: "Done" };
      }
    }
  });
  const result = await controller.chat(input);
  expect(result.actionCalls).toHaveLength(1);
  for (const request of requests)
    expect(request).not.toHaveProperty("executeTools");
});

it("native tool proposals stop further execution and use the existing confirmation response", async () => {
  const callTool = vi.fn(async () => ({
    requiresConfirmation: true,
    confirmationId: "test-confirm",
    kind: "ads.local_tool.action_proposal",
    proposal: { actionHash: "a".repeat(64), actionType: "pause_ad" }
  }));
  const controller = createLlmController({
    registry: createInfiniteOsRegistry(),
    modelClient: {
      nativeToolExecution: true,
      complete: async (request) => {
        await request.executeTools!([
          {
            id: "proposal",
            name: "mcp__infinite_app__ads_call_tool",
            input: {}
          }
        ]);
        await expect(
          request.executeTools!([
            {
              id: "second",
              name: "mcp__infinite_app__ads_call_tool",
              input: {}
            }
          ])
        ).rejects.toThrow("confirmation");
        return { message: "Done" };
      }
    }
  });
  const result = await controller.chat({
    ...input,
    scopedAppTools: {
      serverName: "infinite_app",
      allowedTools: ["mcp__infinite_app__ads_*"],
      tools: [
        {
          name: "ads_call_tool",
          description: "Prepare",
          inputSchema: { type: "object" }
        }
      ],
      callTool
    }
  });
  expect(result.message).toContain("requires confirmation");
  expect(result.actionCalls[0]?.requiresConfirmation).toBe(true);
  expect(callTool).toHaveBeenCalledTimes(1);
});
