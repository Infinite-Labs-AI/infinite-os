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
  refineStepStatus,
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
    ["mcp__infinite_app__list_meta_entities", "listing meta entities"],
    ["mcp__infinite_app__get_meta_performance", "getting meta performance"],
    ["propose_pause_entity", "proposing pause entity"],
    ["run_breakdown_query", "running breakdown query"],
    ["readFile", "reading file"],
    ["seo_queue_draft", "seo queue draft"]
  ])("%s → %s", (name, label) => {
    expect(friendlyStepLabel(name)).toBe(label);
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
      { label: "listing meta entities", status: "ok", startedAt: 0, endedAt: 500, result: "3 ads" },
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
