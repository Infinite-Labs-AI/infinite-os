import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { r4Segments, seg } from "../../formatting/r4-segments.test-util.js";
import type { StepStatus, TurnStep } from "../app/turn-store.js";
import { displayWidth } from "../lib/display-width.js";
import { INFINITE_R4_THEME } from "../theme.js";
import type { Msg } from "../types.js";
import {
  bareToolName,
  friendlyStepLabel,
  plainToolWords,
  refineStepStatus,
  stepProgressWords,
  toolOutcome,
  stepGanttWidth,
  stepLabelWidth,
  stepsFromTrail,
  stepStripLines
} from "./steps.js";

// terminal-r4 `frame()` Steps strip, from the synthetic goldens region-steps
// (one row per status) and region-steps-two (infinite-os carries synthetic data only).
const theme = INFINITE_R4_THEME;
const step = (over: Partial<TurnStep> & Pick<TurnStep, "status">): TurnStep => ({
  id: "s1", name: "checking your campaigns", label: "checking your campaigns", startedAt: 0, endedAt: 1000, result: "result", ...over
});
const strip = (steps: TurnStep[], width = 100, nowMs = 1000) =>
  stepStripLines(steps, { width, color: true, theme, nowMs }).map(r4Segments);
const HEADER = seg(["─", "line"], [" ", ""], ["Steps", "b"], [" ", ""], ["─".repeat(92), "line"]);
const LABEL: [string, string] = ["  checking your campaigns    ", ""];
const BAR = "━".repeat(46);

