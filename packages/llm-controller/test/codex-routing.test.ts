import { describe, expect, it } from "vitest";

import {
  FIRST_PHASE_METRIC_ALIASES,
  createDaemonActionRegistry,
  createInfiniteOsRegistry,
  type ActionDefinition
} from "@infinite-os/runtime";

import { assembleInfiniteOsPrompt, createLlmController, type ModelRequest } from "../src/index.js";
import {
  buildQueryRefinementSections,
  buildQuerySynthesisSections,
  createSourceAwareQueryAdvisor,
  splitHostTurnContext,
  type QueryAdvisorInput
} from "../src/query-advisor.js";

// Codex steering: a desktop union turn carries the app's tools as `mcp__<server>__<tool>` twins. The engine prompt
// and advisor must route by what the turn really has, and leave an open-core turn (no twins) as it was.

const APP_SERVER = "infinite_app";

function twin(name: string): ActionDefinition {
  return {
    id: `mcp__${APP_SERVER}__${name}` as ActionDefinition["id"],
    title: name,
    summary: `${name} (app tool)`,
    category: "operator",
    authority: "tool_agent",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    provenancePolicy: "metadata",
    recommendedNextActions: [],
    recipeIds: [],
    handler: async () => ({})
  } as ActionDefinition;
}

const native = (): ActionDefinition[] => createInfiniteOsRegistry({}).list();

function prompt(actions: ActionDefinition[]): string {
  return assembleInfiniteOsPrompt({ actions, workspaceId: "ws_test", surface: "desktop", modelProvider: "codex" });
}

/** The injected alias hint, parsed back from the prompt. */
function injectedAliases(text: string): Record<string, string[]> {
  const lines = text.split("\n");
  const header = lines.findIndex((line) => line.startsWith("Metric aliases"));
  expect(header).toBeGreaterThan(-1);
  return JSON.parse(lines[header + 1] ?? "{}") as Record<string, string[]>;
}

/** The injected metric id list, parsed back from the prompt. */
function injectedMetrics(text: string): string[] {
  const lines = text.split("\n");
  const header = lines.indexOf("Metrics:");
  expect(header).toBeGreaterThan(-1);
  return JSON.parse(lines[header + 1] ?? "[]") as string[];
}

describe("engine alias hint: trials", () => {
  it("never maps 'trials' or 'new trials' to the trialing-now snapshot", () => {
    expect(FIRST_PHASE_METRIC_ALIASES.stripe_trialing_subscribers).toEqual([
      "trialing subscribers",
      "current trials",
      "trial customers"
    ]);
  });
});

describe("engine prompt: signups", () => {
  it("keeps the signups alias for an open-core turn with no run_app_outcomes", () => {
    const text = prompt(native());
    expect(injectedAliases(text).signup_count).toEqual(["signups"]);
    expect(text).not.toContain('definition "stages_v1"');
  });

  it("routes signups to run_app_outcomes stages_v1 and hides the signups alias when the app twin is present", () => {
    const text = prompt([...native(), twin("run_app_outcomes")]);
    expect(injectedAliases(text)).not.toHaveProperty("signup_count");
    expect(text).toContain('call run_app_outcomes with definition "stages_v1" first');
    expect(text).toContain("accountCreated = Registrations; appSignup = App signups");
    // The fallback for workspaces the outcomes route does not serve.
    expect(text).toContain("Only when run_app_outcomes answers available:false may signup_count answer");
    expect(text).toContain("PostHog 'signup' events");
  });
});

describe("engine prompt: trials", () => {
  it("sends trial starts to read_subscription_metrics and names the snapshot, when that twin is present", () => {
    const text = prompt([...native(), twin("read_subscription_metrics")]);
    expect(text).toContain("Trials started");
    expect(text).toContain("read_subscription_metrics");
    expect(text).toContain("stripe_trialing_subscribers counts customers trialing now");
  });

  it("adds no trial bullet without read_subscription_metrics", () => {
    expect(prompt(native())).not.toContain("Trials started");
  });
});

describe("engine prompt: site visits", () => {
  it("drops the GA4 visit/visitor aliases and routes visits to run_site_metrics when that twin is present", () => {
    const text = prompt([...native(), twin("run_site_metrics"), twin("analysis_compare")]);
    const aliases = injectedAliases(text);
    expect(aliases.sessions).not.toContain("visits");
    expect(aliases.sessions).toContain("sessions");
    expect(aliases).not.toHaveProperty("site_visitors");
    expect(text).toContain("Site visits, visitors or traffic totals -> run_site_metrics");
    expect(text).toContain("read high");
    expect(text).toContain("analysis_compare with segmentBy entry_channel");
  });

  it("keeps the GA4 aliases on an open-core turn", () => {
    const aliases = injectedAliases(prompt(native()));
    expect(aliases.sessions).toContain("visits");
    expect(aliases.site_visitors).toEqual(["visitors", "users"]);
  });
});

