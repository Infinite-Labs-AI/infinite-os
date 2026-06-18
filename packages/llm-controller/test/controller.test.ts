import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readInfiniteOsAuthState, writeInfiniteOsAuthRecord, writeInfiniteOsModelSelection } from "@infinite-os/config";
import { createEnvelope, createInfiniteOsRegistry } from "@infinite-os/runtime";
import {
  createModelBackedMemoryReviewer,
  createCuratedMemoryManager,
  createLlmController,
  filterCuratedMemoryCandidates,
  type ChatProgressEvent,
  type ModelRequest
} from "../src/index.js";
import { createConfiguredModelClient } from "../src/model-client.js";
import { createSessionStore, type ChatSessionStore } from "../src/session-store.js";

function mkCodexHome(tokens: Record<string, string>): string {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens }));
  return codexHome;
}

describe("Infinite OS LLM controller", () => {
  it("executes model-selected read actions and synthesizes an answer with provenance", async () => {
    const registry = createInfiniteOsRegistry({
      list_metrics: (_input, context) =>
        createEnvelope({
          actionId: "list_metrics",
          authority: context.authority,
          data: { metrics: [{ id: "recognized_revenue" }] },
          provenance: ["metric_definitions"],
          nextActions: ["run_metric_query"]
        })
    });
    const prompts: unknown[] = [];
    const controller = createLlmController({
      registry,
      now: () => new Date("2026-06-07T12:00:00.000Z"),
      modelClient: {
        complete: async (request) => {
          prompts.push(request);
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [{ id: "call_1", name: "list_metrics", input: {} }]
            };
          }
          return {
            message: "Recognized revenue is available as a first-phase metric."
          };
        }
      }
    });

    const result = await controller.chat({
      message: "What metrics are available?",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result).toMatchObject({
      ok: true,
      sessionId: "session-1",
      message: "Recognized revenue is available as a first-phase metric.",
      provenance: ["metric_definitions"]
    });
    expect(result.actionCalls).toHaveLength(1);
    expect(result.actionCalls[0]).toMatchObject({
      id: "call_1",
      actionId: "list_metrics",
      status: "ok",
      requiresConfirmation: false
    });
    const systemPrompt = (prompts[0] as { systemPrompt: string }).systemPrompt;
    expect(systemPrompt).toContain("recognized_revenue");
    expect(systemPrompt).toContain("Current date: 2026-06-07");
    expect(systemPrompt).toContain("Resolve relative date phrases against this date");
    expect(systemPrompt).toContain("queryable.vw_revenue_by_source");
    expect(systemPrompt).toContain("list_metrics");
    expect(systemPrompt).toContain("run_metric_query");
    expect(systemPrompt).toContain("Do not expose raw SQL");
    expect(systemPrompt).toContain("Do not expose credentials");
    expect(systemPrompt).toContain("Prefer a concise analyst voice over tool narration");
    expect(systemPrompt).toContain("lead with the winner, mention runner-ups");
    expect(systemPrompt).toContain("Do not repeat raw action IDs");
    expect(systemPrompt).toContain("If the first tool result is too thin");
    expect(systemPrompt).toContain("strongest takeaway first");
    expect(systemPrompt).toContain("why it matters");
    expect(systemPrompt).toContain("one scalar result or one lonely ranked row");
    expect(systemPrompt).toContain("do not stop at inventory-only results");
    expect(systemPrompt).toContain("source lists, sync lists, metric lists, or view lists");
    expect(systemPrompt).toContain("combine three things before answering strongly");
    expect(systemPrompt).toContain("what is connected, whether it looks current/fresh, and at least one concrete analytical signal");
    expect(systemPrompt).toContain("use the journey flow before answering");
    expect(systemPrompt).toContain("which campaign, channel, content, event, or behavior drove");
    expect(systemPrompt).toContain("Do not answer a path/downstream question after only listing sources");
    expect(systemPrompt).toContain("run validate_journey_plan and run_journey_query before the final answer");
    expect(systemPrompt).toContain("Use metric and breakdown queries directly for single-source scalar totals");
    expect(systemPrompt).toContain("carry that period into your tool calls");
    expect(systemPrompt).toContain("short follow-up");
    expect(systemPrompt).toContain("resolving that clarification");
    expect(systemPrompt).toContain("Keep clarification questions brief");
    expect(systemPrompt).toContain("name the likely options directly");
    expect(systemPrompt).toContain("one or two concrete next questions");
    expect(systemPrompt).toContain("Use recalled session context and turn-resolution context");
    const toolNames = (prompts[0] as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(toolNames).not.toContain("terminal");
    expect(toolNames).not.toContain("read_file");
    expect(toolNames).not.toContain("web_search");
    expect(toolNames).not.toContain("execute_sql");
  });

  it("emits Hermes-compatible tool lifecycle progress with exact durations", async () => {
    let clockMs = 1_000;
    const events: ChatProgressEvent[] = [];
    const registry = createInfiniteOsRegistry({
      run_metric_query: (_input, context) => {
        clockMs = 2_750;
        return createEnvelope({
          actionId: "run_metric_query",
          authority: context.authority,
          data: {
            metric: "recognized_revenue",
            rows: [{ value: 123 }],
            view: "queryable.vw_revenue_by_source"
          },
          provenance: ["queryable.vw_revenue_by_source"],
          freshness: { target: "24 hours", asOf: null, stale: false },
          caveats: ["sampled_provider_data"],
          truncated: true,
          nextActions: ["explain_answer", "drilldown_result"]
        });
      }
    });
    const controller = createLlmController({
      registry,
      now: () => new Date(clockMs),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                {
                  id: "call_1",
                  name: "run_metric_query",
                  input: {
                    metric: "recognized_revenue",
                    view: "queryable.vw_revenue_by_source"
                  }
                }
              ]
            };
          }
          return { message: "Recognized revenue is available." };
        }
      }
    });

    await controller.chat({
      message: "What metrics are available?",
      sessionId: "session-hermes-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      progressMode: "rich",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({
      type: "tool.generating",
      stage: "tool",
      message: "Drafting run_metric_query.",
      name: "run_metric_query"
    });
    expect(events).toContainEqual({
      type: "tool.start",
      stage: "tool",
      message: "Running revenue total lookup.",
      toolId: "call_1",
      name: "run_metric_query",
      context: "Running revenue total lookup."
    });
    expect(events).toContainEqual({
      type: "tool.progress",
      stage: "tool",
      message: "metric=recognized_revenue, view=queryable.vw_revenue_by_source",
      toolId: "call_1",
      name: "run_metric_query",
      preview: "metric=recognized_revenue, view=queryable.vw_revenue_by_source"
    });
    expect(events).toContainEqual({
      type: "tool.complete",
      stage: "tool",
      message: "Finished run_metric_query.",
      toolId: "call_1",
      name: "run_metric_query",
      durationMs: 1750,
      summary: "ok; 1 row; 1 source; 1 caveat; fresh 24 hours; truncated; 2 next",
      status: "ok"
    });
    expect(events.slice(-3)).toEqual([
      {
        type: "message.start",
        stage: "message",
        message: "Assistant message started."
      },
      {
        type: "message.delta",
        stage: "message",
        message: "Recognized revenue is available.",
        text: "Recognized revenue is available."
      },
      {
        type: "message.complete",
        stage: "message",
        message: "Assistant message complete.",
        text: "Recognized revenue is available.",
        usage: {}
      }
    ]);
    expect(events).not.toContainEqual({ stage: "tool", message: "Running revenue total lookup." });
  });

  it("emits provider token deltas without dropping repeated chunks or duplicating the final message", async () => {
    const events: ChatProgressEvent[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      modelClient: {
        complete: async (request) => {
          await request.onMessageDelta?.("ha");
          await request.onMessageDelta?.("ha");
          await request.onMessageDelta?.("!");
          return { message: "haha!" };
        }
      }
    });

    await controller.chat({
      message: "Laugh once.",
      sessionId: "session-hermes-streaming",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      progressMode: "rich",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events.filter((event) => "type" in event && event.type === "message.start")).toHaveLength(1);
    expect(
      events
        .filter((event): event is Extract<ChatProgressEvent, { type: "message.delta" }> => "type" in event && event.type === "message.delta")
        .map((event) => event.text)
    ).toEqual(["ha", "ha", "!"]);
    expect(events.at(-1)).toMatchObject({
      type: "message.complete",
      text: "haha!"
    });
  });

  it("continues through multiple read-action rounds before synthesizing", async () => {
    const registry = createInfiniteOsRegistry({
      list_metrics: (_input, context) =>
        createEnvelope({
          actionId: "list_metrics",
          authority: context.authority,
          data: { metrics: [{ id: "recognized_revenue" }] },
          provenance: ["metric_definitions"],
          nextActions: ["run_metric_query"]
        }),
      run_metric_query: (_input, context) =>
        createEnvelope({
          actionId: "run_metric_query",
          authority: context.authority,
          data: { rows: [{ month: "2026-06", value: 123 }] },
          provenance: ["queryable.vw_revenue_by_source"],
          nextActions: ["explain_answer"]
        })
    });
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry,
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          if (request.toolResults.length === 0) {
            return { toolCalls: [{ id: "call_metrics", name: "list_metrics", input: {} }] };
          }
          if (request.toolResults.length === 1) {
            return {
              toolCalls: [
                {
                  id: "call_revenue",
                  name: "run_metric_query",
                  input: { metricId: "recognized_revenue", viewId: "queryable.vw_revenue_by_source" }
                }
              ]
            };
          }
          return { message: "Recognized revenue was 123 in June 2026." };
        }
      }
    });

    const result = await controller.chat({
      message: "What was revenue in June?",
      sessionId: "session-multi-tool",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Recognized revenue was 123 in June 2026.");
    expect(result.actionCalls.map((call) => call.actionId)).toEqual([
      "list_metrics",
      "run_metric_query"
    ]);
    expect(result.provenance).toEqual([
      "metric_definitions",
      "queryable.vw_revenue_by_source"
    ]);
    expect(requests).toHaveLength(3);
    expect(requests[2]?.toolResults.map((result) => result.name)).toEqual([
      "list_metrics",
      "run_metric_query"
    ]);
  });

  it("allows seven default read-action rounds before synthesizing", async () => {
    const registry = createInfiniteOsRegistry({
      list_metrics: (_input, context) =>
        createEnvelope({
          actionId: "list_metrics",
          authority: context.authority,
          data: { metrics: [{ id: "recognized_revenue" }] },
          provenance: ["metric_definitions"]
        })
    });
    let callCount = 0;
    const controller = createLlmController({
      registry,
      modelClient: {
        complete: async () => {
          callCount += 1;
          if (callCount <= 7) {
            return { toolCalls: [{ id: `call_${callCount}`, name: "list_metrics", input: {} }] };
          }
          return { message: "Finished after seven grounding rounds." };
        }
      }
    });

    const result = await controller.chat({
      message: "Keep grounding until enough evidence is available.",
      sessionId: "session-seven-rounds",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Finished after seven grounding rounds.");
    expect(result.actionCalls).toHaveLength(7);
    expect(callCount).toBe(8);
  });

  it.skip("pre-runs revenue total and answers directly", async () => {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [{ id: "src_stripe", provider: "stripe", status: "connected", connection_name: "Stripe Fixture" }]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [{ id: "sync_1", source_id: "src_stripe", status: "succeeded" }]
            },
            provenance: ["sync_runs"]
          }),
        drilldown_result: (_input, context) =>
          createEnvelope({
            actionId: "drilldown_result",
            authority: context.authority,
            data: {
              rows: [{ amount_paid: "9800", currency: "usd", status: "paid", external_order_id: "ord_123" }],
              metric: "recognized_revenue"
            },
            provenance: ["drilldown.stripe_revenue_provider_rows"]
          }),
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ recognized_revenue: "12000" }],
              metric: "recognized_revenue",
              view: "queryable.vw_revenue_by_source"
            },
            provenance: ["queryable.vw_revenue_by_source"],
            caveats: ["content_linkage_not_implemented"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Fallback model answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "what revenue did we do",
      sessionId: "session-revenue-total",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(0);
    expect(result.message).toContain("Recognized revenue is $120.00.");
    expect(result.message).toContain("Stripe");
    expect(result.message).toContain("Health: This source looks healthy based on its current status and recent syncs.");
    expect(result.message).toContain("Most recent revenue detail includes amount $98.00, status paid, order ord_123.");
    expect(result.message).toContain("which source drove revenue");
  });

  it("routes generic revenue prompts through the model-selected revenue path", async () => {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ recognized_revenue: "12000" }],
              metric: "recognized_revenue",
              view: "queryable.vw_revenue_by_source"
            },
            provenance: ["queryable.vw_revenue_by_source"],
            caveats: ["content_linkage_not_implemented"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          requests.push({
            ...request,
            toolResults: [...request.toolResults],
            tools: [...request.tools]
          });
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                {
                  id: "call_revenue_total",
                  name: "run_metric_query",
                  input: {
                    metric: "recognized_revenue",
                    view: "queryable.vw_revenue_by_source"
                  }
                }
              ]
            };
          }
          return { message: "Recognized revenue is $120.00." };
        }
      }
    });

    const result = await controller.chat({
      message: "tell me about revenue",
      sessionId: "session-generic-revenue",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.toolResults).toHaveLength(0);
    expect(requests[1]?.toolResults.map((result) => result.name)).toEqual(["run_metric_query"]);
    expect(result.message).toBe("Recognized revenue is $120.00.");
  });

  it("asks for a time-period clarification on direct revenue questions without a timeframe", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "how much revenue did we do",
      sessionId: "session-revenue-time-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("Which time period do you want for revenue");
    expect(result.message).toContain("this month");
  });

  it("asks for a time-period clarification on direct visitor questions without a timeframe", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "how many visitors did we get",
      sessionId: "session-visitors-time-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("Which time period do you want for visitors or traffic");
    expect(result.message).toContain("this month");
  });

  it("asks for a time-period clarification on direct signup questions without a timeframe", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "how many signups did we get",
      sessionId: "session-signups-time-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("Which time period do you want for signups");
    expect(result.message).toContain("this month");
  });

  it("asks for a time-period clarification on direct conversion-rate questions without a timeframe", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "what is the conversion rate",
      sessionId: "session-conversion-time-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("Which time period do you want for conversion rate");
    expect(result.message).toContain("this month");
  });

  it("asks for a time-period clarification on broader signup-trend questions without a timeframe", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "how are signups doing",
      sessionId: "session-signups-trend-time-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("Which time period do you want for signups");
  });

  it("asks for a time-period clarification on broader traffic-trend questions without a timeframe", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "how is traffic doing",
      sessionId: "session-traffic-trend-time-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("Which time period do you want for visitors or traffic");
  });

  it("asks for a time-period clarification on traffic breakdown questions without a timeframe", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "which source is driving traffic",
      sessionId: "session-traffic-breakdown-time-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("Which time period do you want for the traffic/source breakdown");
  });

  it("asks for a time-period clarification on revenue breakdown questions without a timeframe", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "which source drove revenue",
      sessionId: "session-revenue-breakdown-time-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("Which time period do you want for the revenue/source breakdown");
  });

  it("asks for a time-period clarification on signup breakdown questions without a timeframe", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "which channel is driving signups",
      sessionId: "session-signup-breakdown-time-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("Which time period do you want for the signup/source breakdown");
  });

  it("asks for a time-period clarification on conversion breakdown questions without a timeframe", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "which channel converts best",
      sessionId: "session-conversion-breakdown-time-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("Which time period do you want for the conversion/source breakdown");
  });

  it("asks for a business-metric clarification on ambiguous best-channel questions", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "what's our best channel",
      sessionId: "session-business-metric-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("Do you mean best channel for traffic, signups, conversion rate, or revenue?");
  });

  it.skip("adds a relative this-month window to planned revenue total queries", async () => {
    const seenInputs: unknown[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        drilldown_result: (_input, context) =>
          createEnvelope({
            actionId: "drilldown_result",
            authority: context.authority,
            data: {
              rows: [{ amount_paid: "9800", currency: "usd", status: "paid", external_order_id: "ord_123" }],
              metric: "recognized_revenue"
            },
            provenance: ["drilldown.stripe_revenue_provider_rows"]
          }),
        run_metric_query: (input, context) => {
          seenInputs.push(input);
          return createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ recognized_revenue: "12000" }],
              metric: "recognized_revenue",
              view: "queryable.vw_revenue_by_source"
            },
            provenance: ["queryable.vw_revenue_by_source"],
            caveats: ["content_linkage_not_implemented"]
          });
        }
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      },
      now: () => new Date("2026-06-04T12:00:00.000Z")
    });

    const result = await controller.chat({
      message: "what revenue did we do this month",
      sessionId: "session-revenue-total-this-month",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("Recognized revenue is $120.00 this month.");
    expect(result.message).toContain("this month");
    expect(seenInputs).toEqual([
      {
        metric: "recognized_revenue",
        view: "queryable.vw_revenue_by_source",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-06-01" },
          { field: "occurred_on", operator: "lte", value: "2026-06-04" }
        ]
      }
    ]);
  });

  it.skip("auto-diagnoses empty revenue total queries", async () => {
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ recognized_revenue: null }],
              metric: "recognized_revenue",
              view: "queryable.vw_revenue_by_source"
            },
            provenance: ["queryable.vw_revenue_by_source"],
            caveats: ["content_linkage_not_implemented"]
          }),
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [{ id: "src_1", provider: "stripe", status: "connected" }]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [{ id: "sync_1", source_id: "src_1", status: "succeeded" }]
            },
            provenance: ["sync_runs"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                { id: "call_sources", name: "list_sources", input: {} },
                { id: "call_syncs", name: "get_recent_sync_runs", input: {} }
              ]
            };
          }
          return { message: "Fallback model answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "what revenue did we do",
      sessionId: "session-revenue-total-empty",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("I don't have a revenue total");
    expect(result.message).toContain("Stripe");
    expect(result.message).toContain("status connected");
    expect(result.message).toContain("most recent sync run status is succeeded");
  });

  it.skip("adds a relative last-30-days window to planned visitor queries", async () => {
    const seenInputs: unknown[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (input, context) => {
          seenInputs.push(input);
          return createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ site_visitors: "4321" }],
              metric: "site_visitors",
              view: "queryable.vw_site_traffic"
            },
            provenance: ["queryable.vw_site_traffic"],
            caveats: ["source_native_attribution_only"]
          });
        }
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      },
      now: () => new Date("2026-06-04T12:00:00.000Z")
    });

    const result = await controller.chat({
      message: "how many visitors did we have in the last 30 days",
      sessionId: "session-site-visitors-last-30-days",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("You had 4321 site visitors in the last 30 days.");
    expect(result.message).toContain("in the last 30 days");
    expect(seenInputs).toEqual([
      {
        metric: "site_visitors",
        view: "queryable.vw_site_traffic",
        filters: [
          { field: "occurred_on", operator: "gte", value: "2026-05-06" },
          { field: "occurred_on", operator: "lte", value: "2026-06-04" }
        ]
      }
    ]);
  });

  it.skip("does not attach relative windows to follower snapshot queries", async () => {
    const seenInputs: unknown[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (input, context) => {
          seenInputs.push(input);
          return createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ x_follower_count: "31" }],
              metric: "x_follower_count",
              view: "queryable.vw_x_profile_public_metrics"
            },
            provenance: ["queryable.vw_x_profile_public_metrics"]
          });
        }
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      },
      now: () => new Date("2026-06-04T12:00:00.000Z")
    });

    const result = await controller.chat({
      message: "how many followers i have this month",
      sessionId: "session-follower-this-month",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("You have 31 followers.");
    expect(result.message).not.toContain("this month");
    expect(seenInputs).toEqual([
      {
        metric: "x_follower_count",
        view: "queryable.vw_x_profile_public_metrics"
      }
    ]);
  });

  it.skip("pre-runs visitor channel breakdown and answers directly", async () => {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [{ id: "src_ga4", provider: "google_analytics_4", status: "connected", connection_name: "Main Site GA4" }]
            },
            provenance: ["sources"]
          }),
        run_breakdown_query: (_input, context) =>
          createEnvelope({
            actionId: "run_breakdown_query",
            authority: context.authority,
            data: {
              rows: [
                { utm_source: "google", utm_medium: "cpc", utm_campaign: "brand", site_visitors: "1200" },
                { utm_source: "twitter", utm_medium: "social", utm_campaign: "launch", site_visitors: "700" }
              ],
              metric: "site_visitors",
              view: "queryable.vw_site_traffic"
            },
            provenance: ["queryable.vw_site_traffic"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Fallback model answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "which channels drove the most visitors",
      sessionId: "session-visitor-breakdown",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(0);
    expect(result.message).toContain("Google was your strongest traffic source");
    expect(result.message).toContain("Runner-ups");
    expect(result.message).toContain("What this suggests:");
    expect(result.message).toContain("Source: Google Analytics 4 (Main Site GA4)");
  });

  it.skip("pre-runs signup count and answers directly", async () => {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        drilldown_result: (_input, context) =>
          createEnvelope({
            actionId: "drilldown_result",
            authority: context.authority,
            data: {
              rows: [{ landing_page: "/pricing", utm_source: "google", utm_medium: "cpc" }],
              metric: "signup_count"
            },
            provenance: ["drilldown.posthog_signup_provider_rows"]
          }),
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ signup_count: "87" }],
              metric: "signup_count",
              view: "queryable.vw_site_conversion_rate"
            },
            provenance: ["queryable.vw_site_conversion_rate"],
            caveats: ["source_native_attribution_only"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Fallback model answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "how many signups did we get",
      sessionId: "session-signups",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(0);
    expect(result.message).toContain("You had 87 signups.");
    expect(result.message).toContain("PostHog signup events");
    expect(result.message).toContain("Most recent signup detail includes landing page /pricing, source google, medium cpc.");
  });

  it.skip("pre-runs signup channel breakdown and answers directly", async () => {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [{ id: "src_posthog", provider: "posthog", status: "connected", connection_name: "Product Analytics" }]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [{ id: "sync_1", source_id: "src_posthog", status: "succeeded" }]
            },
            provenance: ["sync_runs"]
          }),
        run_breakdown_query: (_input, context) =>
          createEnvelope({
            actionId: "run_breakdown_query",
            authority: context.authority,
            data: {
              rows: [
                { utm_source: "twitter", utm_medium: "social", utm_campaign: "launch", signup_count: "42" },
                { utm_source: "google", utm_medium: "cpc", utm_campaign: "brand", signup_count: "21" }
              ],
              metric: "signup_count",
              view: "queryable.vw_site_conversion_rate"
            },
            provenance: ["queryable.vw_site_conversion_rate"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Fallback model answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "which channels drove the most signups",
      sessionId: "session-signup-breakdown",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(0);
    expect(result.message).toContain("Twitter was your strongest signup source");
    expect(result.message).toContain("Runner-ups");
    expect(result.message).toContain("Health: This source looks healthy based on its current status and recent syncs.");
  });

  it.skip("uses singular wording in signup breakdown answers when counts are 1", async () => {
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_breakdown_query: (_input, context) =>
          createEnvelope({
            actionId: "run_breakdown_query",
            authority: context.authority,
            data: {
              rows: [
                { utm_source: "google", utm_medium: "cpc", utm_campaign: "brand", signup_count: "1" },
                { utm_source: "newsletter", utm_medium: "email", utm_campaign: "welcome", signup_count: "1" }
              ],
              metric: "signup_count",
              view: "queryable.vw_site_conversion_rate"
            },
            provenance: ["queryable.vw_site_conversion_rate"]
          })
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    const result = await controller.chat({
      message: "which channels drove the most signups",
      sessionId: "session-signup-breakdown-singular",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("Google was your strongest signup source with 1 signup.");
    expect(result.message).toContain("Runner-ups: Newsletter / Email (1 signup).");
    expect(result.message).not.toContain("1 signups");
  });

  it.skip("auto-diagnoses empty signup channel breakdowns", async () => {
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_breakdown_query: (_input, context) =>
          createEnvelope({
            actionId: "run_breakdown_query",
            authority: context.authority,
            data: {
              rows: [],
              metric: "signup_count",
              view: "queryable.vw_site_conversion_rate"
            },
            provenance: ["queryable.vw_site_conversion_rate"]
          }),
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [{ id: "src_posthog", provider: "posthog", status: "connected" }]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [{ id: "sync_1", source_id: "src_posthog", status: "succeeded" }]
            },
            provenance: ["sync_runs"]
          })
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    const result = await controller.chat({
      message: "which channels drove the most signups",
      sessionId: "session-signup-breakdown-empty",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("couldn't rank signup channels");
    expect(result.message).toContain("PostHog is present with status connected");
    expect(result.message).toContain("PostHog latest sync status is succeeded");
  });

  it.skip("suggests connecting the missing provider for empty conversion channel breakdowns", async () => {
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_breakdown_query: (_input, context) =>
          createEnvelope({
            actionId: "run_breakdown_query",
            authority: context.authority,
            data: {
              rows: [],
              metric: "site_conversion_rate",
              view: "queryable.vw_site_conversion_rate"
            },
            provenance: ["queryable.vw_site_conversion_rate"]
          }),
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [{ id: "src_posthog", provider: "posthog", status: "connected" }]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [{ id: "sync_1", source_id: "src_posthog", status: "succeeded" }]
            },
            provenance: ["sync_runs"]
          })
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    const result = await controller.chat({
      message: "which channels convert best",
      sessionId: "session-conversion-breakdown-empty-next-step",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("`infinite setup connectors google_analytics_4`");
    expect(result.message).toContain("Google Analytics 4");
  });

  it.skip("pre-runs conversion rate and answers directly", async () => {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [
                { id: "src_ga4", provider: "google_analytics_4", status: "connected", connection_name: "Main Site GA4" },
                { id: "src_posthog", provider: "posthog", status: "connected", connection_name: "Product Analytics" }
              ]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [
                { id: "sync_ga4", source_id: "src_ga4", status: "succeeded" },
                { id: "sync_posthog", source_id: "src_posthog", status: "succeeded" }
              ]
            },
            provenance: ["sync_runs"]
          }),
        run_metric_query: (input, context) => {
          const metric = typeof (input as Record<string, unknown>).metric === "string"
            ? String((input as Record<string, unknown>).metric)
            : "";
          return createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [
                metric === "site_visitors"
                  ? { site_visitors: "180" }
                  : metric === "signup_count"
                    ? { signup_count: "2" }
                    : { site_conversion_rate: "0.034" }
              ],
              metric,
              view: metric === "site_visitors"
                ? "queryable.vw_site_traffic"
                : "queryable.vw_site_conversion_rate"
            },
            provenance: [
              metric === "site_visitors"
                ? "queryable.vw_site_traffic"
                : "queryable.vw_site_conversion_rate"
            ],
            caveats: ["channel_campaign_landing_page_grain_only"]
          });
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Fallback model answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "what is our conversion rate",
      sessionId: "session-conversion",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(0);
    expect(result.message).toContain("Your site conversion rate is 3.4%.");
    expect(result.message).toContain("GA4 visitors and PostHog signups");
    expect(result.message).toContain("Sources: Google Analytics 4 (Main Site GA4) and PostHog (Product Analytics).");
    expect(result.message).toContain("Health: Google Analytics 4 and PostHog both look healthy based on their current status and recent syncs.");
    expect(result.message).toContain("That reflects 2 signups over 180 visitors.");
  });

  it.skip("pre-runs conversion channel breakdown and answers directly", async () => {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_breakdown_query: (_input, context) =>
          createEnvelope({
            actionId: "run_breakdown_query",
            authority: context.authority,
            data: {
              rows: [
                { utm_source: "twitter", utm_medium: "social", utm_campaign: "launch", site_conversion_rate: "0.08" },
                { utm_source: "google", utm_medium: "cpc", utm_campaign: "brand", site_conversion_rate: "0.03" }
              ],
              metric: "site_conversion_rate",
              view: "queryable.vw_site_conversion_rate"
            },
            provenance: ["queryable.vw_site_conversion_rate"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Fallback model answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "which channels convert best",
      sessionId: "session-conversion-breakdown",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(0);
    expect(result.message).toContain("Twitter was your strongest converting source at 8%");
    expect(result.message).toContain("Runner-ups");
  });

  it.skip("auto-diagnoses empty site visitor totals", async () => {
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ site_visitors: null }],
              metric: "site_visitors",
              view: "queryable.vw_site_traffic"
            },
            provenance: ["queryable.vw_site_traffic"],
            caveats: ["source_native_attribution_only"]
          }),
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [{ id: "src_ga4", provider: "google_analytics_4", status: "connected", connection_name: "Main Site GA4" }]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [{ id: "sync_1", source_id: "src_ga4", status: "succeeded" }]
            },
            provenance: ["sync_runs"]
          })
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    const result = await controller.chat({
      message: "how many visitors did we have",
      sessionId: "session-site-visitors-empty",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("I don't have a visitor total");
    expect(result.message).toContain("Google Analytics 4 (Main Site GA4) is present with status connected");
    expect(result.message).toContain("Google Analytics 4 latest sync status is succeeded");
  });

  it.skip("auto-diagnoses empty conversion-rate queries with both GA4 and PostHog dependencies", async () => {
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ site_conversion_rate: null }],
              metric: "site_conversion_rate",
              view: "queryable.vw_site_conversion_rate"
            },
            provenance: ["queryable.vw_site_conversion_rate"],
            caveats: ["source_native_attribution_only"]
          }),
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [
                { id: "src_ga4", provider: "google_analytics_4", status: "connected" },
                { id: "src_posthog", provider: "posthog", status: "connected" }
              ]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [
                { id: "sync_ga4", source_id: "src_ga4", status: "succeeded" },
                { id: "sync_posthog", source_id: "src_posthog", status: "succeeded" }
              ]
            },
            provenance: ["sync_runs"]
          })
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    const result = await controller.chat({
      message: "what is our conversion rate",
      sessionId: "session-conversion-empty",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("Google Analytics 4 is present with status connected");
    expect(result.message).toContain("PostHog is present with status connected");
    expect(result.message).toContain("Google Analytics 4 latest sync status is succeeded");
    expect(result.message).toContain("PostHog latest sync status is succeeded");
  });

  it.skip("returns a direct empty-state revenue answer when the revenue breakdown has no rows", async () => {
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_breakdown_query: (_input, context) =>
          createEnvelope({
            actionId: "run_breakdown_query",
            authority: context.authority,
            data: {
              rows: [],
              metric: "recognized_revenue",
              view: "queryable.vw_revenue_by_source"
            },
            provenance: ["queryable.vw_revenue_by_source"]
          }),
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [{ id: "src_1", provider: "stripe", status: "connected", connection_name: "Stripe" }]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [{ id: "sync_1", status: "success" }]
            },
            provenance: ["sync_runs"]
          })
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    const result = await controller.chat({
      message: "which source drove revenue",
      sessionId: "session-revenue-empty",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("couldn’t find any revenue rows");
    expect(result.message).toContain("no matching revenue rows");
    expect(result.message).toContain("Stripe");
    expect(result.message).toContain("status connected");
    expect(result.message).toContain("most recent sync run status is success");
    expect(result.actionCalls.map((call) => call.actionId)).toContain("list_sources");
    expect(result.actionCalls.map((call) => call.actionId)).toContain("get_recent_sync_runs");
  });

  it("builds revenue-source synthesis guidance after revenue breakdown results return", async () => {
    const { buildQuerySynthesisSections } = await import("../src/query-advisor.js");
    const sections = buildQuerySynthesisSections("which source drove revenue", [
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [
              { provider: "stripe", currency: "usd", recognized_revenue: "12000" },
              { provider: "posthog", currency: "usd", recognized_revenue: "3000" }
            ],
            metric: "recognized_revenue",
            view: "queryable.vw_revenue_by_source"
          },
          provenance: ["queryable.vw_revenue_by_source"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Revenue-source final synthesis guidance:");
    expect(sections.join("\n")).toContain("top revenue source");
    expect(sections.join("\n")).toContain("runner-up sources");
  });

  it("does not inject non-X query-family recipe guidance before any tool call", async () => {
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const advisor = createSourceAwareQueryAdvisor({
      async listConnectedXIdentities() {
        return [];
      }
    });
    const advice = await advisor.advise({
      message: "which source drove revenue this month",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      sessionId: "session-1",
      surface: "api"
    });

    expect(advice).toMatchObject({
      promptSections: expect.arrayContaining([
        "Resolved explicit time scope for this turn:"
      ])
    });
  });

  it("injects explicit time-scope guidance for scoped business questions before tool calls", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      now: () => new Date("2026-06-04T12:00:00.000Z"),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Revenue answer." };
        }
      }
    });

    await controller.chat({
      message: "which source drove revenue this month",
      sessionId: "session-revenue-source-time-guidance",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("Resolved explicit time scope for this turn:");
    expect(prompts[0]).toContain("The user explicitly asked about the period: this month.");
    expect(prompts[0]).toContain(
      "For this period, scope metric or breakdown queries to 2026-06-01 through 2026-06-04 (UTC date boundaries)."
    );
    expect(prompts[0]).toContain("Do not answer from unscoped totals if the user explicitly asked for a time-bounded period.");
  });

  it("injects workspace snapshot guidance for broad open-ended prompts before tool calls", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Workspace answer." };
        }
      }
    });

    await controller.chat({
      message: "what should i know here",
      sessionId: "session-workspace-snapshot-guidance",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("Workspace snapshot prompt guidance:");
    expect(prompts[0]).toContain("at least one business signal");
    expect(prompts[0]).toContain("Use compatible metric/view pairs:");
    expect(prompts[0]).toContain("`x_post_count` and `x_comment_count` belong on `queryable.vw_x_authored_activity`");
    expect(prompts[0]).toContain("Do not let one noisy metric dominate");
  });

  it("does not inject non-X source-status recipe guidance before any tool call", async () => {
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const advisor = createSourceAwareQueryAdvisor({
      async listConnectedXIdentities() {
        return [];
      }
    });
    const advice = await advisor.advise({
      message: "is x connected",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      sessionId: "session-1",
      surface: "api"
    });

    expect(advice).toBeUndefined();
  });

  it("feeds unknown action errors back to the model for self-correction", async () => {
    const registry = createInfiniteOsRegistry({
      list_metrics: (_input, context) =>
        createEnvelope({
          actionId: "list_metrics",
          authority: context.authority,
          data: { metrics: [{ id: "recognized_revenue" }] },
          provenance: ["metric_definitions"]
        })
    });
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry,
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          if (request.toolResults.length === 0) {
            return { toolCalls: [{ id: "bad_call", name: "resolve_question", input: {} }] };
          }
          if (request.toolResults.length === 1) {
            return { toolCalls: [{ id: "good_call", name: "list_metrics", input: {} }] };
          }
          return { message: "Recovered with list_metrics." };
        }
      }
    });

    const result = await controller.chat({
      message: "What can I ask?",
      sessionId: "session-unknown-action",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Recovered with list_metrics.");
    expect(result.actionCalls.map((call) => [call.actionId, call.status])).toEqual([
      ["resolve_question", "error"],
      ["list_metrics", "ok"]
    ]);
    expect(JSON.stringify(requests[1]?.toolResults[0]?.result)).toContain("unknown_action");
  });

  it("feeds action execution errors back to the model for self-correction", async () => {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: async () => {
          throw new Error("unsupported_view_for_metric:x_post_count:queryable.vw_x_post_public_metrics");
        },
        describe_metric: (_input, context) =>
          createEnvelope({
            actionId: "describe_metric",
            authority: context.authority,
            data: {
              metric: {
                id: "x_post_count",
                source_view: "queryable.vw_x_authored_activity",
                default_time_column: "published_at",
                allowed_dimensions: ["x_post_id", "post_url", "body_text", "published_at"]
              }
            },
            provenance: ["metric_definitions"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                {
                  id: "bad_metric_call",
                  name: "run_metric_query",
                  input: { metric: "x_post_count", view: "queryable.vw_x_post_public_metrics" }
                }
              ]
            };
          }
          if (request.toolResults.length === 1) {
            return { toolCalls: [{ id: "metric_detail_call", name: "describe_metric", input: { metricId: "x_post_count" } }] };
          }
          return { message: "Recovered after metric/view mismatch." };
        }
      }
    });

    const result = await controller.chat({
      message: "what's my latest tweet",
      sessionId: "session-action-error-recovery",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Recovered after metric/view mismatch.");
    expect(requests).toHaveLength(3);
    expect(requests[1]?.toolResults[0]?.result).toMatchObject({
      status: "error",
      actionId: "run_metric_query",
      error: {
        code: "action_execution_failed",
        message: "unsupported_view_for_metric:x_post_count:queryable.vw_x_post_public_metrics"
      }
    });
  });

  it("does not auto-execute operator actions selected by the model", async () => {
    const registry = createInfiniteOsRegistry({
      start_source_sync: () => {
        throw new Error("operator action should not execute before confirmation");
      }
    });
    const controller = createLlmController({
      registry,
      modelClient: {
        complete: async () => ({
          toolCalls: [{ id: "call_sync", name: "start_source_sync", input: { sourceId: "src_1" } }]
        })
      }
    });

    const result = await controller.chat({
      message: "Sync Stripe now",
      sessionId: "session-operator",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result).toMatchObject({
      ok: true,
      sessionId: "session-operator",
      message: expect.stringContaining("requires confirmation"),
      provenance: []
    });
    expect(result.actionCalls).toEqual([
      expect.objectContaining({
        id: "call_sync",
        actionId: "start_source_sync",
        input: { sourceId: "src_1" },
        status: "requires_confirmation",
        requiresConfirmation: true,
        confirmationId: expect.stringMatching(/^confirm_[0-9a-f]{16}$/),
        inputHash: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
    ]);
  });

  it("lets the model sync a source now and then query fresh data in the same turn", async () => {
    const requests: ModelRequest[] = [];
    const executed: string[] = [];
    const registry = createInfiniteOsRegistry({
      sync_source_now: (input, context) => {
        executed.push("sync_source_now");
        return createEnvelope({
          actionId: "sync_source_now",
          authority: context.authority,
          data: {
            sourceId: (input as { sourceId?: string }).sourceId,
            provider: "x",
            syncRunId: "sync_now_1",
            refreshWindowDays: 1,
            recordsExtracted: 2,
            recordsLoaded: 2
          },
          provenance: ["sync_runs", "x_post"]
        });
      },
      run_metric_query: (_input, context) => {
        executed.push("run_metric_query");
        return createEnvelope({
          actionId: "run_metric_query",
          authority: context.authority,
          data: {
            metric: "x_public_engagement",
            rows: [{ body_text: "fresh tweet", x_public_engagement: "42" }]
          },
          provenance: ["queryable.vw_x_post_public_metrics"]
        });
      }
    });
    const controller = createLlmController({
      registry,
      modelClient: {
        complete: async (request) => {
          requests.push({ ...request, toolResults: [...request.toolResults] });
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [{
                id: "call_sync_now",
                name: "sync_source_now",
                input: { sourceId: "src_x", refreshWindowDays: 1, reason: "best tweets today" }
              }]
            };
          }
          if (request.toolResults.length === 1) {
            return {
              toolCalls: [{
                id: "call_fresh_query",
                name: "run_metric_query",
                input: { metric: "x_public_engagement", view: "queryable.vw_x_post_public_metrics" }
              }]
            };
          }
          return { message: "Fresh tweet has 42 engagement." };
        }
      }
    });

    const result = await controller.chat({
      message: "what are my best tweets today?",
      sessionId: "session-sync-now-query",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Fresh tweet has 42 engagement.");
    expect(executed).toEqual(["sync_source_now", "run_metric_query"]);
    expect(requests).toHaveLength(3);
    expect(requests[1]?.toolResults.map((tool) => tool.name)).toEqual(["sync_source_now"]);
    expect(requests[2]?.toolResults.map((tool) => tool.name)).toEqual(["sync_source_now", "run_metric_query"]);
  });

  it("injects failed X sync freshness guidance before the model can answer from stale rows", async () => {
    const requests: ModelRequest[] = [];
    const executed: string[] = [];
    const registry = createInfiniteOsRegistry({
      sync_source_now: () => {
        executed.push("sync_source_now");
        throw new Error("Unsupported state or unable to authenticate data");
      },
      run_metric_query: (_input, context) => {
        executed.push("run_metric_query");
        return createEnvelope({
          actionId: "run_metric_query",
          authority: context.authority,
          data: {
            metric: "x_public_engagement",
            rows: [{ body_text: "stored tweet", x_public_engagement: "17" }]
          },
          provenance: ["queryable.vw_x_post_public_metrics"]
        });
      }
    });
    const controller = createLlmController({
      registry,
      modelClient: {
        complete: async (request) => {
          requests.push({ ...request, toolResults: [...request.toolResults] });
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [{
                id: "call_sync_now",
                name: "sync_source_now",
                input: { sourceId: "src_x", refreshWindowDays: 1, reason: "best tweets today" }
              }]
            };
          }
          if (request.toolResults.length === 1) {
            return {
              toolCalls: [{
                id: "call_stale_query",
                name: "run_metric_query",
                input: { metric: "x_public_engagement", view: "queryable.vw_x_post_public_metrics" }
              }]
            };
          }
          return { message: "I can only discuss stored X rows because the refresh failed." };
        }
      }
    });

    const result = await controller.chat({
      message: "what are my best tweets today?",
      sessionId: "session-sync-now-failed-stale-caveat",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("I can only discuss stored X rows because the refresh failed.");
    expect(executed).toEqual(["sync_source_now", "run_metric_query"]);
    expect(requests).toHaveLength(3);
    expect(requests[1]?.systemPrompt).toContain("X freshness failure guidance:");
    expect(requests[1]?.systemPrompt).toContain("Unsupported state or unable to authenticate data");
    expect(requests[1]?.systemPrompt).toContain("Do not present stored X rows as latest, current, same-day-fresh");
    expect(requests[2]?.systemPrompt).toContain("X freshness failure guidance:");
    expect(requests[2]?.systemPrompt).toContain("label them as local stored/synced data from before the failed refresh");
  });

  it("redacts credential-like operator action inputs before returning or persisting them", async () => {
    const recordedInputs: unknown[] = [];
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall(input) {
        recordedInputs.push(input.input);
      },
      async listSessions() {
        return [];
      },
      async getSession() {
        return null;
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      modelClient: {
        complete: async () => ({
          toolCalls: [
            {
              id: "call_connect",
              name: "connect_source",
              input: {
                provider: "stripe",
                connectionName: "Stripe",
                credentialPayload: {
                  secretKey: "sk_test_secret",
                  accountId: "acct_123"
                }
              }
            }
          ]
        })
      }
    });

    const result = await controller.chat({
      message: "Connect Stripe",
      sessionId: "session-redact",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(JSON.stringify(result)).not.toContain("sk_test_secret");
    expect(JSON.stringify(recordedInputs)).not.toContain("sk_test_secret");
    expect(result.actionCalls[0]).toMatchObject({
      input: {
        provider: "stripe",
        connectionName: "Stripe",
        credentialPayload: "[redacted]"
      },
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    expect(recordedInputs[0]).toMatchObject({
      provider: "stripe",
      connectionName: "Stripe",
      credentialPayload: "[redacted]"
    });
  });

  it("persists user turns, assistant turns, and action calls when a session store is supplied", async () => {
    const registry = createInfiniteOsRegistry({
      list_metrics: (_input, context) =>
        createEnvelope({
          actionId: "list_metrics",
          authority: context.authority,
          data: { metrics: [{ id: "recognized_revenue" }] },
          provenance: ["metric_definitions"]
        })
    });
    const store = createRecordingSessionStore();
    const controller = createLlmController({
      registry,
      sessionStore: store,
      modelClient: {
        complete: async (request) =>
          request.toolResults.length === 0
            ? {
                toolCalls: [{ id: "call_1", name: "list_metrics", input: {} }],
                usage: { promptTokens: 11, completionTokens: 3 }
              }
            : {
                message: "Recognized revenue is available.",
                usage: { promptTokens: 17, completionTokens: 5 }
              }
      }
    });

    await controller.chat({
      message: "Revenue?",
      sessionId: "session-persist",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(store.events).toEqual([
      ["ensureSession", "session-persist"],
      ["searchSessions", "workspace-1", "Revenue?", "session-persist"],
      ["appendMessage", "user", "Revenue?", ""],
      ["recordActionCall", "list_metrics", "ok"],
      ["appendMessage", "assistant", "Recognized revenue is available.", "8"],
      ["recordTokenUsage", "28", "8"]
    ]);
  });

  it("persists selected model and auth metadata on chat sessions", async () => {
    const registry = createInfiniteOsRegistry({});
    const ensured: unknown[] = [];
    const prompts: string[] = [];
    const store: ChatSessionStore = {
      async ensureSession(input) {
        ensured.push(input);
      },
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession() {
        return null;
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const modelClient = {
      modelMetadata: () => ({
        provider: "claude" as const,
        model: "claude-sonnet-4-5",
        authSource: "claude-code"
      }),
      complete: async (request: ModelRequest) => {
        prompts.push(request.systemPrompt);
        return { message: "Hello.", usage: { promptTokens: 9, completionTokens: 2 } };
      }
    };
    const controller = createLlmController({ registry, sessionStore: store, modelClient });

    const result = await controller.chat({
      message: "Hello",
      sessionId: "session-model",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(ensured[0]).toMatchObject({
      sessionId: "session-model",
      modelProvider: "claude",
      modelName: "claude-sonnet-4-5",
      modelAuthSource: "claude-code"
    });
    expect(prompts[0]).toContain("Claude tool-call guidance:");
    expect(prompts[0]).toContain("Anthropic Messages tool calls");
    expect(result).toMatchObject({
      modelProvider: "claude",
      modelName: "claude-sonnet-4-5",
      modelAuthSource: "claude-code",
      usage: { promptTokens: 9, completionTokens: 2 }
    });
  });

  it("generates a unique session id when chat is called without one", async () => {
    const ensured: string[] = [];
    const store: ChatSessionStore = {
      async ensureSession(input) {
        ensured.push(input.sessionId);
      },
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession() {
        return null;
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      modelClient: {
        complete: async () => ({ message: "ok" })
      }
    });

    await controller.chat({
      message: "first",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });
    await controller.chat({
      message: "second",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(ensured).toHaveLength(2);
    expect(ensured[0]).toMatch(/^api_[0-9a-f-]+$/);
    expect(ensured[1]).toMatch(/^api_[0-9a-f-]+$/);
    expect(ensured[0]).not.toBe(ensured[1]);
  });

  it("loads prior session messages as fenced data for follow-up chat turns", async () => {
    const prompts: string[] = [];
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "Which source drove revenue?" },
            { role: "assistant", content: "Stripe drove recognized revenue. access token sk-live-secret" },
            { role: "tool", content: "raw_payload should not be injected as a tool message" }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Continuing from the revenue context." };
        }
      }
    });

    await controller.chat({
      message: "What was the source again?",
      sessionId: "session-follow-up",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("<session-context>");
    expect(prompts[0]).toContain("Which source drove revenue?");
    expect(prompts[0]).toContain("Stripe drove recognized revenue.");
    expect(prompts[0]).toContain("access token [redacted]");
    expect(prompts[0]).not.toContain("sk-live-secret");
    expect(prompts[0]).not.toContain("raw_payload should not be injected");
  });

  it("loads prior-session search results outside the active lineage as fenced data", async () => {
    const prompts: string[] = [];
    const searchCalls: unknown[] = [];
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession() {
        return null;
      },
      async searchSessions(workspaceId, query, options) {
        searchCalls.push({ workspaceId, query, options });
        return [
          {
            id: "session-prior",
            title: "Revenue by source",
            snippet: "Stripe drove recognized revenue. refresh token sk-live-secret",
            lastMatchedAt: "2026-06-01T00:00:00Z"
          }
        ];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Answered from prior session recall." };
        }
      }
    });

    await controller.chat({
      message: "What source drove revenue before?",
      sessionId: "session-active",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(searchCalls).toEqual([
      {
        workspaceId: "workspace-1",
        query: "What source drove revenue before?",
        options: { excludeSessionId: "session-active" }
      }
    ]);
    expect(prompts[0]).toContain("<session-recall-context>");
    expect(prompts[0]).toContain("Revenue by source");
    expect(prompts[0]).toContain("Stripe drove recognized revenue.");
    expect(prompts[0]).toContain("refresh token [redacted]");
    expect(prompts[0]).not.toContain("sk-live-secret");
  });

  it("loads curated memory as a frozen fenced prompt snapshot", async () => {
    const prompts: string[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      memoryManager: {
        loadPromptContext: async () => [
          { scope: "workspace_preference", fact: "Use UTC for weekly reports." },
          { scope: "operator_correction", fact: "access token sk-live-secret should not appear" }
        ],
        reviewTurn: async () => {}
      },
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Answered with memory context." };
        }
      }
    });

    await controller.chat({
      message: "Create the weekly report",
      sessionId: "session-memory-context",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("<memory-context>");
    expect(prompts[0]).toContain("Use UTC for weekly reports.");
    expect(prompts[0]).toContain("access token [redacted]");
    expect(prompts[0]).not.toContain("sk-live-secret");
  });

  it("loads compacted summaries as separate reference-only prompt context", async () => {
    const prompts: string[] = [];
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [],
          actionCalls: [],
          summaries: [
            {
              summaryText: "Revenue source context preserved. access token sk-live-secret",
              summaryJson: { selectedMetric: "recognized_revenue", raw_payload: "should redact" }
            }
          ]
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Answered from compacted context." };
        }
      }
    });

    await controller.chat({
      message: "Continue",
      sessionId: "session-compact-context",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("<summary-context>");
    expect(prompts[0]).toContain("Revenue source context preserved.");
    expect(prompts[0]).toContain("recognized_revenue");
    expect(prompts[0]).toContain("access token [redacted]");
    expect(prompts[0]).not.toContain("sk-live-secret");
    expect(prompts[0]).not.toContain("should redact");
  });

  it("asks for clarification instead of guessing when a first-person X question has multiple connected identities", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_x_1", connectionName: "YourHandle Account", username: "yourhandle" },
            { sourceId: "src_x_2", connectionName: "Infinite OS", username: "growthos" }
          ];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "how many followers i have",
      sessionId: "session-x-ambiguous",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.actionCalls).toEqual([]);
    expect(result.message).toContain("multiple connected X accounts");
    expect(result.message).toContain("1. @yourhandle");
    expect(result.message).toContain("2. @growthos");
    expect(result.message).toContain("the first one");
  });

  it("asks for platform clarification when comment-count is ambiguous and no X identity is connected", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "how many comments ive made",
      sessionId: "session-x-missing-platform-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("If you mean X");
    expect(result.message).toContain("If you mean another platform, tell me which one.");
  });

  it("asks for platform clarification when a strategy prompt is ambiguous and no X identity is connected", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "what should i post more of",
      sessionId: "session-missing-platform-strategy-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("If you mean X");
    expect(result.message).toContain("If you mean another platform, tell me which one.");
  });

  it("asks for platform clarification when a stop-posting prompt is ambiguous and no X identity is connected", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "what should i stop posting",
      sessionId: "session-missing-platform-negative-strategy-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("If you mean X");
    expect(result.message).toContain("If you mean another platform, tell me which one.");
  });

  it("asks for platform clarification when a latest-post prompt is ambiguous and no X identity is connected", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "what's my latest post",
      sessionId: "session-missing-platform-latest-post-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("If you mean X");
    expect(result.message).toContain("If you mean another platform, tell me which one.");
  });

  it("asks for platform clarification when a best-time-to-post prompt is ambiguous and no X identity is connected", async () => {
    let modelCalled = false;
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async () => {
          modelCalled = true;
          return { message: "should not run" };
        }
      }
    });

    const result = await controller.chat({
      message: "what are the best times for me to post",
      sessionId: "session-missing-platform-best-time-clarify",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(modelCalled).toBe(false);
    expect(result.message).toContain("If you mean X");
    expect(result.message).toContain("If you mean another platform, tell me which one.");
  });

  it("prefers a single plausible real X account over synthetic fixture identities in the current model-led loop", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_fixture", connectionName: "X Fixture Public Metrics", accountExternalId: "X Fixture Public Metrics" },
            { sourceId: "src_river", connectionName: "X yourhandle live", accountExternalId: "yourhandle" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "You have 31 followers." };
        }
      }
    });

    const result = await controller.chat({
      message: "how many followers i have",
      sessionId: "session-x-infer-real-account-model-led",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("You have 31 followers.");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("\"sourceId\":\"src_river\"");
    expect(prompts[0]).not.toContain("\"sourceId\":\"src_fixture\"");
    expect(prompts[0]).not.toContain("multiple connected X accounts");
  });

  it("injects X content-type guidance for first-person content performance prompts", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [{ sourceId: "src_river", connectionName: "X yourhandle live", accountExternalId: "yourhandle" }];
        }
      }),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Content-type answer." };
        }
      }
    });

    await controller.chat({
      message: "what type of content is performing better for me?",
      sessionId: "session-x-content-type-guidance",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("\"sourceId\":\"src_river\"");
    expect(prompts[0]).toContain("grouped by `content_type`");
    expect(prompts[0]).toContain("post type, content kind, content format, or format");
  });

  it("injects X mentioned-handle guidance for people-engaged-with prompts", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [{ sourceId: "src_river", connectionName: "X yourhandle live", accountExternalId: "yourhandle" }];
        }
      }),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Engaged-with answer." };
        }
      }
    });

    await controller.chat({
      message: "which 3 people have i engaged with the most?",
      sessionId: "session-x-engaged-with-guidance",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("\"sourceId\":\"src_river\"");
    expect(prompts[0]).toContain("grouped by `mentioned_handle`, not grouped by the user's own `author_id`");
    expect(prompts[0]).toContain("not a complete social graph");
  });

  it("injects X immediate sync guidance before answering latest tweet prompts", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [{
            sourceId: "src_river",
            connectionName: "X yourhandle live",
            accountExternalId: "yourhandle",
            lastSyncedAt: "2026-06-06T15:34:32.364Z",
            latestPostPublishedAt: "2026-06-06T12:07:32.000Z",
            earliestPostPublishedAt: "2026-06-04T03:13:49.000Z",
            syncedPostCount: 105
          }];
        }
      }),
      now: () => new Date("2026-06-07T14:00:00.000Z"),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Needs sync." };
        }
      }
    });

    await controller.chat({
      message: "what was my last tweet?",
      sessionId: "session-x-latest-stale-guidance",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("X recency and coverage guidance:");
    expect(prompts[0]).toContain("\"lastSyncedAt\":\"2026-06-06T15:34:32.364Z\"");
    expect(prompts[0]).toContain("Call `sync_source_now`");
    expect(prompts[0]).toContain("query the latest post from Postgres after that tool result");
  });

  it("injects X coverage guidance before answering first tweet prompts", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [{
            sourceId: "src_river",
            connectionName: "X yourhandle live",
            accountExternalId: "yourhandle",
            lastSyncedAt: "2026-06-07T13:55:00.000Z",
            latestPostPublishedAt: "2026-06-07T13:28:18.144Z",
            earliestPostPublishedAt: "2026-06-04T03:13:49.000Z",
            syncedPostCount: 105
          }];
        }
      }),
      now: () => new Date("2026-06-07T14:00:00.000Z"),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Earliest synced row only." };
        }
      }
    });

    await controller.chat({
      message: "what was my first tweet?",
      sessionId: "session-x-first-coverage-guidance",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("X recency and coverage guidance:");
    expect(prompts[0]).toContain("\"earliestPostPublishedAt\":\"2026-06-04T03:13:49.000Z\"");
    expect(prompts[0]).toContain("earliest synced public post");
    expect(prompts[0]).toContain("call `sync_source_now`");
    expect(prompts[0]).toContain("refreshWindowDays` such as 3650");
    expect(prompts[0]).toContain("earliest synced public post");
  });

  it("injects X same-day sync guidance before answering best tweets today prompts", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [{
            sourceId: "src_river",
            connectionName: "X yourhandle live",
            accountExternalId: "yourhandle",
            lastSyncedAt: "2026-06-06T15:34:32.364Z",
            latestPostPublishedAt: "2026-06-06T12:07:32.000Z",
            earliestPostPublishedAt: "2026-06-04T03:13:49.000Z",
            syncedPostCount: 105
          }];
        }
      }),
      now: () => new Date("2026-06-07T14:00:00.000Z"),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Needs same-day sync." };
        }
      }
    });

    await controller.chat({
      message: "what are my best tweets today?",
      sessionId: "session-x-best-today-guidance",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("same-day X performance questions");
    expect(prompts[0]).toContain("call `sync_source_now`");
    expect(prompts[0]).toContain("filtered to today");
  });

  it("injects X same-day sync guidance before broad current Meta Ads versus X performance prompts", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [{
            sourceId: "src_river",
            connectionName: "X yourhandle live",
            accountExternalId: "yourhandle",
            lastSyncedAt: "2026-06-06T15:34:32.364Z",
            latestPostPublishedAt: "2026-06-06T12:07:32.000Z",
            earliestPostPublishedAt: "2026-06-04T03:13:49.000Z",
            syncedPostCount: 105
          }];
        }
      }),
      now: () => new Date("2026-06-07T14:00:00.000Z"),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Needs current X sync before comparing channels." };
        }
      }
    });

    await controller.chat({
      message: "As of today, which channel is giving me better performance right now, X or Meta Ads?",
      sessionId: "session-x-meta-current-performance-guidance",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("X recency and coverage guidance:");
    expect(prompts[0]).toContain("\"sourceId\":\"src_river\"");
    expect(prompts[0]).toContain("same-day/current X performance questions");
    expect(prompts[0]).toContain("call `sync_source_now`");
    expect(prompts[0]).toContain("before comparing X with Meta Ads");
  });

  it.skip("prefers a single plausible real X account over synthetic fixture identities", async () => {
    const prompts: string[] = [];
    const seenInputs: unknown[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [
                { id: "src_fixture", provider: "x", status: "connected", connection_name: "X Fixture Public Metrics" },
                { id: "src_river", provider: "x", status: "connected", connection_name: "X yourhandle live", account_external_id: "yourhandle" }
              ]
            },
            provenance: ["sources"]
          }),
        run_metric_query: (input, context) => {
          seenInputs.push(input);
          return createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ x_follower_count: "31" }],
              metric: "x_follower_count",
              view: "queryable.vw_x_profile_public_metrics"
            },
            provenance: ["queryable.vw_x_profile_public_metrics"]
          });
        }
      }),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_fixture", connectionName: "X Fixture Public Metrics", accountExternalId: "X Fixture Public Metrics" },
            { sourceId: "src_river", connectionName: "X yourhandle live", accountExternalId: "yourhandle" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "You have 31 followers." };
        }
      }
    });

    const result = await controller.chat({
      message: "how many followers i have",
      sessionId: "session-x-infer-real-account",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("You have 31 followers.");
    expect(result.message).toContain("Source: X (X yourhandle live).");
    expect(seenInputs).toEqual([
      {
        metric: "x_follower_count",
        view: "queryable.vw_x_profile_public_metrics",
        filters: [{ field: "source_id", operator: "equals", value: "src_river" }]
      }
    ]);
    expect(prompts).toHaveLength(0);
  });

  it("reuses a recalled preferred X account before asking for clarification", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "assistant", content: "Source: YourHandle Account (X) for @yourhandle." }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_x_1", connectionName: "YourHandle Account", username: "yourhandle" },
            { sourceId: "src_x_2", connectionName: "Infinite OS", username: "growthos" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "You have 31 followers." };
        }
      }
    });

    const result = await controller.chat({
      message: "how many followers i have",
      sessionId: "session-x-recall",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("You have 31 followers.");
    expect(prompts[0]).toContain("\"username\":\"yourhandle\"");
  });

  it.skip("resolves a bare connected username in an explicit X question", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ x_follower_count: "31" }],
              metric: "x_follower_count",
              view: "queryable.vw_x_profile_public_metrics"
            },
            provenance: ["queryable.vw_x_profile_public_metrics"]
          })
      }),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_x_1", connectionName: "YourHandle Account", username: "yourhandle" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Fallback model answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "how many followers does yourhandle have",
      sessionId: "session-x-bare-handle",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(0);
    expect(result.message).toContain("@yourhandle has 31 followers.");
    expect(result.message).toContain("latest public follower-count snapshot");
  });

  it.skip("resolves an explicit handle from account_external_id when username snapshots are missing", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ x_follower_count: "31" }],
              metric: "x_follower_count",
              view: "queryable.vw_x_profile_public_metrics"
            },
            provenance: ["queryable.vw_x_profile_public_metrics"]
          })
      }),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_x_1", connectionName: "X yourhandle live", accountExternalId: "yourhandle" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Fallback model answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "how many followers does @yourhandle have",
      sessionId: "session-x-account-external-id",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(0);
    expect(result.message).toContain("@yourhandle has 31 followers.");
  });

  it("resolves a bare connected username into prompt context for the current model-led loop", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_x_1", connectionName: "YourHandle Account", username: "yourhandle" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "You have 31 followers." };
        }
      }
    });

    const result = await controller.chat({
      message: "how many followers does yourhandle have",
      sessionId: "session-x-bare-handle-model-led",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("You have 31 followers.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userMessage).toBe("how many followers does yourhandle have");
    expect(requests[0]?.systemPrompt).toContain("\"username\":\"yourhandle\"");
    expect(requests[0]?.systemPrompt).toContain("\"sourceId\":\"src_x_1\"");
    expect(requests[0]?.systemPrompt).toContain("Interpret the user's X question as referring to this connected account");
  });

  it("resolves an explicit handle from account_external_id into prompt context for the current model-led loop", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_x_1", connectionName: "X yourhandle live", accountExternalId: "yourhandle" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "You have 31 followers." };
        }
      }
    });

    const result = await controller.chat({
      message: "how many followers does @yourhandle have",
      sessionId: "session-x-account-external-id-model-led",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("You have 31 followers.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userMessage).toBe("how many followers does @yourhandle have");
    expect(requests[0]?.systemPrompt).toContain("\"connectionName\":\"X yourhandle live\"");
    expect(requests[0]?.systemPrompt).toContain("\"username\":null");
    expect(requests[0]?.systemPrompt).toContain("\"sourceId\":\"src_x_1\"");
  });

  it.skip("resolves a clarification follow-up reply and continues the prior X question", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "how many followers i have" },
            {
              role: "assistant",
              content:
                "I found multiple connected X accounts for this workspace: @yourhandle (YourHandle Account), @growthos (Infinite OS). Tell me which one to use."
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ x_follower_count: "31" }],
              metric: "x_follower_count",
              view: "queryable.vw_x_profile_public_metrics"
            },
            provenance: ["queryable.vw_x_profile_public_metrics"]
          })
      }),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_x_1", connectionName: "YourHandle Account", username: "yourhandle" },
            { sourceId: "src_x_2", connectionName: "Infinite OS", username: "growthos" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Fallback model answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "yourhandle",
      sessionId: "session-x-follow-up-resolution",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(0);
    expect(result.message).toContain("You have 31 followers.");
    expect(result.message).toContain("latest public follower-count snapshot");
    expect(result.message).toContain("how many posts or comments you've made");
  });

  it.skip("resolves a natural-language clarification reply that mentions the X username", async () => {
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "how many followers i have" },
            {
              role: "assistant",
              content:
                "I found multiple connected X accounts for this workspace: @yourhandle (YourHandle Account), @growthos (Infinite OS). Tell me which one to use."
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ x_follower_count: "31" }],
              metric: "x_follower_count",
              view: "queryable.vw_x_profile_public_metrics"
            },
            provenance: ["queryable.vw_x_profile_public_metrics"]
          })
      }),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_x_1", connectionName: "YourHandle Account", username: "yourhandle" },
            { sourceId: "src_x_2", connectionName: "Infinite OS", username: "growthos" }
          ];
        }
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    const result = await controller.chat({
      message: "the yourhandle one",
      sessionId: "session-x-follow-up-natural-language",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("You have 31 followers.");
    expect(result.message).toContain("latest public follower-count snapshot");
  });

  it.skip("resolves an ordinal clarification reply and continues the prior X question", async () => {
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "how many followers i have" },
            {
              role: "assistant",
              content:
                "I found multiple connected X accounts for this workspace: @yourhandle (YourHandle Account), @growthos (Infinite OS). Tell me which one to use."
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ x_follower_count: "31" }],
              metric: "x_follower_count",
              view: "queryable.vw_x_profile_public_metrics"
            },
            provenance: ["queryable.vw_x_profile_public_metrics"]
          })
      }),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_x_1", connectionName: "YourHandle Account", username: "yourhandle" },
            { sourceId: "src_x_2", connectionName: "Infinite OS", username: "growthos" }
          ];
        }
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    const result = await controller.chat({
      message: "the first one",
      sessionId: "session-x-follow-up-ordinal",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("You have 31 followers.");
    expect(result.message).toContain("latest public follower-count snapshot");
  });

  it.skip("reviews clarification follow-up turns against the resolved X question", async () => {
    const reviewed: Array<{ userMessage: string; assistantMessage: string }> = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "how many followers i have" },
            {
              role: "assistant",
              content:
                "I found multiple connected X accounts for this workspace: @yourhandle (YourHandle Account), @growthos (Infinite OS). Tell me which one to use."
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ x_follower_count: "31" }],
              metric: "x_follower_count",
              view: "queryable.vw_x_profile_public_metrics"
            },
            provenance: ["queryable.vw_x_profile_public_metrics"]
          })
      }),
      sessionStore: store,
      memoryManager: {
        async reviewTurn(input) {
          reviewed.push({
            userMessage: input.userMessage,
            assistantMessage: input.assistantMessage
          });
        }
      },
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_x_1", connectionName: "YourHandle Account", username: "yourhandle" },
            { sourceId: "src_x_2", connectionName: "Infinite OS", username: "growthos" }
          ];
        }
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    await controller.chat({
      message: "yourhandle",
      sessionId: "session-x-follow-up-memory",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(reviewed).toEqual([
      expect.objectContaining({
        userMessage: "how many followers i have",
        assistantMessage: expect.stringContaining("You have 31 followers.")
      })
    ]);
  });

  it("re-runs session recall against the resolved clarification question", async () => {
    const searched: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "how many followers i have" },
            {
              role: "assistant",
              content:
                "I found multiple connected X accounts for this workspace: @yourhandle (YourHandle Account), @growthos (Infinite OS). Tell me which one to use."
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions(_workspaceId, query) {
        searched.push(query);
        return query === "how many followers i have"
          ? [{ id: "session-old", title: "Prior follower question", snippet: "Followers were discussed before." }]
          : [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ x_follower_count: "31" }],
              metric: "x_follower_count",
              view: "queryable.vw_x_profile_public_metrics"
            },
            provenance: ["queryable.vw_x_profile_public_metrics"]
          })
      }),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_x_1", connectionName: "YourHandle Account", username: "yourhandle" },
            { sourceId: "src_x_2", connectionName: "Infinite OS", username: "growthos" }
          ];
        }
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    await controller.chat({
      message: "the first one",
      sessionId: "session-x-follow-up-recall",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(searched).toEqual(["the first one", "how many followers i have"]);
  });

  it("resolves a natural-language clarification reply into the original X question for the model loop", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "how many followers i have" },
            {
              role: "assistant",
              content:
                "I found multiple connected X accounts for this workspace: @yourhandle (YourHandle Account), @growthos (Infinite OS). Tell me which one to use."
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_x_1", connectionName: "YourHandle Account", username: "yourhandle" },
            { sourceId: "src_x_2", connectionName: "Infinite OS", username: "growthos" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "You have 31 followers." };
        }
      }
    });

    const result = await controller.chat({
      message: "the yourhandle one",
      sessionId: "session-x-follow-up-natural-language-model",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("You have 31 followers.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userMessage).toBe("how many followers i have");
    expect(requests[0]?.systemPrompt).toContain("\"username\":\"yourhandle\"");
    expect(requests[0]?.systemPrompt).toContain("Interpret this turn as a clarification reply");
  });

  it("resolves an ordinal clarification reply into the original X question for the model loop", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "how many followers i have" },
            {
              role: "assistant",
              content:
                "I found multiple connected X accounts for this workspace: @yourhandle (YourHandle Account), @growthos (Infinite OS). Tell me which one to use."
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_x_1", connectionName: "YourHandle Account", username: "yourhandle" },
            { sourceId: "src_x_2", connectionName: "Infinite OS", username: "growthos" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "You have 31 followers." };
        }
      }
    });

    const result = await controller.chat({
      message: "the first one",
      sessionId: "session-x-follow-up-ordinal-model",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("You have 31 followers.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userMessage).toBe("how many followers i have");
    expect(requests[0]?.systemPrompt).toContain("\"username\":\"yourhandle\"");
    expect(requests[0]?.systemPrompt).toContain("Interpret this turn as a clarification reply");
  });

  it("resolves a clarification reply back into the original strategy question for the model loop", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "what should i post more of" },
            {
              role: "assistant",
              content:
                "I found multiple connected X accounts for this workspace: @yourhandle (YourHandle Account), @growthos (Infinite OS). Tell me which one to use."
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_x_1", connectionName: "YourHandle Account", username: "yourhandle" },
            { sourceId: "src_x_2", connectionName: "Infinite OS", username: "growthos" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Post more GTM teardown content." };
        }
      }
    });

    const result = await controller.chat({
      message: "the first one",
      sessionId: "session-x-follow-up-strategy-model",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Post more GTM teardown content.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userMessage).toBe("what should i post more of");
    expect(requests[0]?.systemPrompt).toContain("\"username\":\"yourhandle\"");
    expect(requests[0]?.systemPrompt).toContain("Interpret this turn as a clarification reply");
  });

  it("resolves a time-scope clarification reply back into the original revenue question for the model loop", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "how much revenue did we do" },
            {
              role: "assistant",
              content:
                "Which time period do you want for revenue: today, this week, this month, this quarter, this year, or all time?"
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Revenue answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "this month",
      sessionId: "session-revenue-follow-up-time-scope",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Revenue answer.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userMessage).toBe("how much revenue did we do this month");
    expect(requests[0]?.systemPrompt).toContain("Resolved missing time scope for this turn:");
    expect(requests[0]?.systemPrompt).toContain("Original question: how much revenue did we do");
    expect(requests[0]?.systemPrompt).toContain("Clarifying time scope reply: this month");
  });

  it("resolves a time-scope clarification reply back into the original visitor question for the model loop", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "how many visitors did we get" },
            {
              role: "assistant",
              content:
                "Which time period do you want for visitors or traffic: today, this week, this month, this quarter, this year, or all time?"
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Visitor answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "this quarter",
      sessionId: "session-visitors-follow-up-time-scope",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Visitor answer.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userMessage).toBe("how many visitors did we get this quarter");
    expect(requests[0]?.systemPrompt).toContain("Resolved missing time scope for this turn:");
    expect(requests[0]?.systemPrompt).toContain("Original question: how many visitors did we get");
    expect(requests[0]?.systemPrompt).toContain("Clarifying time scope reply: this quarter");
  });

  it("resolves a time-scope clarification reply back into the original revenue breakdown question for the model loop", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "which source drove revenue" },
            {
              role: "assistant",
              content:
                "Which time period do you want for the revenue/source breakdown: today, this week, this month, this quarter, this year, or all time?"
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Revenue breakdown answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "this quarter",
      sessionId: "session-revenue-breakdown-follow-up-time-scope",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Revenue breakdown answer.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userMessage).toBe("which source drove revenue this quarter");
    expect(requests[0]?.systemPrompt).toContain("Resolved missing time scope for this turn:");
    expect(requests[0]?.systemPrompt).toContain("Original question: which source drove revenue");
    expect(requests[0]?.systemPrompt).toContain("Clarifying time scope reply: this quarter");
  });

  it("resolves a business-metric clarification reply back into the original best-channel question for the model loop", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "what's our best channel" },
            {
              role: "assistant",
              content: "Do you mean best channel for traffic, signups, conversion rate, or revenue?"
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Signup-channel answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "signups",
      sessionId: "session-business-metric-follow-up",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("For \"what's our best channel for signups\", which time period do you want");
    expect(requests).toHaveLength(0);
  });

  it("resolves a time-scope clarification reply back into the original business-metric question for the model loop", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "what's our best channel" },
            {
              role: "assistant",
              content: "Do you mean best channel for traffic, signups, conversion rate, or revenue?"
            },
            { role: "user", content: "signups" },
            {
              role: "assistant",
              content:
                "For \"what's our best channel for signups\", which time period do you want for the signup/source breakdown: today, this week, this month, this quarter, this year, or all time?"
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Signup breakdown answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "this month",
      sessionId: "session-business-metric-time-follow-up",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Signup breakdown answer.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userMessage).toBe("what's our best channel for signups this month");
    expect(requests[0]?.systemPrompt).toContain("Resolved missing time scope for this turn:");
    expect(requests[0]?.systemPrompt).toContain("Original question: what's our best channel for signups");
    expect(requests[0]?.systemPrompt).toContain("Clarifying time scope reply: this month");
  });

  it("chains business-metric and time-scope clarifications back into the original question for the model loop", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "what's our best channel" },
            {
              role: "assistant",
              content: "Do you mean best channel for traffic, signups, conversion rate, or revenue?"
            },
            { role: "user", content: "signups" },
            {
              role: "assistant",
              content:
                "For \"what's our best channel for signups\", which time period do you want for the signup/source breakdown: today, this week, this month, this quarter, this year, or all time?"
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Chained clarification answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "this quarter",
      sessionId: "session-business-metric-time-chain",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Chained clarification answer.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userMessage).toBe("what's our best channel for signups this quarter");
    expect(requests[0]?.systemPrompt).toContain("Resolved missing time scope for this turn:");
    expect(requests[0]?.systemPrompt).toContain("Original question: what's our best channel for signups");
    expect(requests[0]?.systemPrompt).toContain("Clarifying time scope reply: this quarter");
  });

  it("accepts a combined business-metric and time-scope clarification reply in one hop", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "what's our best channel" },
            {
              role: "assistant",
              content: "Do you mean best channel for traffic, signups, conversion rate, or revenue?"
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Combined clarification answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "signups this quarter",
      sessionId: "session-business-metric-combined-follow-up",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Combined clarification answer.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userMessage).toBe("what's our best channel for signups this quarter");
    expect(requests[0]?.systemPrompt).toContain("Resolved missing business metric scope for this turn:");
    expect(requests[0]?.systemPrompt).toContain("Clarifying business metric reply: signups this quarter");
    expect(requests[0]?.systemPrompt).toContain("resolves the previously ambiguous business metric target and time period");
  });

  it("accepts a combined business-metric and all-time clarification reply in one hop", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "what's our best channel" },
            {
              role: "assistant",
              content: "Do you mean best channel for traffic, signups, conversion rate, or revenue?"
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Combined all-time answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "revenue all time",
      sessionId: "session-business-metric-combined-all-time",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Combined all-time answer.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userMessage).toBe("what's our best channel for revenue all time");
    expect(requests[0]?.systemPrompt).toContain("Resolved missing business metric scope for this turn:");
    expect(requests[0]?.systemPrompt).toContain("Clarifying business metric reply: revenue all time");
  });

  it("accepts a fuller business-metric clarification reply phrase", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "what's our best channel" },
            {
              role: "assistant",
              content: "Do you mean best channel for traffic, signups, conversion rate, or revenue?"
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Full phrase answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "best channel for signups",
      sessionId: "session-business-metric-full-phrase",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("For \"what's our best channel for signups\", which time period do you want");
    expect(requests).toHaveLength(0);
  });

  it("reconstructs a business-metric clarification naturally when the original question already had a time scope", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "what's our best channel this month" },
            {
              role: "assistant",
              content: "Do you mean best channel for traffic, signups, conversion rate, or revenue?"
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Natural reconstruction answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "signups",
      sessionId: "session-business-metric-existing-time-scope",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Natural reconstruction answer.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userMessage).toBe("what's our best channel for signups this month");
    expect(requests[0]?.systemPrompt).toContain("Clarifying business metric reply: signups");
  });

  it("prefers the reply's explicit time scope when the original business question already had one", async () => {
    const requests: ModelRequest[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession(sessionId) {
        return {
          id: sessionId,
          messages: [
            { role: "user", content: "what's our best channel this month" },
            {
              role: "assistant",
              content: "Do you mean best channel for traffic, signups, conversion rate, or revenue?"
            }
          ],
          actionCalls: []
        };
      },
      async searchSessions() {
        return [];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      sessionStore: store,
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [];
        }
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "Override scope answer." };
        }
      }
    });

    const result = await controller.chat({
      message: "signups this quarter",
      sessionId: "session-business-metric-scope-override",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Override scope answer.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userMessage).toBe("what's our best channel for signups this quarter");
    expect(requests[0]?.userMessage).not.toContain("this month this quarter");
  });

  it("stores deterministic preferred X-account memory when resolving an account", async () => {
    const remembered: Array<{ workspaceId: string; actorId: string; sessionId: string; facts: unknown[] }> = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      memoryManager: {
        async reviewTurn() {},
        async rememberFacts(input) {
          remembered.push(input);
        }
      },
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [{ sourceId: "src_x_1", connectionName: "YourHandle Account", username: "yourhandle" }];
        }
      }),
      modelClient: {
        complete: async () => ({ message: "You have 31 followers." })
      }
    });

    await controller.chat({
      message: "how many followers i have",
      sessionId: "session-x-memory",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(remembered).toEqual([
      {
        workspaceId: "workspace-1",
        actorId: "operator-1",
        sessionId: "session-x-memory",
        facts: [
          {
            scope: "source_naming",
            fact: "Prefer connected X account @yourhandle (YourHandle Account) for first-person X questions."
          }
        ]
      }
    ]);
  });

  it("injects resolved X account context into the prompt for first-person X questions", async () => {
    const prompts: string[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: {
        async advise() {
          return {
            promptSections: [
              "Resolved X account context for this turn:",
              JSON.stringify({
                sourceId: "src_x_1",
                connectionName: "YourHandle Account",
                username: "yourhandle"
              }),
              "Interpret first-person X questions as referring to this connected account unless the user says otherwise.",
              "If you need to narrow X data to this account, use a filter with field `source_id` and value `src_x_1`. Do not use `source_id` or `username` as a grouped/queryable dimension unless a tool result explicitly says they are allowed dimensions."
            ]
          };
        }
      },
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "You have 31 followers." };
        }
      }
    });

    const result = await controller.chat({
      message: "how many followers i have",
      sessionId: "session-x-resolved",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("You have 31 followers.");
    expect(prompts[0]).toContain("<turn-resolution-context>");
    expect(prompts[0]).toContain("YourHandle Account");
    expect(prompts[0]).toContain("\"username\":\"yourhandle\"");
    expect(prompts[0]).toContain("field `source_id` and value `src_x_1`");
  });

  it("does not misread question words as bare X handles in first-person tweet questions", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_river", connectionName: "X yourhandle live", username: "yourhandle", accountExternalId: "yourhandle" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "I found your latest tweet." };
        }
      }
    });

    const result = await controller.chat({
      message: "what's my latest tweet",
      sessionId: "session-x-latest-tweet",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("I found your latest tweet.");
    expect(prompts[0]).toContain("\"sourceId\":\"src_river\"");
    expect(prompts[0]).toContain("\"username\":\"yourhandle\"");
    expect(result.message).not.toContain("@what");
  });

  it("does not misread ordinary prose after X as a bare handle", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_river", connectionName: "X yourhandle live", username: "yourhandle", accountExternalId: "yourhandle" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Compare spend efficiency across channels." };
        }
      }
    });

    const result = await controller.chat({
      message: "When we increase spend on X or Meta Ads, do we actually get proportionate gains in engagement and downstream results, or are we just paying more for the same attention?",
      sessionId: "session-x-meta-no-bare-handle-the",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toBe("Compare spend efficiency across channels.");
    expect(prompts[0]).not.toContain("I do not have connected X data for @the");
    expect(prompts[0]).not.toContain("I do not have connected X data for @or");
  });

  it("injects timing-analysis guidance for first-person X timing questions", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_river", connectionName: "X yourhandle live", username: "yourhandle", accountExternalId: "yourhandle" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Timing analysis." };
        }
      }
    });

    await controller.chat({
      message: "what are the best times for me to tweet",
      sessionId: "session-x-timing-guidance",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("published_hour_utc");
    expect(prompts[0]).toContain("published_weekday_utc");
    expect(prompts[0]).toContain("posting-volume buckets");
  });

  it("injects pattern-analysis guidance for broader first-person X comparison prompts", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_river", connectionName: "X yourhandle live", username: "yourhandle", accountExternalId: "yourhandle" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Pattern analysis." };
        }
      }
    });

    await controller.chat({
      message: "analyse what my best performing tweets had in common",
      sessionId: "session-x-pattern-guidance",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("For X pattern-analysis questions");
    expect(prompts[0]).toContain("Do not stop at naming a single winner");
    expect(prompts[0]).toContain("reply-versus-original-post patterns");
  });

  it("injects strategy guidance for first-person X content-recommendation prompts", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_river", connectionName: "X yourhandle live", username: "yourhandle", accountExternalId: "yourhandle" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Strategy guidance." };
        }
      }
    });

    await controller.chat({
      message: "what should i post more of on x",
      sessionId: "session-x-strategy-guidance",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("X strategy refinement guidance:");
    expect(prompts[0]).toContain("Before recommending what to post more of");
  });

  it("injects X stop-posting guidance for first-person X negative-strategy prompts", async () => {
    const prompts: string[] = [];
    const { createSourceAwareQueryAdvisor } = await import("../src/query-advisor.js");
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: createSourceAwareQueryAdvisor({
        async listConnectedXIdentities() {
          return [
            { sourceId: "src_river", connectionName: "X yourhandle live", username: "yourhandle", accountExternalId: "yourhandle" }
          ];
        }
      }),
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "Negative strategy guidance." };
        }
      }
    });

    await controller.chat({
      message: "what should i stop posting on x",
      sessionId: "session-x-negative-strategy-guidance",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("If the user is asking what to stop posting");
    expect(prompts[0]).toContain("Do not pretend the returned top-post data proves what to stop doing");
  });

  it("passes turn-resolution context through without injecting query-family recipes", async () => {
    const prompts: string[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: {
        async advise() {
          return {
            promptSections: [
              "Resolved X account context for this turn:",
              "{\"username\":\"yourhandle\"}",
              "Interpret first-person X questions as referring to this connected account unless the user says otherwise."
            ]
          };
        }
      },
      modelClient: {
        complete: async (request) => {
          prompts.push(request.systemPrompt);
          return { message: "done" };
        }
      }
    });

    await controller.chat({
      message: "my best tweet",
      sessionId: "session-x-best",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(prompts[0]).toContain("<turn-resolution-context>");
    expect(prompts[0]).toContain("\"username\":\"yourhandle\"");
    expect(prompts[0]).not.toContain("query recipe for this turn");
  });

  it("builds refinement guidance after a weak best-post breakdown result", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("my best tweet", [
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [
              {
                x_post_id: "post_1",
                post_url: "https://x.com/example/status/1",
                body_text: "https://x.com/example/status/1",
                x_public_engagement: "7"
              }
            ],
            metric: "x_public_engagement",
            view: "queryable.vw_x_post_public_metrics"
          },
          provenance: ["queryable.vw_x_post_public_metrics"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Best-post refinement guidance:");
    expect(sections.join("\n")).toContain("too thin for a strong final answer");
  });

  it("builds timing-analysis refinement guidance when engagement buckets exist without posting-volume buckets", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("what are the best times for me to tweet", [
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [{ published_hour_utc: 2, x_public_engagement: "33" }],
            metric: "x_public_engagement",
            view: "queryable.vw_x_post_public_metrics"
          },
          provenance: ["queryable.vw_x_post_public_metrics"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Timing-analysis refinement guidance:");
    expect(sections.join("\n")).toContain("fetch `x_post_count` over the same time buckets");
  });

  it("builds X metric/view mismatch recovery guidance after invalid X query errors", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("When we increase spend on X or Meta Ads, are we getting proportionate gains?", [
      {
        name: "run_metric_query",
        result: {
          status: "error",
          actionId: "run_metric_query",
          input: { metric: "x_post_count", view: "queryable.vw_x_post_public_metrics" },
          error: {
            code: "action_execution_failed",
            message: "unsupported_view_for_metric:x_post_count:queryable.vw_x_post_public_metrics"
          }
        }
      }
    ]);

    expect(sections.join("\n")).toContain("X metric/view recovery guidance:");
    expect(sections.join("\n")).toContain("`x_post_count` belongs on `queryable.vw_x_authored_activity`");
    expect(sections.join("\n")).toContain("describe_metric");
    expect(sections.join("\n")).toContain("Do not retry `x_post_count` on `queryable.vw_x_post_public_metrics`");
  });

  it("builds failed-sync freshness guidance for current X answers", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("what are my best tweets today?", [
      {
        name: "sync_source_now",
        result: {
          status: "error",
          actionId: "sync_source_now",
          error: {
            code: "action_execution_failed",
            message: "Unsupported state or unable to authenticate data"
          }
        }
      },
      {
        name: "run_metric_query",
        result: createEnvelope({
          actionId: "run_metric_query",
          authority: "tool_agent",
          data: {
            rows: [{ body_text: "stored tweet", x_public_engagement: "17" }],
            metric: "x_public_engagement",
            view: "queryable.vw_x_post_public_metrics"
          },
          provenance: ["queryable.vw_x_post_public_metrics"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("X freshness failure guidance:");
    expect(sections.join("\n")).toContain("Unsupported state or unable to authenticate data");
    expect(sections.join("\n")).toContain("Do not present stored X rows as latest, current, same-day-fresh");
    expect(sections.join("\n")).toContain("local stored/synced data from before the failed refresh");
  });

  it("clears failed-sync freshness guidance after a later successful X refresh", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("what are my best tweets today?", [
      {
        name: "sync_source_now",
        result: {
          status: "error",
          actionId: "sync_source_now",
          error: {
            code: "action_execution_failed",
            message: "Unsupported state or unable to authenticate data"
          }
        }
      },
      {
        name: "sync_source_now",
        result: createEnvelope({
          actionId: "sync_source_now",
          authority: "tool_agent",
          data: {
            sourceId: "src_x",
            provider: "x",
            syncRunId: "sync_retry",
            refreshWindowDays: 1,
            recordsExtracted: 2,
            recordsLoaded: 2
          },
          provenance: ["sync_runs", "x_post"]
        })
      }
    ]);

    expect(sections.join("\n")).not.toContain("X freshness failure guidance:");
  });

  it("builds pattern-analysis refinement guidance when the top-post set is too thin", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("analyse what my best performing tweets had in common", [
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [{ x_post_id: "1", body_text: "https://x.com/example/status/1", x_public_engagement: "7" }],
            metric: "x_public_engagement",
            view: "queryable.vw_x_post_public_metrics"
          },
          provenance: ["queryable.vw_x_post_public_metrics"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("X pattern-analysis refinement guidance:");
    expect(sections.join("\n")).toContain("too thin for a strong comparison answer");
  });

  it("builds negative-strategy refinement guidance when the post sample is too thin", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("what should i stop posting on x", [
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [{ x_post_id: "1", body_text: "https://x.com/example/status/1", x_public_engagement: "7" }],
            metric: "x_public_engagement",
            view: "queryable.vw_x_post_public_metrics"
          },
          provenance: ["queryable.vw_x_post_public_metrics"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("X negative-strategy refinement guidance:");
    expect(sections.join("\n")).toContain("too thin for a strong stop-posting recommendation");
    expect(sections.join("\n")).toContain("grounded caution from one-sided winner data");
  });

  it("builds open-ended refinement guidance when a generic ranked result is too thin", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("what stands out here", [
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [{ provider: "stripe", currency: "usd", recognized_revenue: "12000" }],
            metric: "recognized_revenue",
            view: "queryable.vw_revenue_by_source"
          },
          provenance: ["queryable.vw_revenue_by_source"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Open-ended analysis refinement guidance:");
    expect(sections.join("\n")).toContain("thin ranked result for recognized_revenue");
    expect(sections.join("\n")).toContain("what actually stands out and why it matters");
  });

  it("builds open-ended refinement guidance when a generic scalar result lacks context", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("what should i know here", [
      {
        name: "run_metric_query",
        result: createEnvelope({
          actionId: "run_metric_query",
          authority: "tool_agent",
          data: {
            rows: [{ site_visitors: "4321" }],
            metric: "site_visitors",
            view: "queryable.vw_site_traffic"
          },
          provenance: ["queryable.vw_site_traffic"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Open-ended analysis refinement guidance:");
    expect(sections.join("\n")).toContain("scalar result for site_visitors");
    expect(sections.join("\n")).toContain("why the result matters instead of just restating it");
  });

  it("builds open-ended refinement guidance when only source coverage is known", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("what should i know here", [
      {
        name: "list_sources",
        result: createEnvelope({
          actionId: "list_sources",
          authority: "tool_agent",
          data: {
            sources: [{ id: "src_ga4", provider: "google_analytics_4", status: "connected" }]
          },
          provenance: ["sources"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Open-ended analysis refinement guidance:");
    expect(sections.join("\n")).toContain("which sources are connected");
    expect(sections.join("\n")).toContain("what metrics or views are available");
  });

  it("builds metric-question refinement guidance when a targeted metric question bailed at list_sources", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    // "how many clicks?" is a targeted (not open-ended) metric question. The old gate only fired
    // for open-ended prompts, so this previously returned no guidance and let the model stop here.
    const sections = buildQueryRefinementSections("how many clicks did we get", [
      {
        name: "list_sources",
        result: createEnvelope({
          actionId: "list_sources",
          authority: "tool_agent",
          data: {
            sources: [{ id: "src_meta", provider: "meta_ads", status: "connected" }]
          },
          provenance: ["sources"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Metric-question refinement guidance:");
    expect(sections.join("\n")).toContain("only have a source list");
    expect(sections.join("\n")).toContain("Do not stop to ask for a time range");
  });

  it("also fires metric-question guidance for cost-per-lead phrasing", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("what's my cost per lead", [
      {
        name: "list_sources",
        result: createEnvelope({
          actionId: "list_sources",
          authority: "tool_agent",
          data: { sources: [{ id: "src_meta", provider: "meta_ads", status: "connected" }] },
          provenance: ["sources"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Metric-question refinement guidance:");
  });

  it("does NOT fire metric-question guidance once a metric result already exists", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("how many clicks did we get", [
      {
        name: "list_sources",
        result: createEnvelope({
          actionId: "list_sources",
          authority: "tool_agent",
          data: { sources: [{ id: "src_meta", provider: "meta_ads", status: "connected" }] },
          provenance: ["sources"]
        })
      },
      {
        name: "run_metric_query",
        result: createEnvelope({
          actionId: "run_metric_query",
          authority: "tool_agent",
          data: { rows: [{ meta_ads_clicks: "1234" }], metric: "meta_ads_clicks", view: "queryable.vw_meta_ads_campaign_daily" },
          provenance: ["queryable.vw_meta_ads_campaign_daily"]
        })
      }
    ]);

    expect(sections.join("\n")).not.toContain("Metric-question refinement guidance:");
  });

  it("does NOT fire metric-question guidance for a non-metric prompt with only a source list", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("which sources are connected", [
      {
        name: "list_sources",
        result: createEnvelope({
          actionId: "list_sources",
          authority: "tool_agent",
          data: { sources: [{ id: "src_meta", provider: "meta_ads", status: "connected" }] },
          provenance: ["sources"]
        })
      }
    ]);

    expect(sections.join("\n")).not.toContain("Metric-question refinement guidance:");
  });

  it("builds open-ended refinement guidance when only metric coverage is known", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("what should i know here", [
      {
        name: "list_metrics",
        result: createEnvelope({
          actionId: "list_metrics",
          authority: "tool_agent",
          data: {
            metrics: [{ id: "site_visitors" }, { id: "signup_count" }]
          },
          provenance: ["metric_definitions"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Open-ended analysis refinement guidance:");
    expect(sections.join("\n")).toContain("what can be queried");
    expect(sections.join("\n")).toContain("which sources are actually connected");
  });

  it("builds open-ended refinement guidance when freshness context is missing", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("what should i know here", [
      {
        name: "list_sources",
        result: createEnvelope({
          actionId: "list_sources",
          authority: "tool_agent",
          data: {
            sources: [{ id: "src_ga4", provider: "google_analytics_4", status: "connected" }]
          },
          provenance: ["sources"]
        })
      },
      {
        name: "list_metrics",
        result: createEnvelope({
          actionId: "list_metrics",
          authority: "tool_agent",
          data: {
            metrics: [{ id: "site_visitors" }]
          },
          provenance: ["metric_definitions"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Open-ended analysis refinement guidance:");
    expect(sections.join("\n")).toContain("not enough freshness context yet");
    expect(sections.join("\n")).toContain("fetch recent sync or source-health context");
  });

  it("builds capability-exploration refinement guidance when only high-level schema inventory is available", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("what can i inspect?", [
      {
        name: "list_metrics",
        result: createEnvelope({
          actionId: "list_metrics",
          authority: "tool_agent",
          data: {
            metrics: [{ id: "recognized_revenue" }, { id: "site_visitors" }]
          },
          provenance: ["metric_definitions"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Capability-exploration refinement guidance:");
    expect(sections.join("\n")).toContain("high-level schema inventory");
    expect(sections.join("\n")).toContain("fetch at least one metric or view detail");
  });

  it("builds open-ended refinement guidance when workspace inventory exists but no analytical signal has been fetched yet", async () => {
    const { buildQueryRefinementSections } = await import("../src/query-advisor.js");
    const sections = buildQueryRefinementSections("what should i know here", [
      {
        name: "list_sources",
        result: createEnvelope({
          actionId: "list_sources",
          authority: "tool_agent",
          data: {
            sources: [{ id: "src_ga4", provider: "google_analytics_4", status: "connected" }]
          },
          provenance: ["sources"]
        })
      },
      {
        name: "get_recent_sync_runs",
        result: createEnvelope({
          actionId: "get_recent_sync_runs",
          authority: "tool_agent",
          data: {
            syncRuns: [{ id: "sync_1", source_id: "src_ga4", status: "succeeded" }]
          },
          provenance: ["sync_runs"]
        })
      },
      {
        name: "list_metrics",
        result: createEnvelope({
          actionId: "list_metrics",
          authority: "tool_agent",
          data: {
            metrics: [{ id: "site_visitors" }, { id: "signup_count" }]
          },
          provenance: ["metric_definitions"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Open-ended analysis refinement guidance:");
    expect(sections.join("\n")).toContain("workspace inventory and freshness context");
    expect(sections.join("\n")).toContain("fetch at least one supporting metric or breakdown");
  });

  it("injects open-ended refinement guidance into the second model pass when a broad scalar result is too thin", async () => {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ site_visitors: "4321" }],
              metric: "site_visitors",
              view: "queryable.vw_site_traffic"
            },
            provenance: ["queryable.vw_site_traffic"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                {
                  id: "call_visitors",
                  name: "run_metric_query",
                  input: { metric: "site_visitors", view: "queryable.vw_site_traffic" }
                }
              ]
            };
          }
          return { message: "Open-ended answer." };
        }
      }
    });

    await controller.chat({
      message: "what should i know here",
      sessionId: "session-open-ended-refinement-prompt",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.systemPrompt).toContain("Open-ended analysis refinement guidance:");
    expect(requests[1]?.systemPrompt).toContain("scalar result for site_visitors");
    expect(requests[1]?.systemPrompt).toContain("why the result matters instead of just restating it");
  });

  it("injects capability-exploration refinement guidance into the second model pass when only list_metrics returned", async () => {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_metrics: (_input, context) =>
          createEnvelope({
            actionId: "list_metrics",
            authority: context.authority,
            data: {
              metrics: [{ id: "recognized_revenue" }, { id: "site_visitors" }]
            },
            provenance: ["metric_definitions"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [{ id: "call_metrics", name: "list_metrics", input: {} }]
            };
          }
          return { message: "Capability answer." };
        }
      }
    });

    await controller.chat({
      message: "what can i inspect?",
      sessionId: "session-capability-refinement-prompt",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.systemPrompt).toContain("Capability-exploration refinement guidance:");
    expect(requests[1]?.systemPrompt).toContain("high-level schema inventory");
    expect(requests[1]?.systemPrompt).toContain("fetch at least one metric or view detail");
  });

  it("injects open-ended refinement guidance into the second model pass when only workspace inventory has been gathered", async () => {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [{ id: "src_ga4", provider: "google_analytics_4", status: "connected" }]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [{ id: "sync_1", source_id: "src_ga4", status: "succeeded" }]
            },
            provenance: ["sync_runs"]
          }),
        list_metrics: (_input, context) =>
          createEnvelope({
            actionId: "list_metrics",
            authority: context.authority,
            data: {
              metrics: [{ id: "site_visitors" }, { id: "signup_count" }]
            },
            provenance: ["metric_definitions"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                { id: "call_sources", name: "list_sources", input: {} },
                { id: "call_syncs", name: "get_recent_sync_runs", input: {} },
                { id: "call_metrics", name: "list_metrics", input: {} }
              ]
            };
          }
          return { message: "Workspace answer." };
        }
      }
    });

    await controller.chat({
      message: "what should i know here",
      sessionId: "session-open-ended-inventory-refinement-prompt",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.systemPrompt).toContain("Open-ended analysis refinement guidance:");
    expect(requests[1]?.systemPrompt).toContain("workspace inventory and freshness context");
    expect(requests[1]?.systemPrompt).toContain("fetch at least one supporting metric or breakdown");
  });

  it.skip("auto-refines weak best-post breakdowns with a richer controller-side breakdown", async () => {
    const requestedLimits: number[] = [];
    const progressMessages: string[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_breakdown_query: (input, context) => {
          const limit = Number((input as Record<string, unknown>).limit ?? 0);
          requestedLimits.push(limit);
          return createEnvelope({
            actionId: "run_breakdown_query",
            authority: context.authority,
            data:
              requestedLimits.length >= 2
                ? {
                    rows: [
                      { x_post_id: "1", body_text: "First strong post", x_public_engagement: "19" },
                      { x_post_id: "2", body_text: "Second strong post", x_public_engagement: "13" },
                      { x_post_id: "3", body_text: "Third strong post", x_public_engagement: "8" }
                    ],
                    metric: "x_public_engagement",
                    view: "queryable.vw_x_post_public_metrics"
                  }
                : {
                    rows: [
                      { x_post_id: "1", body_text: "https://x.com/example/status/1", x_public_engagement: "7" }
                    ],
                    metric: "x_public_engagement",
                    view: "queryable.vw_x_post_public_metrics"
                  },
            provenance: ["queryable.vw_x_post_public_metrics"]
          });
        }
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    const result = await controller.chat({
      message: "my best tweet",
      sessionId: "session-auto-refine-best",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        progressMessages.push(event.message);
      }
    });

    expect(requestedLimits).toEqual([5, 5]);
    expect(result.actionCalls.map((call) => call.id)).toContain("auto_refine_best_post");
    expect(result.message).toContain("Your best tweet earned 19 public engagements.");
    expect(progressMessages).toContain("Re-running engagement breakdown with richer post detail.");
  });

  it("emits timing-specific refinement progress when timing evidence needs another pass", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_breakdown_query: (_input, context) =>
          createEnvelope({
            actionId: "run_breakdown_query",
            authority: context.authority,
            data: {
              rows: [{ published_hour_utc: 2, x_public_engagement: "33" }],
              metric: "x_public_engagement",
              view: "queryable.vw_x_post_public_metrics"
            },
            provenance: ["queryable.vw_x_post_public_metrics"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                {
                  id: "call_timing_breakdown",
                  name: "run_breakdown_query",
                  input: {
                    metric: "x_public_engagement",
                    view: "queryable.vw_x_post_public_metrics",
                    groupBy: ["published_hour_utc"]
                  }
                }
              ]
            };
          }
          return { message: "Timing answer." };
        }
      }
    });

    await controller.chat({
      message: "what are the best times for me to tweet",
      sessionId: "session-timing-refinement-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({
      stage: "resolve",
      message: "Refining timing analysis with posting-volume context."
    });
  });

  it("emits strategy-specific refinement progress when recommendation evidence is too thin", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_breakdown_query: (_input, context) =>
          createEnvelope({
            actionId: "run_breakdown_query",
            authority: context.authority,
            data: {
              rows: [{ x_post_id: "1", body_text: "https://x.com/example/status/1", x_public_engagement: "7" }],
              metric: "x_public_engagement",
              view: "queryable.vw_x_post_public_metrics"
            },
            provenance: ["queryable.vw_x_post_public_metrics"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                {
                  id: "call_strategy_breakdown",
                  name: "run_breakdown_query",
                  input: {
                    metric: "x_public_engagement",
                    view: "queryable.vw_x_post_public_metrics"
                  }
                }
              ]
            };
          }
          return { message: "Strategy answer." };
        }
      }
    });

    await controller.chat({
      message: "what should i post more of on x",
      sessionId: "session-strategy-refinement-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({
      stage: "resolve",
      message: "Refining X strategy answer with a richer post sample."
    });
  });

  it("emits open-ended-analysis refinement progress when broad evidence needs more context", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ site_visitors: "4321" }],
              metric: "site_visitors",
              view: "queryable.vw_site_traffic"
            },
            provenance: ["queryable.vw_site_traffic"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                {
                  id: "call_visitors",
                  name: "run_metric_query",
                  input: {
                    metric: "site_visitors",
                    view: "queryable.vw_site_traffic"
                  }
                }
              ]
            };
          }
          return { message: "Open-ended answer." };
        }
      }
    });

    await controller.chat({
      message: "what should i know here",
      sessionId: "session-open-ended-refinement-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({
      stage: "resolve",
      message: "Refining open-ended analysis with more comparison context."
    });
  });

  it("emits capability-exploration refinement progress when schema inventory needs more detail", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_metrics: (_input, context) =>
          createEnvelope({
            actionId: "list_metrics",
            authority: context.authority,
            data: {
              metrics: [{ id: "recognized_revenue" }, { id: "site_visitors" }]
            },
            provenance: ["metric_definitions"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [{ id: "call_metrics", name: "list_metrics", input: {} }]
            };
          }
          return { message: "Capability answer." };
        }
      }
    });

    await controller.chat({
      message: "what can i inspect?",
      sessionId: "session-capability-refinement-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({
      stage: "resolve",
      message: "Refining capability overview with more query detail."
    });
  });

  it("emits inventory-specific refinement progress when workspace context still lacks a concrete signal", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [{ id: "src_ga4", provider: "google_analytics_4", status: "connected" }]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [{ id: "sync_1", source_id: "src_ga4", status: "succeeded" }]
            },
            provenance: ["sync_runs"]
          }),
        list_metrics: (_input, context) =>
          createEnvelope({
            actionId: "list_metrics",
            authority: context.authority,
            data: {
              metrics: [{ id: "site_visitors" }, { id: "signup_count" }]
            },
            provenance: ["metric_definitions"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                { id: "call_sources", name: "list_sources", input: {} },
                { id: "call_syncs", name: "get_recent_sync_runs", input: {} },
                { id: "call_metrics", name: "list_metrics", input: {} }
              ]
            };
          }
          return { message: "Workspace answer." };
        }
      }
    });

    await controller.chat({
      message: "what should i know here",
      sessionId: "session-open-ended-inventory-refinement-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({
      stage: "resolve",
      message: "Refining workspace analysis with a concrete signal."
    });
  });

  it("builds best-post final synthesis guidance after a strong ranked breakdown", async () => {
    const { buildQuerySynthesisSections } = await import("../src/query-advisor.js");
    const sections = buildQuerySynthesisSections("my best tweet", [
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [
              { x_post_id: "1", body_text: "First strong post", x_public_engagement: "19" },
              { x_post_id: "2", body_text: "Second strong post", x_public_engagement: "13" },
              { x_post_id: "3", body_text: "Third strong post", x_public_engagement: "8" }
            ],
            metric: "x_public_engagement",
            view: "queryable.vw_x_post_public_metrics"
          },
          provenance: ["queryable.vw_x_post_public_metrics"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Best-post final synthesis guidance:");
    expect(sections.join("\n")).toContain("Lead with the winning post text");
    expect(sections.join("\n")).toContain("Mention at least two runner-ups");
    expect(sections.join("\n")).toContain("Prefer a conversational ranked list or bullets");
  });

  it("does not classify tweet timing questions as best-post ranking questions", async () => {
    const { classifyQueryFamily, buildQueryRefinementSections } = await import("../src/query-advisor.js");
    expect(classifyQueryFamily("what are the best times for me to tweet")).toBe("other");
    expect(buildQueryRefinementSections("what are the best times for me to tweet", [])).toEqual([]);
  });

  it("builds direct metric synthesis guidance for follower-count questions after metric results return", async () => {
    const { buildQuerySynthesisSections } = await import("../src/query-advisor.js");
    const sections = buildQuerySynthesisSections("how many followers i have", [
      {
        name: "run_metric_query",
        result: createEnvelope({
          actionId: "run_metric_query",
          authority: "tool_agent",
          data: {
            rows: [{ x_follower_count: "31" }],
            metric: "x_follower_count",
            view: "queryable.vw_x_profile_public_metrics"
          },
          provenance: ["queryable.vw_x_profile_public_metrics"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Follower-count final synthesis guidance:");
    expect(sections.join("\n")).toContain("latest public X profile metrics snapshot");
    expect(sections.join("\n")).toContain("avoid table-heavy formatting");
  });

  it("builds generic breakdown synthesis guidance for non-family questions after ranked rows return", async () => {
    const { buildQuerySynthesisSections } = await import("../src/query-advisor.js");
    const sections = buildQuerySynthesisSections("what stands out here", [
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [
              { provider: "stripe", currency: "usd", recognized_revenue: "12000" },
              { provider: "posthog", currency: "usd", recognized_revenue: "3000" }
            ],
            metric: "recognized_revenue",
            view: "queryable.vw_revenue_by_source"
          },
          provenance: ["queryable.vw_revenue_by_source"]
        })
      },
      {
        name: "list_sources",
        result: createEnvelope({
          actionId: "list_sources",
          authority: "tool_agent",
          data: {
            sources: [{ id: "src_stripe", provider: "stripe", status: "connected", connection_name: "Stripe Live" }]
          },
          provenance: ["sources"]
        })
      },
      {
        name: "get_recent_sync_runs",
        result: createEnvelope({
          actionId: "get_recent_sync_runs",
          authority: "tool_agent",
          data: {
            syncRuns: [{ id: "sync_1", source_id: "src_stripe", status: "succeeded" }]
          },
          provenance: ["sync_runs"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Generic breakdown final synthesis guidance:");
    expect(sections.join("\n")).toContain("ranked rows for recognized_revenue");
    expect(sections.join("\n")).toContain("Top row: stripe / usd at recognized_revenue=12000.");
    expect(sections.join("\n")).toContain("Runner-up: posthog / usd at recognized_revenue=3000.");
    expect(sections.join("\n")).toContain("Pattern: the winner is clearly ahead of the next row.");
    expect(sections.join("\n")).toContain("Source context: stripe (Stripe Live) has sync-run history, latest sync succeeded");
    expect(sections.join("\n")).toContain("do not describe a source as never synced");
    expect(sections.join("\n")).toContain("Lead with the strongest takeaway");
    expect(sections.join("\n")).toContain("Explain why that takeaway matters");
    expect(sections.join("\n")).toContain("Cite the strongest concrete evidence row");
    expect(sections.join("\n")).toContain("End with the next useful question or drilldown");
    expect(sections.join("\n")).toContain("runner-ups");
  });

  it("builds timing-analysis synthesis guidance for X time-bucket breakdowns", async () => {
    const { buildQuerySynthesisSections } = await import("../src/query-advisor.js");
    const sections = buildQuerySynthesisSections("what are the best times for me to tweet", [
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [
              { published_hour_utc: 2, x_public_engagement: "33" },
              { published_hour_utc: 22, x_public_engagement: "20" },
              { published_hour_utc: 18, x_public_engagement: "14" }
            ],
            metric: "x_public_engagement",
            view: "queryable.vw_x_post_public_metrics"
          },
          provenance: ["queryable.vw_x_post_public_metrics"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Timing-analysis synthesis guidance:");
    expect(sections.join("\n")).toContain("Top hour buckets:");
    expect(sections.join("\n")).toContain("directional");
    expect(sections.join("\n")).toContain("posting-volume buckets");
  });

  it("builds combined timing-analysis guidance when engagement and posting-volume buckets are both present", async () => {
    const { buildQuerySynthesisSections } = await import("../src/query-advisor.js");
    const sections = buildQuerySynthesisSections("what are the best times for me to tweet", [
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [
              { published_hour_utc: 2, x_public_engagement: "33" },
              { published_weekday_utc: 2, x_public_engagement: "66" }
            ],
            metric: "x_public_engagement",
            view: "queryable.vw_x_post_public_metrics"
          },
          provenance: ["queryable.vw_x_post_public_metrics"]
        })
      },
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [
              { published_hour_utc: 2, x_post_count: "5" },
              { published_weekday_utc: 2, x_post_count: "7" }
            ],
            metric: "x_post_count",
            view: "queryable.vw_x_authored_activity"
          },
          provenance: ["queryable.vw_x_authored_activity"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Timing-analysis synthesis guidance:");
    expect(sections.join("\n")).toContain("Highest engagement hour bucket:");
    expect(sections.join("\n")).toContain("Highest posting-volume hour bucket:");
    expect(sections.join("\n")).toContain("Compare engagement buckets against posting-volume buckets");
    expect(sections.join("\n")).toContain("signal may partly reflect frequency");
  });

  it("builds dedicated X pattern-analysis synthesis guidance for top-post comparison prompts", async () => {
    const { buildQuerySynthesisSections, classifyQueryFamily } = await import("../src/query-advisor.js");
    expect(classifyQueryFamily("analyse what my best performing tweets had in common")).toBe("best_post");
    const sections = buildQuerySynthesisSections("analyse what my best performing tweets had in common", [
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [
              { x_post_id: "1", body_text: "Hot take one", x_public_engagement: "33" },
              { x_post_id: "2", body_text: "Hot take two", x_public_engagement: "19" },
              { x_post_id: "3", body_text: "Founder post", x_public_engagement: "10" }
            ],
            metric: "x_public_engagement",
            view: "queryable.vw_x_post_public_metrics"
          },
          provenance: ["queryable.vw_x_post_public_metrics"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("X pattern-analysis synthesis guidance:");
    expect(sections.join("\n")).toContain("Top posts include:");
    expect(sections.join("\n")).toContain("Compare the top posts for recurring themes");
  });

  it("builds dedicated X strategy synthesis guidance for top-post recommendation prompts", async () => {
    const { buildQuerySynthesisSections } = await import("../src/query-advisor.js");
    const sections = buildQuerySynthesisSections("what should i post more of on x", [
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [
              { x_post_id: "1", body_text: "Hot take one", x_public_engagement: "33" },
              { x_post_id: "2", body_text: "Hot take two", x_public_engagement: "19" },
              { x_post_id: "3", body_text: "Founder post", x_public_engagement: "10" }
            ],
            metric: "x_public_engagement",
            view: "queryable.vw_x_post_public_metrics"
          },
          provenance: ["queryable.vw_x_post_public_metrics"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("X strategy synthesis guidance:");
    expect(sections.join("\n")).toContain("recommend what the user should post more of");
    expect(sections.join("\n")).toContain("2-3 concrete content recommendations");
  });

  it("builds dedicated X negative-strategy synthesis guidance for stop-posting prompts", async () => {
    const { buildQuerySynthesisSections } = await import("../src/query-advisor.js");
    const sections = buildQuerySynthesisSections("what should i stop posting on x", [
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [
              { x_post_id: "1", body_text: "Hot take one", x_public_engagement: "33" },
              { x_post_id: "2", body_text: "Hot take two", x_public_engagement: "19" },
              { x_post_id: "3", body_text: "Founder post", x_public_engagement: "10" }
            ],
            metric: "x_public_engagement",
            view: "queryable.vw_x_post_public_metrics"
          },
          provenance: ["queryable.vw_x_post_public_metrics"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("X negative-strategy synthesis guidance:");
    expect(sections.join("\n")).toContain("do not claim that the data directly proves what to stop posting");
    expect(sections.join("\n")).toContain("grounded observations about what performs well");
    expect(sections.join("\n")).toContain("cautious hypotheses");
  });

  it("builds generic metric synthesis guidance for non-family questions after scalar results return", async () => {
    const { buildQuerySynthesisSections } = await import("../src/query-advisor.js");
    const sections = buildQuerySynthesisSections("what should i know here", [
      {
        name: "run_metric_query",
        result: createEnvelope({
          actionId: "run_metric_query",
          authority: "tool_agent",
          data: {
            rows: [{ site_visitors: "4321" }],
            metric: "site_visitors",
            view: "queryable.vw_site_traffic"
          },
          provenance: ["queryable.vw_site_traffic"]
        })
      },
      {
        name: "list_sources",
        result: createEnvelope({
          actionId: "list_sources",
          authority: "tool_agent",
          data: {
            sources: [{ id: "src_ga4", provider: "google_analytics_4", status: "connected", connection_name: "Main Site GA4" }]
          },
          provenance: ["sources"]
        })
      },
      {
        name: "get_recent_sync_runs",
        result: createEnvelope({
          actionId: "get_recent_sync_runs",
          authority: "tool_agent",
          data: {
            syncRuns: [{ id: "sync_1", source_id: "src_ga4", status: "succeeded" }]
          },
          provenance: ["sync_runs"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Generic metric final synthesis guidance:");
    expect(sections.join("\n")).toContain("direct metric result for site_visitors");
    expect(sections.join("\n")).toContain("Metric result: site_visitors=4321.");
    expect(sections.join("\n")).toContain("Source context: google_analytics_4 (Main Site GA4) has sync-run history, latest sync succeeded");
    expect(sections.join("\n")).toContain("do not describe a source as never synced");
    expect(sections.join("\n")).toContain("Lead with the main takeaway in one sentence");
    expect(sections.join("\n")).toContain("explain why the result matters");
    expect(sections.join("\n")).toContain("next most useful follow-up question");
  });

  it("builds generic multi-signal synthesis guidance for broad prompts with multiple analytical signals", async () => {
    const { buildQuerySynthesisSections } = await import("../src/query-advisor.js");
    const sections = buildQuerySynthesisSections("what should i know here", [
      {
        name: "run_metric_query",
        result: createEnvelope({
          actionId: "run_metric_query",
          authority: "tool_agent",
          data: {
            rows: [{ site_visitors: "4321" }],
            metric: "site_visitors",
            view: "queryable.vw_site_traffic"
          },
          provenance: ["queryable.vw_site_traffic"]
        })
      },
      {
        name: "run_metric_query",
        result: createEnvelope({
          actionId: "run_metric_query",
          authority: "tool_agent",
          data: {
            rows: [{ recognized_revenue: "9800" }],
            metric: "recognized_revenue",
            view: "queryable.vw_revenue_by_source"
          },
          provenance: ["queryable.vw_revenue_by_source"]
        })
      },
      {
        name: "run_breakdown_query",
        result: createEnvelope({
          actionId: "run_breakdown_query",
          authority: "tool_agent",
          data: {
            rows: [{ published_hour_utc: 2, x_public_engagement: "33" }],
            metric: "x_public_engagement",
            view: "queryable.vw_x_post_public_metrics"
          },
          provenance: ["queryable.vw_x_post_public_metrics"]
        })
      },
      {
        name: "list_sources",
        result: createEnvelope({
          actionId: "list_sources",
          authority: "tool_agent",
          data: {
            sources: [{ id: "src_ga4", provider: "google_analytics_4", status: "connected", connection_name: "Main Site GA4" }]
          },
          provenance: ["sources"]
        })
      },
      {
        name: "get_recent_sync_runs",
        result: createEnvelope({
          actionId: "get_recent_sync_runs",
          authority: "tool_agent",
          data: {
            syncRuns: [{ id: "sync_1", source_id: "src_ga4", status: "succeeded" }]
          },
          provenance: ["sync_runs"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Generic multi-signal synthesis guidance:");
    expect(sections.join("\n")).toContain("site_visitors=4321");
    expect(sections.join("\n")).toContain("recognized_revenue=9800");
    expect(sections.join("\n")).toContain("x_public_engagement:");
    expect(sections.join("\n")).toContain("combine multiple signals instead of overfitting");
    expect(sections.join("\n")).toContain("strongest cross-workspace takeaway");
    expect(sections.join("\n")).toContain("prefer them over source-quality caveats in the lead");
    expect(sections.join("\n")).toContain("Keep source-quality caveats in the answer, but place them after the main takeaway");
  });

  it("builds generic multi-signal synthesis guidance that de-emphasizes recoverable tool errors", async () => {
    const { buildQuerySynthesisSections } = await import("../src/query-advisor.js");
    const sections = buildQuerySynthesisSections("what should i know here", [
      {
        name: "run_metric_query",
        result: createEnvelope({
          actionId: "run_metric_query",
          authority: "tool_agent",
          data: {
            rows: [{ site_visitors: "4321" }],
            metric: "site_visitors",
            view: "queryable.vw_site_traffic"
          },
          provenance: ["queryable.vw_site_traffic"]
        })
      },
      {
        name: "run_breakdown_query",
        result: {
          status: "error",
          actionId: "run_breakdown_query",
          input: { metric: "x_post_count", view: "queryable.vw_x_post_public_metrics" },
          error: {
            code: "unsupported_view_for_metric",
            message: "Metric x_post_count is not available on queryable.vw_x_post_public_metrics"
          }
        }
      },
      {
        name: "run_metric_query",
        result: createEnvelope({
          actionId: "run_metric_query",
          authority: "tool_agent",
          data: {
            rows: [{ recognized_revenue: "9800" }],
            metric: "recognized_revenue",
            view: "queryable.vw_revenue_by_source"
          },
          provenance: ["queryable.vw_revenue_by_source"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Generic multi-signal synthesis guidance:");
    expect(sections.join("\n")).toContain("Recoverable query issues:");
    expect(sections.join("\n")).toContain("unsupported_view_for_metric");
    expect(sections.join("\n")).toContain("do not let the failure dominate the answer");
  });

  it("builds generic capability-overview synthesis guidance for schema exploration questions", async () => {
    const { buildQuerySynthesisSections } = await import("../src/query-advisor.js");
    const sections = buildQuerySynthesisSections("what revenue can I inspect?", [
      {
        name: "list_metrics",
        result: createEnvelope({
          actionId: "list_metrics",
          authority: "tool_agent",
          data: {
            metrics: [{ id: "recognized_revenue" }, { id: "site_visitors" }]
          },
          provenance: ["metric_definitions"]
        })
      },
      {
        name: "describe_metric",
        result: createEnvelope({
          actionId: "describe_metric",
          authority: "tool_agent",
          data: {
            metric: {
              id: "recognized_revenue",
              source_view: "queryable.vw_revenue_by_source",
              allowed_dimensions: ["provider", "currency"]
            }
          },
          provenance: ["metric_definitions"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Generic capability-overview synthesis guidance:");
    expect(sections.join("\n")).toContain("Metric available: recognized_revenue from queryable.vw_revenue_by_source.");
    expect(sections.join("\n")).toContain("Allowed dimensions include: provider, currency.");
    expect(sections.join("\n")).toContain("Metrics you can inspect include: recognized_revenue, site_visitors.");
    expect(sections.join("\n")).toContain("Lead with the most useful thing the user can inspect first");
    expect(sections.join("\n")).toContain("Explain why that capability matters");
    expect(sections.join("\n")).toContain("one or two concrete next questions");
  });

  it("builds generic workspace-overview synthesis guidance for non-family questions after source and metric discovery", async () => {
    const { buildQuerySynthesisSections } = await import("../src/query-advisor.js");
    const sections = buildQuerySynthesisSections("what should i know here", [
      {
        name: "list_sources",
        result: createEnvelope({
          actionId: "list_sources",
          authority: "tool_agent",
          data: {
            sources: [
              { id: "src_ga4", provider: "google_analytics_4", connection_name: "GA4 Fixture" },
              {
                id: "src_x",
                provider: "x",
                connection_name: "YourHandle Account",
                status: "connected",
                last_synced_at: "2026-06-06T15:34:32.364Z"
              }
            ]
          },
          provenance: ["sources"]
        })
      },
      {
        name: "get_recent_sync_runs",
        result: createEnvelope({
          actionId: "get_recent_sync_runs",
          authority: "tool_agent",
          data: {
            syncRuns: [
              { id: "sync_ga4", source_id: "src_ga4", status: "succeeded" },
              {
                id: "sync_x",
                source_id: "src_x",
                status: "succeeded",
                started_at: "2026-06-06T15:33:00.000Z",
                finished_at: "2026-06-06T15:34:32.364Z",
                records_loaded: 105
              }
            ]
          },
          provenance: ["sync_runs"]
        })
      },
      {
        name: "list_metrics",
        result: createEnvelope({
          actionId: "list_metrics",
          authority: "tool_agent",
          data: {
            metrics: [{ id: "recognized_revenue" }, { id: "site_visitors" }, { id: "signup_count" }]
          },
          provenance: ["metric_definitions"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Generic workspace-overview synthesis guidance:");
    expect(sections.join("\n")).toContain("Connected sources: 2.");
    expect(sections.join("\n")).toContain("Source snapshot: google_analytics_4 (GA4 Fixture); x (YourHandle Account).");
    expect(sections.join("\n")).toContain("Likely synthetic/test sources: google_analytics_4 (GA4 Fixture).");
    expect(sections.join("\n")).toContain("Recent sync health: 2 succeeded.");
    expect(sections.join("\n")).toContain("x (YourHandle Account) has last_synced_at=2026-06-06T15:34:32.364Z");
    expect(sections.join("\n")).toContain("latest sync succeeded");
    expect(sections.join("\n")).toContain("Do not describe a source as never synced when last_synced_at or sync runs are present.");
    expect(sections.join("\n")).toContain("Metrics available include: recognized_revenue, site_visitors, signup_count.");
    expect(sections.join("\n")).toContain("Lead with the strongest workspace-level takeaway first");
    expect(sections.join("\n")).toContain("production-like, incomplete, or synthetic");
    expect(sections.join("\n")).toContain("what kinds of questions this workspace is now ready to answer");
  });

  it("builds generic capability-overview synthesis guidance for schema exploration questions", async () => {
    const { buildQuerySynthesisSections } = await import("../src/query-advisor.js");
    const sections = buildQuerySynthesisSections("what revenue can I inspect?", [
      {
        name: "list_metrics",
        result: createEnvelope({
          actionId: "list_metrics",
          authority: "tool_agent",
          data: {
            metrics: [{ id: "recognized_revenue" }, { id: "site_visitors" }]
          },
          provenance: ["metric_definitions"]
        })
      },
      {
        name: "describe_metric",
        result: createEnvelope({
          actionId: "describe_metric",
          authority: "tool_agent",
          data: {
            metric: {
              id: "recognized_revenue",
              source_view: "queryable.vw_revenue_by_source",
              allowed_dimensions: ["provider", "currency"]
            }
          },
          provenance: ["metric_definitions"]
        })
      }
    ]);

    expect(sections.join("\n")).toContain("Generic capability-overview synthesis guidance:");
    expect(sections.join("\n")).toContain("Metric available: recognized_revenue from queryable.vw_revenue_by_source.");
    expect(sections.join("\n")).toContain("Allowed dimensions include: provider, currency.");
    expect(sections.join("\n")).toContain("Metrics you can inspect include: recognized_revenue, site_visitors.");
    expect(sections.join("\n")).toContain("Lead with the most useful thing the user can inspect first");
  });

  it("routes broad workspace snapshot questions through model-selected tools", async () => {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [
                { id: "src_ga4", provider: "google_analytics_4", status: "connected", connection_name: "GA4 Fixture" },
                { id: "src_x", provider: "x", status: "connected", connection_name: "X yourhandle live" }
              ]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [
                { id: "sync_ga4", source_id: "src_ga4", status: "succeeded" },
                { id: "sync_x", source_id: "src_x", status: "succeeded" }
              ]
            },
            provenance: ["sync_runs"]
          }),
        list_metrics: (_input, context) =>
          createEnvelope({
            actionId: "list_metrics",
            authority: context.authority,
            data: {
              metrics: [{ id: "recognized_revenue" }, { id: "site_visitors" }, { id: "signup_count" }]
            },
            provenance: ["metric_definitions"]
          }),
        run_metric_query: (input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [
                typeof (input as Record<string, unknown>).metric === "string" &&
                (input as Record<string, unknown>).metric === "recognized_revenue"
                  ? { recognized_revenue: "9800" }
                  : typeof (input as Record<string, unknown>).metric === "string" &&
                      (input as Record<string, unknown>).metric === "site_visitors"
                    ? { site_visitors: "180" }
                    : typeof (input as Record<string, unknown>).metric === "string" &&
                        (input as Record<string, unknown>).metric === "signup_count"
                      ? { signup_count: "2" }
                      : { site_conversion_rate: "0.0042" }
              ],
              metric: String((input as Record<string, unknown>).metric),
              view: String((input as Record<string, unknown>).view)
            },
            provenance: ["metric_definitions"]
          }),
        drilldown_result: (_input, context) =>
          createEnvelope({
            actionId: "drilldown_result",
            authority: context.authority,
            data: {
              rows: [{ amount_paid: "9800", currency: "usd", status: "paid", external_order_id: "ord_123" }],
              metric: "recognized_revenue"
            },
            provenance: ["drilldown.stripe_revenue_provider_rows"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          requests.push({
            ...request,
            toolResults: [...request.toolResults],
            tools: [...request.tools]
          });
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                { id: "call_sources", name: "list_sources", input: {} },
                { id: "call_syncs", name: "get_recent_sync_runs", input: {} },
                { id: "call_metrics", name: "list_metrics", input: {} }
              ]
            };
          }
          return { message: "Workspace snapshot from the model." };
        }
      }
    });

    const result = await controller.chat({
      message: "what should i know here",
      sessionId: "session-workspace-overview",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.toolResults).toHaveLength(0);
    expect(requests[1]?.toolResults.map((result) => result.name)).toEqual([
      "list_sources",
      "get_recent_sync_runs",
      "list_metrics"
    ]);
    expect(result.message).toBe("Workspace snapshot from the model.");
  });

  it("routes revenue capability questions through model-selected tools", async () => {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_metrics: (_input, context) =>
          createEnvelope({
            actionId: "list_metrics",
            authority: context.authority,
            data: {
              metrics: [{ id: "recognized_revenue" }, { id: "site_visitors" }]
            },
            provenance: ["metric_definitions"]
          }),
        describe_metric: (_input, context) =>
          createEnvelope({
            actionId: "describe_metric",
            authority: context.authority,
            data: {
              metric: {
                id: "recognized_revenue",
                source_view: "queryable.vw_revenue_by_source",
                allowed_dimensions: ["provider", "currency"]
              }
            },
            provenance: ["metric_definitions"]
          }),
        describe_queryable_view: (_input, context) =>
          createEnvelope({
            actionId: "describe_queryable_view",
            authority: context.authority,
            data: {
              view: {
                id: "queryable.vw_revenue_by_source",
                row_grain: "day/source/currency",
                default_time_column: "occurred_on"
              }
            },
            provenance: ["queryable_views"]
          }),
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [
                { id: "src_live", provider: "stripe", status: "connected", connection_name: "Stripe Live" },
                { id: "src_check", provider: "stripe", status: "connected", connection_name: "Stripe Export Check" }
              ]
            },
            provenance: ["sources"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          requests.push({
            ...request,
            toolResults: [...request.toolResults],
            tools: [...request.tools]
          });
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                { id: "call_metrics", name: "list_metrics", input: {} },
                { id: "call_metric_detail", name: "describe_metric", input: { metricId: "recognized_revenue" } },
                {
                  id: "call_view_detail",
                  name: "describe_queryable_view",
                  input: { viewId: "queryable.vw_revenue_by_source" }
                },
                { id: "call_sources", name: "list_sources", input: {} }
              ]
            };
          }
          return { message: "Recognized revenue is available from Stripe-backed revenue data." };
        }
      }
    });

    const result = await controller.chat({
      message: "what revenue can I inspect?",
      sessionId: "session-revenue-capability",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.toolResults.map((result) => result.name)).toEqual([
      "list_metrics",
      "describe_metric",
      "describe_queryable_view",
      "list_sources"
    ]);
    expect(result.message).toBe("Recognized revenue is available from Stripe-backed revenue data.");
  });

  it("routes broad capability-overview questions through model-selected tools", async () => {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [
                { id: "src_ga4", provider: "google_analytics_4", status: "connected", connection_name: "GA4 Fixture" },
                { id: "src_x", provider: "x", status: "connected", connection_name: "X yourhandle live" }
              ]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [
                { id: "sync_ga4", source_id: "src_ga4", status: "succeeded" },
                { id: "sync_x", source_id: "src_x", status: "succeeded" }
              ]
            },
            provenance: ["sync_runs"]
          }),
        list_metrics: (_input, context) =>
          createEnvelope({
            actionId: "list_metrics",
            authority: context.authority,
            data: {
              metrics: [{ id: "recognized_revenue" }, { id: "site_visitors" }, { id: "signup_count" }]
            },
            provenance: ["metric_definitions"]
          }),
        list_queryable_views: (_input, context) =>
          createEnvelope({
            actionId: "list_queryable_views",
            authority: context.authority,
            data: {
              views: [{ view_name: "vw_revenue_by_source" }, { view_name: "vw_site_traffic" }]
            },
            provenance: ["queryable_views"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          requests.push({
            ...request,
            toolResults: [...request.toolResults],
            tools: [...request.tools]
          });
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                { id: "call_sources", name: "list_sources", input: {} },
                { id: "call_syncs", name: "get_recent_sync_runs", input: {} },
                { id: "call_metrics", name: "list_metrics", input: {} },
                { id: "call_views", name: "list_queryable_views", input: {} }
              ]
            };
          }
          return { message: "Capability overview from the model." };
        }
      }
    });

    const result = await controller.chat({
      message: "what can I inspect?",
      sessionId: "session-capability-overview",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.toolResults.map((result) => result.name)).toEqual([
      "list_sources",
      "get_recent_sync_runs",
      "list_metrics",
      "list_queryable_views"
    ]);
    expect(result.message).toBe("Capability overview from the model.");
  });

  it("emits progress notes for resolved context and tool execution", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ x_follower_count: "31" }],
              metric: "x_follower_count",
              view: "queryable.vw_x_profile_public_metrics"
            },
            provenance: ["metric_definitions"]
          })
      }),
      queryAdvisor: {
        async advise() {
          return {
            progressNotes: [
              "Checking connected X accounts.",
              "Resolved X account context: @yourhandle."
            ],
            promptSections: ["Resolved X account context for this turn:", "{\"username\":\"yourhandle\"}"]
          };
        }
      },
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                {
                  id: "call_followers",
                  name: "run_metric_query",
                  input: {
                    metric: "x_follower_count",
                    view: "queryable.vw_x_profile_public_metrics"
                  }
                }
              ]
            };
          }
          return { message: "You have 31 followers." };
        }
      }
    });

    await controller.chat({
      message: "how many followers i have",
      sessionId: "session-x-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toEqual([
      { stage: "resolve", message: "Checking connected X accounts." },
      { stage: "resolve", message: "Resolved X account context: @yourhandle." },
      { stage: "tool", message: "Running follower lookup." }
    ]);
  });

  it("emits recall preparation before recalling prior session context for X questions", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const store: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall() {},
      async listSessions() {
        return [];
      },
      async getSession() {
        return { id: "session-recall-progress", messages: [], actionCalls: [] };
      },
      async searchSessions() {
        return [{ id: "session-old", title: "Prior X context", snippet: "@yourhandle follower question" }];
      },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) {
        return { sessionId: input.newSessionId ?? "session-child", parentSessionId: input.sessionId };
      }
    };
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ x_follower_count: "31" }],
              metric: "x_follower_count",
              view: "queryable.vw_x_profile_public_metrics"
            },
            provenance: ["queryable.vw_x_profile_public_metrics"]
          })
      }),
      sessionStore: store,
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    await controller.chat({
      message: "how many followers i have",
      sessionId: "session-recall-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({ stage: "resolve", message: "Preparing recall lookup." });
    expect(events).toContainEqual({ stage: "recall", message: "Recalled prior session context." });
  });

  it("humanizes progress labels for model-selected tool calls", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_breakdown_query: (_input, context) =>
          createEnvelope({
            actionId: "run_breakdown_query",
            authority: context.authority,
            data: {
              rows: [
                { provider: "stripe", currency: "usd", recognized_revenue: "12000" },
                { provider: "posthog", currency: "usd", recognized_revenue: "3000" }
              ],
              metric: "recognized_revenue",
              view: "queryable.vw_revenue_by_source"
            },
            provenance: ["queryable.vw_revenue_by_source"]
          })
      }),
      modelClient: {
        complete: async (request) =>
          request.toolResults.length === 0
            ? {
                toolCalls: [
                  {
                    id: "call_revenue_breakdown",
                    name: "run_breakdown_query",
                    input: { metric: "recognized_revenue", view: "queryable.vw_revenue_by_source", groupBy: ["provider", "currency"] }
                  }
                ]
              }
            : { message: "Stripe leads revenue." }
      }
    });

    const result = await controller.chat({
      message: "What stands out here",
      sessionId: "session-model-progress-humanized",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(result.message).toBe("Stripe leads revenue.");
    expect(events).toContainEqual({
      stage: "tool",
      message: "Running revenue-by-source breakdown."
    });
    expect(events).not.toContainEqual({
      stage: "tool",
      message: "Running run_breakdown_query."
    });
  });

  it("humanizes schema-planning progress labels for model-selected tool calls", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_metrics: (_input, context) =>
          createEnvelope({
            actionId: "list_metrics",
            authority: context.authority,
            data: { metrics: [{ id: "recognized_revenue" }] },
            provenance: ["metric_definitions"]
          }),
        describe_metric: (_input, context) =>
          createEnvelope({
            actionId: "describe_metric",
            authority: context.authority,
            data: { metric: { id: "recognized_revenue", name: "Recognized revenue" } },
            provenance: ["metric_definitions"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [{ id: "call_list_metrics", name: "list_metrics", input: {} }]
            };
          }
          if (request.toolResults.length === 1) {
            return {
              toolCalls: [{ id: "call_describe_metric", name: "describe_metric", input: { metricId: "recognized_revenue" } }]
            };
          }
          return { message: "Recognized revenue is available." };
        }
      }
    });

    const result = await controller.chat({
      message: "What metrics are available?",
      sessionId: "session-model-schema-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(result.message).toBe("Recognized revenue is available.");
    expect(events).toContainEqual({
      stage: "tool",
      message: "Checking available metrics."
    });
    expect(events).toContainEqual({
      stage: "tool",
      message: "Checking metric definition."
    });
    expect(events).not.toContainEqual({
      stage: "tool",
      message: "Running list_metrics."
    });
    expect(events).not.toContainEqual({
      stage: "tool",
      message: "Running describe_metric."
    });
  });

  it("humanizes capability-exploration progress labels for model-selected schema inspection", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_metrics: (_input, context) =>
          createEnvelope({
            actionId: "list_metrics",
            authority: context.authority,
            data: { metrics: [{ id: "recognized_revenue" }] },
            provenance: ["metric_definitions"]
          }),
        describe_metric: (_input, context) =>
          createEnvelope({
            actionId: "describe_metric",
            authority: context.authority,
            data: { metric: { id: "recognized_revenue", name: "Recognized revenue" } },
            provenance: ["metric_definitions"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [{ id: "call_list_metrics", name: "list_metrics", input: {} }]
            };
          }
          if (request.toolResults.length === 1) {
            return {
              toolCalls: [{ id: "call_describe_metric", name: "describe_metric", input: { metricId: "recognized_revenue" } }]
            };
          }
          return { message: "Recognized revenue is available." };
        }
      }
    });

    await controller.chat({
      message: "what can i inspect?",
      sessionId: "session-model-capability-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({
      stage: "tool",
      message: "Checking which metrics are available to inspect."
    });
    expect(events).toContainEqual({
      stage: "tool",
      message: "Checking how that metric can be analyzed."
    });
    expect(events).not.toContainEqual({
      stage: "tool",
      message: "Checking available metrics."
    });
    expect(events).not.toContainEqual({
      stage: "tool",
      message: "Checking metric definition."
    });
  });

  it("humanizes timing progress labels for model-selected X timing breakdowns", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_breakdown_query: (_input, context) =>
          createEnvelope({
            actionId: "run_breakdown_query",
            authority: context.authority,
            data: {
              rows: [{ published_hour_utc: 2, x_public_engagement: "33" }],
              metric: "x_public_engagement",
              view: "queryable.vw_x_post_public_metrics"
            },
            provenance: ["queryable.vw_x_post_public_metrics"]
          })
      }),
      modelClient: {
        complete: async (request) =>
          request.toolResults.length === 0
            ? {
                toolCalls: [
                  {
                    id: "call_timing_breakdown",
                    name: "run_breakdown_query",
                    input: {
                      metric: "x_public_engagement",
                      view: "queryable.vw_x_post_public_metrics",
                      groupBy: ["published_hour_utc"]
                    }
                  }
                ]
              }
            : { message: "Timing answer." }
      }
    });

    await controller.chat({
      message: "what are the best times for me to tweet",
      sessionId: "session-model-timing-progress-humanized",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({
      stage: "tool",
      message: "Running X timing breakdown."
    });
    expect(events).not.toContainEqual({
      stage: "tool",
      message: "Running engagement breakdown."
    });
  });

  it("humanizes strategy progress labels for model-selected X strategy breakdowns", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_breakdown_query: (_input, context) =>
          createEnvelope({
            actionId: "run_breakdown_query",
            authority: context.authority,
            data: {
              rows: [{ x_post_id: "1", body_text: "Hot take one", x_public_engagement: "33" }],
              metric: "x_public_engagement",
              view: "queryable.vw_x_post_public_metrics"
            },
            provenance: ["queryable.vw_x_post_public_metrics"]
          })
      }),
      modelClient: {
        complete: async (request) =>
          request.toolResults.length === 0
            ? {
                toolCalls: [
                  {
                    id: "call_strategy_breakdown",
                    name: "run_breakdown_query",
                    input: {
                      metric: "x_public_engagement",
                      view: "queryable.vw_x_post_public_metrics"
                    }
                  }
                ]
              }
            : { message: "Strategy answer." }
      }
    });

    await controller.chat({
      message: "what should i post more of on x",
      sessionId: "session-model-strategy-progress-humanized",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({
      stage: "tool",
      message: "Running top-post strategy breakdown."
    });
    expect(events).not.toContainEqual({
      stage: "tool",
      message: "Running engagement breakdown."
    });
  });

  it("humanizes workflow progress labels for broad open-ended analysis prompts", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [{ id: "src_ga4", provider: "google_analytics_4", status: "connected", connection_name: "Main Site GA4" }]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [{ id: "sync_1", source_id: "src_ga4", status: "succeeded" }]
            },
            provenance: ["sync_runs"]
          }),
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ site_visitors: "4321" }],
              metric: "site_visitors",
              view: "queryable.vw_site_traffic"
            },
            provenance: ["queryable.vw_site_traffic"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                { id: "call_sources", name: "list_sources", input: {} },
                { id: "call_syncs", name: "get_recent_sync_runs", input: {} },
                { id: "call_metric", name: "run_metric_query", input: { metric: "site_visitors", view: "queryable.vw_site_traffic" } }
              ]
            };
          }
          return { message: "Open-ended answer." };
        }
      }
    });

    await controller.chat({
      message: "what should i know here",
      sessionId: "session-open-ended-progress-humanized",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({ stage: "tool", message: "Checking source coverage." });
    expect(events).toContainEqual({ stage: "tool", message: "Checking data freshness." });
    expect(events).toContainEqual({ stage: "tool", message: "Checking site traffic signal." });
    expect(events).not.toContainEqual({ stage: "tool", message: "Checking connected sources." });
    expect(events).not.toContainEqual({ stage: "tool", message: "Running site traffic lookup." });
  });

  it("humanizes source-schedule progress labels for broad open-ended analysis prompts", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_source_schedules: (_input, context) =>
          createEnvelope({
            actionId: "list_source_schedules",
            authority: context.authority,
            data: {
              schedules: [{ source_id: "src_ga4", status: "active" }]
            },
            provenance: ["source_schedules"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [{ id: "call_schedules", name: "list_source_schedules", input: {} }]
            };
          }
          return { message: "Open-ended answer." };
        }
      }
    });

    await controller.chat({
      message: "what should i know here",
      sessionId: "session-open-ended-schedule-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({ stage: "tool", message: "Checking source schedule coverage." });
    expect(events).not.toContainEqual({ stage: "tool", message: "Running list_source_schedules." });
  });

  it("humanizes metric and dataset detail labels for broad open-ended analysis prompts", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        describe_metric: (_input, context) =>
          createEnvelope({
            actionId: "describe_metric",
            authority: context.authority,
            data: {
              metric: { id: "site_visitors", source_view: "queryable.vw_site_traffic" }
            },
            provenance: ["metric_definitions"]
          }),
        describe_queryable_view: (_input, context) =>
          createEnvelope({
            actionId: "describe_queryable_view",
            authority: context.authority,
            data: {
              view: { id: "queryable.vw_site_traffic", row_grain: "day/source" }
            },
            provenance: ["queryable_views"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                { id: "call_metric", name: "describe_metric", input: { metricId: "site_visitors" } },
                { id: "call_view", name: "describe_queryable_view", input: { viewId: "queryable.vw_site_traffic" } }
              ]
            };
          }
          return { message: "Open-ended answer." };
        }
      }
    });

    await controller.chat({
      message: "what should i know here",
      sessionId: "session-open-ended-detail-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({ stage: "tool", message: "Checking how that metric should be interpreted." });
    expect(events).toContainEqual({ stage: "tool", message: "Checking how that dataset can be analyzed." });
    expect(events).not.toContainEqual({ stage: "tool", message: "Checking metric definition." });
    expect(events).not.toContainEqual({ stage: "tool", message: "Checking queryable view definition." });
  });

  it("suppresses consecutive duplicate progress events in one run", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        describe_queryable_view: (_input, context) =>
          createEnvelope({
            actionId: "describe_queryable_view",
            authority: context.authority,
            data: {
              view: { id: "queryable.vw_site_traffic", row_grain: "day/source" }
            },
            provenance: ["queryable_views"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                { id: "call_view_1", name: "describe_queryable_view", input: { viewId: "queryable.vw_site_traffic" } },
                { id: "call_view_2", name: "describe_queryable_view", input: { viewId: "queryable.vw_site_traffic" } }
              ]
            };
          }
          return { message: "Done." };
        }
      }
    });

    await controller.chat({
      message: "what should i know here",
      sessionId: "session-progress-dedupe",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events.filter((event) => event.message === "Checking how that dataset can be analyzed.")).toHaveLength(1);
  });

  it("uses a stronger fallback metric-progress label for broad open-ended analysis", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ custom_signal: "9" }],
              metric: "custom_signal",
              view: "queryable.vw_custom_signal"
            },
            provenance: ["queryable.vw_custom_signal"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                { id: "call_metric", name: "run_metric_query", input: { metric: "custom_signal", view: "queryable.vw_custom_signal" } }
              ]
            };
          }
          return { message: "Open-ended answer." };
        }
      }
    });

    await controller.chat({
      message: "what should i know here",
      sessionId: "session-open-ended-fallback-signal-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({ stage: "tool", message: "Checking the strongest available signal." });
    expect(events).not.toContainEqual({ stage: "tool", message: "Checking key metric signal." });
  });

  it("uses a stronger fallback breakdown-progress label for broad open-ended analysis", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_breakdown_query: (_input, context) =>
          createEnvelope({
            actionId: "run_breakdown_query",
            authority: context.authority,
            data: {
              rows: [{ country: "US", custom_signal: "9" }],
              metric: "custom_signal",
              view: "queryable.vw_custom_signal"
            },
            provenance: ["queryable.vw_custom_signal"]
          })
      }),
      modelClient: {
        complete: async (request) => {
          if (request.toolResults.length === 0) {
            return {
              toolCalls: [
                {
                  id: "call_breakdown",
                  name: "run_breakdown_query",
                  input: { metric: "custom_signal", view: "queryable.vw_custom_signal", groupBy: ["country"] }
                }
              ]
            };
          }
          return { message: "Open-ended answer." };
        }
      }
    });

    await controller.chat({
      message: "what stands out here",
      sessionId: "session-open-ended-fallback-breakdown-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toContainEqual({ stage: "tool", message: "Checking comparison breakdown." });
    expect(events).not.toContainEqual({ stage: "tool", message: "Running run_breakdown_query." });
  });

  it.skip("uses family-specific composed progress labels for traffic questions", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ site_visitors: "4321" }],
              metric: "site_visitors",
              view: "queryable.vw_site_traffic"
            },
            provenance: ["queryable.vw_site_traffic"]
          })
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    await controller.chat({
      message: "how many visitors did we have",
      sessionId: "session-traffic-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events.at(-1)).toEqual({
      stage: "resolve",
      message: "Composed answer from retrieved traffic data."
    });
    expect(events).toContainEqual({
      stage: "tool",
      message: "Checking connected Google Analytics 4 source."
    });
  });

  it.skip("uses action-specific planned progress labels for source status questions", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [{ id: "src_x_1", provider: "x", status: "connected" }]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [{ id: "sync_1", source_id: "src_x_1", status: "succeeded" }]
            },
            provenance: ["sync_runs"]
          })
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    await controller.chat({
      message: "what sources are connected",
      sessionId: "session-source-progress",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toEqual([
      { stage: "tool", message: "Checking connected sources." },
      { stage: "tool", message: "Checking recent sync runs." },
      { stage: "resolve", message: "Composed answer from retrieved source status." }
    ]);
  });

  it.skip("uses provider-specific progress labels for provider-specific source status questions", async () => {
    const events: Array<{ stage: string; message: string }> = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [{ id: "src_x_1", provider: "x", status: "connected" }]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [{ id: "sync_1", source_id: "src_x_1", status: "succeeded" }]
            },
            provenance: ["sync_runs"]
          })
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    await controller.chat({
      message: "is x connected",
      sessionId: "session-source-progress-provider",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      onProgress(event) {
        events.push(event);
      }
    });

    expect(events).toEqual([
      { stage: "tool", message: "Checking connected X source." },
      { stage: "tool", message: "Checking recent X syncs." },
      { stage: "resolve", message: "Composed answer from retrieved source status." }
    ]);
  });

  it("filters and persists only allowed curated memory facts after chat turns", async () => {
    expect(
      filterCuratedMemoryCandidates([
        { scope: "workspace_preference", fact: "Use UTC for weekly reports." },
        { scope: "workspace_preference", fact: "Use UTC for weekly reports." },
        { scope: "source_naming", fact: "Call source src_x public X posts." },
        { scope: "temporary_progress", fact: "Task progress: currently debugging." },
        { scope: "workspace_preference", fact: "API key is sk-live-secret." },
        { scope: "metric_preference", fact: "raw_payload contains rows." }
      ])
    ).toEqual([
      { scope: "workspace_preference", fact: "Use UTC for weekly reports." },
      { scope: "source_naming", fact: "Call source src_x public X posts." }
    ]);

    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const memoryManager = createCuratedMemoryManager({
      db: {
        query: async (sql, params = []) => {
          queries.push({ sql, params });
          return [];
        }
      },
      reviewer: () => [
        { scope: "workspace_preference", fact: "Use UTC for weekly reports." },
        { scope: "workspace_preference", fact: "Access token is abc." }
      ]
    });
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      memoryManager,
      modelClient: {
        complete: async () => ({ message: "Noted." })
      }
    });

    await controller.chat({
      message: "Remember I prefer UTC reports",
      sessionId: "session-memory",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    const insertQueries = queries.filter((query) => query.sql.includes("insert into chat_memory_facts"));
    expect(insertQueries).toHaveLength(1);
    expect(insertQueries[0]?.params).toEqual([
      expect.stringMatching(/^mem_/),
      "workspace-1",
      "operator-1",
      "workspace_preference",
      "Use UTC for weekly reports.",
      "session-memory"
    ]);
    expect(insertQueries[0]?.sql).toContain("where not exists");
  });

  it("does not insert duplicate auto-reviewed memory facts already present in the workspace", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const memoryManager = createCuratedMemoryManager({
      db: {
        query: async (sql, params = []) => {
          queries.push({ sql, params });
          return [];
        }
      },
      reviewer: () => [
        { scope: "workspace_preference", fact: "Use UTC for weekly reports." },
        { scope: "workspace_preference", fact: "use utc for weekly reports." }
      ]
    });
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      memoryManager,
      modelClient: {
        complete: async () => ({ message: "Noted." })
      }
    });

    await controller.chat({
      message: "Remember I prefer UTC reports",
      sessionId: "session-memory-dupe",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    const insertQueries = queries.filter((query) => query.sql.includes("insert into chat_memory_facts"));
    expect(insertQueries).toHaveLength(1);
    expect(insertQueries[0]?.sql).toContain("lower(fact) = lower($5)");
    expect(insertQueries[0]?.sql).toContain("where not exists");
  });

  it("loads only accepted DB-backed curated memory facts for prompts", async () => {
    const queries: unknown[][] = [];
    const memoryManager = createCuratedMemoryManager({
      db: {
        query: async <T = Record<string, unknown>>(_sql: string, params: unknown[] = []): Promise<T[]> => {
          queries.push(params);
          return [
            { id: "mem_1", scope: "workspace_preference", fact: "Use UTC for weekly reports." },
            { id: "mem_2", scope: "workspace_preference", fact: "Access token is abc." },
            { id: "mem_3", scope: "temporary_progress", fact: "Task progress: debugging." }
          ] as T[];
        }
      },
      reviewer: () => []
    });

    const context = await memoryManager.loadPromptContext?.({
      workspaceId: "workspace-1",
      actorId: "operator-1",
      sessionId: "session-1"
    });

    expect(queries).toEqual([["workspace-1"]]);
    expect(context).toEqual([
      { id: "mem_1", scope: "workspace_preference", fact: "Use UTC for weekly reports." }
    ]);
  });

  it("derives curated memory candidates from a model review response", async () => {
    const requests: unknown[] = [];
    const reviewer = createModelBackedMemoryReviewer({
      complete: async (request) => {
        requests.push(request);
        return {
          message: JSON.stringify({
            memories: [
              { scope: "workspace_preference", fact: "Use UTC for weekly reports." },
              { scope: "operator_correction", fact: "Treat recognized_revenue as Stripe paid invoices." },
              { scope: "workspace_preference", fact: "Access token is abc." },
              { scope: "temporary_progress", fact: "Task progress: wrote tests." }
            ]
          })
        };
      }
    });

    const candidates = await reviewer({
      workspaceId: "workspace-1",
      actorId: "operator-1",
      sessionId: "session-memory-model",
      userMessage: "Remember I prefer UTC reports.",
      assistantMessage: "Noted.",
      actionCalls: []
    });

    expect(candidates).toEqual([
      { scope: "workspace_preference", fact: "Use UTC for weekly reports." },
      { scope: "operator_correction", fact: "Treat recognized_revenue as Stripe paid invoices." }
    ]);
    expect((requests[0] as { systemPrompt: string }).systemPrompt).toContain("Forbidden durable memory");
    expect((requests[0] as { tools: unknown[] }).tools).toEqual([]);
  });

  it("does not fail chat turns when memory review fails", async () => {
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      memoryManager: {
        reviewTurn: async () => {
          throw new Error("memory backend unavailable");
        }
      },
      modelClient: {
        complete: async () => ({ message: "Answered." })
      }
    });

    await expect(
      controller.chat({
        message: "Hello",
        sessionId: "session-memory-failure",
        workspaceId: "workspace-1",
        actorId: "operator-1",
        surface: "api"
      })
    ).resolves.toMatchObject({ ok: true, message: "Answered." });
  });

  it("builds Codex Responses requests from user-level Infinite OS model auth", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-model-client-"));
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    try {
      const env = { GROWTH_OS_HOME: growthHome };
      writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.4" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "codex",
          source: "codex-cli",
          authMode: "device-code",
          token: "codex-access-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
            headers: new Headers(init?.headers)
          });
          return new Response(
            JSON.stringify({
              usage: { input_tokens: 12, output_tokens: 4 },
              output: [
                {
                  type: "function_call",
                  call_id: "call_1",
                  name: "list_metrics",
                  arguments: "{}"
                }
              ]
            }),
            { status: 200 }
          );
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "What can I inspect?",
        tools: [
          {
            name: "list_metrics",
            title: "List metrics",
            summary: "List available metrics",
            authority: "tool_agent",
            inputSchema: { type: "object", properties: {} }
          }
        ],
        toolResults: []
      });

      expect(requests[0].url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(requests[0].headers.get("authorization")).toBe("Bearer codex-access-token");
      // Cloudflare-bypass headers ported from the Python Codex path so the TS
      // /responses request isn't 403'd on non-residential IPs.
      expect(requests[0].headers.get("originator")).toBe("codex_cli_rs");
      expect(requests[0].headers.get("user-agent")).toBe("codex_cli_rs/0.0.0 (Hermes Agent)");
      // Opaque (non-JWT) token → no chatgpt_account_id claim → header omitted.
      expect(requests[0].headers.get("chatgpt-account-id")).toBeNull();
      expect(requests[0].body).toMatchObject({ model: "gpt-5.4", store: false, stream: true });
      expect(JSON.stringify(requests[0].body)).toContain("list_metrics");
      expect(response.toolCalls).toEqual([{ id: "call_1", name: "list_metrics", input: {} }]);
      expect(response.usage).toEqual({ promptTokens: 12, completionTokens: 4 });
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("derives the ChatGPT-Account-ID Cloudflare header from a JWT Codex access token", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-codex-account-header-"));
    const requests: Array<{ headers: Headers }> = [];
    try {
      // Build a JWT-shaped access token whose payload carries the
      // chatgpt_account_id claim under the OpenAI auth namespace, mirroring the
      // real Codex OAuth token. Only the payload segment matters here.
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-12345" } })
      ).toString("base64url");
      const jwtToken = `${header}.${payload}.signature`;
      const env = { GROWTH_OS_HOME: growthHome };
      writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.4" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "codex",
          source: "codex-cli",
          authMode: "device-code",
          token: jwtToken
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (_url, init) => {
          requests.push({ headers: new Headers(init?.headers) });
          return new Response(JSON.stringify({ output_text: "ok" }), { status: 200 });
        }
      });

      await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "Hello",
        tools: [],
        toolResults: []
      });

      expect(requests[0].headers.get("originator")).toBe("codex_cli_rs");
      expect(requests[0].headers.get("user-agent")).toBe("codex_cli_rs/0.0.0 (Hermes Agent)");
      expect(requests[0].headers.get("chatgpt-account-id")).toBe("acct-12345");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("drops the ChatGPT-Account-ID header (no throw) for a JWT-shaped token with a malformed payload", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-codex-bad-jwt-header-"));
    const requests: Array<{ headers: Headers }> = [];
    try {
      // A JWT-SHAPED token (>=2 dot-separated segments, so it passes the
      // segment-count guard) whose payload base64url-decodes to a non-JSON
      // string. This must hit the JSON.parse try/catch in
      // chatgptAccountIdFromToken and be TOLERATED — the header is dropped
      // rather than the request crashing at construction (mirrors the Python
      // _codex_cloudflare_headers `except Exception: pass`).
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const badPayload = Buffer.from("this-is-not-json").toString("base64url");
      const jwtToken = `${header}.${badPayload}.signature`;
      const env = { GROWTH_OS_HOME: growthHome };
      writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.4" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "codex",
          source: "codex-cli",
          authMode: "device-code",
          token: jwtToken
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (_url, init) => {
          requests.push({ headers: new Headers(init?.headers) });
          return new Response(JSON.stringify({ output_text: "ok" }), { status: 200 });
        }
      });

      // Must not throw — the request still fires with the static headers and
      // only the account-id header is omitted.
      await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "Hello",
        tools: [],
        toolResults: []
      });

      expect(requests).toHaveLength(1);
      expect(requests[0].headers.get("originator")).toBe("codex_cli_rs");
      expect(requests[0].headers.get("user-agent")).toBe("codex_cli_rs/0.0.0 (Hermes Agent)");
      expect(requests[0].headers.get("chatgpt-account-id")).toBeNull();
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("streams Codex Responses SSE text deltas through model request callbacks", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-codex-streaming-client-"));
    const deltas: string[] = [];
    const reasoningDeltas: string[] = [];
    try {
      const env = { GROWTH_OS_HOME: growthHome };
      writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.4" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "codex",
          source: "codex-cli",
          authMode: "device-code",
          token: "codex-access-token"
        },
        env
      );
      const encoder = new TextEncoder();
      const client = createConfiguredModelClient({
        env,
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    [
                      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Revenue "}',
                      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"is up."}',
                      'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"Checked source freshness."}',
                      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":3}}}',
                      "data: [DONE]"
                    ].join("\n\n")
                  )
                );
                controller.close();
              }
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } }
          )
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "Hello",
        tools: [],
        toolResults: [],
        onMessageDelta(delta) {
          deltas.push(delta);
        },
        onReasoningDelta(delta) {
          reasoningDeltas.push(delta);
        }
      });

      expect(deltas).toEqual(["Revenue ", "is up."]);
      expect(reasoningDeltas).toEqual(["Checked source freshness."]);
      expect(response.message).toBe("Revenue is up.");
      expect(response.usage).toEqual({ promptTokens: 5, completionTokens: 3 });
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("uses explicit environment model overrides without changing user-level model auth", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-model-override-client-"));
    const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    try {
      const env = {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_MODEL_PROVIDER: "codex",
        GROWTH_OS_MODEL_NAME: "gpt-5.4"
      };
      writeInfiniteOsModelSelection({ provider: "codex", model: "stored-model" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "codex",
          source: "codex-cli",
          authMode: "device-code",
          token: "codex-access-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (_url, init) => {
          requests.push({
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
            headers: new Headers(init?.headers)
          });
          return new Response(JSON.stringify({ output_text: "Override model answered." }), { status: 200 });
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "Hello",
        tools: [],
        toolResults: []
      });

      expect(response.message).toBe("Override model answered.");
      expect(requests[0].body).toMatchObject({ model: "gpt-5.4", store: false, stream: true });
      expect(requests[0].headers.get("authorization")).toBe("Bearer codex-access-token");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("refreshes Codex auth and retries once after a 401", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-codex-refresh-"));
    const requests: Array<{ url: string; body: string; headers: Headers }> = [];
    try {
      const env = {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_CODEX_REFRESH_URL: "https://codex.example.test/oauth/token"
      };
      writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.4" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "codex",
          source: "codex-cli",
          authMode: "device-code",
          token: "expired-codex-token",
          refreshToken: "codex-refresh-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: String(init?.body ?? ""),
            headers: new Headers(init?.headers)
          });
          if (String(url).endsWith("/responses") && requests.length === 1) {
            return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
          }
          if (String(url) === env.GROWTH_OS_CODEX_REFRESH_URL) {
            return new Response(
              JSON.stringify({
                access_token: "fresh-codex-token",
                refresh_token: "fresh-codex-refresh",
                expires_at: "2026-06-03T12:00:00.000Z"
              }),
              { status: 200 }
            );
          }
          return new Response(JSON.stringify({ output_text: "Recovered." }), { status: 200 });
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "Hello",
        tools: [],
        toolResults: []
      });

      expect(response.message).toBe("Recovered.");
      expect(requests.map((request) => request.url)).toEqual([
        "https://chatgpt.com/backend-api/codex/responses",
        "https://codex.example.test/oauth/token",
        "https://chatgpt.com/backend-api/codex/responses"
      ]);
      expect(requests[0].headers.get("authorization")).toBe("Bearer expired-codex-token");
      const refreshBody = new URLSearchParams(requests[1].body);
      expect(refreshBody.get("grant_type")).toBe("refresh_token");
      expect(refreshBody.get("refresh_token")).toBe("codex-refresh-token");
      expect(requests[2].headers.get("authorization")).toBe("Bearer fresh-codex-token");
      expect(readInfiniteOsAuthState(env).providers.codex).toMatchObject({
        token: "fresh-codex-token",
        refreshToken: "fresh-codex-refresh"
      });
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("uses the first-party Codex OAuth refresh endpoint by default", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-codex-default-refresh-"));
    const requests: Array<{ url: string; body: string; headers: Headers }> = [];
    try {
      const env = { GROWTH_OS_HOME: growthHome };
      writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.4" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "codex",
          source: "growth-os-auth-store",
          authMode: "device-code",
          token: "expired-codex-token",
          refreshToken: "codex-refresh-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: String(init?.body ?? ""),
            headers: new Headers(init?.headers)
          });
          if (String(url).endsWith("/responses") && requests.length === 1) {
            return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
          }
          if (String(url) === "https://auth.openai.com/oauth/token") {
            return new Response(
              JSON.stringify({
                access_token: "fresh-codex-token",
                refresh_token: "fresh-codex-refresh"
              }),
              { status: 200 }
            );
          }
          return new Response(JSON.stringify({ output_text: "Recovered." }), { status: 200 });
        }
      });

      await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "Hello",
        tools: [],
        toolResults: []
      });

      expect(requests.map((request) => request.url)).toEqual([
        "https://chatgpt.com/backend-api/codex/responses",
        "https://auth.openai.com/oauth/token",
        "https://chatgpt.com/backend-api/codex/responses"
      ]);
      expect(requests[1]?.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
      expect(requests[1]?.body).toContain("grant_type=refresh_token");
      expect(requests[1]?.body).toContain("refresh_token=codex-refresh-token");
      expect(requests[1]?.body).toContain("client_id=");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("returns Codex re-login diagnostics when refresh fails after a 401", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-codex-refresh-fail-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "growth-os-no-claude-home-"));
    try {
      const env = {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_CODEX_REFRESH_URL: "https://codex.example.test/oauth/token",
        HOME: fakeHome
      };
      writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.4" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "codex",
          source: "codex-cli",
          authMode: "device-code",
          token: "expired-codex-token",
          refreshToken: "codex-refresh-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url) => {
          if (String(url) === env.GROWTH_OS_CODEX_REFRESH_URL) {
            return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
          }
          return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "Hello",
        tools: [],
        toolResults: []
      });

      expect(response.message).toContain("infinite auth login codex");
      expect(response.message).toContain("infinite auth import codex");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("does not fall back to Claude when the selected Codex provider remains unauthorized", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-codex-no-cross-fallback-"));
    try {
      const env = { GROWTH_OS_HOME: growthHome };
      writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.4" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "codex",
          source: "codex-cli",
          authMode: "device-code",
          token: "expired-codex-token",
          refreshToken: "broken-refresh-token"
        },
        env
      );
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "claude-code",
          authMode: "reuse",
          token: "claude-fallback-token"
        },
        env
      );
      const requests: string[] = [];
      const client = createConfiguredModelClient({
        env,
        fetch: async (url) => {
          requests.push(String(url));
          if (String(url).includes("/responses")) {
            return new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
          }
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "Hi",
        tools: [],
        toolResults: []
      });

      expect(response.message).toContain("Codex model auth expired and could not be refreshed");
      expect(requests.some((url) => url.includes("/messages"))).toBe(false);
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("builds Claude Messages requests from reused Claude Code Infinite OS auth", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-client-"));
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    try {
      const env = { GROWTH_OS_HOME: growthHome };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "claude-code",
          authMode: "reuse",
          token: "claude-access-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
            headers: new Headers(init?.headers)
          });
          return new Response(
            JSON.stringify({
              usage: { input_tokens: 23, output_tokens: 7 },
              content: [{ type: "text", text: "Recognized revenue is available." }]
            }),
            { status: 200 }
          );
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "What revenue can I inspect?",
        tools: [
          {
            name: "list_metrics",
            title: "List metrics",
            summary: "List available metrics",
            authority: "tool_agent",
            inputSchema: { type: "object", properties: {} }
          }
        ],
        toolResults: [
          {
            id: "call_1",
            name: "list_metrics",
            result: createEnvelope({
              actionId: "list_metrics",
              authority: "tool_agent",
              data: { metrics: [{ id: "recognized_revenue" }] },
              provenance: ["metric_definitions"]
            })
          }
        ]
      });

      expect(requests[0].url).toBe("https://api.anthropic.com/v1/messages");
      expect(requests[0].headers.get("authorization")).toBe("Bearer claude-access-token");
      expect(requests[0].headers.get("anthropic-version")).toBe("2023-06-01");
      expect(requests[0].headers.get("x-app")).toBe("cli");
      expect(requests[0].headers.get("user-agent")).toContain("claude-cli/");
      expect(requests[0].headers.get("anthropic-beta")).toContain("claude-code-20250219");
      expect(requests[0].body).toMatchObject({ model: "claude-sonnet-4-5" });
      expect(JSON.stringify(requests[0].body)).toContain("list_metrics");
      expect(JSON.stringify(requests[0].body)).toContain("recognized_revenue");
      expect(JSON.stringify(requests[0].body)).toContain("Infinite OS result digest");
      expect(JSON.stringify(requests[0].body)).toContain("metrics available");
      expect(response.message).toBe("Recognized revenue is available.");
      expect(response.usage).toEqual({ promptTokens: 23, completionTokens: 7 });
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("streams Claude Messages SSE text deltas through model request callbacks", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-streaming-client-"));
    const deltas: string[] = [];
    const requests: Array<{ body: Record<string, unknown> }> = [];
    try {
      const env = { GROWTH_OS_HOME: growthHome };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "claude-code",
          authMode: "reuse",
          token: "claude-access-token"
        },
        env
      );
      const encoder = new TextEncoder();
      const client = createConfiguredModelClient({
        env,
        fetch: async (_url, init) => {
          requests.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    [
                      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
                      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Revenue "}}',
                      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"is available."}}',
                      'event: message_delta\ndata: {"type":"message_delta","delta":{"usage":{"input_tokens":9,"output_tokens":4}}}',
                      "data: [DONE]"
                    ].join("\n\n")
                  )
                );
                controller.close();
              }
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } }
          );
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "What revenue can I inspect?",
        tools: [],
        toolResults: [],
        onMessageDelta(delta) {
          deltas.push(delta);
        }
      });

      expect(requests[0].body).toMatchObject({ stream: true });
      expect(deltas).toEqual(["Revenue ", "is available."]);
      expect(response.message).toBe("Revenue is available.");
      expect(response.usage).toEqual({ promptTokens: 9, completionTokens: 4 });
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("builds Claude Messages requests from reused Claude Code credentials file when Infinite OS auth is absent", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-client-file-auth-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "growth-os-claude-home-"));
    const claudeDir = join(fakeHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "claude-file-token",
          refreshToken: "claude-file-refresh"
        }
      })
    );
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    try {
      const env = { GROWTH_OS_HOME: growthHome, HOME: fakeHome };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      const client = createConfiguredModelClient({
        env,
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
            headers: new Headers(init?.headers)
          });
          return new Response(
            JSON.stringify({
              usage: { input_tokens: 11, output_tokens: 4 },
              content: [{ type: "text", text: "Used Claude credentials file." }]
            }),
            { status: 200 }
          );
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "What metrics are available?",
        tools: [],
        toolResults: []
      });

      expect(requests[0].headers.get("authorization")).toBe("Bearer claude-file-token");
      expect(response.message).toBe("Used Claude credentials file.");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("prefers live Claude credentials-file tokens over stale stored reuse tokens", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-prefer-live-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "growth-os-claude-home-live-"));
    const claudeDir = join(fakeHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "live-claude-file-token",
          refreshToken: "live-claude-file-refresh"
        }
      })
    );
    const requests: Array<{ headers: Headers }> = [];
    try {
      const env = { GROWTH_OS_HOME: growthHome, HOME: fakeHome };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "claude-code-credentials-file",
          authMode: "reuse",
          token: "stale-stored-token",
          refreshToken: "stale-stored-refresh"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (_url, init) => {
          requests.push({ headers: new Headers(init?.headers) });
          return new Response(
            JSON.stringify({
              usage: { input_tokens: 5, output_tokens: 2 },
              content: [{ type: "text", text: "Used live credentials." }]
            }),
            { status: 200 }
          );
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "Hi",
        tools: [],
        toolResults: []
      });

      expect(requests[0].headers.get("authorization")).toBe("Bearer live-claude-file-token");
      expect(response.message).toBe("Used live credentials.");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("uses the direct Bearer /messages path for non-OAuth reuse credentials without any bridge", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-reuse-direct-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "growth-os-claude-reuse-direct-home-"));
    try {
      const requests: Array<{ url: string; headers: Headers }> = [];
      const env = { GROWTH_OS_HOME: growthHome, HOME: fakeHome };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "claude-code",
          authMode: "reuse",
          token: "plain-bearer-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url, init) => {
          requests.push({ url: String(url), headers: new Headers(init?.headers) });
          return new Response(
            JSON.stringify({
              content: [{ type: "text", text: "Direct path used." }]
            }),
            { status: 200 }
          );
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "hello",
        tools: [],
        toolResults: []
      });

      expect(response.message).toBe("Direct path used.");
      expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
      expect(requests[0].headers.get("authorization")).toBe("Bearer plain-bearer-token");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns the OAuth-unsupported message for Claude OAuth-bearer credentials and never calls the API", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-oauth-unsupported-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "growth-os-claude-oauth-unsupported-home-"));
    try {
      const requests: string[] = [];
      const env = { GROWTH_OS_HOME: growthHome, HOME: fakeHome };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "macos-keychain",
          authMode: "reuse",
          token: "sk-ant-oat01-test-access-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url) => {
          requests.push(String(url));
          return new Response(JSON.stringify({ content: [{ type: "text", text: "should not run" }] }), {
            status: 200
          });
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "hello",
        tools: [],
        toolResults: []
      });

      expect(response.message).toContain("Claude via OAuth");
      expect(response.message).toContain("no longer supported");
      expect(response.message).toContain("ANTHROPIC_API_KEY");
      // OAuth-bearer credentials must short-circuit before any network call.
      expect(requests).toEqual([]);
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns the OAuth-unsupported message when Claude setup-token auth is selected", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-setup-token-unsupported-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "growth-os-claude-setup-token-unsupported-home-"));
    try {
      const env = { GROWTH_OS_HOME: growthHome, HOME: fakeHome };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "macos-keychain",
          authMode: "setup-token",
          token: "sk-ant-oat01-test-access-token",
          refreshToken: "sk-ant-ort01-test-refresh-token"
        },
        env
      );
      const client = createConfiguredModelClient({ env });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "hello",
        tools: [],
        toolResults: []
      });

      expect(response.message).toContain("Claude via OAuth");
      expect(response.message).toContain("ANTHROPIC_API_KEY");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("uses the Anthropic API-key path with x-api-key when ANTHROPIC_API_KEY is set", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-api-key-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "growth-os-claude-api-key-home-"));
    const requests: Array<{ url: string; headers: Headers }> = [];
    try {
      const env = {
        GROWTH_OS_HOME: growthHome,
        HOME: fakeHome,
        ANTHROPIC_API_KEY: "sk-ant-api03-test-key"
      };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      const client = createConfiguredModelClient({
        env,
        fetch: async (url, init) => {
          requests.push({ url: String(url), headers: new Headers(init?.headers) });
          return new Response(
            JSON.stringify({
              usage: { input_tokens: 4, output_tokens: 2 },
              content: [{ type: "text", text: "API key answered." }]
            }),
            { status: 200 }
          );
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "hello",
        tools: [],
        toolResults: []
      });

      expect(requests[0].url).toBe("https://api.anthropic.com/v1/messages");
      expect(requests[0].headers.get("x-api-key")).toBe("sk-ant-api03-test-key");
      expect(requests[0].headers.get("authorization")).toBeNull();
      expect(requests[0].headers.get("anthropic-version")).toBe("2023-06-01");
      expect(response.message).toBe("API key answered.");
      expect(response.usage).toEqual({ promptTokens: 4, completionTokens: 2 });
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("refreshes Claude bearer auth and retries once after a 401", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-refresh-"));
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    try {
      const env = {
        GROWTH_OS_HOME: growthHome,
        GROWTH_OS_CLAUDE_REFRESH_URL: "https://claude.example.test/oauth/token"
      };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "claude-code",
          authMode: "reuse",
          token: "expired-claude-token",
          refreshToken: "claude-refresh-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
            headers: new Headers(init?.headers)
          });
          if (String(url).endsWith("/messages") && requests.length === 1) {
            return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
          }
          if (String(url) === env.GROWTH_OS_CLAUDE_REFRESH_URL) {
            return new Response(
              JSON.stringify({
                access_token: "fresh-claude-token",
                refresh_token: "fresh-claude-refresh",
                expires_at: "2026-06-03T12:00:00.000Z"
              }),
              { status: 200 }
            );
          }
          return new Response(JSON.stringify({ content: [{ type: "text", text: "Recovered." }] }), {
            status: 200
          });
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "Hello",
        tools: [],
        toolResults: []
      });

      expect(response.message).toBe("Recovered.");
      expect(requests.map((request) => request.url)).toEqual([
        "https://api.anthropic.com/v1/messages",
        "https://claude.example.test/oauth/token",
        "https://api.anthropic.com/v1/messages"
      ]);
      expect(requests[0].headers.get("authorization")).toBe("Bearer expired-claude-token");
      expect(requests[0].headers.get("x-app")).toBe("cli");
      expect(requests[0].headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
      expect(requests[2].headers.get("authorization")).toBe("Bearer fresh-claude-token");
      expect(requests[2].headers.get("x-app")).toBe("cli");
      expect(readInfiniteOsAuthState(env).providers.claude).toMatchObject({
        token: "fresh-claude-token",
        refreshToken: "fresh-claude-refresh"
      });
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("returns Claude re-login diagnostics when bearer auth remains unauthorized", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-unauthorized-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "growth-os-no-codex-home-"));
    try {
      const env = { GROWTH_OS_HOME: growthHome, HOME: fakeHome };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "claude-code",
          authMode: "reuse",
          token: "expired-claude-token",
          refreshToken: "broken-refresh-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url) => {
          if (String(url).includes("/messages")) {
            return new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
          }
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "Hi",
        tools: [],
        toolResults: []
      });

      expect(response.message).toContain("Claude model auth expired or is invalid and could not be refreshed");
      expect(response.message).toContain("infinite auth login claude --mode reuse");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("does not fall back to Codex when the selected Claude provider remains unauthorized", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-no-cross-fallback-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "growth-os-no-codex-home-"));
    try {
      const env = { GROWTH_OS_HOME: growthHome, HOME: fakeHome };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "claude-code",
          authMode: "reuse",
          token: "expired-claude-token",
          refreshToken: "broken-refresh-token"
        },
        env
      );
      const requests: string[] = [];
      const client = createConfiguredModelClient({
        env,
        fetch: async (url) => {
          requests.push(String(url));
          if (String(url).includes("/messages")) {
            return new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
          }
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
        }
      });

      const response = await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "Hi",
        tools: [],
        toolResults: []
      });

      expect(response.message).toContain("Claude model auth expired or is invalid");
      expect(requests.some((url) => url.includes("/responses"))).toBe(false);
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("builds a more synthesis-friendly digest for metric and view descriptions", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-capability-digest-"));
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    try {
      const env = {
        GROWTH_OS_HOME: growthHome
      };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "claude-code",
          authMode: "reuse",
          token: "claude-access-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
            headers: new Headers(init?.headers)
          });
          return new Response(
            JSON.stringify({
              usage: { input_tokens: 8, output_tokens: 3 },
              content: [{ type: "text", text: "Done." }]
            }),
            { status: 200 }
          );
        }
      });

      await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "What revenue can I inspect?",
        tools: [],
        toolResults: [
          {
            id: "metric_1",
            name: "describe_metric",
            result: createEnvelope({
              actionId: "describe_metric",
              authority: "tool_agent",
              data: {
                metric: {
                  id: "recognized_revenue",
                  source_view: "queryable.vw_revenue_by_source",
                  default_time_column: "occurred_on",
                  allowed_dimensions: ["provider", "currency"]
                }
              },
              provenance: ["metric_definitions"]
            })
          },
          {
            id: "view_1",
            name: "describe_queryable_view",
            result: createEnvelope({
              actionId: "describe_queryable_view",
              authority: "tool_agent",
              data: {
                view: {
                  id: "queryable.vw_revenue_by_source",
                  row_grain: "day/source/currency",
                  default_time_column: "occurred_on",
                  allowed_dimensions: ["provider", "currency"]
                }
              },
              provenance: ["queryable_views"]
            })
          }
        ]
      });

      const bodyText = JSON.stringify(requests[0].body);
      expect(bodyText).toContain("metric recognized_revenue from queryable.vw_revenue_by_source; time occurred_on; dimensions provider, currency.");
      expect(bodyText).toContain("view queryable.vw_revenue_by_source; grain day/source/currency; time occurred_on; dimensions provider, currency.");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("builds more readable timing bucket labels into breakdown digests", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-timing-digest-"));
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    try {
      const env = {
        GROWTH_OS_HOME: growthHome
      };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "claude-code",
          authMode: "reuse",
          token: "claude-access-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
            headers: new Headers(init?.headers)
          });
          return new Response(
            JSON.stringify({
              usage: { input_tokens: 9, output_tokens: 3 },
              content: [{ type: "text", text: "Done." }]
            }),
            { status: 200 }
          );
        }
      });

      await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "What are the best times to tweet?",
        tools: [],
        toolResults: [
          {
            id: "timing_1",
            name: "run_breakdown_query",
            result: createEnvelope({
              actionId: "run_breakdown_query",
              authority: "tool_agent",
              data: {
                rows: [
                  { published_hour_utc: 2, x_public_engagement: "33" },
                  { published_weekday_utc: 2, x_public_engagement: "66" }
                ],
                metric: "x_public_engagement",
                view: "queryable.vw_x_post_public_metrics"
              },
              provenance: ["queryable.vw_x_post_public_metrics"]
            })
          }
        ]
      });

      const bodyText = JSON.stringify(requests[0].body);
      expect(bodyText).toContain("hour 02 UTC");
      expect(bodyText).toContain("Tuesday");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("builds a more synthesis-friendly digest for metric and source results", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-digest-"));
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    try {
      const env = {
        GROWTH_OS_HOME: growthHome
      };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "claude-code",
          authMode: "reuse",
          token: "claude-access-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
            headers: new Headers(init?.headers)
          });
          return new Response(
            JSON.stringify({
              usage: { input_tokens: 11, output_tokens: 5 },
              content: [{ type: "text", text: "Done." }]
            }),
            { status: 200 }
          );
        }
      });

      await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "What happened?",
        tools: [],
        toolResults: [
          {
            id: "metric_1",
            name: "run_metric_query",
            result: createEnvelope({
              actionId: "run_metric_query",
              authority: "tool_agent",
              data: {
                rows: [{ recognized_revenue: "12000" }],
                metric: "recognized_revenue",
                view: "queryable.vw_revenue_by_source"
              },
              provenance: ["queryable.vw_revenue_by_source"]
            })
          },
          {
            id: "sources_1",
            name: "list_sources",
            result: createEnvelope({
              actionId: "list_sources",
              authority: "tool_agent",
              data: {
                sources: [{ id: "src_x_1", provider: "x", status: "connected", connection_name: "YourHandle Account" }]
              },
              provenance: ["sources"]
            })
          }
        ]
      });

      const bodyText = JSON.stringify(requests[0].body);
      expect(bodyText).toContain("metric recognized_revenue: 12000");
      expect(bodyText).toContain("connected sources: x (YourHandle Account) status=connected");
      expect(bodyText).toContain("Infinite OS result digest");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("builds source sync evidence into source-health digests", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-source-digest-"));
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    try {
      const env = {
        GROWTH_OS_HOME: growthHome
      };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "claude-code",
          authMode: "reuse",
          token: "claude-access-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
            headers: new Headers(init?.headers)
          });
          return new Response(
            JSON.stringify({
              usage: { input_tokens: 11, output_tokens: 5 },
              content: [{ type: "text", text: "Done." }]
            }),
            { status: 200 }
          );
        }
      });

      await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "What is source health?",
        tools: [],
        toolResults: [
          {
            id: "sources_1",
            name: "list_sources",
            result: createEnvelope({
              actionId: "list_sources",
              authority: "tool_agent",
              data: {
                sources: [{
                  id: "src_x",
                  provider: "x",
                  status: "connected",
                  connection_name: "YourHandle Account",
                  last_synced_at: "2026-06-06T15:34:32.364Z"
                }]
              },
              provenance: ["sources"]
            })
          },
          {
            id: "syncs_1",
            name: "get_recent_sync_runs",
            result: createEnvelope({
              actionId: "get_recent_sync_runs",
              authority: "tool_agent",
              data: {
                syncRuns: [{
                  id: "sync_x",
                  source_id: "src_x",
                  status: "succeeded",
                  started_at: "2026-06-06T15:33:00.000Z",
                  finished_at: "2026-06-06T15:34:32.364Z",
                  records_loaded: 105
                }]
              },
              provenance: ["sync_runs"]
            })
          }
        ]
      });

      const bodyText = JSON.stringify(requests[0].body);
      expect(bodyText).toContain("x (YourHandle Account) status=connected last_synced_at=2026-06-06T15:34:32.364Z");
      expect(bodyText).toContain("#1 src_x succeeded finished_at=2026-06-06T15:34:32.364Z records_loaded=105");
      expect(bodyText).toContain("Do not say never synced when last_synced_at or sync runs are present.");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("builds semantic winner labels into breakdown digests for model-backed synthesis", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-breakdown-digest-"));
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    try {
      const env = {
        GROWTH_OS_HOME: growthHome
      };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "claude-code",
          authMode: "reuse",
          token: "claude-access-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
            headers: new Headers(init?.headers)
          });
          return new Response(
            JSON.stringify({
              usage: { input_tokens: 9, output_tokens: 4 },
              content: [{ type: "text", text: "Done." }]
            }),
            { status: 200 }
          );
        }
      });

      await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "Which sources won?",
        tools: [],
        toolResults: [
          {
            id: "breakdown_1",
            name: "run_breakdown_query",
            result: createEnvelope({
              actionId: "run_breakdown_query",
              authority: "tool_agent",
              data: {
                rows: [
                  { provider: "stripe", currency: "usd", recognized_revenue: "12000" },
                  { provider: "posthog", currency: "usd", recognized_revenue: "3000" }
                ],
                metric: "recognized_revenue",
                view: "queryable.vw_revenue_by_source"
              },
              provenance: ["queryable.vw_revenue_by_source"]
            })
          },
          {
            id: "breakdown_2",
            name: "run_breakdown_query",
            result: createEnvelope({
              actionId: "run_breakdown_query",
              authority: "tool_agent",
              data: {
                rows: [
                  { utm_source: "google", utm_medium: "cpc", utm_campaign: "brand", site_visitors: "1200" },
                  { utm_source: "twitter", utm_medium: "social", utm_campaign: "launch", site_visitors: "700" }
                ],
                metric: "site_visitors",
                view: "queryable.vw_site_traffic"
              },
              provenance: ["queryable.vw_site_traffic"]
            })
          }
        ]
      });

      const bodyText = JSON.stringify(requests[0].body);
      expect(bodyText).toContain("recognized_revenue ranked rows: #1 recognized_revenue=12000 stripe / usd");
      expect(bodyText).toContain("#2 recognized_revenue=3000 posthog / usd");
      expect(bodyText).toContain("Pattern: winner is clearly ahead of the next row");
      expect(bodyText).toContain("site_visitors ranked rows: #1 site_visitors=1200 google / cpc / brand");
      expect(bodyText).toContain("#2 site_visitors=700 twitter / social / launch");
      expect(bodyText).toContain("Pattern: top rows are relatively close");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("labels X engagement breakdowns as top posts in the digest", async () => {
    const growthHome = mkdtempSync(join(tmpdir(), "growth-os-claude-x-breakdown-digest-"));
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    try {
      const env = {
        GROWTH_OS_HOME: growthHome
      };
      writeInfiniteOsModelSelection({ provider: "claude", model: "claude-sonnet-4-5" }, env);
      writeInfiniteOsAuthRecord(
        {
          provider: "claude",
          source: "claude-code",
          authMode: "reuse",
          token: "claude-access-token"
        },
        env
      );
      const client = createConfiguredModelClient({
        env,
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
            headers: new Headers(init?.headers)
          });
          return new Response(
            JSON.stringify({
              usage: { input_tokens: 9, output_tokens: 4 },
              content: [{ type: "text", text: "Done." }]
            }),
            { status: 200 }
          );
        }
      });

      await client.complete({
        systemPrompt: "Use typed Infinite OS actions.",
        userMessage: "What should I post more of on X?",
        tools: [],
        toolResults: [
          {
            id: "x_breakdown_1",
            name: "run_breakdown_query",
            result: createEnvelope({
              actionId: "run_breakdown_query",
              authority: "tool_agent",
              data: {
                rows: [
                  { x_post_id: "1", body_text: "Hot take one", x_public_engagement: "33" },
                  { x_post_id: "2", body_text: "Hot take two", x_public_engagement: "19" }
                ],
                metric: "x_public_engagement",
                view: "queryable.vw_x_post_public_metrics"
              },
              provenance: ["queryable.vw_x_post_public_metrics"]
            })
          }
        ]
      });

      const bodyText = JSON.stringify(requests[0].body);
      expect(bodyText).toContain("top X posts by engagement");
      expect(bodyText).toContain("Hot take one");
      expect(bodyText).toContain("Hot take two");
    } finally {
      rmSync(growthHome, { recursive: true, force: true });
    }
  });

  it("builds SQL-backed session store operations over LLM runtime tables", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const store = createSessionStore({
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        return [];
      },
      one: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> => {
        queries.push({ sql, params });
        return {
          id: "session-1",
          workspaceId: "workspace-1",
          sessionKey: "session-1",
          actorId: "operator-1",
          surface: "api",
          modelProvider: "claude",
          modelName: "claude-sonnet-4-5",
          modelAuthSource: "claude-code"
        } as T;
      }
    });

    await store.ensureSession({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api",
      modelProvider: "claude",
      modelName: "claude-sonnet-4-5",
      modelAuthSource: "claude-code"
    });
    await store.appendMessage({ sessionId: "session-1", role: "user", content: "Hello" });
    await store.recordActionCall({
      sessionId: "session-1",
      providerToolCallId: "call_1",
      actionId: "list_metrics",
      authority: "tool_agent",
      input: {},
      outputEnvelope: { ok: true },
      status: "ok",
      requiresConfirmation: false,
      confirmationId: "confirm_abc",
      inputHash: "hash_abc"
    });
    await store.listSessions("workspace-1");
    await store.getSession("session-1");
    await store.searchSessions("workspace-1", "revenue by source", { excludeSessionId: "session-1" });
    await store.getPendingActionCall?.("confirm_abc");
    await store.confirmActionCall?.({
      confirmationId: "confirm_abc",
      outputEnvelope: { ok: true, actionId: "start_source_sync" },
      status: "ok"
    });
    await store.recordTokenUsage?.({
      sessionId: "session-1",
      promptTokens: 31,
      completionTokens: 9
    });
    await store.resumeSession("session-1");
    await store.endSession("session-1", "operator_request");
    await store.compactSession({
      sessionId: "session-1",
      newSessionId: "session-2",
      summaryText: "The operator asked about revenue sources.",
      summaryJson: { selectedMetric: "recognized_revenue" }
    });

    expect(queries.map((query) => query.sql).join("\n")).toContain("chat_sessions");
    expect(queries.map((query) => query.sql).join("\n")).toContain("chat_messages");
    expect(queries.map((query) => query.sql).join("\n")).toContain("chat_action_calls");
    expect(queries.map((query) => query.sql).join("\n")).toContain("input_hash");
    expect(queries.map((query) => query.sql).join("\n")).toContain("chat_session_summaries");
    expect(queries.map((query) => query.sql).join("\n")).toContain('summary_text as "summaryText"');
    expect(queries.map((query) => query.sql).join("\n")).toContain("websearch_to_tsquery");
    expect(queries.map((query) => query.sql).join("\n")).toContain("excluded_lineage");
    expect(queries.map((query) => query.sql).join("\n")).toContain("confirmed_at = now()");
    expect(queries.map((query) => query.sql).join("\n")).toContain("confirmation_id = $1");
    expect(queries.map((query) => query.sql).join("\n")).toContain("last_prompt_tokens = $2");
    expect(queries.map((query) => query.sql).join("\n")).toContain("total_tokens = coalesce(total_tokens, 0) + $2 + $3");
    expect(queries.find((query) => query.sql.includes("websearch_to_tsquery"))?.params).toEqual([
      "workspace-1",
      "revenue by source",
      "session-1"
    ]);
    expect(queries.map((query) => query.sql).join("\n")).toContain("status = 'active'");
    expect(queries.map((query) => query.sql).join("\n")).toContain("status = 'ended'");
    expect(queries.map((query) => query.sql).join("\n")).toContain("status = 'compacted'");
  });

  it.skip("suggests exact setup commands for missing providers in empty-state answers", async () => {
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ recognized_revenue: null }],
              metric: "recognized_revenue",
              view: "queryable.vw_revenue_by_source"
            },
            provenance: ["queryable.vw_revenue_by_source"]
          }),
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: { sources: [] },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: { syncRuns: [] },
            provenance: ["sync_runs"]
          })
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    const result = await controller.chat({
      message: "what revenue did we do",
      sessionId: "session-next-step-command",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("`infinite setup connectors stripe`");
    expect(result.message).not.toContain("There are no recent sync runs recorded");
    expect(result.actionCalls.map((call) => call.actionId)).not.toContain("get_recent_sync_runs");
  });

  it.skip("suggests an exact sync command when the provider exists but has no successful sync", async () => {
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({
        run_metric_query: (_input, context) =>
          createEnvelope({
            actionId: "run_metric_query",
            authority: context.authority,
            data: {
              rows: [{ site_visitors: null }],
              metric: "site_visitors",
              view: "queryable.vw_site_traffic"
            },
            provenance: ["queryable.vw_site_traffic"]
          }),
        list_sources: (_input, context) =>
          createEnvelope({
            actionId: "list_sources",
            authority: context.authority,
            data: {
              sources: [{ id: "src_ga4", provider: "google_analytics_4", status: "connected", connection_name: "Main Site GA4" }]
            },
            provenance: ["sources"]
          }),
        get_recent_sync_runs: (_input, context) =>
          createEnvelope({
            actionId: "get_recent_sync_runs",
            authority: context.authority,
            data: {
              syncRuns: [{ id: "sync_1", source_id: "src_ga4", status: "failed" }]
            },
            provenance: ["sync_runs"]
          })
      }),
      modelClient: {
        complete: async () => ({ message: "Fallback model answer." })
      }
    });

    const result = await controller.chat({
      message: "how many visitors did we have",
      sessionId: "session-sync-command",
      workspaceId: "workspace-1",
      actorId: "operator-1",
      surface: "api"
    });

    expect(result.message).toContain("`infinite sync src_ga4`");
  });
});

function createRecordingSessionStore(): ChatSessionStore & { events: string[][] } {
  const events: string[][] = [];
  return {
    events,
    async ensureSession(input) {
      events.push(["ensureSession", input.sessionId]);
    },
    async appendMessage(input) {
      events.push(["appendMessage", input.role, input.content, input.tokenCount === undefined ? "" : String(input.tokenCount)]);
    },
    async recordActionCall(input) {
      events.push(["recordActionCall", input.actionId, input.status]);
    },
    async recordTokenUsage(input) {
      events.push([
        "recordTokenUsage",
        String(input.promptTokens ?? 0),
        String(input.completionTokens ?? 0)
      ]);
    },
    async listSessions() {
      return [];
    },
    async getSession() {
      return null;
    },
    async searchSessions(workspaceId, query, options) {
      events.push(["searchSessions", workspaceId, query, options?.excludeSessionId ?? ""]);
      return [];
    },
    async endSession() {
      events.push(["endSession"]);
    },
    async compactSession() {
      events.push(["compactSession"]);
      return { sessionId: "session-child", parentSessionId: "session-parent" };
    },
    async resumeSession() {
      events.push(["resumeSession"]);
    }
  };
}
