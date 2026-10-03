// Wave 3 r1 (TJ-12, W3-job-running, W3-job-done): a job's command output is
// clipped per line and capped at 6 rows, its gutter on every row; the
// command prints once; `Lands in:` names the place; a job that is done no
// longer says it keeps going; a running job says how long it has run.
// Synthetic views only.
import type { AnswerViewV1 } from "@infinite-os/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { stripAnsi } from "../lib/text.js";
import { resolveTheme } from "../theme.js";
import { renderView } from "./registry.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

const theme = resolveTheme({});

function job(body: Record<string, unknown>, extra: Record<string, unknown> = {}): AnswerViewV1 {
  const decoded = decodeAnswerView({
    v: 1, kind: "job", tool: "run_command", title: "$ convert", state: "background", asOf: null,
    scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
    body: { jobId: "j1", label: "Converting", phase: "running", steps: [], runsWhere: "this_mac", outlivesTurn: true, noCompletionSignal: false, ...body },
    ...extra
  });
  if (!decoded) throw new Error("test view does not decode");
  return decoded;
}

const ctx = (overrides: Partial<ViewRenderCtx> = {}): ViewRenderCtx => ({
  width: 100, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps: { open: false, watch: false, retry: false }, timeZone: "UTC", ...overrides
});
const lines = (render: ViewRender): string[] => [render.head, render.source ?? "", ...render.detail, ...render.footnotes].map(stripAnsi);

const ARGV = ["convert", "-i", "assets/clip.mp4", "out/clip.gif"];
const FAILED = job({
  label: ARGV.join(" "), phase: "failed",
  command: {
    argv: ARGV, exitCode: 1, signal: null, endedBy: "exit", stdoutTail: "",
    stderrTail: [`${"x".repeat(2000)}`, "line two", "line three", "line four", "line five", "line six", "line seven", "clip.mp4: Invalid data found when processing input"].join("\n"),
    truncated: true
  }
}, { state: "failed", stateReason: { code: "exit_code", words: "It exited with code 1." } });

describe("command output (TJ-12)", () => {
  for (const width of [48, 60, 80, 100, 140]) {
    it(`each line clipped with …, at most 6 rows, │ on every row (${width} columns)`, () => {
      const out = lines(renderView(FAILED, ctx({ width })));
      const block = out.filter((line) => line.startsWith("│"));
      expect(block.length).toBeLessThanOrEqual(6);
      // The app had already cut this output (truncated): the count is a floor, never exact (R-IOV-5).
      expect(block.some((line) => /^│ … \d+\+ more lines$/u.test(line))).toBe(true);
      // The last lines are what matter for an error: they stay.
      expect(block.at(-1)).toContain("Invalid data found");
      expect(block.find((line) => line.startsWith("│ xxx"))?.endsWith("…") ?? true).toBe(true);
      for (const line of out) expect(line.length, line).toBeLessThanOrEqual(width);
      // Every output row keeps its gutter: no bare continuation row of the long line.
      expect(out.some((line) => /^x{5}/u.test(line))).toBe(false);
    });
  }

  it("the command prints once", () => {
    const out = lines(renderView(FAILED, ctx())).join("\n");
    expect(out.split("convert -i assets/clip.mp4 out/clip.gif").length - 1).toBe(1);
    expect(out).toContain("$ convert -i assets/clip.mp4 out/clip.gif");
  });

  const lines10 = Array.from({ length: 10 }, (_unused, index) => `line ${index + 1}`).join("\n");
  const tail = (truncated: boolean, stderrTail = lines10) => job({
    phase: "failed", command: { argv: ARGV, exitCode: 1, signal: null, endedBy: "exit", stdoutTail: "", stderrTail, truncated }
  }, { state: "failed" });

  it("an output the app had cut never claims an exact count of what is missing (R-IOV-5)", () => {
    const block = lines(renderView(tail(true), ctx())).filter((line) => line.startsWith("│"));
    expect(block).toHaveLength(6);
    expect(block[0]).toBe("│ … 5+ more lines");
    expect(block.at(-1)).toBe("│ line 10");
  });

  it("an output the terminal alone cut says the exact count", () => {
    const block = lines(renderView(tail(false), ctx())).filter((line) => line.startsWith("│"));
    expect(block[0]).toBe("│ … 5 more lines");
  });

  it("an output the app had cut to exactly 6 lines still says something is missing, within 6 rows", () => {
    const six = Array.from({ length: 6 }, (_unused, index) => `line ${index + 1}`).join("\n");
    const block = lines(renderView(tail(true, six), ctx())).filter((line) => line.startsWith("│"));
    expect(block).toHaveLength(6);
    expect(block[0]).toBe("│ … 1+ more lines");
    expect(block.at(-1)).toBe("│ line 6");
  });

  it("a short output the app had cut keeps its │ … marker", () => {
    const block = lines(renderView(tail(true, "one\ntwo"), ctx())).filter((line) => line.startsWith("│"));
    expect(block).toEqual(["│ …", "│ one", "│ two"]);
  });

  it("a short output prints whole, with no 'more' line", () => {
    const short = job({ phase: "failed", command: { argv: ARGV, exitCode: 1, signal: null, endedBy: "exit", stdoutTail: "", stderrTail: "one\ntwo" } }, { state: "failed" });
    const block = lines(renderView(short, ctx())).filter((line) => line.startsWith("│"));
    expect(block).toEqual(["│ one", "│ two"]);
  });
});

describe("where it lands, and whether it keeps going (W3-job-done)", () => {
  const done = job({
    label: "A note", phase: "done", runsWhere: "this_mac_app_open", outlivesTurn: true, noCompletionSignal: true,
    steps: [{ id: "a", label: "Ask recorded", state: "done" }, { id: "b", label: "You approve the send", state: "todo" }],
    landsAt: { place: "email.campaign", label: "Open in Email Campaigns", params: { actionId: "x1" } }
  }, { state: "done", outcome: "applied" });

  it("Lands in: names the place, never 'Open in' twice", () => {
    const out = lines(renderView(done, ctx())).join("\n");
    expect(out).toContain("Lands in: Email Campaigns");
    expect(out).not.toContain("Lands in: Open in");
  });

  it("a done or failed job no longer says it keeps going while you chat", () => {
    expect(lines(renderView(done, ctx())).join("\n")).not.toContain("keeps going while you chat");
    expect(lines(renderView(FAILED, ctx())).join("\n")).not.toContain("keeps going while you chat");
  });
});

describe("how long it has run (W3-job-running)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:42:03Z"));
  });
  afterEach(() => vi.useRealTimers());

  const running = (extra: Record<string, unknown> = {}) => job({
    label: "Writing the post", phase: "running", runsWhere: "cloud",
    steps: [{ id: "a", label: "Outline", state: "done" }, { id: "b", label: "Draft", state: "now" }],
    progress: { finished: 1, of: 2 }, startedAt: "2026-01-15T10:40:00Z", ...extra
  });

  it("says the time so far, and the usual time when the job knows it", () => {
    expect(lines(renderView(running(), ctx())).join("\n")).toContain("2:03 so far · keeps going while you chat");
    expect(lines(renderView(running({ etaMs: 240_000 }), ctx())).join("\n")).toContain("2:03 so far · usually about 4 min · keeps going while you chat");
  });

  it("no start time, no clock", () => {
    expect(lines(renderView(running({ startedAt: null }), ctx())).join("\n")).not.toContain("so far");
  });
});
