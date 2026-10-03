// Wave 3 r1 (TJ-2, terminal half): a document's markdown section reads as
// text (headings, paragraphs, lists), never its raw source; an image token
// prints only its alt words, never a link or a URL; the live URL is a labelled
// line. Synthetic views only.
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { stripAnsi } from "../lib/text.js";
import { INFINITE_R4_THEME, resolveTheme } from "../theme.js";
import { renderView } from "./registry.js";
import type { ViewRender, ViewRenderCtx } from "./types.js";

const theme = resolveTheme({});

function doc(text: string, extra: Record<string, unknown> = {}): AnswerViewV1 {
  const decoded = decodeAnswerView({
    v: 1, kind: "document", tool: "read_post", title: "Sample post body", state: "ready", asOf: null,
    scope: { workspaceName: "Demo", crossWorkspace: false }, caveats: [],
    body: { meta: [{ label: "Status", value: "Live" }], sections: [{ text, format: "markdown" }], ...extra }
  });
  if (!decoded) throw new Error("test view does not decode");
  return decoded;
}

const ctx = (overrides: Partial<ViewRenderCtx> = {}): ViewRenderCtx => ({
  width: 100, color: false, theme, selected: 0, tab: 0, page: 0, explainOpen: false,
  showHiddenColumns: false, caps: { open: false, watch: false, retry: false }, timeZone: "UTC", ...overrides
});
const lines = (render: ViewRender): string[] => [render.head, render.source ?? "", ...render.detail, ...render.footnotes].map(stripAnsi);

const SOURCE = [
  "# Sample post body",
  "",
  "![A sample jar photo](https://cdn.example.test/jar.png \"jar\")",
  "",
  "Start with **1:8** by weight.",
  "",
  "## What to buy",
  "",
  "- a coarse grinder",
  "- a big jar",
  "",
  "![A pour over a glass](an image on cdn.example.test",
  "",
  "<img src=\"https://cdn.example.test/x.png\" alt=\"A second jar\">"
].join("\n");

describe("a document's markdown reads as text (TJ-2)", () => {
  it("headings, paragraphs and lists draw without their markdown marks", () => {
    const out = lines(renderView(doc(SOURCE), ctx()));
    const body = out.filter((line) => line.startsWith("│"));
    expect(body.some((line) => /│ Sample post body$/u.test(line))).toBe(true);
    expect(body.some((line) => /│ What to buy$/u.test(line))).toBe(true);
    expect(body.some((line) => line.includes("Start with 1:8 by weight."))).toBe(true);
    expect(body.some((line) => /a coarse grinder/u.test(line))).toBe(true);
    for (const line of body) {
      expect(line).not.toMatch(/^│ #|\*\*|^│ - /u);
    }
  });

  it("an image token prints only its alt words: closed, cut short, or as html", () => {
    const out = lines(renderView(doc(SOURCE), ctx())).join("\n");
    expect(out).toContain("A sample jar photo");
    expect(out).toContain("A pour over a glass");
    expect(out).toContain("A second jar");
    expect(out).not.toMatch(/!\[|\]\(|<img|cdn\.example|https?:/u);
  });

  it("an image with no alt words prints nothing at all", () => {
    const out = lines(renderView(doc("Before.\n\n![](https://cdn.example.test/a.png)\n\nAfter."), ctx())).join("\n");
    expect(out).toContain("Before.");
    expect(out).toContain("After.");
    expect(out).not.toMatch(/!\[|https?:|cdn/u);
  });

  it("the live URL is a labelled line, never a bare one", () => {
    const out = lines(renderView(doc("Hello.", { liveUrl: "https://blog.example.test/demo-item" }), ctx()));
    expect(out).toContain("Live: https://blog.example.test/demo-item");
    expect(out).not.toContain("https://blog.example.test/demo-item".padEnd(1));
    expect(out.filter((line) => line.trim() === "https://blog.example.test/demo-item")).toEqual([]);
  });

  it("colour on, the body still carries no markdown marks", () => {
    const out = lines(renderView(doc(SOURCE), ctx({ color: true, theme: INFINITE_R4_THEME }))).join("\n");
    expect(out).not.toMatch(/!\[|\]\(|^│ #/mu);
  });

  for (const width of [48, 60, 80, 100, 140]) {
    it(`every line fits ${width} columns`, () => {
      const out = lines(renderView(doc(SOURCE, { liveUrl: "https://blog.example.test/a/very/long/path/that/goes/on/and/on/demo-item-sample-post-body" }), ctx({ width })));
      for (const line of out) expect(line.length, line).toBeLessThanOrEqual(width);
    });
  }
});