describe("engine prompt: Meta", () => {
  const metaTurn = () => [...native(), twin("get_meta_performance"), twin("list_meta_entities")];

  it("routes Meta numbers to get_meta_performance and drops the Meta recipes, aliases and metric ids", () => {
    const text = prompt(metaTurn());
    const aliases = injectedAliases(text);
    for (const id of ["results", "cost_per_result", "roas", "ctr", "cpc", "meta_ads_spend", "link_clicks"]) {
      expect(aliases).not.toHaveProperty(id);
      expect(injectedMetrics(text)).not.toContain(id);
    }
    // The Stripe-attributed ROAS is not a Meta metric id and stays served.
    expect(aliases).toHaveProperty("roas_from_stripe");
    expect(text).not.toContain("cost_per_result with result_type=lead");
    expect(text).not.toContain("maps to the cost_per_result metric");
    expect(text).toContain("Meta Ads numbers");
    expect(text).toContain("-> get_meta_performance with a structured `period`");
    expect(text).toContain("Meta's claim");
    // The native live Graph read is never offered next to the stored read.
    expect(text).not.toContain("-> run_meta_live_insights");
  });

  it("names the app's list_meta_entities twin for status, never the queryable effective_status recipe", () => {
    const text = prompt(metaTurn());
    expect(text).toContain(`-> mcp__${APP_SERVER}__list_meta_entities`);
    expect(text).not.toContain("do NOT reach for a live entity-list or Graph tool");
  });

  it("tells Meta-credited registrations and trials apart from our own counts", () => {
    const text = prompt([...metaTurn(), twin("run_app_outcomes"), twin("read_subscription_metrics")]);
    expect(text).toContain(
      "- Registrations or trials credited to Meta ads → get_meta_performance (Meta's claim). Our own counts stay run_app_outcomes (registrations = first profile insert) and read_subscription_metrics (Stripe trial starts). Never present one as the other; when asked to compare, show both, labelled."
    );
    const metaLine = text.split("\n").find((line) => line.startsWith("- Meta Ads numbers")) ?? "";
    expect(metaLine).toMatch(/registrations/);
    expect(metaLine).toMatch(/trials/);
    const claim = metaLine.slice(metaLine.indexOf("Its results"));
    expect(claim).toMatch(/registrations/);
    expect(claim).toMatch(/trials/);
    expect(claim).toContain("Meta's claim");
  });

  it("adds no Meta-credit bullet without get_meta_performance", () => {
    expect(prompt(native())).not.toContain("credited to Meta ads");
  });

  it("drops the result_type partition rule on a desktop Meta turn and keeps it open-core", () => {
    expect(prompt(metaTurn())).not.toContain("partition");
    expect(prompt(native())).toContain("it never relaxes a required result_type partition");
  });

  it("leaves an open-core turn's Meta recipes as they were", () => {
    const text = prompt(native());
    expect(text).toContain("cost_per_result with result_type=lead");
    expect(injectedAliases(text).cost_per_result).toContain("cpl");
    expect(text).not.toContain("-> get_meta_performance");
  });
});

describe("engine prompt: leads", () => {
  it("sends leads to list_audit_leads, its own step, when that twin is present", () => {
    const text = prompt([...native(), twin("list_audit_leads"), twin("get_meta_performance")]);
    expect(text).toContain("'Leads', 'new leads' or 'audit leads' -> list_audit_leads");
    expect(text).toContain("never a signup or registration");
    expect(injectedAliases(text)).not.toHaveProperty("results");
  });

  it("adds no leads bullet without list_audit_leads", () => {
    expect(prompt(native())).not.toContain("-> list_audit_leads");
  });
});

