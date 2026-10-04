import { describe, expect, it } from "vitest";

import {
  FIRST_PHASE_METRIC_ALIASES,
  createDaemonActionRegistry,
  createInfiniteOsRegistry,
  type ActionDefinition
} from "@infinite-os/runtime";

import { OPERATOR_ACTIONS } from "@infinite-os/types";

import { assembleInfiniteOsPrompt, createLlmController, type ModelRequest } from "../src/index.js";
import type { ChatSessionStore } from "../src/session-store.js";
import {
  appListSourcesEnvelope,
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

// Every union turn (only the desktop sends one) leaves out the engine's writes (authority "operator") and these
// reads, which answer from this engine's local store or run a sync inside the turn.
const LOCAL_ONLY_READS = [
  "sync_source_now", "get_recent_sync_runs", "describe_source", "list_source_schedules",
  "describe_context_item", "validate_journey_plan", "search_context"
];
// It leaves out the native live Meta Graph reads too, whatever app tools it carries: they read Meta on the laptop's
// credential, and the turn reaches Meta through the app's reads (by name or through capability_call) instead.
const META_LIVE_READS = ["run_meta_live_insights", "list_meta_entities", "get_meta_entity", "list_meta_assets"];
type AnyRegistry = ReturnType<typeof createInfiniteOsRegistry>;
const operatorIds = (registry: AnyRegistry) =>
  registry.list().filter((action) => action.authority === "operator").map((action) => action.id as string);
/** The ids every union turn withholds, whatever app tools it carries. */
const unionAlwaysWithheld = (registry: AnyRegistry) =>
  new Set([...operatorIds(registry), ...LOCAL_ONLY_READS, ...META_LIVE_READS]);
/** The natives a union turn with no app twins keeps, in registry order. */
const unionNatives = (registry: AnyRegistry) => {
  const withheld = unionAlwaysWithheld(registry);
  return registry.list().map((action) => action.id as string).filter((id) => !withheld.has(id));
};

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

describe("engine prompt: X", () => {
  const X_LINE = "- X (Twitter): the user's own posts ('my best tweet', 'my latest post', their engagement) -> list_my_x_posts; tracked creators and their posts -> search_x_corpus. The engine has no X metrics; never answer an X question from run_metric_query or run_breakdown_query, and never call X disconnected or not syncing because of that.";
  const GAP_LINE = "- When the honest answer is that you can't do what was asked (no tool, metric or data for it), call report_capability_gap with what was asked before you reply, then say so plainly.";

  it("advertises no X metric, view or alias on any turn", () => {
    for (const text of [prompt(native()), prompt([...native(), twin("list_my_x_posts"), twin("search_x_corpus")])]) {
      expect(text).not.toMatch(/x_public_engagement|x_post_count|x_comment_count|x_follower_count|vw_x_/);
      expect(Object.values(injectedAliases(text)).flat().join("|")).not.toMatch(/tweet|best post|follower/);
    }
  });

  it("sends the user's own posts and tracked creators to the app's X tools when the host has them", () => {
    expect(prompt([...native(), twin("list_my_x_posts"), twin("search_x_corpus")])).toContain(X_LINE);
    const ownOnly = prompt([...native(), twin("list_my_x_posts")]);
    expect(ownOnly).toContain("-> list_my_x_posts. The engine has no X metrics");
    expect(ownOnly).not.toContain("search_x_corpus");
  });

  it("names report_capability_gap only where the host has it", () => {
    expect(prompt([...native(), twin("report_capability_gap")])).toContain(GAP_LINE);
    expect(prompt(native())).not.toContain("report_capability_gap");
    expect(prompt(native())).not.toContain("list_my_x_posts");
  });
});

describe("engine prompt: leads", () => {
  const AUDIT_LEADS_LINE = "- 'Leads', 'new leads' or 'audit leads' -> list_audit_leads: an audit lead is its own step, never a signup or registration.";
  const CONTACTS_LINE = "- People who filled in a form, 'leads', 'new leads' or contacts from a campaign -> list_contacts: this workspace's Contacts and their form submissions, never a signup or registration.";
  const AUDIT_CLAUSE = " 'Audit leads' (people who submitted Infinite's own growth-audit form) -> list_audit_leads: an audit lead is its own step, never a signup or registration.";
  const META_LEADS_CLAIM = " Meta's 'leads' result is Meta's claim; read it with get_meta_performance only when the person asks about Meta ads.";
  const leadsBullets = (text: string) =>
    text.split("\n").filter((line) => line.startsWith("- ") && /-> list_(contacts|audit_leads)\b/.test(line));

  it("sends leads to list_audit_leads, its own step, when that twin is present", () => {
    const text = prompt([...native(), twin("list_audit_leads"), twin("get_meta_performance")]);
    expect(text).toContain("'Leads', 'new leads' or 'audit leads' -> list_audit_leads");
    expect(text).toContain("never a signup or registration");
    expect(injectedAliases(text)).not.toHaveProperty("results");
  });

  it("adds no leads bullet without list_audit_leads", () => {
    expect(prompt(native())).not.toContain("-> list_audit_leads");
    expect(prompt(native())).not.toContain("-> list_contacts");
  });

  it("keeps the audit-leads bullet byte for byte on a turn without list_contacts", () => {
    expect(leadsBullets(prompt([...native(), twin("list_audit_leads")]))).toEqual([AUDIT_LEADS_LINE]);
    expect(leadsBullets(prompt([...native(), twin("list_audit_leads"), twin("get_meta_performance")]))).toEqual([
      AUDIT_LEADS_LINE + META_LEADS_CLAIM
    ]);
    // The desktop's website sign-in reader (formerly list_website_contacts) is not list_contacts.
    for (const name of ["list_website_contacts", "list_website_signins"]) {
      expect(leadsBullets(prompt([...native(), twin("list_audit_leads"), twin(name)])), name).toEqual([AUDIT_LEADS_LINE]);
    }
  });

  it("sends form leads, new leads and campaign contacts to list_contacts and keeps audit leads on list_audit_leads", () => {
    const withMeta = prompt([...native(), twin("list_contacts"), twin("list_audit_leads"), twin("get_meta_performance")]);
    expect(leadsBullets(withMeta)).toEqual([CONTACTS_LINE + AUDIT_CLAUSE + META_LEADS_CLAIM]);
    expect(withMeta).not.toContain("'Leads', 'new leads' or 'audit leads' -> list_audit_leads");
    expect(leadsBullets(prompt([...native(), twin("list_contacts"), twin("list_audit_leads")]))).toEqual([
      CONTACTS_LINE + AUDIT_CLAUSE
    ]);
    expect(leadsBullets(prompt([...native(), twin("list_contacts"), twin("get_meta_performance")]))).toEqual([
      CONTACTS_LINE + META_LEADS_CLAIM
    ]);
  });

  it("names no audit-leads route when list_contacts comes without list_audit_leads", () => {
    const text = prompt([...native(), twin("list_contacts")]);
    expect(leadsBullets(text)).toEqual([CONTACTS_LINE]);
    expect(text).not.toContain("list_audit_leads");
    expect(text).not.toContain("Meta's 'leads' result");
  });

  it("routes leads to list_contacts in a real union turn that carries the app's Contacts read", async () => {
    const requests: ModelRequest[] = [];
    const appTools = ["list_contacts", "list_audit_leads", "get_meta_performance"];
    const controller = createLlmController({
      registry: createDaemonActionRegistry(),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return { message: "done" };
        }
      }
    });
    await controller.chat({
      message: "any new leads this week?",
      sessionId: "s-union-leads",
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
    const systemPrompt = requests[0]?.systemPrompt ?? "";
    expect(leadsBullets(systemPrompt)).toEqual([CONTACTS_LINE + AUDIT_CLAUSE + META_LEADS_CLAIM]);
    expect(systemPrompt).not.toContain("'Leads', 'new leads' or 'audit leads'");
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

  it("drops run_meta_live_insights, and refuses a call to it, in a union turn without the app twin too", async () => {
    const { tools, call } = await toolsFor(["list_sources"]);
    expect(tools).toContain(`mcp__${APP_SERVER}__list_sources`);
    expect(tools).not.toContain("run_meta_live_insights");
    expect(call).toMatchObject({
      status: "error",
      error: { code: "unknown_action", message: "Unknown Infinite OS action: run_meta_live_insights. This chat turn does not offer it." }
    });
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
      expect(call, bare).toMatchObject({
        status: "error",
        error: {
          code: "unknown_action",
          message: `Unknown Infinite OS action: ${bare}. This turn offers mcp__${APP_SERVER}__list_meta_entities in its place.`
        }
      });
      expect(appCalls, bare).toEqual([]);
    }
  });

  it("withholds the native live entity reads in a union turn without the twin too", async () => {
    const { tools } = await run(["get_meta_performance"], "list_sources");
    for (const id of LIVE_READS) {
      expect(tools).not.toContain(id);
    }
  });
});

describe("union turn: the native live Meta Graph reads, whatever app tools the turn carries", () => {
  const app = (name: string) => `mcp__${APP_SERVER}__${name}`;
  // The app read that answers in each live read's place, by name or through capability_call.
  const APP_READ: Record<string, string> = {
    run_meta_live_insights: "get_meta_performance",
    list_meta_entities: "list_meta_entities",
    get_meta_entity: "list_meta_entities",
    list_meta_assets: "list_meta_entities"
  };
  // The desktop's general-profile discovery tools (1bu-1 capability-discovery.ts GENERAL_PROFILE_REQUIRED_TOOL_NAMES).
  const DISCOVERY = ["capability_search", "capability_describe", "capability_call", "skill_search", "skill_load"];
  const CAPABILITY_CALL = app("capability_call");
  // The app tools a union turn can carry, and the sentence each live read's refusal then adds.
  const TURNS: Array<{ label: string; appTools: string[]; refusal: (id: string) => string }> = [
    {
      label: "the app's Meta reads by name",
      appTools: ["get_current_workspace", "list_sources", "get_meta_performance", "list_meta_entities"],
      refusal: (id) => `This turn offers ${app(APP_READ[id]!)} in its place.`
    },
    {
      label: "the app's Meta reads by name beside capability_call",
      appTools: ["get_meta_performance", "list_meta_entities", ...DISCOVERY],
      refusal: (id) => `This turn offers ${app(APP_READ[id]!)} in its place.`
    },
    {
      label: "capability_call only",
      appTools: ["get_current_workspace", ...DISCOVERY],
      refusal: (id) => `Use ${CAPABILITY_CALL} with ${APP_READ[id]} in its place.`
    },
    {
      label: "get_meta_performance by name, the entity reads behind capability_call",
      appTools: ["get_meta_performance", ...DISCOVERY],
      refusal: (id) => id === "run_meta_live_insights"
        ? `This turn offers ${app("get_meta_performance")} in its place.`
        : `Use ${CAPABILITY_CALL} with list_meta_entities in its place.`
    },
    {
      label: "neither",
      appTools: ["get_current_workspace"],
      refusal: () => "This chat turn does not offer it."
    }
  ];
  const REGISTRIES: Array<[string, (handlers: Parameters<typeof createInfiniteOsRegistry>[0]) => AnyRegistry]> = [
    ["daemon", (handlers) => createDaemonActionRegistry(handlers)],
    ["full", (handlers) => createInfiniteOsRegistry(handlers)]
  ];
  const spellings = (id: string) => [id, `mcp_${id}`, app(id), id.toUpperCase(), app(id).toUpperCase()];

  /** One turn on a registry whose live Meta reads record that they ran; the model calls `call` once, then answers. */
  async function run(
    makeRegistry: (handlers: Parameters<typeof createInfiniteOsRegistry>[0]) => AnyRegistry,
    appTools: string[] | undefined,
    options: { call?: string; mode?: "union" | "exclusive"; message?: string; general?: boolean } = {}
  ) {
    const graphReads: string[] = [];
    const handlers = Object.fromEntries(META_LIVE_READS.map((id) => [id, async () => {
      graphReads.push(id);
      return { ok: true, actionId: id, authority: "tool_agent", status: "ok", data: {}, provenance: [], caveats: [], truncated: false, nextActions: [] };
    }])) as Parameters<typeof createInfiniteOsRegistry>[0];
    const requests: ModelRequest[] = [];
    const appCalls: string[] = [];
    const controller = createLlmController({
      registry: makeRegistry(handlers),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return options.call && request.toolResults.length === 0
            ? { toolCalls: [{ id: "call_meta", name: options.call, input: { sourceId: "src_meta" } }] }
            : { message: "done" };
        }
      }
    });
    const result = await controller.chat({
      message: options.message ?? "how are my ads doing?",
      sessionId: `s-live-meta-${options.mode ?? "union"}-${(appTools ?? ["plain"]).join("-")}-${options.call ?? ""}-${options.message ?? ""}-${options.general ? "general" : "legacy"}`,
      workspaceId: "ws_test",
      actorId: "operator-1",
      surface: "desktop",
      ...(options.general ? {
        agentProfile: "general-marketing-v1" as const,
        interactiveFeatures: ["workspace.app-tools.v1", "actions.confirmation.v1", "actions.continuation.v1"] as const
      } : {}),
      ...(appTools ? {
        scopedAppTools: {
          serverName: APP_SERVER,
          allowedTools: appTools.map(app),
          mode: options.mode ?? "union",
          // App-authored descriptions are the app's own text; these never name an engine action.
          tools: appTools.map((name) => ({ name, description: "App tool.", inputSchema: { type: "object" } })),
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
      prompts: requests.map((request) => request.systemPrompt),
      call: result.actionCalls.find((entry) => entry.id === "call_meta"),
      graphReads,
      appCalls
    };
  }

  it("leaves every live Meta read out of the advertised set and the manifest, on the daemon and the full registry", async () => {
    for (const [registryName, makeRegistry] of REGISTRIES) {
      for (const { label, appTools } of TURNS) {
        const { tools, manifest } = await run(makeRegistry, appTools);
        expect(tools.filter((name) => name.startsWith("mcp__")), `${registryName}, ${label}`).toEqual(appTools.map(app));
        for (const id of META_LIVE_READS) {
          expect(tools, `${registryName}, ${label}: ${id}`).not.toContain(id);
          expect(manifest.some((entry) => entry.id === id || entry.recommendedNextActions.includes(id)), `${registryName}, ${label}: ${id}`).toBe(false);
        }
      }
    }
  });

  it("refuses each live read under every spelling, never reaching Graph, and names what the turn offers in its place", async () => {
    for (const [registryName, makeRegistry] of REGISTRIES) {
      for (const { label, appTools, refusal } of TURNS) {
        for (const id of META_LIVE_READS) {
          for (const spelling of spellings(id)) {
            const { call, graphReads, appCalls } = await run(makeRegistry, appTools, { call: spelling });
            const where = `${registryName}, ${label}: ${spelling}`;
            expect(graphReads, where).toEqual([]);
            if (spelling === app(id) && appTools.includes(id)) {
              // The app's own read of that name, which answers from its stored copy.
              expect(call, where).toMatchObject({ actionId: app(id), status: "ok" });
              expect(appCalls, where).toEqual([id]);
              continue;
            }
            expect(call, where).toMatchObject({
              actionId: id,
              status: "error",
              requiresConfirmation: false,
              error: { code: "unknown_action", message: `Unknown Infinite OS action: ${id}. ${refusal(id)}` }
            });
            expect(appCalls, where).toEqual([]);
          }
        }
      }
    }
  });

  it("names no live Meta read on any union prompt line, legacy or general profile, before and after a refused call", async () => {
    const messages = [
      "how are my ads doing?",
      "is the spring campaign running?",
      "what's my cost per lead this week?",
      "which ad accounts and pixels can I use?",
      "what stands out?"
    ];
    for (const [registryName, makeRegistry] of REGISTRIES) {
      for (const { label, appTools } of TURNS) {
        for (const message of messages) {
          for (const general of [false, true]) {
            const { prompts } = await run(makeRegistry, appTools, { message, general, call: "run_meta_live_insights" });
            expect(prompts, message).toHaveLength(2);
            for (const [index, systemPrompt] of prompts.entries()) {
              for (const id of META_LIVE_READS) {
                const named = systemPrompt.split("\n").filter((line) => new RegExp(`\\b${id}\\b`).test(line));
                expect(named, `${registryName}, ${label}, ${general ? "general" : "legacy"}, request ${index}, "${message}": ${id}`).toEqual([]);
              }
            }
          }
        }
      }
    }
  });

  it("keeps every live Meta read in a plain turn, where a call still runs the native read", async () => {
    for (const [registryName, makeRegistry] of REGISTRIES) {
      const { tools, prompts } = await run(makeRegistry, undefined);
      for (const id of META_LIVE_READS) {
        expect(tools, `${registryName}: ${id}`).toContain(id);
        for (const spelling of [id, `mcp_${id}`]) {
          const { call, graphReads } = await run(makeRegistry, undefined, { call: spelling });
          expect(graphReads, `${registryName}: ${spelling}`).toEqual([id]);
          expect(call, `${registryName}: ${spelling}`).toMatchObject({ actionId: id, status: "ok" });
        }
        // A spelling the registry does not know is refused as before, with no added sentence.
        for (const spelling of [app(id), id.toUpperCase()]) {
          const { call, graphReads } = await run(makeRegistry, undefined, { call: spelling });
          expect(graphReads, `${registryName}: ${spelling}`).toEqual([]);
          expect(call?.error, `${registryName}: ${spelling}`).toEqual({ code: "unknown_action", message: `Unknown Infinite OS action: ${spelling}` });
        }
      }
      expect(prompts[0]).toContain("-> run_meta_live_insights: a live Graph read at the requested level");
    }
  });

  it("leaves an exclusive turn as it was: app tools only, a native spelling an unknown scoped tool, the prompt's Meta line whole", async () => {
    const appTools = ["get_meta_performance", "list_meta_entities", "run_metric_query", ...DISCOVERY];
    for (const [registryName, makeRegistry] of REGISTRIES) {
      const { tools, prompts } = await run(makeRegistry, appTools, { mode: "exclusive" });
      expect(tools, registryName).toEqual(appTools.map(app));
      expect(prompts[0]).toContain("run_metric_query and run_breakdown_query refuse Meta metrics and views; never use run_meta_live_insights.");
      for (const id of META_LIVE_READS) {
        for (const spelling of [id, `mcp_${id}`, id.toUpperCase()]) {
          const { call, graphReads, appCalls } = await run(makeRegistry, appTools, { mode: "exclusive", call: spelling });
          const normalized = spelling === `mcp_${id}` ? id : spelling;
          expect(graphReads, `${registryName}: ${spelling}`).toEqual([]);
          expect(appCalls, `${registryName}: ${spelling}`).toEqual([]);
          expect(call?.error, `${registryName}: ${spelling}`).toEqual({ code: "unknown_action", message: `Unknown scoped app tool: ${normalized}` });
        }
      }
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
      expect(tools, name).toEqual([...unionNatives(registry).filter((id) => id !== name), app(name)]);
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
        ...unionNatives(registry).filter((id) => id !== name && id !== "run_meta_live_insights"),
        app(name),
        app("get_meta_performance")
      ]);
      // Without the app's Meta read the native copy stays: the twin refuses Meta metrics.
      const withoutMeta = await firstRequest(registry, [name]);
      expect(withoutMeta.tools, name).toEqual([...unionNatives(registry), app(name)]);
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
    // A kept native keeps its other hints: run_journey_query drops only create_saved_report (an engine write).
    expect(manifest.find((entry) => entry.id === "run_journey_query")?.recommendedNextActions).toEqual(["fetch_evidence", "verify_claims"]);
  });

  it("keeps every other native and its other next-step hints in a union turn without the twins", async () => {
    const registry = createInfiniteOsRegistry({});
    const always = unionAlwaysWithheld(registry);
    const { tools, manifest } = await firstRequest(registry, ["get_current_workspace"]);
    expect(tools).toEqual([...unionNatives(registry), app("get_current_workspace")]);
    expect(manifest.filter((entry) => !entry.id.startsWith("mcp__"))).toEqual(
      nextSteps(registry)
        .filter((entry) => !always.has(entry.id))
        .map((entry) => expect.objectContaining({
          id: entry.id,
          recommendedNextActions: entry.recommendedNextActions.filter((id) => !always.has(id))
        }))
    );
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
    expect(tools).toEqual([...unionNatives(registry), ...[...ANALYTICS_TWINS, ...META_GATED_TWINS].map(app)]);
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
      const natives = unionNatives(registry);
      expect(natives).toContain("list_sources");
      const { tools } = await run(registry, ["list_sources"]);
      expect(tools).toEqual([...natives.filter((id) => id !== "list_sources"), app("list_sources")]);
    }
  });

  it("drops list_sources and every withheld id from the next-step hints of the natives it keeps", async () => {
    for (const registry of [createDaemonActionRegistry(), createInfiniteOsRegistry({})]) {
      const { manifest } = await run(registry, ["list_sources"]);
      const withheld = new Set([...unionAlwaysWithheld(registry), "list_sources"]);
      for (const entry of manifest) {
        for (const id of entry.recommendedNextActions) {
          expect(withheld.has(id), `${entry.id} -> ${id}`).toBe(false);
        }
      }
      const hints = (id: string) => manifest.find((entry) => entry.id === id)?.recommendedNextActions;
      if (registry.get("run_metric_query")) {
        // The write and local-only hints go too: resolve_entity pointed at validate_journey_plan, drilldown_result at
        // create_saved_report.
        expect(hints("resolve_entity")).toEqual(["run_journey_query"]);
        expect(hints("drilldown_result")).toEqual([]);
      } else {
        // The daemon union keeps no native once its list_sources twin is in the turn.
        expect(manifest.map((entry) => entry.id)).toEqual([app("list_sources")]);
      }
    }
  });

  it("refuses a bare list_sources call instead of reading the local store, and names the twin", async () => {
    for (const bare of ["list_sources", "mcp_list_sources"]) {
      const { result, appCalls } = await run(createDaemonActionRegistry(), ["list_sources"], { call: bare });
      expect(result.actionCalls.find((call) => call.id === "call_sources"), bare).toMatchObject({
        status: "error",
        error: {
          code: "unknown_action",
          message: `Unknown Infinite OS action: list_sources. This turn offers ${app("list_sources")} in its place.`
        }
      });
      expect(appCalls, bare).toEqual([]);
    }
  });

  it("reads the native list_sources result as it is, never one level down", () => {
    const nativeResult = { name: "list_sources", result: structuredClone(DESKTOP_SOURCES) };
    expect(appListSourcesEnvelope(nativeResult.name, nativeResult.result)).toBeUndefined();
    const overview = buildQuerySynthesisSections("give me a snapshot of the workspace", [nativeResult]).join("\n");
    expect(overview).toContain("- Connected sources: 2.");
    expect(buildQueryRefinementSections("how many signups did we get", [nativeResult]).join("\n")).toContain("you only have a source list so far");
  });

  it("sends the desktop Codex union no daemon native: its twin replaces list_sources, the rest are live Meta, write or local-only", async () => {
    const registry = createDaemonActionRegistry();
    const twins = [
      "get_meta_performance", "list_meta_entities", "list_sources", "list_metrics", "describe_metric",
      "list_queryable_views", "describe_queryable_view", "run_metric_query", "run_breakdown_query", "run_funnel_query"
    ];
    const replaced = ["run_meta_live_insights", "list_meta_entities", "get_meta_entity", "list_meta_assets", "list_sources"];
    const { tools } = await run(registry, twins);
    const natives = tools.filter((name) => !name.startsWith("mcp__"));
    const daemon = registry.list().map((action) => action.id as string);
    const withheld = new Set([...replaced, ...unionAlwaysWithheld(registry)]);
    // The withheld set is derived from each action's authority and the twins the turn carries.
    expect(daemon).toEqual(expect.arrayContaining(replaced));
    expect(natives).toEqual(daemon.filter((id) => !withheld.has(id)));
    // Pinned on purpose, as a tripwire: today every one of the daemon's 30 natives is withheld (18 writes, 7 local-only
    // reads, 4 live Meta reads, list_sources). A new daemon native fails here, so its change must decide whether a
    // union turn offers it.
    expect(operatorIds(registry)).toHaveLength(18);
    expect(daemon).toHaveLength(30);
    expect(natives).toEqual([]);
    expect(tools).toEqual(twins.map(app));
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
    // The rescue's own line: the Meta routing bullet also says "get_meta_performance with a structured `period`".
    expect(requests[1]?.systemPrompt).toContain("- The user asked for a Meta Ads number, but you only have a source list so far.");
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

describe("union turn: the answer read after the twin's source list", () => {
  const app = (name: string) => `mcp__${APP_SERVER}__${name}`;
  // The app tools a desktop Codex turn carries for these questions (a subset of the desktop's Codex allowlist).
  const DESKTOP_TOOLS = [
    "get_current_workspace", "list_sources", "get_meta_performance", "list_contacts", "list_audit_leads",
    "run_app_outcomes", "list_metrics", "run_metric_query", "run_breakdown_query"
  ];
  const SOURCES = {
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
    provenance: ["sources"],
    caveats: [],
    truncated: false,
    nextActions: []
  };
  const engineEnvelope = (actionId: string, data: Record<string, unknown>) => ({
    ok: true, actionId, authority: "tool_agent", status: "ok", data, provenance: [], caveats: [], truncated: false, nextActions: []
  });
  // What each app tool returns through the daemon's bridge.
  const APP_RESULTS: Record<string, unknown> = {
    get_current_workspace: { ok: true, workspace: { id: "ws_test", name: "Acme" } },
    list_sources: SOURCES,
    get_meta_performance: { ok: true, period: { preset: "last_7d" }, totals: { spend: 120, leads: 8, cost_per_lead: 15 } },
    list_contacts: { ok: true, contacts: [{ email: "lead@example.com", form: "contact" }], total: 1 },
    list_audit_leads: { ok: true, leads: [], total: 0 },
    run_app_outcomes: { ok: true, available: true, accountCreated: 12, appSignup: 12 },
    list_metrics: engineEnvelope("list_metrics", { metrics: [{ id: "recognized_revenue" }, { id: "site_visitors" }] }),
    run_metric_query: engineEnvelope("run_metric_query", { metric: "recognized_revenue", rows: [{ recognized_revenue: "1234" }] })
  };
  const STALE_RESCUE = "only have a source list so far";
  // The rescue's own line; the routing bullets also say "get_meta_performance with a structured `period`".
  const META_RESCUE = "- The user asked for a Meta Ads number, but you only have a source list so far.";
  const OPEN_ENDED = "Open-ended analysis refinement guidance:";
  const OVERVIEW = "Generic workspace-overview synthesis guidance:";
  const REFINING = "Refining answer with a better-targeted follow-up query.";

  /** The real controller on the daemon registry; the model calls `calls` one per round, then answers. */
  async function turn(
    message: string,
    calls: Array<string | { name: string; input: Record<string, unknown> }>,
    options: { mode?: "union" | "exclusive"; results?: Record<string, unknown> } = {}
  ) {
    const requests: ModelRequest[] = [];
    const progress: Array<{ stage?: string; message: string }> = [];
    const steps = calls.map((call) => typeof call === "string" ? { name: call, input: {} } : call);
    const controller = createLlmController({
      registry: createDaemonActionRegistry(),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          const step = steps[requests.length - 1];
          return step
            ? { toolCalls: [{ id: `call_${requests.length}`, name: app(step.name), input: step.input }] }
            : { message: "done" };
        }
      }
    });
    await controller.chat({
      message,
      sessionId: `s-answer-${options.mode ?? "union"}-${message}-${steps.map((step) => step.name).join("-")}-${Object.keys(options.results ?? {}).join("-")}`,
      workspaceId: "ws_test",
      actorId: "operator-1",
      surface: "desktop",
      onProgress: (event) => {
        if ("message" in event && typeof event.message === "string") {
          progress.push({ stage: "stage" in event ? String(event.stage) : undefined, message: event.message });
        }
      },
      scopedAppTools: {
        serverName: APP_SERVER,
        allowedTools: DESKTOP_TOOLS.map(app),
        mode: options.mode ?? "union",
        tools: DESKTOP_TOOLS.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
        callTool: async (name: string) => structuredClone(options.results?.[name] ?? APP_RESULTS[name] ?? { ok: true })
      }
    });
    expect(requests).toHaveLength(steps.length + 1);
    return {
      /** The system prompt of the request that follows the given call (1-based). */
      promptAfter: (call: number) => requests[call]?.systemPrompt ?? "",
      /** The progress lines emitted after the given call's (1-based) own label. */
      progressAfter: (call: number) => {
        const labels = progress.flatMap((event, index) => event.stage === "tool" ? [index] : []);
        return progress.slice((labels[call - 1] ?? progress.length) + 1).map((event) => event.message);
      }
    };
  }

  it.each([
    ["what's my cpl", "get_meta_performance"],
    ["how are my ads doing this week?", "get_meta_performance"],
    ["how many leads did we get this week?", "list_contacts"],
    ["how many new leads this week?", "list_contacts"],
    ["how many signups did we get", "run_app_outcomes"],
    ["what was my revenue last month?", "run_metric_query"]
  ])("adds no stale rescue or workspace overview once %j has its answer read (%s)", async (message, answer) => {
    const { promptAfter, progressAfter } = await turn(message, ["list_sources", answer]);
    const text = promptAfter(2);
    expect(text).not.toContain(STALE_RESCUE);
    expect(text).not.toContain("Metric-question refinement guidance:");
    expect(text).not.toContain("run run_metric_query or run_breakdown_query");
    expect(text).not.toContain(OPEN_ENDED);
    expect(text).not.toContain(OVERVIEW);
    expect(progressAfter(2)).not.toContain(REFINING);
  });

  it("still fires the rescue after the twin's source list alone", async () => {
    const meta = await turn("what's my cpl", ["list_sources", "get_meta_performance"]);
    expect(meta.promptAfter(1)).toContain(META_RESCUE);
    expect(meta.progressAfter(1)).toContain(REFINING);
    const revenue = await turn("what was my revenue last month?", ["list_sources", "run_metric_query"]);
    expect(revenue.promptAfter(1)).toContain(STALE_RESCUE);
  });

  it("keeps the rescue after a workspace-context read, which answers nothing", async () => {
    const { promptAfter } = await turn("what's my cpl", ["list_sources", "get_current_workspace"]);
    expect(promptAfter(2)).toContain(META_RESCUE);
  });

  it("does not repeat the rescue after an answer read that failed: the model has the error", async () => {
    const { promptAfter } = await turn("what's my cpl", ["list_sources", "get_meta_performance"], {
      results: { get_meta_performance: { ok: false, error: { code: "needs_login", message: "Sign in to read Meta." } } }
    });
    expect(promptAfter(2)).not.toContain(STALE_RESCUE);
  });

  it("stops asking an open-ended turn for metric coverage once the twin's metric list or a metric result is in", async () => {
    const { promptAfter } = await turn("what stands out?", ["list_sources", "list_metrics", "run_metric_query"]);
    expect(promptAfter(1)).toContain("You know which sources are connected");
    expect(promptAfter(2)).not.toContain("not yet what metrics or views are available");
    expect(promptAfter(2)).not.toContain(OPEN_ENDED);
    expect(promptAfter(3)).not.toContain(OPEN_ENDED);
    expect(promptAfter(3)).not.toContain(OVERVIEW);
  });

  it("adds no stale rescue in an exclusive turn (iMessage, scheduled, triggered) once the answer read is in", async () => {
    const meta = await turn("what's my cpl", ["list_sources", "get_meta_performance"], { mode: "exclusive" });
    expect(meta.promptAfter(2)).not.toContain(STALE_RESCUE);
    expect(meta.promptAfter(2)).not.toContain(OVERVIEW);
    const leads = await turn("how many new leads this week?", ["list_sources", "list_contacts"], { mode: "exclusive" });
    expect(leads.promptAfter(2)).not.toContain(STALE_RESCUE);
    expect(leads.promptAfter(2)).not.toContain(OVERVIEW);
  });

  it("never reads another brand's source list (a targeted twin call) as this workspace's sources", async () => {
    const targeted = { name: "list_sources", input: { targetWorkspaceId: "ws_other_brand" } };
    const overview = await turn("give me a snapshot of the workspace", [targeted]);
    expect(overview.promptAfter(1)).not.toContain("- Connected sources: 2.");
    expect(overview.promptAfter(1)).not.toContain(OVERVIEW);
    // The home call (no argument) still reads as this workspace's sources.
    const home = await turn("give me a snapshot of the workspace", ["list_sources"]);
    expect(home.promptAfter(1)).toContain("- Connected sources: 2.");
  });
});

describe("union turn: engine writes and local-only reads", () => {
  const app = (name: string) => `mcp__${APP_SERVER}__${name}`;
  // The desktop Codex union's app tools for these turns: its Meta proposal tools (1bu-1 meta-ads-pack.ts, registered
  // unconditionally by catalog.ts), the source/Meta twins and the lead and outcome reads (a subset of its legacy
  // Cmd+L catalogue).
  const DESKTOP_TWINS = [
    "list_sources", "get_meta_performance", "list_meta_entities", "propose_activate_meta_entity",
    "propose_pause_meta_entity", "propose_meta_budget", "propose_meta_launch", "propose_update_meta_ad",
    "propose_create_meta_campaign", "propose_create_meta_ad_set", "propose_create_meta_creative", "propose_create_meta_ad",
    "list_contacts", "list_audit_leads", "run_app_outcomes"
  ];
  const CONFIRMATION_MESSAGE = "This request includes an operator action that requires confirmation before execution.";
  const LEGACY_AUTHORITY_LINE = "- Operator/write actions are never auto-executed, but the RUNTIME owns that confirmation — not you. When you have the required parameters, CALL the action directly: the app then shows the user a Confirm control that gates execution, and the action runs only after they act on it. Do NOT run your own confirmation step — never ask the user to type or repeat a confirmation phrase (e.g. 'reply confirm' / 'CONFIRM CREATE ...'), never withhold the tool call waiting for verbal approval, and never invent an extra approval turn. Gather the parameters, make the single tool call, and let the app's Confirm control be the one and only confirmation.";

  /** The real controller; the model makes each call in `calls` in its own round, then answers "done". */
  async function turn(
    registry: AnyRegistry,
    appTools: string[] | undefined,
    options: { calls?: Array<{ name: string; input?: Record<string, unknown> }>; mode?: "union" | "exclusive"; message?: string } = {}
  ) {
    const requests: ModelRequest[] = [];
    const appCalls: string[] = [];
    const recorded: Array<{ actionId: string; authority: string; requiresConfirmation: boolean; confirmationId?: string }> = [];
    const sessionStore: ChatSessionStore = {
      async ensureSession() {},
      async appendMessage() {},
      async recordActionCall(input) {
        recorded.push({
          actionId: input.actionId,
          authority: input.authority,
          requiresConfirmation: input.requiresConfirmation,
          ...(input.confirmationId ? { confirmationId: input.confirmationId } : {})
        });
      },
      async listSessions() { return []; },
      async getSession() { return null; },
      async searchSessions() { return []; },
      async resumeSession() {},
      async endSession() {},
      async compactSession(input) { return { sessionId: input.newSessionId ?? "s", parentSessionId: input.sessionId }; }
    };
    const calls = options.calls ?? [];
    const controller = createLlmController({
      registry,
      sessionStore,
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          const step = calls[requests.length - 1];
          return step
            ? { toolCalls: [{ id: `call_${requests.length}`, name: step.name, input: step.input ?? {} }] }
            : { message: "done" };
        }
      }
    });
    const result = await controller.chat({
      message: options.message ?? "raise the spring ad set's budget to $80 a day",
      sessionId: `s-writes-${options.mode ?? "union"}-${(appTools ?? ["plain"]).length}-${calls.map((call) => call.name).join("-")}-${options.message ?? ""}`,
      workspaceId: "ws_test",
      actorId: "operator-1",
      surface: "desktop",
      ...(appTools ? {
        scopedAppTools: {
          serverName: APP_SERVER,
          allowedTools: appTools.map(app),
          mode: options.mode ?? "union",
          // The app's own description: it rides in the manifest as the tool's summary, and never names an engine
          // action (the app's list_meta_entities shares a withheld native's name).
          tools: appTools.map((name) => ({ name, description: "App tool.", inputSchema: { type: "object" } })),
          callTool: async (name: string) => {
            appCalls.push(name);
            return { ok: true, rows: [] };
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
    return { tools: first.tools.map((tool) => tool.name), manifest, requests, result, appCalls, recorded };
  }

  it("derives the withheld writes from each action's authority, which is the whole OPERATOR_ACTIONS list", () => {
    for (const registry of [createDaemonActionRegistry(), createInfiniteOsRegistry({})]) {
      expect([...operatorIds(registry)].sort()).toEqual([...OPERATOR_ACTIONS].sort());
      // Every local-only read is still a real registry read (a rename would leave a dead id here).
      for (const id of LOCAL_ONLY_READS) {
        expect(registry.get(id)?.authority, id).toBe("tool_agent");
      }
    }
  });

  it("withholds every engine write, the seven local-only reads and the four live Meta reads from a union turn, on the daemon and the full registry", async () => {
    for (const registry of [createDaemonActionRegistry(), createInfiniteOsRegistry({})]) {
      const { tools, manifest } = await turn(registry, ["get_current_workspace"]);
      expect(tools).toEqual([...unionNatives(registry), app("get_current_workspace")]);
      for (const id of unionAlwaysWithheld(registry)) {
        expect(tools, id).not.toContain(id);
        expect(manifest.some((entry) => entry.recommendedNextActions.includes(id)), id).toBe(false);
      }
    }
  });

  it("sends a desktop Codex union on the daemon registry zero natives, and the turn runs on its app tools", async () => {
    const registry = createDaemonActionRegistry();
    const { tools, manifest, result, appCalls, requests } = await turn(registry, DESKTOP_TWINS, {
      message: "how many new leads this week?",
      calls: [{ name: app("list_contacts") }]
    });
    expect(tools).toEqual(DESKTOP_TWINS.map(app));
    expect(tools.filter((name) => !name.startsWith("mcp__"))).toEqual([]);
    expect(manifest.map((entry) => entry.id)).toEqual(DESKTOP_TWINS.map(app));
    expect(appCalls).toEqual(["list_contacts"]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.toolResults[0]).toMatchObject({ name: app("list_contacts"), result: { status: "ok" } });
    expect(result).toMatchObject({ ok: true, message: "done" });
  });

  it.each([
    ["set_meta_entity_status", { sourceId: "src_meta", entityId: "1201", entity: "adset", status: "ACTIVE", confirmActivation: "1201" },
      `This turn offers ${app("propose_activate_meta_entity")} or ${app("propose_pause_meta_entity")} in its place.`],
    ["update_meta_budget", { sourceId: "src_meta", entityId: "1201", entity: "adset", dailyBudget: 8000 },
      `This turn offers ${app("propose_meta_budget")} in its place.`],
    ["create_meta_ad_set", { campaignId: "1200", name: "Spring", optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS" },
      `This turn offers ${app("propose_create_meta_ad_set")} or ${app("propose_meta_launch")} in its place.`],
    ["create_meta_campaign", { name: "Spring", objective: "OUTCOME_LEADS" },
      `This turn offers ${app("propose_create_meta_campaign")} or ${app("propose_meta_launch")} in its place.`],
    ["create_meta_creative", { name: "Spring", pageId: "1", imageHash: "abc" },
      `This turn offers ${app("propose_create_meta_creative")} or ${app("propose_meta_launch")} in its place.`],
    ["update_meta_ad", { sourceId: "src_meta", entityId: "1202", name: "Renamed" },
      `This turn offers ${app("propose_update_meta_ad")} in its place.`],
    ["delete_meta_entity", { sourceId: "src_meta", entityId: "1201", entity: "adset" },
      `Deleting is not available from chat; pause it instead with ${app("propose_pause_meta_entity")}.`],
    ["connect_source", { provider: "stripe" }, "This chat turn does not offer it."],
    ["sync_source_now", { sourceId: "src_ga4" }, "This chat turn does not offer it."],
    ["describe_source", { sourceId: "src_ga4" }, `This turn offers ${app("list_sources")} in its place.`]
  ])("refuses a model call to %s as an unknown action, never a Confirm card", async (id, input, refusal) => {
    for (const name of [id, `mcp_${id}`]) {
      const { result, recorded, requests, appCalls } = await turn(createDaemonActionRegistry(), DESKTOP_TWINS, {
        calls: [{ name, input }]
      });
      const call = result.actionCalls.find((entry) => entry.id === "call_1");
      expect(call, name).toMatchObject({
        actionId: id,
        status: "error",
        requiresConfirmation: false,
        error: { code: "unknown_action", message: `Unknown Infinite OS action: ${id}. ${refusal}` }
      });
      expect(call?.confirmationId, name).toBeUndefined();
      // The turn goes on: the model reads the refusal and answers; no confirmation message ends it.
      expect(requests, name).toHaveLength(2);
      expect(result.message, name).toBe("done");
      expect(result.message, name).not.toBe(CONFIRMATION_MESSAGE);
      expect(recorded, name).toEqual([{ actionId: id, authority: "tool_agent", requiresConfirmation: false }]);
      expect(appCalls, name).toEqual([]);
    }
  });

  it("names only the replacements the turn carries", async () => {
    const launchOnly = await turn(createDaemonActionRegistry(), ["get_current_workspace", "propose_meta_launch"], {
      calls: [{ name: "create_meta_ad_set" }]
    });
    expect(launchOnly.result.actionCalls[0]?.error?.message).toBe(
      `Unknown Infinite OS action: create_meta_ad_set. This turn offers ${app("propose_meta_launch")} in its place.`
    );
    for (const [id, refusal] of [
      ["set_meta_entity_status", "This chat turn does not offer it."],
      ["update_meta_budget", "This chat turn does not offer it."],
      ["delete_meta_entity", "Deleting is not available from chat; pause it instead."]
    ]) {
      const bare = await turn(createDaemonActionRegistry(), ["get_current_workspace"], { calls: [{ name: id! }] });
      expect(bare.result.actionCalls[0]?.error?.message, id).toBe(`Unknown Infinite OS action: ${id}. ${refusal}`);
    }
  });

  it("leaves a plain turn byte-identical: every engine write is offered and a call still becomes a Confirm card", async () => {
    const registry = createDaemonActionRegistry();
    const { tools, result, recorded, requests } = await turn(registry, undefined, {
      calls: [{ name: "update_meta_budget", input: { sourceId: "src_meta", entityId: "1201", entity: "adset", dailyBudget: 8000 } }]
    });
    expect(tools).toEqual(registry.list().map((action) => action.id as string));
    expect(requests).toHaveLength(1);
    expect(result.message).toBe(CONFIRMATION_MESSAGE);
    expect(result.actionCalls[0]).toMatchObject({
      actionId: "update_meta_budget",
      status: "requires_confirmation",
      requiresConfirmation: true,
      confirmationId: expect.stringMatching(/^confirm_/)
    });
    expect(recorded).toEqual([expect.objectContaining({ actionId: "update_meta_budget", authority: "operator", requiresConfirmation: true })]);
    expect(requests[0]?.systemPrompt).toContain(LEGACY_AUTHORITY_LINE);
  });

  it("leaves an exclusive turn byte-identical: app tools only, a native write refused as an unknown scoped tool", async () => {
    const { tools, result, requests } = await turn(createDaemonActionRegistry(), DESKTOP_TWINS, {
      mode: "exclusive",
      calls: [{ name: "update_meta_budget" }]
    });
    expect(tools).toEqual(DESKTOP_TWINS.map(app));
    expect(result.actionCalls[0]?.error).toEqual({ code: "unknown_action", message: "Unknown scoped app tool: update_meta_budget" });
    expect(requests[0]?.systemPrompt).toContain(LEGACY_AUTHORITY_LINE);
  });

  it("gives a union turn a prompt that names no withheld action and promises no engine Confirm control", async () => {
    const cases: Array<[AnyRegistry, string[]]> = [
      [createDaemonActionRegistry(), DESKTOP_TWINS],
      [createDaemonActionRegistry(), ["get_current_workspace"]],
      [createInfiniteOsRegistry({}), DESKTOP_TWINS],
      [createInfiniteOsRegistry({}), ["get_current_workspace"]]
    ];
    for (const [registry, appTools] of cases) {
      for (const message of [
        "raise the spring ad set's budget to $80 a day",
        "which campaign drove the most signups last month?",
        "what stands out?"
      ]) {
        const { requests } = await turn(registry, appTools, { message });
        const systemPrompt = requests[0]?.systemPrompt ?? "";
        for (const id of unionAlwaysWithheld(registry)) {
          expect(new RegExp(`\\b${id}\\b`).test(systemPrompt), `${appTools.length} tools, ${message}: ${id}`).toBe(false);
        }
        expect(systemPrompt).not.toContain("Confirm control");
        expect(systemPrompt).not.toContain("the RUNTIME owns that confirmation");
        expect(systemPrompt).toContain("this turn offers none of the engine's own write actions");
        expect(systemPrompt).toContain("never ask the user to type or repeat a confirmation phrase");
      }
    }
  });

  it("keeps the legacy authority line on every non-union prompt", () => {
    const base = { actions: native(), workspaceId: "ws_test", surface: "desktop" as const, modelProvider: "codex" as const };
    const plain = assembleInfiniteOsPrompt(base);
    expect(plain).toContain(LEGACY_AUTHORITY_LINE);
    expect(assembleInfiniteOsPrompt({ ...base, scopedAppToolMode: "exclusive" })).toBe(plain);
  });
});

describe("advisor rescue after a source list alone follows the app routing", () => {
  const app = (name: string) => `mcp__${APP_SERVER}__${name}`;
  const DESKTOP = ["list_sources", "get_meta_performance", "list_contacts", "list_audit_leads", "run_app_outcomes", "run_metric_query", "run_breakdown_query"];
  const desktopIds = (...names: string[]) => [...createDaemonActionRegistry().list().map((action) => action.id as string), ...names.map(app)];
  const sourcesOnly = [{ name: "list_sources", result: { data: { sources: [] } } }];
  const rescue = (message: string, available: readonly string[]) =>
    buildQueryRefinementSections(message, sourcesOnly, available).join("\n");
  // The rescue exactly as 33ead6d wrote it, for a turn without the app's reads.
  const METRIC_RESCUE = [
    "Metric-question refinement guidance:",
    "- The user asked for a specific metric or number, but you only have a source list so far.",
    "- Do not stop to ask for a time range. Identify the metric (use the metric-aliases hint, or list_metrics/describe_metric if unsure) and run run_metric_query or run_breakdown_query over all available data, then state the assumed scope as a caveat and offer to narrow.",
    "- Only report a metric as unavailable after confirming it is not reachable under any alias."
  ];
  const META_RESCUE = [
    "Metric-question refinement guidance:",
    "- The user asked for a Meta Ads number, but you only have a source list so far.",
    "- Call get_meta_performance with a structured `period` (all available data when no period was named, stated as the assumed scope). run_metric_query and run_breakdown_query refuse Meta metrics."
  ];
  const CONTACTS_LINE = "- Leads, new leads, form submissions or contacts -> call list_contacts: this workspace's Contacts and their form submissions, never a signup or registration.";
  const META_LEADS_CLAIM = " Meta's 'leads' result is Meta's claim; read it with get_meta_performance only when the person asks about Meta ads.";
  const AUDIT_LINE = "- Audit leads and audit sign-ups (people who submitted Infinite's own growth-audit form) -> call list_audit_leads: an audit lead is its own step, never a signup or registration.";
  const LEADS_TO_AUDIT_LINE = "- Leads, new leads or audit leads -> call list_audit_leads: an audit lead is its own step, never a signup or registration.";
  const OUTCOMES_LINE = "- Signups, registrations or new accounts -> call run_app_outcomes with definition \"stages_v1\" (accountCreated = registrations), never a signup_count metric or breakdown.";
  const META_CAMPAIGN_CLAIM_LINE = "- Meta's claim: the campaign may be a Meta Ads campaign -> also call get_meta_performance with a structured `period`; its leads, results, registrations and trials are Meta's claim, not our records. Answer with both, labelled \"our records\" and \"Meta's claim\", never one presented as the other, and say so when Meta has no campaign by that name.";
  const appRescue = (...lines: string[]) => [
    "Metric-question refinement guidance:",
    "- The user asked for a number the app's own reads answer, but you only have a source list so far.",
    ...lines,
    "- Do not stop to ask for a time range: read over the period the person named, or over all available data stated as the assumed scope."
  ];

  it.each([
    ["how many new leads this week?", appRescue(CONTACTS_LINE + META_LEADS_CLAIM)],
    ["how many leads did we get this week?", appRescue(CONTACTS_LINE + META_LEADS_CLAIM)],
    // A campaign may be a Meta Ads campaign: our records and Meta's claim, labelled.
    ["show me leads from the spring campaign", appRescue(`- Our records: ${CONTACTS_LINE.slice(2)}`, META_CAMPAIGN_CLAIM_LINE)],
    ["how many leads did the spring campaign get?", appRescue(`- Our records: ${CONTACTS_LINE.slice(2)}`, META_CAMPAIGN_CLAIM_LINE)],
    ["how many people filled in the contact form this week?", appRescue(CONTACTS_LINE + META_LEADS_CLAIM)],
    ["how many audit leads this week?", appRescue(AUDIT_LINE)],
    ["how many signups did we get", appRescue(OUTCOMES_LINE)],
    ["how many registrations last week?", appRescue(OUTCOMES_LINE)],
    ["how many signups came from my email campaign?", appRescue(OUTCOMES_LINE)],
    ["how many leads and signups this week?", appRescue(CONTACTS_LINE + META_LEADS_CLAIM, OUTCOMES_LINE)]
  ])("routes %j to the app's read when the turn carries it", (message, expected) => {
    expect(buildQueryRefinementSections(message, sourcesOnly, desktopIds(...DESKTOP))).toEqual(expected);
  });

  it.each([
    ["how many leads did our facebook ads get this week?"],
    ["how many leads did the spring ad set get?"],
    ["what's my cpl"],
    ["what is our cost per lead this month?"]
  ])("keeps the Meta rescue when %j asks about Meta ads", (message) => {
    expect(buildQueryRefinementSections(message, sourcesOnly, desktopIds(...DESKTOP))).toEqual(META_RESCUE);
  });

  it("keeps the Meta rescue, with its credit note, for signups the person credits to Meta ads", () => {
    const text = rescue("how many signups did facebook ads bring?", desktopIds(...DESKTOP));
    expect(text).toContain(META_RESCUE[1]);
    expect(text).toContain("are Meta's claim");
    expect(text).not.toContain("run_app_outcomes with definition");
  });

  it("keeps the metric rescue for a number no app read answers", () => {
    for (const message of ["what was my revenue last month?", "how many orders"]) {
      expect(buildQueryRefinementSections(message, sourcesOnly, desktopIds(...DESKTOP)), message).toEqual(METRIC_RESCUE);
    }
  });

  it("sends leads to list_audit_leads on a turn with it and no list_contacts, as the prompt does", () => {
    expect(buildQueryRefinementSections("how many new leads this week?", sourcesOnly, desktopIds("list_sources", "list_audit_leads")))
      .toEqual(appRescue(LEADS_TO_AUDIT_LINE));
    expect(buildQueryRefinementSections("how many new leads this week?", sourcesOnly, desktopIds("list_sources", "list_audit_leads", "get_meta_performance")))
      .toEqual(appRescue(LEADS_TO_AUDIT_LINE + META_LEADS_CLAIM));
  });

  it("names list_contacts without the Meta clause on a turn without get_meta_performance", () => {
    expect(buildQueryRefinementSections("how many new leads this week?", sourcesOnly, desktopIds("list_sources", "list_contacts")))
      .toEqual(appRescue(CONTACTS_LINE));
  });

  it("is byte-identical to 33ead6d without the app's reads", () => {
    const natives = createDaemonActionRegistry().list().map((action) => action.id as string);
    for (const available of [[], natives, [...native().map((action) => action.id as string)]]) {
      for (const message of [
        "how many new leads this week?", "how many leads did we get this week?", "how many signups did we get",
        "how many leads did the spring campaign get?", "what was my revenue last month?", "what's my cpl"
      ]) {
        expect(buildQueryRefinementSections(message, sourcesOnly, available), message).toEqual(METRIC_RESCUE);
      }
      // Metric-shaped ("how many"), but no metric term names registrations or a form fill: no rescue then, none now.
      expect(buildQueryRefinementSections("how many registrations last week?", sourcesOnly, available)).toEqual([]);
      expect(buildQueryRefinementSections("how many people filled in the contact form this week?", sourcesOnly, available)).toEqual([]);
    }
    // Only the Meta read: a campaign's leads stay Meta's, as they were.
    expect(buildQueryRefinementSections("how many leads did the spring campaign get?", sourcesOnly, desktopIds("get_meta_performance")))
      .toEqual(META_RESCUE);
  });

  it("never reads a refused list_sources call as a source list", () => {
    const refused = {
      name: "list_sources",
      result: {
        status: "error",
        actionId: "list_sources",
        input: {},
        error: { code: "unknown_action", message: `Unknown Infinite OS action: list_sources. This turn offers ${app("list_sources")} in its place.` }
      }
    };
    for (const message of ["how many signups did we get", "what's my cpl", "how many new leads this week?"]) {
      expect(buildQueryRefinementSections(message, [refused], desktopIds(...DESKTOP)), message).toEqual([]);
      expect(buildQueryRefinementSections(message, [refused]), message).toEqual([]);
    }
    expect(buildQueryRefinementSections("what stands out?", [refused]).join("\n")).not.toContain("You know which sources are connected");
    // Nor as a connection state to lead with.
    const refusedSyncRuns = { name: "get_recent_sync_runs", result: { ...refused.result, actionId: "get_recent_sync_runs" } };
    expect(buildQuerySynthesisSections("is ga4 connected?", [refused, refusedSyncRuns]).join("\n")).not.toContain("Source-status final synthesis guidance:");
    expect(buildQuerySynthesisSections("is ga4 connected?", [sourcesOnly[0]!]).join("\n")).toContain("Source-status final synthesis guidance:");
    // A refused sync_source_now is not a failed refresh to warn about by name.
    const refusedSync = { name: "sync_source_now", result: { ...refused.result, actionId: "sync_source_now", error: { code: "unknown_action", message: "Unknown Infinite OS action: sync_source_now. This chat turn does not offer it." } } };
    expect(buildQueryRefinementSections("what are my latest posts?", [refusedSync]).join("\n")).not.toContain("sync_source_now");
  });

  it("rescues toward list_contacts after the twin's source list in a real union turn, and not after a refused bare list_sources", async () => {
    async function run(message: string, firstCall: string) {
      const requests: ModelRequest[] = [];
      const controller = createLlmController({
        registry: createDaemonActionRegistry(),
        modelClient: {
          complete: async (request) => {
            requests.push(request);
            return requests.length === 1
              ? { toolCalls: [{ id: "call_1", name: firstCall, input: {} }] }
              : { message: "done" };
          }
        }
      });
      await controller.chat({
        message,
        sessionId: `s-rescue-${message}-${firstCall}`,
        workspaceId: "ws_test",
        actorId: "operator-1",
        surface: "desktop",
        scopedAppTools: {
          serverName: APP_SERVER,
          allowedTools: DESKTOP.map(app),
          mode: "union",
          tools: DESKTOP.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
          callTool: async (name: string) => name === "list_sources"
            ? { ok: true, actionId: "list_sources", authority: "tool_agent", status: "ok", data: { sources: [{ id: "src_ga4", provider: "ga4", status: "connected" }] }, provenance: [], caveats: [], truncated: false, nextActions: [] }
            : { ok: true }
        }
      });
      return requests[1]?.systemPrompt ?? "";
    }
    const afterTwin = await run("how many new leads this week?", app("list_sources"));
    expect(afterTwin).toContain(CONTACTS_LINE);
    expect(afterTwin).not.toContain("run run_metric_query or run_breakdown_query");
    const signups = await run("how many signups did we get", app("list_sources"));
    expect(signups).toContain(OUTCOMES_LINE);
    expect(signups).not.toContain("run run_metric_query or run_breakdown_query");
    const campaign = await run("show me leads from the spring campaign", app("list_sources"));
    expect(campaign).toContain(`- Our records: ${CONTACTS_LINE.slice(2)}`);
    expect(campaign).toContain(META_CAMPAIGN_CLAIM_LINE);
    expect(campaign).not.toContain(META_RESCUE[1]);
    const refusedBare = await run("how many signups did we get", "list_sources");
    expect(refusedBare).not.toContain("only have a source list so far");
  });
});

describe("advisor rescue: lead, audit, trial and form sign-up words go where the prompt sends them", () => {
  const app = (name: string) => `mcp__${APP_SERVER}__${name}`;
  const desktopIds = (...names: string[]) => [...createDaemonActionRegistry().list().map((action) => action.id as string), ...names.map(app)];
  const sourcesOnly = [{ name: "list_sources", result: { data: { sources: [] } } }];
  const rescue = (message: string, available: readonly string[]) => buildQueryRefinementSections(message, sourcesOnly, available);
  // 1bu-1 origin/main (ab1d9b28) apps/desktop/src/main/brain/tools/catalog.ts:537-623: the iMessage remote-human lane's
  // app tools (main.ts:5495 sends them exclusive). The scheduled lane drops the alert and reminder CRUD and
  // list_needs_you (:625-646); the triggered lane also drops the live reads (:672-679) and list_my_workspaces (:710).
  // No lane carries list_contacts: only the unmerged feat/2026-09-29-cmdl-contacts-forms adds it.
  const REMOTE_HUMAN = [
    "list_alert_sources", "create_alert", "list_alerts", "update_alert", "cancel_alert", "create_imessage_reminder",
    "list_imessage_reminders", "update_imessage_reminder", "cancel_imessage_reminder", "get_current_workspace",
    "list_my_workspaces", "list_sources", "get_current_research_state", "run_metric_query", "run_breakdown_query",
    "run_funnel_query", "run_site_metrics", "run_app_outcomes", "list_signup_people", "list_account_people",
    "list_app_signup_people", "list_signup_attempts", "list_website_contacts", "list_audit_leads",
    "read_subscription_metrics", "read_funnel_counts", "run_posthog_live_query", "list_metrics", "describe_metric",
    "list_queryable_views", "describe_queryable_view", "list_reddit_leads", "list_needs_you", "search_x_accounts",
    "list_x_drafts", "get_x_inspiration_playbook", "seo_recommendations", "seo_traffic", "seo_traffic_by_page",
    "seo_competitor_intel", "seo_list_content", "seo_post_detail", "get_seo_job_status", "suggest_next_seo_move",
    "get_lifecycle_overview", "get_email_campaign_outcomes", "count_audience", "preview_email_audience", "list_replies",
    "read_email_draft", "list_tracked_links", "get_tracked_link_clicks", "preview_tracked_link", "get_links_playbook",
    "organic_content_overview", "organic_post_deep_dive", "organic_daily_analysis_history", "get_organic_playbook",
    "list_youtube_experiments", "get_youtube_experiment_reading", "get_youtube_experiment_strategy",
    "get_meta_performance", "list_meta_entities", "analysis_discover", "analysis_compare", "analysis_decompose",
    "analysis_trace", "analysis_reconcile", "analysis_catalog"
  ];
  const TRIGGERED_DROPPED = new Set([
    "list_alert_sources", "create_alert", "list_alerts", "update_alert", "cancel_alert", "create_imessage_reminder",
    "list_imessage_reminders", "update_imessage_reminder", "cancel_imessage_reminder", "list_needs_you",
    "run_posthog_live_query", "seo_competitor_intel", "search_x_accounts", "list_youtube_experiments",
    "get_youtube_experiment_reading", "get_lifecycle_overview", "list_my_workspaces"
  ]);
  const TRIGGERED = REMOTE_HUMAN.filter((name) => !TRIGGERED_DROPPED.has(name));
  // The Cmd+L union's lead, outcome, trial and traffic reads on origin/main (no list_contacts yet).
  const MAIN_UNION = [
    "list_sources", "get_meta_performance", "list_meta_entities", "list_audit_leads", "run_app_outcomes",
    "list_signup_people", "read_subscription_metrics", "run_site_metrics", "analysis_compare", "run_metric_query",
    "run_breakdown_query"
  ];
  const WITH_CONTACTS = [...MAIN_UNION, "list_contacts"];
  /** The tool sets a turn without list_contacts carries: each exclusive lane offers only its app tools. */
  const NO_CONTACTS_SETS: Array<[string, string[]]> = [
    ["audit leads only", desktopIds("list_sources", "list_audit_leads")],
    ["audit leads and Meta", desktopIds("list_sources", "list_audit_leads", "get_meta_performance")],
    ["the Cmd+L union", desktopIds(...MAIN_UNION)],
    ["the remote-human lane", REMOTE_HUMAN.map(app)],
    ["the triggered lane", TRIGGERED.map(app)]
  ];

  const METRIC_RESCUE = [
    "Metric-question refinement guidance:",
    "- The user asked for a specific metric or number, but you only have a source list so far.",
    "- Do not stop to ask for a time range. Identify the metric (use the metric-aliases hint, or list_metrics/describe_metric if unsure) and run run_metric_query or run_breakdown_query over all available data, then state the assumed scope as a caveat and offer to narrow.",
    "- Only report a metric as unavailable after confirming it is not reachable under any alias."
  ];
  const META_RESCUE_LINE = "- The user asked for a Meta Ads number, but you only have a source list so far.";
  const META_LEADS_CLAIM = " Meta's 'leads' result is Meta's claim; read it with get_meta_performance only when the person asks about Meta ads.";
  const AUDIT_LINE = "- Audit leads and audit sign-ups (people who submitted Infinite's own growth-audit form) -> call list_audit_leads: an audit lead is its own step, never a signup or registration.";
  const LEADS_TO_AUDIT_LINE = "- Leads, new leads or audit leads -> call list_audit_leads: an audit lead is its own step, never a signup or registration.";
  const OUTCOMES_LINE = "- Signups, registrations or new accounts -> call run_app_outcomes with definition \"stages_v1\" (accountCreated = registrations), never a signup_count metric or breakdown.";
  const TRIAL_LINE = "- Trials started or trial sign-ups -> call read_subscription_metrics (Stripe trial starts): a trial is never a registration, and stripe_trialing_subscribers counts customers trialing now, never trials started.";
  const FORM_SIGNUP_LINE = "- A newsletter, webinar, waitlist, demo or event sign-up is a form submission -> call list_contacts: this workspace's Contacts and their form submissions, never an account registration.";
  const SITE_LINE = "- Site visits, visitors or traffic totals -> call run_site_metrics (server Visits read high and are never people). GA4 site_visitors or sessions only when the person asks for GA4.";
  const SITE_COMPARE_LINE = "- Site visits, visitors or traffic totals -> call run_site_metrics (server Visits read high and are never people). By channel or source -> analysis_compare with segmentBy entry_channel. GA4 site_visitors or sessions only when the person asks for GA4.";
  const appRescue = (...lines: string[]) => [
    "Metric-question refinement guidance:",
    "- The user asked for a number the app's own reads answer, but you only have a source list so far.",
    ...lines,
    "- Do not stop to ask for a time range: read over the period the person named, or over all available data stated as the assumed scope."
  ];

  const CONTACT_AND_FORM_QUESTIONS = [
    "how many contacts do we have?",
    "how many form submissions this week?",
    "how many people filled out the contact form this week?",
    "show me contacts from the spring campaign",
    "how many form fills did we get this month?",
    "how many people registered for the webinar?",
    "how many people signed up for the newsletter this week?"
  ];

  it.each(NO_CONTACTS_SETS)("never sends contacts or form submissions to list_audit_leads on %s, and adds no rescue, as at 58888d9", (_label, available) => {
    for (const message of CONTACT_AND_FORM_QUESTIONS) {
      expect(rescue(message, available), message).toEqual([]);
    }
    // Lead words still go where the prompt's no-list_contacts bullet sends them.
    const leads = rescue("how many new leads this week?", available).join("\n");
    expect(leads).toContain(LEADS_TO_AUDIT_LINE);
  });

  it.each([
    ["how many people signed up for an audit this week?", [AUDIT_LINE]],
    ["who signed up for an audit this week? show me", [AUDIT_LINE]],
    ["how many audit sign-ups did we get this month?", [AUDIT_LINE]],
    ["how many people registered for a free growth audit?", [AUDIT_LINE]],
    ["how many people requested an audit this week?", [AUDIT_LINE]],
    ["how many people filled out the audit form this week?", [AUDIT_LINE]],
    ["how many signups and audit sign-ups this week?", [AUDIT_LINE, OUTCOMES_LINE]]
  ])("sends %j to list_audit_leads, never to run_app_outcomes, as an audit sign-up", (message, lines) => {
    for (const available of [desktopIds(...MAIN_UNION), desktopIds(...WITH_CONTACTS), REMOTE_HUMAN.map(app), TRIGGERED.map(app)]) {
      expect(rescue(message, available), message).toEqual(appRescue(...lines));
    }
  });

  it.each([
    ["how many trial signups this week?", [TRIAL_LINE]],
    ["how many people signed up for a trial this week?", [TRIAL_LINE]],
    ["how many free trial sign-ups did we get this month?", [TRIAL_LINE]],
    ["how many new trials this week?", [TRIAL_LINE]],
    ["how many people started a trial and signed up?", [OUTCOMES_LINE, TRIAL_LINE]],
    ["how many signups and trials this week?", [OUTCOMES_LINE, TRIAL_LINE]]
  ])("sends the trials in %j to read_subscription_metrics, never to run_app_outcomes", (message, lines) => {
    for (const available of [desktopIds(...MAIN_UNION), REMOTE_HUMAN.map(app), TRIGGERED.map(app)]) {
      expect(rescue(message, available), message).toEqual(appRescue(...lines));
    }
  });

  it("never names run_app_outcomes for a trial sign-up on a turn without read_subscription_metrics", () => {
    for (const message of ["how many trial signups this week?", "how many people signed up for a trial this week?", "how many free trial sign-ups did we get this month?"]) {
      expect(rescue(message, desktopIds("list_sources", "run_app_outcomes")).join("\n"), message).not.toContain("run_app_outcomes");
    }
  });

  it.each([
    ["how many people registered for the webinar?", [FORM_SIGNUP_LINE]],
    ["how many people signed up for the newsletter this week?", [FORM_SIGNUP_LINE]],
    ["how many waitlist sign-ups this week?", [FORM_SIGNUP_LINE]],
    ["how many people signed up for the newsletter and how many signed up for the app?", [FORM_SIGNUP_LINE, OUTCOMES_LINE]]
  ])("sends the form sign-up in %j to list_contacts, never to run_app_outcomes", (message, lines) => {
    expect(rescue(message, desktopIds(...WITH_CONTACTS))).toEqual(appRescue(...lines));
  });

  it("sends site visitors to run_site_metrics, as the prompt does, in place of the metric rescue's run_metric_query", () => {
    for (const message of ["how many visitors this week?", "how many site visitors did we get last month?"]) {
      expect(rescue(message, desktopIds(...MAIN_UNION)), message).toEqual(appRescue(SITE_COMPARE_LINE));
      expect(rescue(message, desktopIds("list_sources", "run_site_metrics")), message).toEqual(appRescue(SITE_LINE));
    }
    // It adds no rescue where none fired: traffic and page visits name no metric term.
    for (const message of ["how much traffic did the site get last month?", "how many visits did the pricing page get?"]) {
      expect(rescue(message, desktopIds(...MAIN_UNION)), message).toEqual([]);
    }
    // GA4 by name keeps the metric rescue; SEO traffic is not a site-visits total; Meta's visitors stay Meta's.
    expect(rescue("how many visitors did GA4 record this week?", desktopIds(...MAIN_UNION))).toEqual(METRIC_RESCUE);
    expect(rescue("how much SEO traffic did we get this month?", desktopIds(...MAIN_UNION)).join("\n")).not.toContain("run_site_metrics");
    expect(rescue("how many visitors did our facebook ads send?", desktopIds(...MAIN_UNION)).join("\n")).toContain(META_RESCUE_LINE);
    // An open-core turn keeps the metric rescue.
    expect(rescue("how many visitors this week?", [])).toEqual(METRIC_RESCUE);
  });

  /** A real controller turn: the model reads the app's list_sources, then answers; returns the second prompt. */
  async function laneTurn(message: string, appTools: string[], mode: "union" | "exclusive") {
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createDaemonActionRegistry(),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return requests.length === 1
            ? { toolCalls: [{ id: "call_1", name: app("list_sources"), input: {} }] }
            : { message: "done" };
        }
      }
    });
    await controller.chat({
      message,
      sessionId: `s-lane-${mode}-${appTools.length}-${message}`,
      workspaceId: "ws_test",
      actorId: "operator-1",
      surface: "desktop",
      scopedAppTools: {
        serverName: APP_SERVER,
        allowedTools: appTools.map(app),
        mode,
        tools: appTools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
        callTool: async (name: string) => name === "list_sources"
          ? { ok: true, actionId: "list_sources", authority: "tool_agent", status: "ok", data: { sources: [{ id: "src_ga4", provider: "ga4", status: "connected" }] }, provenance: [], caveats: [], truncated: false, nextActions: [] }
          : { ok: true }
      }
    });
    expect(requests).toHaveLength(2);
    return { first: requests[0]!, second: requests[1]?.systemPrompt ?? "" };
  }

  it("gives the remote-human and triggered lanes no audit-leads rescue for contacts or form questions", async () => {
    for (const lane of [REMOTE_HUMAN, TRIGGERED]) {
      for (const message of ["how many contacts do we have?", "how many form submissions this week?", "how many people filled out the contact form this week?"]) {
        const { second } = await laneTurn(message, lane, "exclusive");
        expect(second, message).not.toContain(LEADS_TO_AUDIT_LINE);
        expect(second, message).not.toContain("only have a source list so far");
      }
      const { second } = await laneTurn("how many new leads this week?", lane, "exclusive");
      expect(second).toContain(LEADS_TO_AUDIT_LINE + META_LEADS_CLAIM);
    }
  });

  it("gives a desktop union turn the audit and trial reads, never run_app_outcomes, for audit and trial sign-ups", async () => {
    const audit = await laneTurn("how many people signed up for an audit this week?", MAIN_UNION, "union");
    expect(audit.first.tools.filter((tool) => !tool.name.startsWith("mcp__"))).toEqual([]);
    expect(audit.second).toContain(AUDIT_LINE);
    expect(audit.second).not.toContain(OUTCOMES_LINE);
    const trial = await laneTurn("how many people signed up for a trial this week?", MAIN_UNION, "union");
    expect(trial.second).toContain(TRIAL_LINE);
    expect(trial.second).not.toContain(OUTCOMES_LINE);
  });

  // A campaign's number on a turn with get_meta_performance. The prompt (prompt-assembler.ts appRoutingGuidance) sends
  // "contacts from a campaign" to list_contacts, and without it 'leads' to list_audit_leads, while its Meta bullet
  // lists leads, results, registrations and trials as Meta Ads numbers that "are Meta's claim, not our records", and
  // its compare rule is "show both, labelled". The rescue names both reads, labelled; explicit Meta ads keep the Meta
  // rescue alone.
  const CONTACTS_LINE = "- Leads, new leads, form submissions or contacts -> call list_contacts: this workspace's Contacts and their form submissions, never a signup or registration.";
  const ourRecords = (line: string) => `- Our records: ${line.slice(2)}`;
  const META_CAMPAIGN_CLAIM_LINE = "- Meta's claim: the campaign may be a Meta Ads campaign -> also call get_meta_performance with a structured `period`; its leads, results, registrations and trials are Meta's claim, not our records. Answer with both, labelled \"our records\" and \"Meta's claim\", never one presented as the other, and say so when Meta has no campaign by that name.";
  const META_RESCUE = [
    "Metric-question refinement guidance:",
    META_RESCUE_LINE,
    "- Call get_meta_performance with a structured `period` (all available data when no period was named, stated as the assumed scope). run_metric_query and run_breakdown_query refuse Meta metrics."
  ];
  /** Every line of the rescue that names one of our lead reads. */
  const ourLeadReadLines = (lines: string[]) => lines.filter((line) => /\b(?:list_contacts|list_audit_leads)\b/.test(line));

  it.each([
    ["how many leads did the spring campaign get?"],
    ["show me leads from the spring campaign"],
    ["how many leads did our spring campaign bring in this week?"]
  ])("never sends %j to list_audit_leads alone on a turn without list_contacts: our records and Meta's claim, labelled", (message) => {
    for (const [label, available] of NO_CONTACTS_SETS.filter(([, ids]) => ids.includes(app("get_meta_performance")))) {
      const lines = rescue(message, available);
      expect(lines, `${label}: ${message}`).toEqual(appRescue(ourRecords(LEADS_TO_AUDIT_LINE), META_CAMPAIGN_CLAIM_LINE));
      expect(lines.join("\n"), label).not.toContain(LEADS_TO_AUDIT_LINE + META_LEADS_CLAIM);
      expect(lines.join("\n"), label).not.toContain("only when the person asks about Meta ads");
    }
  });

  it.each([
    ["how many leads did the spring campaign get?"],
    ["show me leads from the spring campaign"]
  ])("never sends %j to list_contacts alone on a turn with it: our records and Meta's claim, labelled", (message) => {
    const lines = rescue(message, desktopIds(...WITH_CONTACTS));
    expect(lines).toEqual(appRescue(ourRecords(CONTACTS_LINE), META_CAMPAIGN_CLAIM_LINE));
    expect(lines.join("\n")).not.toContain("only when the person asks about Meta ads");
  });

  it("labels a campaign's signups and trials as our records beside Meta's claim", () => {
    expect(rescue("how many signups did the spring campaign bring?", desktopIds(...MAIN_UNION)))
      .toEqual(appRescue(ourRecords(OUTCOMES_LINE), META_CAMPAIGN_CLAIM_LINE));
    expect(rescue("how many trials did the spring campaign bring?", desktopIds(...MAIN_UNION)))
      .toEqual(appRescue(ourRecords(TRIAL_LINE), META_CAMPAIGN_CLAIM_LINE));
  });

  it.each([
    ["how many leads from facebook ads this week?"],
    ["what's the cost per lead on the video ad?"],
    ["cost per lead on the video ad"],
    ["how many leads did the spring ad set get?"]
  ])("keeps the Meta rescue alone for %j, with and without list_contacts", (message) => {
    for (const available of [desktopIds(...MAIN_UNION), desktopIds(...WITH_CONTACTS), REMOTE_HUMAN.map(app), TRIGGERED.map(app)]) {
      const lines = rescue(message, available);
      expect(lines, message).toEqual(META_RESCUE);
      expect(ourLeadReadLines(lines), message).toEqual([]);
    }
  });

  it("names none of our lead reads for \"leads from facebook ads this week\", with and without list_contacts", () => {
    // Not metric-shaped ("how many", "show me", "cost per"): no rescue fires, as before; the prompt's Meta bullet routes it.
    for (const available of [desktopIds(...MAIN_UNION), desktopIds(...WITH_CONTACTS)]) {
      expect(rescue("leads from facebook ads this week", available)).toEqual([]);
    }
  });

  it("keeps plain lead questions on list_contacts or list_audit_leads, unlabelled, with Meta's leads only on a Meta ask", () => {
    expect(rescue("how many new leads this week?", desktopIds(...WITH_CONTACTS))).toEqual(appRescue(CONTACTS_LINE + META_LEADS_CLAIM));
    expect(rescue("how many new leads this week?", desktopIds(...MAIN_UNION))).toEqual(appRescue(LEADS_TO_AUDIT_LINE + META_LEADS_CLAIM));
    for (const available of [desktopIds(...MAIN_UNION), desktopIds(...WITH_CONTACTS)]) {
      expect(rescue("how many new audit leads this week?", available)).toEqual(appRescue(AUDIT_LINE));
      // Not metric-shaped: no rescue, as before; the prompt's leads bullet routes it.
      expect(rescue("any new audit leads?", available)).toEqual([]);
    }
    // A non-ad campaign is not Meta's: our records only.
    expect(rescue("how many leads came from my email campaign?", desktopIds(...WITH_CONTACTS))).toEqual(appRescue(CONTACTS_LINE + META_LEADS_CLAIM));
  });

  it("leaves a campaign's leads as they were on a turn without get_meta_performance", () => {
    expect(rescue("how many leads did the spring campaign get?", desktopIds("list_sources", "list_contacts"))).toEqual(appRescue(CONTACTS_LINE));
    expect(rescue("how many leads did the spring campaign get?", desktopIds("list_sources", "list_audit_leads"))).toEqual(appRescue(LEADS_TO_AUDIT_LINE));
  });

  it("gives today's desktop union turn both reads, labelled, for a campaign's leads", async () => {
    const { second } = await laneTurn("how many leads did the spring campaign get?", MAIN_UNION, "union");
    expect(second).toContain(ourRecords(LEADS_TO_AUDIT_LINE));
    expect(second).toContain(META_CAMPAIGN_CLAIM_LINE);
    expect(second).not.toContain(LEADS_TO_AUDIT_LINE + META_LEADS_CLAIM);
  });
});

describe("advisor: a refused call is no read", () => {
  const app = (name: string) => `mcp__${APP_SERVER}__${name}`;
  const refused = (name: string) => ({
    name,
    result: {
      status: "error",
      actionId: name,
      input: {},
      error: { code: "unknown_action", message: `Unknown Infinite OS action: ${name}` }
    }
  });
  const twinSources = {
    name: app("list_sources"),
    result: {
      data: {
        ok: true, actionId: "list_sources", authority: "tool_agent", status: "ok",
        data: { sources: [{ id: "src_ga4", provider: "ga4", status: "connected", connection_name: "Main site" }] },
        provenance: [], caveats: [], truncated: false, nextActions: []
      }
    }
  };

  it("still rescues after a refused app call, which answered nothing", () => {
    const available = [...createDaemonActionRegistry().list().map((action) => action.id as string), app("list_sources"), app("list_audit_leads")];
    expect(buildQueryRefinementSections("how many new leads this week?", [twinSources, refused(app("list_contacts"))], available))
      .toEqual(buildQueryRefinementSections("how many new leads this week?", [twinSources], available));
    expect(buildQueryRefinementSections("how many new leads this week?", [twinSources], available).join("\n"))
      .toContain("-> call list_audit_leads");
  });

  it("never reads a refused get_recent_sync_runs as freshness context", () => {
    const sources = { name: "list_sources", result: { data: { sources: [{ id: "src_ga4", provider: "ga4", status: "connected" }] } } };
    const metrics = { name: "list_metrics", result: { data: { metrics: [{ id: "site_visitors" }] } } };
    expect(buildQueryRefinementSections("what stands out?", [sources, metrics, refused("get_recent_sync_runs")]))
      .toEqual(buildQueryRefinementSections("what stands out?", [sources, metrics]));
    expect(buildQueryRefinementSections("what stands out?", [sources, metrics]).join("\n")).toContain("not enough freshness context yet");
  });

  it("keeps the twin's source list when a refused bare list_sources follows it", () => {
    for (const message of ["give me an overview of the workspace", "give me a snapshot of the workspace", "what stands out?"]) {
      expect(buildQuerySynthesisSections(message, [twinSources, refused("list_sources")]), message)
        .toEqual(buildQuerySynthesisSections(message, [twinSources]));
    }
    expect(buildQuerySynthesisSections("give me an overview of the workspace", [twinSources]).join("\n")).toContain("- Connected sources: 1.");
  });
});

describe("union turn: a refused write's input", () => {
  it("is redacted where it is recorded and where it is echoed to the model, as the Confirm card's was", async () => {
    const input = { provider: "stripe", credentialKind: "api_key", credentialPayload: { apiKey: "sk_live_abc123" } };
    const requests: ModelRequest[] = [];
    const controller = createLlmController({
      registry: createDaemonActionRegistry(),
      modelClient: {
        complete: async (request) => {
          requests.push(request);
          return requests.length === 1 ? { toolCalls: [{ id: "call_1", name: "connect_source", input }] } : { message: "done" };
        }
      }
    });
    const result = await controller.chat({
      message: "connect stripe with key sk_live_abc123",
      sessionId: "s-refused-write-redaction",
      workspaceId: "ws_test",
      actorId: "operator-1",
      surface: "desktop",
      scopedAppTools: {
        serverName: APP_SERVER,
        allowedTools: [`mcp__${APP_SERVER}__list_sources`],
        mode: "union",
        tools: [{ name: "list_sources", description: "list_sources", inputSchema: { type: "object" } }],
        callTool: async () => ({ ok: true })
      }
    });
    const call = result.actionCalls[0];
    expect(call).toMatchObject({ actionId: "connect_source", status: "error", error: { code: "unknown_action" } });
    expect(call?.input).toEqual({ provider: "stripe", credentialKind: "[redacted]", credentialPayload: "[redacted]" });
    expect(JSON.stringify(requests[1]?.toolResults)).not.toContain("sk_live_abc123");
  });
});