describe("the Steps strip (region-steps)", () => {
  it("draws the header as a line rule with Steps in b", () => {
    expect(strip([step({ status: "ok" })])[0]).toEqual(HEADER);
  });

  it.each<[StepStatus, ReturnType<typeof seg>]>([
    ["ok", seg(LABEL, [BAR, "dim"], [" ", ""], ["✓", "green"], [" ", ""], ["result", "dim"])],
    ["wait", seg(LABEL, [BAR, "cyan"], [" ", ""], ["▣", "amber"], [" ", ""], ["result", "dim"])],
    ["fail", seg(LABEL, [`${BAR} ✗`, "red"], [" ", ""], ["result", "dim"])],
    ["unk", seg(LABEL, [BAR, "cyan"], [" ", ""], ["?", "amber"], [" ", ""], ["result", "dim"])],
    ["off", seg(LABEL, [BAR, "cyan"], [" ", ""], ["· result", "dim"])],
    ["bg", seg(LABEL, [`${"━".repeat(44)}╍╍ ⟳`, "cyan"], [" ", ""], ["result", "dim"])],
    ["part", seg(LABEL, [BAR, "cyan"], [" ", ""], ["◐", "amber"], [" ", ""], ["result", "dim"])],
    ["old", seg(LABEL, [BAR, "cyan"], [" ", ""], ["⧗", "amber"], [" ", ""], ["result", "dim"])]
  ])("a %s step: label, bar, glyph in its tone, result dim", (status, row) => {
    expect(strip([step({ status })])[1]).toEqual(row);
  });

  it("a running step ends in ╍╍ and a braille spinner, all cyan", () => {
    // 800 ms in: the spinner's first frame (r4 draws ⠋).
    const [, row] = strip([step({ status: "run", endedAt: null })], 100, 800);
    expect(row).toEqual(seg(LABEL, [`${"━".repeat(44)}╍╍ ⠋`, "cyan"], [" ", ""], ["result", "dim"]));
  });

  it("lays two calls on the turn's timeline (region-steps-two)", () => {
    const rows = strip([
      step({ id: "a", label: "checking your campaigns", status: "ok", startedAt: 0, endedAt: 500, result: "1 ad" }),
      step({ id: "b", label: "waiting for your OK", status: "wait", startedAt: 500, endedAt: 600, result: "pause 1 ad" })
    ], 100, 600);
    expect(rows[1]).toEqual(seg(LABEL, ["━".repeat(38), "dim"], [" ".repeat(9), ""], ["✓", "green"], [" ", ""], ["1 ad", "dim"]));
    expect(rows[2]).toEqual(seg([`  waiting for your OK${" ".repeat(46)}`, ""], ["━".repeat(8), "cyan"], [" ", ""], ["▣", "amber"], [" ", ""], ["pause 1 ad", "dim"]));
  });

  it("keeps one row per call: the same tool twice is two rows, and the failed one stays", () => {
    const rows = stepStripLines([
      step({ id: "c1", label: "queueing draft", status: "ok", startedAt: 0, endedAt: 400, result: "queued" }),
      step({ id: "c2", label: "queueing draft", status: "fail", startedAt: 400, endedAt: 1000, result: "same error" })
    ], { width: 100, color: false, theme, nowMs: 1000 });
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatch(/^ {2}queueing draft .*✓ queued$/u);
    expect(rows[2]).toMatch(/^ {2}queueing draft .*✗ same error$/u);
  });

  it("uses r4's column widths at 60, 100 and 160", () => {
    expect([60, 100, 160].map((w) => [stepLabelWidth(w), stepGanttWidth(w)])).toEqual([[26, 6], [26, 46], [28, 104]]);
  });

  it("cuts a long label and a long result with an ellipsis and never passes the width", () => {
    for (const width of [40, 60, 100, 160]) {
      const rows = stepStripLines([step({ status: "ok", label: "l".repeat(80), result: "r".repeat(80) })], { width, color: false, theme, nowMs: 1000 });
      expect(rows.every((row) => displayWidth(row) <= width)).toBe(true);
      expect(rows[1]).toContain("…");
    }
  });

  it("a failed or unknown call whose reason was cut keeps the whole reason on dim rows under it", () => {
    const reason = "the ad account hit its daily spending limit, so the change was not sent";
    for (const status of ["fail", "unk"] as const) {
      const rows = stepStripLines([step({ status, label: "pausing ad", result: reason })], { width: 80, color: false, theme, nowMs: 1000 });
      expect(rows[1]).toContain("…");
      const more = rows.slice(2);
      expect(more.length).toBeGreaterThan(0);
      expect(more.every((row) => row.startsWith("    ") && displayWidth(row) <= 80)).toBe(true);
      expect(more.map((row) => row.trim()).join(" ")).toBe(reason);
      const painted = stepStripLines([step({ status, label: "pausing ad", result: reason })], { width: 80, color: true, theme, nowMs: 1000 });
      expect(r4Segments(painted[2]!).filter((part) => part.text.trim()).every((part) => part.style === "dim")).toBe(true);
    }
  });

  it("an ok call keeps one row however long its result (r4)", () => {
    const rows = stepStripLines([step({ status: "ok", result: "r".repeat(80) })], { width: 80, color: false, theme, nowMs: 1000 });
    expect(rows).toHaveLength(2);
  });

  it("a failed call whose reason fits has no extra rows", () => {
    const rows = stepStripLines([step({ status: "fail", result: "limit" })], { width: 80, color: false, theme, nowMs: 1000 });
    expect(rows).toHaveLength(2);
  });

  it("draws nothing for a turn with no calls", () => {
    expect(stepStripLines([], { width: 100, color: true, theme })).toEqual([]);
  });
});