describe("advisor synthesis lines", () => {
  const metricResult = (metric: string) => [{ name: "run_metric_query", result: { data: { metric, rows: [] } } }];
  const breakdownResult = (metric: string) => [{ name: "run_breakdown_query", result: { data: { metric, rows: [] } } }];

  it("says signup_count counts PostHog 'signup' events, never the signup authority", () => {
    const text = buildQuerySynthesisSections("how many signups", metricResult("signup_count")).join("\n");
    expect(text).toContain("PostHog events named 'signup', not accounts or registrations");
    expect(text).toContain("0 here does not mean nobody signed up");
    expect(text).not.toContain("first-phase signup authority");
  });

  it("says the conversion rate is GA4 key events over GA4 visitors, not a signup rate", () => {
    const text = buildQuerySynthesisSections("what is our conversion rate", metricResult("site_conversion_rate")).join("\n");
    expect(text).toContain("GA4 key events divided by GA4 visitors (same lane), not a signup or registration rate");
    expect(text).not.toContain("PostHog signups");
  });

  it("says a signup channel breakdown is PostHog 'signup' events, not registrations", () => {
    const text = buildQuerySynthesisSections("signups by channel", breakdownResult("signup_count")).join("\n");
    expect(text).toContain("PostHog 'signup' events by channel, not registrations");
  });

  it("never calls GA4 visitors the traffic authority", () => {
    const text = buildQuerySynthesisSections("how many visitors", metricResult("site_visitors")).join("\n");
    expect(text).not.toContain("traffic authority");
    expect(text).toContain("GA4");
    expect(text).toContain("never people");
  });

  it("says the trialing count is a snapshot, not trials started", () => {
    const text = buildQuerySynthesisSections("how many new trials", metricResult("stripe_trialing_subscribers")).join("\n");
    expect(text).toContain("trialing right now");
    expect(text).toContain("not trials started");
  });
});

describe("advisor refinement: Meta metric questions", () => {
  const sourcesOnly = [{ name: "list_sources", result: { data: { sources: [] } } }];

  it("sends a Meta cost/ROAS question to get_meta_performance when the app twin is present", () => {
    for (const question of ["what's my cpl", "what is our roas", "how much did we spend on meta ads"]) {
      const text = buildQueryRefinementSections(question, sourcesOnly, [`mcp__${APP_SERVER}__get_meta_performance`]).join("\n");
      expect(text).toContain("get_meta_performance with a structured `period`");
      expect(text).not.toContain("run run_metric_query or run_breakdown_query");
    }
  });

  it("sends Meta-credited registrations and trials to get_meta_performance, labelled as Meta's claim", () => {
    for (const question of [
      "how many registrations did facebook ads bring last week?",
      "how many trials came from our meta campaigns?"
    ]) {
      const text = buildQueryRefinementSections(question, sourcesOnly, [`mcp__${APP_SERVER}__get_meta_performance`]).join("\n");
      expect(text).toContain("get_meta_performance with a structured `period`");
      expect(text).toContain("Meta's claim");
    }
  });

  it("does not fire the Meta check on non-Meta questions", () => {
    for (const question of [
      "how many impressions did my tweets get last week?",
      "what is my instagram reach this month?",
      "how much did I spend on google ads?",
      "what's my reach on youtube?"
    ]) {
      const text = buildQueryRefinementSections(question, sourcesOnly, [`mcp__${APP_SERVER}__get_meta_performance`]).join("\n");
      expect(text, question).not.toContain("get_meta_performance");
    }
  });

  it("does not fire the Meta check on our own registrations or trials", () => {
    for (const question of ["how many registrations last week?", "how many trials this month?"]) {
      const text = buildQueryRefinementSections(question, sourcesOnly, [`mcp__${APP_SERVER}__get_meta_performance`]).join("\n");
      expect(text, question).not.toContain("get_meta_performance");
    }
  });

  it("sends a plain ads question to get_meta_performance", () => {
    for (const question of [
      "how much did I spend on ads last week?",
      "what's my ad spend?",
      "how many impressions did my ads get?"
    ]) {
      const text = buildQueryRefinementSections(question, sourcesOnly, [`mcp__${APP_SERVER}__get_meta_performance`]).join("\n");
      expect(text, question).toContain("get_meta_performance with a structured `period`");
    }
  });

  it("does not fire the Meta check on another platform's ads or campaigns", () => {
    for (const question of [
      "how much did I spend on reddit ads last week?",
      "how many impressions did my pinterest ads get?",
      "what's my snapchat ad spend?",
      "how many clicks did my bing ads get?",
      "how many clicks did my google campaign get?",
      "how much did we spend on google campaigns this month?"
    ]) {
      const text = buildQueryRefinementSections(question, sourcesOnly, [`mcp__${APP_SERVER}__get_meta_performance`]).join("\n");
      expect(text, question).not.toContain("get_meta_performance");
    }
  });

  it("does not read a non-ad campaign or meta tags as Meta", () => {
    for (const question of [
      "how many signups came from my email campaign?",
      "how many clicks did my newsletter campaign get?",
      "what's the ctr on my meta descriptions?"
    ]) {
      const text = buildQueryRefinementSections(question, sourcesOnly, [`mcp__${APP_SERVER}__get_meta_performance`]).join("\n");
      expect(text, question).not.toContain("get_meta_performance");
    }
  });

  it("still reads a named ad campaign as Meta", () => {
    const text = buildQueryRefinementSections("how many leads did the spring campaign get?", sourcesOnly, [`mcp__${APP_SERVER}__get_meta_performance`]).join("\n");
    expect(text).toContain("get_meta_performance with a structured `period`");
  });

  it("labels Meta-credited signups as Meta's claim", () => {
    for (const question of ["how many signups did facebook ads bring?", "how many sign-ups did meta get us?"]) {
      const text = buildQueryRefinementSections(question, sourcesOnly, [`mcp__${APP_SERVER}__get_meta_performance`]).join("\n");
      expect(text, question).toContain("get_meta_performance with a structured `period`");
      expect(text, question).toContain("Meta's claim");
    }
  });

  it("keeps the metric-alias rescue on an open-core turn", () => {
    const text = buildQueryRefinementSections("what's my cpl", sourcesOnly).join("\n");
    expect(text).toContain("run run_metric_query or run_breakdown_query");
  });

  it("keeps the metric-alias rescue for a non-Meta number on a desktop turn", () => {
    const text = buildQueryRefinementSections("how many orders", sourcesOnly, [`mcp__${APP_SERVER}__get_meta_performance`]).join("\n");
    expect(text).toContain("run run_metric_query or run_breakdown_query");
  });
});

