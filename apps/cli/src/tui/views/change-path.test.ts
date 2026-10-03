// Wave 3 r1 (TJ-7): a change target's path is cut from its OUTER parts first,
// so the nearest parent (the ad set) keeps its leading words; and a row with
// no new value that shows its reason as words prints the words, never
// `set to`. Synthetic views only.
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { displayWidth } from "../lib/display-width.js";
import { stripAnsi } from "../lib/text.js";
import { resolveTheme } from "../theme.js";
import { targetPathLine } from "./change.js";
import { renderView } from "./registry.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

const theme = resolveTheme({});
const plain = { color: false, theme };
const OUTER = "Spring trials · prospecting · broad audiences";
const NEAREST = "Broad · US 21+ · 2026-09-23 — test_b1_broad_v2";
const body = (path: string[]) => ({ target: { kind: "ad", id: "a1", label: "Hook B", path } });

describe("targetPathLine cuts the outer parts first (TJ-7)", () => {
  it("a path that fits prints whole", () => {
    expect(targetPathLine(body(["Spring", "Broad"]), 60, plain)).toBe("Spring › Broad");
  });

  it("the nearest parent stays whole while the outer part is cut", () => {
    const line = targetPathLine(body([OUTER, NEAREST]), 72, plain)!;
    expect(displayWidth(line)).toBeLessThanOrEqual(72);
    expect(line.endsWith(` › ${NEAREST}`)).toBe(true);
    expect(line.startsWith("Spring")).toBe(true);
    expect(line).toContain("…");
  });

  it("with three parts, each outer part gets a fair share before any goes", () => {
    const line = targetPathLine(body(["Account one with a long name", OUTER, NEAREST]), 90, plain)!;
    expect(displayWidth(line)).toBeLessThanOrEqual(90);
    expect(line.endsWith(` › ${NEAREST}`)).toBe(true);
    expect(line.split(" › ")).toHaveLength(3);
  });

  it("too narrow for the outer parts: they fold to … and the nearest parent keeps its leading words", () => {
    const line = targetPathLine(body([OUTER, NEAREST]), 40, plain)!;
    expect(displayWidth(line)).toBeLessThanOrEqual(40);
    expect(line.startsWith("… › Broad · US 21+")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
  });

  for (const width of [12, 20, 48, 60, 80, 100, 140]) {
    it(`never wider than ${width} columns, and never loses the nearest parent's first word`, () => {
      const line = targetPathLine(body(["A", OUTER, NEAREST]), width, plain)!;
      expect(displayWidth(line)).toBeLessThanOrEqual(width);
      if (width >= 12) expect(line).toContain("Bro");
    });
  }
});

function change(raw: Record<string, unknown>): AnswerViewV1 {
  const decoded = decodeAnswerView({
    v: 1, kind: "change", tool: "pause_item", title: "Pause Hook B", state: "no_change", asOf: null,
    provenance: { source: "Ads · ad", via: "our_db" },
    scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
    stateReason: { code: "already", words: "Our stored copy shows Hook B already paused." },
    body: { target: { kind: "ad", id: "a1", label: "Hook B", path: [OUTER, NEAREST] }, rows: [] },
    ...raw
  });
  if (!decoded) throw new Error("test view does not decode");
  return decoded;
}

const ctx = (overrides: Partial<ViewRenderCtx> = {}): ViewRenderCtx => ({
  width: 100, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps: { open: false, watch: false, retry: false }, timeZone: "UTC", ...overrides
});
const lines = (render: ViewRender): string[] => [render.head, render.source ?? "", ...render.detail].map(stripAnsi);

describe("the no_change head's path line (TJ-7, flow-pause-05)", () => {
  for (const width of [48, 60, 80, 100, 140]) {
    it(`keeps the ad set's leading words at ${width} columns`, () => {
      const out = lines(renderView(change({}), ctx({ width })));
      const path = out.find((line) => line.includes(" › "))!;
      expect(path).toContain("Broad");
      for (const line of out) expect(displayWidth(line), line).toBeLessThanOrEqual(width);
    });
  }
});

describe("a row with no new value shows its reason's words (write_theme_files)", () => {
  it("`show: words` prints the words directly, never `set to`", () => {
    const view = change({
      state: "needs_yes", stateReason: undefined,
      body: { target: { kind: "theme", label: "Dawn" }, rows: [{ label: "header.liquid", after: null, reason: { code: "kept", words: "kept as it is", show: "words" } }] }
    });
    const out = lines(renderView(view, ctx())).join("\n");
    expect(out).toContain("kept as it is");
    expect(out).not.toContain("set to");
  });
});