describe("step labels and statuses", () => {
  it.each([
    ["mcp__infinite_app__list_meta_entities", "listing Meta entities"],
    ["mcp__infinite_app__get_meta_performance", "getting Meta performance"],
    ["propose_pause_entity", "proposing pause entity"],
    ["run_breakdown_query", "running breakdown query"],
    ["readFile", "reading file"],
    ["seo_queue_draft", "seo queue draft"],
    ["get_google_ads_performance", "getting Google Ads performance"],
    ["check_ga4_sync", "checking GA4 sync"],
    ["list_posthog_events", "listing PostHog events"],
    ["read_x_playbook", "reading X playbook"],
    ["sync_stripe_and_shopify", "syncing Stripe and Shopify"]
  ])("a tool id is humanised, proper nouns kept: %s → %s", (name, label) => {
    expect(friendlyStepLabel(name)).toBe(label);
  });

  it.each([
    "checking Google Ads",
    "pausing on Meta",
    "waiting for your OK",
    "reading the X playbook",
    "checking what I can do",
    "making 3 creatives (Codex)"
  ])("a label that is already words stays as written (run-2 M5): %s", (label) => {
    expect(friendlyStepLabel(label)).toBe(label);
  });

  it("a trail line whose call is already words keeps it; a title-cased tool id is still humanised", () => {
    const messages: Msg[] = [{
      kind: "trail", role: "system", text: "",
      tools: ["checking Google Ads (0.6s) :: 3 campaigns ✓", "Mcp Infinite App Get Meta Performance(\"x\") (0.5s) :: 1 ad ✓"]
    }];
    expect(stepsFromTrail(messages).map((item) => item.label)).toEqual(["checking Google Ads", "getting Meta performance"]);
  });

  it("strips the MCP server prefix only", () => {
    expect(bareToolName("mcp__infinite_app__get_report")).toBe("get_report");
    expect(bareToolName("get_report")).toBe("get_report");
  });

  it("reads trail lines as steps, end to end, without arguments or durations", () => {
    const messages: Msg[] = [{
      kind: "trail", role: "system", text: "",
      tools: [
        "Mcp Infinite App List Meta Entities(\"{\\\"level\\\":\\\"ad\\\"}\") (0.5s) :: 3 ads ✓",
        "Pause Entity(\"Hook B\") (1.0s) :: refused ✗",
        "■ Send Email(\"x\") · stopped"
      ]
    }];
    expect(stepsFromTrail(messages).map(({ label, status, startedAt, endedAt, result }) => ({ label, status, startedAt, endedAt, result }))).toEqual([
      { label: "listing Meta entities", status: "ok", startedAt: 0, endedAt: 500, result: "3 ads" },
      { label: "pausing entity", status: "fail", startedAt: 500, endedAt: 1500, result: "refused" },
      { label: "sending email", status: "stopped", startedAt: 1500, endedAt: 1500, result: "stopped" }
    ]);
  });

  it("a finished call takes the state of the one view it drew", () => {
    const view = (tool: string, state: AnswerViewV1["state"]) => ({ tool, state }) as AnswerViewV1;
    const done = step({ status: "ok", name: "mcp__app__get_report" });
    expect(refineStepStatus(done, [view("get_report", "partial")])).toBe("part");
    expect(refineStepStatus(done, [view("get_report", "out_of_date")])).toBe("old");
    expect(refineStepStatus(done, [view("get_report", "ready")])).toBe("ok");
    expect(refineStepStatus(done, [view("get_report", "partial"), view("get_report", "ready")])).toBe("ok");
    expect(refineStepStatus(step({ status: "fail", name: "get_report" }), [view("get_report", "partial")])).toBe("fail");
  });
});

describe("generic words for a call the app sent no words for", () => {
  it.each([
    ["mcp__sample_app__list_sample_rows", "list sample rows"],
    ["get_sample_report", "get sample report"],
    ["readFile", "read file"],
    ["", "tool"]
  ])("plain words: namespace off, split, lower case: %s → %s", (name, words) => {
    expect(plainToolWords(name)).toBe(words);
  });

  it.each([
    ['List Sample Rows("{\\"level\\":\\"row\\"}")', "List Sample Rows"],
    ['run sample query {"level":"row"}', "run sample query"],
    ["list_sample_rows({\"limit\":5})", "listing sample rows"],
    ["fetch rows [1,2,3]", "fetch rows"]
  ])("a label never carries call arguments or JSON: %s → %s", (name, label) => {
    expect(friendlyStepLabel(name)).toBe(label);
  });

  it("a provider-chosen name never forges a measured duration or the trail's separator", () => {
    const label = friendlyStepLabel("evil (9.9s) :: pwned");
    expect(label).not.toContain("(9.9s)");
    expect(label).not.toContain(" :: ");
    // Brackets that hold words stay (r4 `making 3 creatives (Codex)`).
    expect(friendlyStepLabel("making 3 creatives (Codex)")).toBe("making 3 creatives (Codex)");
  });

  it("a name that is only arguments falls back to a neutral word", () => {
    expect(friendlyStepLabel('{"level":"row"}')).toBe("tool");
  });
});

