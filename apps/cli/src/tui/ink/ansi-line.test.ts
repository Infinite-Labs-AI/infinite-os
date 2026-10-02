import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import React from "react";

import { parseAnsiSegments, type AnsiSegment } from "../lib/ansi-segments.js";
import { chip, style } from "../style/sgr.js";
import type { Tier } from "../style/tokens.js";
import { renderToString } from "./renderer.js";
import { AnsiLine } from "./transcript-app.js";

// Ink paints through chalk, and a test worker is not a TTY, so chalk's level
// is 0 here. chalk is one instance per process (Node caches it), so set the
// level on the very instance stock Ink imports, and put it back afterwards.
type Chalk = { level: number };
let inkChalk: Chalk;
let previousLevel = 0;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const chalkPath = createRequire(require.resolve("ink")).resolve("chalk");
  inkChalk = ((await import(pathToFileURL(chalkPath).href)) as { default: Chalk }).default;
  previousLevel = inkChalk.level;
  inkChalk.level = 3;
});

afterAll(() => {
  inkChalk.level = previousLevel;
});

/** The style of every character, so two renders compare cell by cell whatever their escape layout. */
function cells(segments: readonly AnsiSegment[]): string[] {
  return segments.flatMap(({ text, ...look }) => [...text].map((char) => `${char} ${JSON.stringify(look, Object.keys(look).sort())}`));
}

function throughInk(line: string): string {
  return renderToString(React.createElement(AnsiLine, { line }), { columns: 120 });
}

/** A line with every r4 look the bridge used to drop: chip backgrounds, a bold label, an underlined link, a selected row. */
function sample(tier: Tier): string {
  return [
    chip("p", tier, true),
    " ",
    style("Pause", "b", tier),
    "   ",
    chip("n", tier),
    " dismiss  ",
    style("open in the app ↗", ["cyan", "u"], tier),
    " ",
    style("▸ ", ["cb", "sel"], tier),
    style("Ad set 01", ["b", "sel"], tier),
    " ",
    style(" ∞ Infinite ", "inv", tier),
    " ",
    style("label", "dim", tier)
  ].join("");
}

describe("AnsiLine draws what the renderer painted", () => {
  for (const tier of ["truecolor", "256", "16", "mono"] as const) {
    it(`keeps every cell's look at the ${tier} tier`, () => {
      const line = sample(tier);
      expect(cells(parseAnsiSegments(throughInk(line)))).toEqual(cells(parseAnsiSegments(line)));
    });
  }

  it("puts chip backgrounds, underline and inverse on screen", () => {
    expect(throughInk(chip("p", "truecolor", true))).toContain("48;2;233;180;76");
    expect(throughInk(style("docs ↗", ["cyan", "u"], "256"))).toContain("\u001b[4m");
    expect(throughInk(chip("p", "mono", true))).toContain("\u001b[7m");
    expect(throughInk(style("row", "sel", "16"))).toContain("\u001b[100m");
  });

  it("prints a plain line as it is", () => {
    expect(throughInk("[p] Pause")).toBe("[p] Pause");
  });
});