describe("advisor ambiguity short-circuit", () => {
  const advise = (message: string, extra: Partial<QueryAdvisorInput> = {}) =>
    createSourceAwareQueryAdvisor().advise({
      message,
      workspaceId: "ws_test",
      actorId: "operator-1",
      sessionId: "s1",
      surface: "desktop",
      ...extra
    });

  it("asks for registrations, not signups, when the question names no metric", async () => {
    const result = await advise("what's our best channel");
    expect(result?.message).toBe("Do you mean best channel for traffic, registrations, conversion rate, or revenue?");
  });

  it("lets a Meta-named question through when get_meta_performance is available", async () => {
    const result = await advise("Which campaign is performing best?", {
      availableActionIds: [`mcp__${APP_SERVER}__get_meta_performance`]
    });
    expect(result?.message).toBeUndefined();
  });

  it("still asks on an open-core turn with no get_meta_performance", async () => {
    const result = await advise("Which campaign is performing best?", { availableActionIds: ["run_metric_query"] });
    expect(result?.message).toContain("Do you mean best channel for");
  });

  it("treats a named ad metric as the disambiguator", async () => {
    expect((await advise("which campaign has the best ROAS"))?.message).toBeUndefined();
    expect((await advise("which campaign is best for registrations"))?.message).toBeUndefined();
  });

  it("resolves a reply to the new clarification and to the old one", async () => {
    for (const asked of [
      "Do you mean best channel for traffic, registrations, conversion rate, or revenue?",
      "Do you mean best channel for traffic, signups, conversion rate, or revenue?"
    ]) {
      const result = await advise("revenue", {
        recentMessages: [
          { role: "user", content: "what's our best channel" },
          { role: "assistant", content: asked }
        ]
      });
      expect(result?.effectiveMessage).toBe("what's our best channel for revenue");
    }
  });

  it("accepts 'registrations' as the reply", async () => {
    const result = await advise("registrations", {
      recentMessages: [
        { role: "user", content: "what's our best channel" },
        { role: "assistant", content: "Do you mean best channel for traffic, registrations, conversion rate, or revenue?" }
      ]
    });
    expect(result?.effectiveMessage).toBe("what's our best channel for registrations");
  });
});

// The desktop host prefixes a time block and appends an iMessage reply style to the turn text. Neither is the
// person's question, and both carry words ("connected", "yesterday", "signup") the advisor classifies on.
const TIME_BLOCK = [
  "[Host turn context: facts from the app, not from the person]",
  "Current time: 2026-09-29 10:00 UTC (2026-09-29T10:00:00Z)."
].join("\n");
const REPLY_STYLE = [
  "Reply style for iMessage (final answer only):",
  "Be concise.",
  "If a brand has no source connected or no data yet, say it isn't measured; report yesterday's numbers plainly."
].join("\n");

describe("host turn context stripping", () => {
  it("splits the host time block and reply style from the question", () => {
    const message = `${TIME_BLOCK}\n\nhow many signups\n\n${REPLY_STYLE}`;
    const split = splitHostTurnContext(message);
    expect(split.question).toBe("how many signups");
    expect(`${split.before}${split.question}${split.after}`).toBe(message);
  });

  it("leaves a plain question untouched", () => {
    expect(splitHostTurnContext("how many signups")).toEqual({ before: "", question: "how many signups", after: "" });
  });

  it("gives the advisor only the question, and the model the whole turn text", async () => {
    const seen: QueryAdvisorInput[] = [];
    const requests: ModelRequest[] = [];
    const message = `${TIME_BLOCK}\n\nhow many visitors\n\n${REPLY_STYLE}`;
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      queryAdvisor: {
        advise: (input) => {
          seen.push(input);
          return { effectiveMessage: `${input.message} (resolved)` };
        }
      },
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "ok" };
        }
      }
    });
    await controller.chat({ message, sessionId: "s-strip", workspaceId: "ws_test", actorId: "operator-1", surface: "desktop" });
    expect(seen[0]?.message).toBe("how many visitors");
    // The advisor's rewrite keeps the host's blocks around it for the model.
    expect(requests[0]?.userMessage).toBe(`${TIME_BLOCK}\n\nhow many visitors (resolved)\n\n${REPLY_STYLE}`);
  });
});