describe("a call's outcome from its complete frame", () => {
  it("ok, failed and waiting", () => {
    expect(toolOutcome({ status: "ok", summary: "3 rows" })).toEqual({ status: "ok", result: "3 rows" });
    expect(toolOutcome({ status: "error", summary: "refused" })).toEqual({ status: "fail", result: "refused" });
    expect(toolOutcome({ error: "not allowed" })).toEqual({ status: "fail", result: "not allowed" });
    expect(toolOutcome({ status: "requires_confirmation" })).toEqual({ status: "wait", result: "" });
    // A question is not an approval: the row says which of the two it waits for.
    expect(toolOutcome({ status: "needs_clarification" })).toEqual({ status: "wait", result: "waiting for an answer" });
    expect(toolOutcome({ status: "needs_clarification", words: { label: "asking which item" } }))
      .toEqual({ status: "wait", result: "waiting for an answer" });
    expect(toolOutcome({ status: "needs_clarification", words: { label: "asking which item", result: "2 choices" } }))
      .toEqual({ status: "wait", result: "2 choices" });
  });

  it("the app's words win: its result, or none; a failure with no worded result keeps its reason", () => {
    expect(toolOutcome({ status: "ok", summary: "raw summary", words: { label: "checking the catalog", result: "3 rows" } }))
      .toEqual({ status: "ok", result: "3 rows" });
    expect(toolOutcome({ status: "ok", summary: "raw summary", words: { label: "checking the catalog" } }))
      .toEqual({ status: "ok", result: "" });
    expect(toolOutcome({ status: "error", summary: "refused", words: { label: "checking the catalog" } }))
      .toEqual({ status: "fail", result: "refused" });
  });

  it("never returns JSON or control sequences as a result", () => {
    expect(toolOutcome({ status: "ok", summary: '{"rows":3}' }).result).toBe("");
    expect(toolOutcome({ status: "error", error: '[{"code":"x"}]' }).result).toBe("");
    expect(toolOutcome({ status: "ok", summary: "\u001b[31m3 rows\u001b[0m" }).result).toBe("3 rows");
  });

  it("a running call's progress is shown only when it is words", () => {
    expect(stepProgressWords("1 of 3")).toBe("1 of 3");
    expect(stepProgressWords('{"level":"row"}')).toBe("");
    expect(stepProgressWords("list_sample_rows")).toBe("");
    expect(stepProgressWords(undefined)).toBe("");
  });
});

