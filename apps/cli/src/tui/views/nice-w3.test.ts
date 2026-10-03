// Wave 3 r1 per-screen nits (TJ-13 and the W3 screens): a list's label column
// takes the free width before it is cut; a card row wraps under its value with
// a hanging indent; a URL wraps at its separators; a compare's range method is
// behind `?` and a difference's unit follows the sole measure; a link preview
// copies its tagged URL. Synthetic views only.
import { readFileSync } from "node:fs";
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { displayWidth } from "../lib/display-width.js";
import { stripAnsi } from "../lib/text.js";
import { resolveTheme } from "../theme.js";
import { fieldRows, wrapUrl } from "./card.js";
import { viewFocusAfterTurnDone } from "./focus.js";
import { documentListLines } from "./launch.js";
import { renderLiveTurn } from "./layout.js";
import { renderView } from "./registry.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

const theme = resolveTheme({});
const plain = { color: false, theme };

function decode(raw: Record<string, unknown>): AnswerViewV1 {
  const view = decodeAnswerView({ v: 1, asOf: null, state: "ready", scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [], ...raw });
  if (!view) throw new Error("test view does not decode");
  return view;
}
const ctx = (overrides: Partial<ViewRenderCtx> = {}): ViewRenderCtx => ({
  width: 100, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps: { open: false, watch: false, retry: false }, timeZone: "UTC", ...overrides
});
const lines = (render: ViewRender): string[] => [render.head, render.source ?? "", ...render.detail, ...render.footnotes].map(stripAnsi);

describe("a list's label column takes the free width first (TJ-13, W3-list-ready)", () => {
  const people = decode({
    kind: "list", tool: "list_people", title: "Registrations",
    body: {
      layout: "rows",
      columns: [{ key: "name", label: "Name" }, { key: "site", label: "Website" }, { key: "from", label: "Came from" }],
      rows: [
        { id: "u1", title: "ana@example.test", cells: { name: { text: "Ana Exampl" }, site: { text: "ana.example.test" }, from: { text: "facebook · paid · fall-launch · ad “Founder video A”" } } },
        { id: "u2", title: "No email on this record", cells: { name: { text: null, reason: { code: "x", words: "no name", show: "dash" } }, site: { text: null, reason: { code: "y", words: "no site", show: "dash" } }, from: { text: null, reason: { code: "z", words: "none", show: "dash" } } } }
      ]
    }
  });

  for (const width of [100, 140]) {
    it(`the long text column gives way before the label is cut (${width} columns)`, () => {
      const out = lines(renderView(people, ctx({ width })));
      expect(out.some((line) => line.includes("No email on this record")), out.join("\n")).toBe(true);
      for (const line of out) expect(displayWidth(line), line).toBeLessThanOrEqual(width);
    });
  }
});

describe("card rows and URLs wrap where a reader expects (W3-ap-send, W3-ap-link)", () => {
  it("a URL wraps after / ? & = ., never inside a word", () => {
    const url = "https://shop.example.test/pricing?utm_source=newsletter&utm_medium=email&utm_campaign=harvest-launch";
    const rows = wrapUrl(url, 30);
    expect(rows.join("")).toBe(url);
    for (const row of rows) {
      expect(displayWidth(row)).toBeLessThanOrEqual(30);
      expect(row).toMatch(/[/?&=.]$|launch$/u);
    }
  });

  it("a card's URL row wraps at its separators under its value column", () => {
    const out = fieldRows([{ label: "to", value: "https://shop.example.test/pricing?utm_source=newsletter&utm_medium=email&utm_campaign=harvest-launch" }], 56, plain);
    expect(out.length).toBeGreaterThan(1);
    for (const line of out.slice(1)) expect(line.startsWith("         ")).toBe(true);
    expect(out.map((line) => line.trim()).join("").replace(/^to\s*/u, "")).toBe("https://shop.example.test/pricing?utm_source=newsletter&utm_medium=email&utm_campaign=harvest-launch");
  });

  it("a numbered draft row wraps under its words, never under its number (60 columns)", () => {
    const out = documentListLines([{ slot: "Draft 1", subject: "Thanks for signing up, can I take fifteen minutes of your time?" }], { ...ctx(), width: 56 });
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toMatch(/^1 {2}Draft 1/u);
    for (const line of out.slice(1)) expect(line.startsWith("   ")).toBe(true);
  });
});