describe("union turn: native live Meta read", () => {
  async function toolsFor(appTools: string[]): Promise<{ tools: string[]; call?: unknown }> {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          if (request.toolResults.length === 0) {
            return { toolCalls: [{ id: "call_live", name: "run_meta_live_insights", input: {} }] };
          }
          return { message: "done" };
        }
      }
    });
    const result = await controller.chat({
      message: "how are my ads doing",
      sessionId: `s-union-${appTools.join("-")}`,
      workspaceId: "ws_test",
      actorId: "operator-1",
      surface: "desktop",
      scopedAppTools: {
        serverName: APP_SERVER,
        allowedTools: appTools.map((name) => `mcp__${APP_SERVER}__${name}`),
        mode: "union",
        tools: appTools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
        callTool: async () => ({ ok: true })
      }
    });
    return {
      tools: (requests[0] as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
      call: result.actionCalls.find((call) => call.actionId === "run_meta_live_insights")
    };
  }

  it("drops run_meta_live_insights, and refuses a call to it, when the app's get_meta_performance is present", async () => {
    const { tools, call } = await toolsFor(["get_meta_performance"]);
    expect(tools).toContain(`mcp__${APP_SERVER}__get_meta_performance`);
    expect(tools).not.toContain("run_meta_live_insights");
    expect(call).toMatchObject({ status: "error", error: { code: "unknown_action" } });
  });

  it("keeps run_meta_live_insights in a union turn without the app twin", async () => {
    const { tools } = await toolsFor(["list_sources"]);
    expect(tools).toContain("run_meta_live_insights");
  });
});

describe("union turn: native live Meta entity reads", () => {
  const LIVE_READS = ["list_meta_entities", "get_meta_entity", "list_meta_assets"];

  async function run(appTools: string[], callName: string) {
    const requests: ModelRequest[] = [];
    const appCalls: string[] = [];
    const controller = createLlmController({
      registry: createInfiniteOsRegistry({}),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          if (request.toolResults.length === 0) {
            return { toolCalls: [{ id: "call_status", name: callName, input: {} }] };
          }
          return { message: "done" };
        }
      }
    });
    const result = await controller.chat({
      message: "is the spring campaign running?",
      sessionId: `s-union-status-${appTools.join("-")}-${callName}`,
      workspaceId: "ws_test",
      actorId: "operator-1",
      surface: "desktop",
      scopedAppTools: {
        serverName: APP_SERVER,
        allowedTools: appTools.map((name) => `mcp__${APP_SERVER}__${name}`),
        mode: "union",
        tools: appTools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
        callTool: async (name: string) => {
          appCalls.push(name);
          return { ok: true };
        }
      }
    });
    const first = requests[0] as { tools: Array<{ name: string }>; systemPrompt?: string };
    return {
      tools: first.tools.map((tool) => tool.name),
      call: result.actionCalls.find((call) => call.id === "call_status"),
      appCalls
    };
  }

  it("withholds the native live entity reads when the app's list_meta_entities twin is present", async () => {
    const { tools } = await run(["list_meta_entities", "get_meta_performance"], "list_meta_entities");
    expect(tools).toContain(`mcp__${APP_SERVER}__list_meta_entities`);
    for (const id of LIVE_READS) {
      expect(tools).not.toContain(id);
    }
  });

  it("never runs a live Graph read for a bare list_meta_entities call when the twin is present", async () => {
    for (const bare of LIVE_READS) {
      const { call } = await run(["list_meta_entities"], bare);
      // Refused (never the native live read) or routed to the app twin.
      const refused = call?.status === "error" && (call.error as { code?: string } | undefined)?.code === "unknown_action";
      const routed = call?.actionId === `mcp__${APP_SERVER}__${bare}`;
      expect(refused || routed).toBe(true);
    }
  });

  it("refuses an mcp_-prefixed call to a withheld native entity read when the twin is present", async () => {
    for (const bare of LIVE_READS) {
      const { call, appCalls } = await run(["list_meta_entities"], `mcp_${bare}`);
      expect(call, bare).toMatchObject({ status: "error", error: { code: "unknown_action" } });
      expect(appCalls, bare).toEqual([]);
    }
  });

  it("keeps the native live entity reads in a union turn without the twin", async () => {
    const { tools } = await run(["get_meta_performance"], "list_sources");
    for (const id of LIVE_READS) {
      expect(tools).toContain(id);
    }
  });
});