describe("a step that waits (r4 ▣)", () => {
  const view = (tool: string, state: AnswerViewV1["state"]) => ({ tool, state }) as AnswerViewV1;
  const waiting = step({ status: "wait", name: "mcp__app__propose_change", result: "" });

  it("says it is waiting while it has no result of its own", () => {
    expect(strip([waiting])[1]!.map((segment) => segment.text).join("")).toMatch(/▣ waiting for your OK$/u);
    expect(strip([step({ status: "wait", result: "pause 1 item" })])[1]!.map((segment) => segment.text).join("")).toMatch(/▣ pause 1 item$/u);
  });

  it("never says it twice: a row labelled `waiting for your OK` with no result has no result", () => {
    const row = strip([step({ status: "wait", label: "waiting for your OK", result: "" })])[1]!.map((segment) => segment.text).join("");
    expect(row.match(/waiting for your OK/gu)).toHaveLength(1);
    expect(row).toMatch(/▣$/u);
  });

  it("follows the card it waited on: working once the yes is sent, then done, dismissed or failed", () => {
    expect(refineStepStatus(waiting, [])).toBe("wait");
    expect(refineStepStatus(waiting, [view("propose_change", "needs_yes")])).toBe("wait");
    expect(refineStepStatus(waiting, [view("propose_change", "applying")])).toBe("run");
    expect(refineStepStatus(waiting, [view("propose_change", "done")])).toBe("ok");
    expect(refineStepStatus(waiting, [view("propose_change", "cancelled")])).toBe("off");
    expect(refineStepStatus(waiting, [view("propose_change", "expired")])).toBe("off");
    expect(refineStepStatus(waiting, [view("propose_change", "failed")])).toBe("fail");
    expect(refineStepStatus(waiting, [view("propose_change", "outcome_unknown")])).toBe("unk");
    // Two cards of one tool and this call alone: no telling which one it made.
    expect(refineStepStatus(waiting, [view("propose_change", "done"), view("propose_change", "needs_yes")])).toBe("wait");
  });

  it("two calls of one tool follow their own cards, paired in order", () => {
    const first = step({ id: "c1", status: "wait", name: "mcp__app__propose_change", label: "pausing sample A", result: "" });
    const second = step({ id: "c2", status: "wait", name: "mcp__app__propose_change", label: "pausing sample B", result: "" });
    const other = step({ id: "c0", status: "ok", name: "mcp__app__list_sample_rows", label: "listing sample rows", result: "3 rows" });
    const failed = step({ id: "c3", status: "fail", name: "mcp__app__propose_change", label: "pausing sample C", result: "refused" });
    const steps = [other, first, failed, second];
    const views = [view("propose_change", "done"), view("list_sample_rows", "ready"), view("propose_change", "cancelled")];
    expect(refineStepStatus(first, views, steps)).toBe("ok");
    expect(refineStepStatus(second, views, steps)).toBe("off");
    const rows = stepStripLines(steps, { width: 100, color: false, theme, nowMs: 1000, views }).slice(1);
    expect(rows[1]).toMatch(/pausing sample A.*✓$/u);
    expect(rows[2]).toMatch(/pausing sample C.*✗ refused$/u);
    expect(rows[3]).toMatch(/pausing sample B.*·$/u);
    expect(rows.join("\n")).not.toContain("waiting");
    // More calls than cards (or fewer): no telling which is whose, each keeps its own status.
    expect(refineStepStatus(first, [view("propose_change", "done")], steps)).toBe("wait");
    expect(refineStepStatus(second, [...views, view("propose_change", "done")], steps)).toBe("wait");
  });

  it("a step waiting for an answer says so, and stops saying it once its card moved on", () => {
    const asking = step({ status: "wait", name: "mcp__app__ask_which", label: "asking which item", result: "waiting for an answer" });
    const row = (views: AnswerViewV1[]) => stepStripLines([asking], { width: 100, color: false, theme, nowMs: 1000, views })[1]!;
    expect(row([])).toMatch(/▣ waiting for an answer$/u);
    expect(row([view("ask_which", "needs_answer")])).toMatch(/▣ waiting for an answer$/u);
    expect(row([view("ask_which", "done")])).toMatch(/✓$/u);
    expect(row([view("ask_which", "done")])).not.toContain("waiting");
  });

  it("a waiting row that moved on no longer says it is waiting", () => {
    const rows = stepStripLines([waiting], { width: 100, color: false, theme, nowMs: 1000, views: [view("propose_change", "done")] });
    expect(rows[1]).toMatch(/✓$/u);
    expect(rows[1]).not.toContain("waiting");
  });

  it("reads a pending trail line as waiting", () => {
    const messages: Msg[] = [{ kind: "trail", role: "system", text: "", tools: ["Propose Change (0.4s) :: pause 1 item ▣"] }];
    expect(stepsFromTrail(messages).map(({ label, status, result }) => ({ label, status, result }))).toEqual([
      { label: "proposing change", status: "wait", result: "pause 1 item" }
    ]);
  });
});
