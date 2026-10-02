import { describe, expect, it } from "vitest";

import { r4Segments, seg } from "../../formatting/r4-segments.test-util.js";
import { INFINITE_R4_THEME } from "../theme.js";
import type { Msg } from "../types.js";
import { detailsPaneWidth, layoutTurn, renderCommittedTurn, renderLiveTurn } from "./layout.js";
import type { ViewRender } from "./types.js";

// The r4 frame body (terminal-r4 `frame()` + River's layout decision): side by
// side from 120 columns, one column below. Synthetic data only.
const theme = INFINITE_R4_THEME;
const view = (over: Partial<ViewRender> = {}): ViewRender => ({
  head: " Ads running  ✓ Ready", source: "Demo · up to Sep 30", detail: ["row one", "row two"], footnotes: [], keys: [], okKey: null, rowCount: 0, ...over
});
const messages: Msg[] = [
  { role: "user", text: "which ads are on?" },
  { role: "assistant", text: "Two are on, and both are spending at their usual pace this week." }
];

describe("the frame body", () => {
  it("one column below 120: answer, a blank, a line rule, the details, a blank, then the Steps", () => {
    const lines = layoutTurn(["❯ q", "", "∞ a"], view(), ["  step"], 100);
    expect(lines).toEqual(["❯ q", "", "∞ a", "", "─".repeat(100), " Ads running  ✓ Ready", "Demo · up to Sep 30", "", "row one", "row two", "", `─ Steps ${"─".repeat(92)}`, "  step"]);
  });

  it("side by side from 120: the answer pane padded to 33, the separator in line, an empty details row ends at the bar", () => {
    const lines = layoutTurn(["❯ q", "", "∞ a", "  more", "  and more", "  last"], view(), [], 120, { color: true, theme });
    expect(r4Segments(lines[0]!)).toEqual(seg([`❯ q${" ".repeat(31)}`, ""], ["│", "line"], ["  Ads running  ✓ Ready", ""]));
    expect(r4Segments(lines[2]!)).toEqual(seg([`∞ a${" ".repeat(31)}`, ""], ["│", "line"]));
    expect(r4Segments(lines[5]!)).toEqual(seg([`  last${" ".repeat(28)}`, ""], ["│", "line"]));
  });

  it("wraps the answer pane at its width less one (r4 `wrap(…, lw − 1)`)", () => {
    const lines = renderLiveTurn({ messages, views: [], focus: null, width: 160, color: false, theme, details: ["┌─ card ─┐"] }).lines;
    const left = lines.map((line) => line.slice(0, 40).trimEnd());
    expect(left[0]).toBe("❯ which ads are on?");
    expect(left[2]).toBe("∞ Two are on, and both are spending at");
    expect(left.every((line) => line.length <= 39)).toBe(true);
  });
});

describe("what takes the details pane", () => {
  it("a pending card handed in sits right of the answer from 120, under it below", () => {
    const card = ["┌─ Pause ad? ─┐", "│ status      │", "└─────────────┘"];
    expect(detailsPaneWidth(160)).toBe(117);
    expect(detailsPaneWidth(100)).toBe(100);
    const wide = renderLiveTurn({ messages, views: [], focus: null, width: 160, color: false, theme, details: card }).lines;
    expect(wide[0]).toBe(`❯ which ads are on?${" ".repeat(21)} │ ┌─ Pause ad? ─┐`);
    const narrow = renderLiveTurn({ messages, views: [], focus: null, width: 100, color: false, theme, details: card }).lines;
    expect(narrow.slice(-3)).toEqual(card);
    expect(narrow.some((line) => line.includes(" │ "))).toBe(false);
  });

  it("a quiet view with a head (r4 `steps only`) is a details pane; without one it prints with the Steps", () => {
    const headed = view({ head: "steps only", source: "", detail: ["The draft is in the answer."], quiet: true });
    const wide = layoutTurn(["∞ a"], headed, [], 120);
    expect(wide.slice(0, 4).map((line) => line.slice(33))).toEqual([" │ steps only", " │", " │", " │ The draft is in the answer."]);
    const bare = layoutTurn(["∞ a"], view({ head: "", source: null, detail: ["read the playbook"], quiet: true }), [], 120);
    expect(bare).toEqual(["∞ a", `─ Steps ${"─".repeat(112)}`, "  read the playbook"]);
  });
});

describe("a committed turn keeps every message the transcript draws (one renderer for both)", () => {
  const turn: Msg[] = [
    { role: "user", text: "fix the import" },
    { kind: "trail", role: "system", text: "", todos: [{ id: "t1", content: "Check the import path", status: "in_progress" }] },
    { role: "assistant", title: "Infinite — Acme", text: "Changed one line." },
    { kind: "diff", role: "tool", text: "--- a/x.ts\n+++ b/x.ts\n-old line\n+new line" }
  ];

  it("keeps the project label, the diff's colours and the trail's todos", () => {
    const lines = renderCommittedTurn({ messages: turn, views: [], focus: null, width: 80, color: true, theme });
    const segments = lines.map((line) => r4Segments(line));
    const has = (text: string, style: string) => segments.some((row) => row.some((part) => part.text.includes(text) && part.style === style));
    expect(has("Infinite — Acme", "dim")).toBe(true);
    expect(has("- old line", "red")).toBe(true);
    expect(has("+ new line", "green")).toBe(true);
    expect(lines.some((line) => line.includes("Check the import path"))).toBe(true);
  });

  it("draws the same answer column live", () => {
    const lines = renderLiveTurn({ messages: turn, views: [], focus: null, width: 80, color: false, theme }).lines;
    expect(lines).toContain("Δ diff");
    expect(lines.some((line) => line.includes("Check the import path"))).toBe(true);
    expect(lines.some((line) => line.includes("Infinite — Acme"))).toBe(true);
  });
});