describe("union turn: engine analytics twins", () => {
  // Engine reads the app carries as same-name twins that run the same engine handler on the cloud workspace.
  const ANALYTICS_TWINS = ["list_metrics", "describe_metric", "list_queryable_views", "describe_queryable_view", "run_funnel_query"];
  // The app's metric and breakdown twins refuse Meta metrics and views (get_meta_performance answers those).
  const META_GATED_TWINS = ["run_metric_query", "run_breakdown_query"];
  const app = (name: string) => `mcp__${APP_SERVER}__${name}`;
  type Registry = ReturnType<typeof createInfiniteOsRegistry>;

  async function firstRequest(
    registry: Registry,
    appTools?: string[],
    options: { mode?: "union" | "exclusive"; call?: string } = {}
  ) {
    const requests: ModelRequest[] = [];
    const appCalls: string[] = [];
    const controller = createLlmController({
      registry,
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          if (options.call && request.toolResults.length === 0) {
            return { toolCalls: [{ id: "call_bare", name: options.call, input: {} }] };
          }
          return { message: "done" };
        }
      }
    });
    const result = await controller.chat({
      message: "what can I look at?",
      sessionId: `s-twins-${options.mode ?? "union"}-${(appTools ?? ["none"]).join("-")}-${options.call ?? ""}`,
      workspaceId: "ws_test",
      actorId: "operator-1",
      surface: "desktop",
      ...(appTools ? {
        scopedAppTools: {
          serverName: APP_SERVER,
          allowedTools: appTools.map(app),
          mode: options.mode ?? "union",
          tools: appTools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
          callTool: async (name: string) => {
            appCalls.push(name);
            return { ok: true };
          }
        }
      } : {})
    });
    const first = requests[0] as { tools: Array<{ name: string }>; systemPrompt: string };
    const lines = first.systemPrompt.split("\n");
    const manifest = JSON.parse(lines[lines.indexOf("Typed Infinite OS action manifest:") + 1] ?? "[]") as Array<{
      id: string;
      recommendedNextActions: string[];
    }>;
    return {
      tools: first.tools.map((tool) => tool.name),
      manifest,
      call: result.actionCalls.find((call) => call.id === "call_bare"),
      appCalls
    };
  }

  const nativeIds = (registry: Registry) => registry.list().map((action) => action.id as string);
  const nextSteps = (registry: Registry) => registry.list().map((action) => ({ id: action.id as string, recommendedNextActions: action.recommendedNextActions }));

  it("withholds each native analytics read when its same-name app twin is in the turn", async () => {
    const registry = createInfiniteOsRegistry({});
    for (const name of ANALYTICS_TWINS) {
      const { tools } = await firstRequest(registry, [name]);
      expect(tools, name).toEqual([...nativeIds(registry).filter((id) => id !== name), app(name)]);
    }
  });

  it("refuses a bare call to a withheld native analytics read instead of running the local store", async () => {
    const { call, appCalls } = await firstRequest(createInfiniteOsRegistry({}), ["run_funnel_query"], { call: "run_funnel_query" });
    expect(call).toMatchObject({ status: "error", error: { code: "unknown_action" } });
    expect(appCalls).toEqual([]);
  });

  it("withholds run_metric_query and run_breakdown_query only when the app's get_meta_performance is there too", async () => {
    const registry = createInfiniteOsRegistry({});
    for (const name of META_GATED_TWINS) {
      const withMeta = await firstRequest(registry, [name, "get_meta_performance"]);
      expect(withMeta.tools, name).toEqual([
        ...nativeIds(registry).filter((id) => id !== name && id !== "run_meta_live_insights"),
        app(name),
        app("get_meta_performance")
      ]);
      // Without the app's Meta read the native copy stays: the twin refuses Meta metrics.
      const withoutMeta = await firstRequest(registry, [name]);
      expect(withoutMeta.tools, name).toEqual([...nativeIds(registry), app(name)]);
    }
  });

  it("drops the withheld ids from the next-step hints of the natives it keeps", async () => {
    const registry = createInfiniteOsRegistry({});
    const withheld = [...ANALYTICS_TWINS, ...META_GATED_TWINS];
    const { manifest } = await firstRequest(registry, [...withheld, "get_meta_performance"]);
    for (const entry of manifest) {
      for (const id of withheld) {
        expect(entry.recommendedNextActions, entry.id).not.toContain(id);
      }
    }
    expect(manifest.find((entry) => entry.id === "sync_source_now")?.recommendedNextActions).toEqual(["get_recent_sync_runs"]);
  });

  it("keeps the native tool list and next-step hints unchanged in a union turn without the twins", async () => {
    const registry = createInfiniteOsRegistry({});
    const { tools, manifest } = await firstRequest(registry, ["get_current_workspace"]);
    expect(tools).toEqual([...nativeIds(registry), app("get_current_workspace")]);
    expect(manifest.filter((entry) => !entry.id.startsWith("mcp__"))).toEqual(nextSteps(registry).map((entry) => expect.objectContaining(entry)));
  });

  it("leaves exclusive and unscoped turns unchanged", async () => {
    const registry = createInfiniteOsRegistry({});
    const twins = [...ANALYTICS_TWINS, ...META_GATED_TWINS, "get_meta_performance"];
    const exclusive = await firstRequest(registry, twins, { mode: "exclusive" });
    expect(exclusive.tools).toEqual(twins.map(app));
    const unscoped = await firstRequest(registry);
    expect(unscoped.tools).toEqual(nativeIds(registry));
    expect(unscoped.manifest).toEqual(nextSteps(registry).map((entry) => expect.objectContaining(entry)));
  });

  it("changes nothing on the daemon registry, which already retires these reads", async () => {
    const registry = createDaemonActionRegistry();
    const daemon = nativeIds(registry);
    for (const name of [...ANALYTICS_TWINS, ...META_GATED_TWINS]) {
      expect(daemon).not.toContain(name);
    }
    const { tools } = await firstRequest(registry, [...ANALYTICS_TWINS, ...META_GATED_TWINS]);
    expect(tools).toEqual([...daemon, ...[...ANALYTICS_TWINS, ...META_GATED_TWINS].map(app)]);
  });
});