describe("compare (W3-cmp-youtube, W3-cmp-analysis)", () => {
  const view = decode({
    kind: "compare", tool: "read_test", title: "Thumbnail test", explain: "Two versions shown to the same audience.",
    body: {
      window: { from: "2026-01-01", to: "2026-01-14", tz: "UTC", label: "Since Jan 1" }, armLabel: "Version",
      arms: [
        { key: "a", label: "Original", n: 5000, metrics: { ctr: { value: 1.5 } } },
        { key: "b", label: "New", n: 5000, metrics: { ctr: { value: 2.5 } } }
      ],
      metricRows: [{ key: "ctr", label: "CTR", unit: "percent" }],
      differences: [{ label: "Gap", against: "a", absolute: { value: 1 }, relative: { value: null, reason: { code: "n", words: "a gap in points", show: "dash" } }, method: "two gates then a p-value" }],
      verdict: { grade: "supported", namesWinner: false }
    }
  });

  it("the range method is behind ?", () => {
    expect(lines(renderView(view, ctx())).join("\n")).not.toContain("Range method");
    expect(lines(renderView(view, ctx({ explainOpen: true }))).join("\n")).toContain("Range method: two gates then a p-value");
  });

  it("with no explain of its own, ? is still offered, so the range method can be seen (R-IOV-6)", () => {
    const bare = { ...view, explain: undefined } as unknown as AnswerViewV1;
    const state = viewFocusAfterTurnDone(bare);
    expect(state.facts.explain).toBe(true);
    expect(lines(renderView(bare, ctx({ explainOpen: true }))).join("\n")).toContain("Range method: two gates then a p-value");
    const noMethod = { ...view, explain: undefined, body: { ...(view.body as unknown as Record<string, unknown>), differences: [] } } as unknown as AnswerViewV1;
    expect(viewFocusAfterTurnDone(noMethod).facts.explain).toBe(false);
  });

  it("a difference with no named metric takes the sole measure's unit", () => {
    const out = lines(renderView(view, ctx())).join("\n");
    expect(out).toMatch(/Gap[^\n]*\+1%/u);
  });
});

describe("a link preview copies its tagged URL (W3-link-preview)", () => {
  const preview = decode({
    kind: "link", tool: "preview_link", title: "Link preview", state: "preview",
    body: {
      target: "url", minted: false, opened: false, url: "https://shop.example.test/",
      finalUrl: "https://shop.example.test/?utm_source=social&utm_medium=bio&utm_campaign=evergreen",
      utm: { source: "social", medium: "bio", campaign: "evergreen" }, warnings: []
    }
  });

  it("c copies the tagged URL; no bare base-URL line above the rows", () => {
    const render = renderView(preview, ctx());
    expect(render.copyText).toBe("https://shop.example.test/?utm_source=social&utm_medium=bio&utm_campaign=evergreen");
    expect(lines(render).filter((line) => line.trim() === "https://shop.example.test/")).toEqual([]);
    expect(lines(render).some((line) => /^to +https:\/\/shop\.example\.test\/\?utm_source/u.test(line))).toBe(true);
  });

  for (const width of [48, 60, 100]) {
    it(`fits ${width} columns`, () => {
      for (const line of lines(renderView(preview, ctx({ width })))) expect(displayWidth(line), line).toBeLessThanOrEqual(width);
    });
  }
});

describe("images never draw a picture or a URL (sweep)", () => {
  const FIXTURES = new URL("./__fixtures__/", import.meta.url);
  const read = (name: string): AnswerViewV1 =>
    decodeAnswerView(JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")))!;
  for (const name of ["images-done", "images-codex"]) {
    for (const width of [48, 60, 80, 100, 140]) {
      it(`${name} at ${width} columns: no http, no data URI, every line fits`, () => {
        const out = lines(renderView(read(name), ctx({ width, caps: { open: true, watch: true, retry: false } })));
        expect(out.join("\n")).not.toMatch(/https?:|data:image|\.png|\.jpe?g/iu);
        // On screen (the turn's layout), every line fits.
        const turn = renderLiveTurn({ messages: [{ role: "user", text: "make them" }], views: [read(name)], focus: null, width, color: false, theme, caps: { open: true, watch: true, retry: false } }).lines;
        for (const line of turn) expect(displayWidth(stripAnsi(line)), line).toBeLessThanOrEqual(width);
      });
    }
  }
});