describe("union turn: the app's list_sources twin", () => {
  const app = (name: string) => `mcp__${APP_SERVER}__${name}`;
  // The desktop's list_sources envelope (cloud rows, or cloud plus local Meta/Shopify rows), as its bridge returns it.
  const DESKTOP_SOURCES = {
    ok: true,
    actionId: "list_sources",
    authority: "tool_agent",
    status: "ok",
    data: {
      sources: [
        { id: "src_ga4", provider: "ga4", status: "connected", connection_name: "Main site", last_synced_at: "2026-09-28T06:00:00.000Z" },
        { id: "src_meta", provider: "meta_ads", status: "connected", connection_name: "Ad account" }
      ]
    },
    provenance: ["sources", "datasets"],
    caveats: ["permanent_local_sources_unavailable"],
    truncated: false,
    nextActions: []
  };

  async function run(
    registry: ReturnType<typeof createInfiniteOsRegistry>,
    appTools: string[],
    options: { message?: string; call?: string } = {}
  ) {
    const requests: ModelRequest[] = [];
    const appCalls: string[] = [];
    const progress: string[] = [];
    const controller = createLlmController({
      registry,
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          if (options.call && request.toolResults.length === 0) {
            return { toolCalls: [{ id: "call_sources", name: options.call, input: {} }] };
          }
          return { message: "done" };
        }
      }
    });
    const result = await controller.chat({
      message: options.message ?? "which sources are connected?",
      sessionId: `s-sources-${appTools.join("-")}-${options.call ?? ""}-${options.message ?? ""}`,
      workspaceId: "ws_test",
      actorId: "operator-1",
      surface: "desktop",
      onProgress: (event) => {
        if ("message" in event && typeof event.message === "string") progress.push(event.message);
      },
      scopedAppTools: {
        serverName: APP_SERVER,
        allowedTools: appTools.map(app),
        mode: "union",
        tools: appTools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
        callTool: async (name: string) => {
          appCalls.push(name);
          // The daemon's bridge parses the MCP text content back into the app's envelope.
          return name === "list_sources" ? structuredClone(DESKTOP_SOURCES) : { ok: true };
        }
      }
    });
    const first = requests[0] as { tools: Array<{ name: string }>; systemPrompt: string };
    const lines = first.systemPrompt.split("\n");
    const manifest = JSON.parse(lines[lines.indexOf("Typed Infinite OS action manifest:") + 1] ?? "[]") as Array<{
      id: string;
      recommendedNextActions: string[];
    }>;
    return { tools: first.tools.map((tool) => tool.name), manifest, requests, result, appCalls, progress };
  }

  /** The twin's tool result exactly as the controller feeds it back (and to the advisor). */
  async function twinResult() {
    const { requests } = await run(createDaemonActionRegistry(), ["list_sources"], { call: app("list_sources") });
    const result = requests[1]?.toolResults[0];
    expect(result?.name).toBe(app("list_sources"));
    return result as { name: string; result: unknown };
  }

  it("withholds the native list_sources, on the daemon and the full registry, when the twin is in the turn", async () => {
    for (const registry of [createDaemonActionRegistry(), createInfiniteOsRegistry({})]) {
      const natives = registry.list().map((action) => action.id as string);
      expect(natives).toContain("list_sources");
      const { tools } = await run(registry, ["list_sources"]);
      expect(tools).toEqual([...natives.filter((id) => id !== "list_sources"), app("list_sources")]);
    }
  });

  it("drops list_sources from the next-step hints of the natives it keeps", async () => {
    const { manifest } = await run(createDaemonActionRegistry(), ["list_sources"]);
    const hints = (id: string) => manifest.find((entry) => entry.id === id)?.recommendedNextActions;
    expect(hints("get_recent_sync_runs")).toEqual(["list_source_schedules"]);
    expect(hints("connect_source")).toEqual(["start_source_sync"]);
    expect(hints("revoke_source")).toEqual([]);
  });

  it("refuses a bare list_sources call instead of reading the local store", async () => {
    for (const bare of ["list_sources", "mcp_list_sources"]) {
      const { result, appCalls } = await run(createDaemonActionRegistry(), ["list_sources"], { call: bare });
      expect(result.actionCalls.find((call) => call.id === "call_sources"), bare).toMatchObject({
        status: "error",
        error: { code: "unknown_action" }
      });
      expect(appCalls, bare).toEqual([]);
    }
  });

  it("sends the desktop Codex union 25 engine natives once every app twin is in the turn", async () => {
    const registry = createDaemonActionRegistry();
    const twins = [
      "get_meta_performance", "list_meta_entities", "list_sources", "list_metrics", "describe_metric",
      "list_queryable_views", "describe_queryable_view", "run_metric_query", "run_breakdown_query", "run_funnel_query"
    ];
    const { tools } = await run(registry, twins);
    const natives = tools.filter((name) => !name.startsWith("mcp__"));
    expect(registry.list()).toHaveLength(30);
    expect(natives).toHaveLength(25);
    expect(natives).not.toEqual(expect.arrayContaining(["list_sources"]));
    for (const withheld of ["run_meta_live_insights", "list_meta_entities", "get_meta_entity", "list_meta_assets", "list_sources"]) {
      expect(natives).not.toContain(withheld);
    }
  });

  it("labels the twin's progress like the native's", async () => {
    const { progress } = await run(createDaemonActionRegistry(), ["list_sources"], { call: app("list_sources") });
    expect(progress).toContain("Checking connected sources.");
    expect(progress).not.toContain(`Running ${app("list_sources")}.`);
  });

  it("fires the Meta rescue after the twin's source list, as it did after the native's", async () => {
    const twin = await twinResult();
    const text = buildQueryRefinementSections("what's my cpl", [twin], [app("get_meta_performance")]).join("\n");
    expect(text).toContain("get_meta_performance with a structured `period`");
    // End to end: the second model request carries the rescue.
    const { requests } = await run(createDaemonActionRegistry(), ["list_sources", "get_meta_performance"], {
      message: "what's my cpl",
      call: app("list_sources")
    });
    expect(requests[1]?.systemPrompt).toContain("get_meta_performance with a structured `period`");
  });

  it("fires the metric rescue and the open-ended refinement after the twin's source list", async () => {
    const twin = await twinResult();
    expect(buildQueryRefinementSections("how many signups did we get", [twin]).join("\n")).toContain("you only have a source list so far");
    expect(buildQueryRefinementSections("what stands out?", [twin]).join("\n")).toContain("You know which sources are connected");
  });

  it("reads the twin's rows for source-status and workspace synthesis", async () => {
    const twin = await twinResult();
    expect(buildQuerySynthesisSections("is ga4 connected?", [twin]).join("\n")).toContain("Source-status final synthesis guidance:");
    const overview = buildQuerySynthesisSections("give me a snapshot of the workspace", [twin]).join("\n");
    expect(overview).toContain("- Connected sources: 2.");
    expect(overview).toContain("ga4 (Main site)");
    expect(overview).toContain("Do not describe a source as never synced");
    const metric = { name: "run_metric_query", result: { data: { metric: "recognized_revenue", rows: [{ recognized_revenue: "12000" }] } } };
    expect(buildQuerySynthesisSections("tell me something", [twin, metric]).join("\n")).toContain("- Source context: ga4 (Main site) has last_synced_at=2026-09-28T06:00:00.000Z");
  });
});
