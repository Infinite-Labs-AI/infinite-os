import { describe, expect, it } from "vitest";

import { inkStyle, style } from "../style/sgr.js";
import { R4_TOKENS, type Tier, type Token } from "../style/tokens.js";
import { parseAnsiSegments } from "./ansi-segments.js";

// The bridge contract: whatever a token paints as in a string renderer, the
// Ink transcript gets the same look back as Ink props (`inkStyle`). This is
// the bug class where chip backgrounds, underlined links and inverse tabs
// were lost between the renderer and the screen.

const TOKENS = ["", ...Object.keys(R4_TOKENS)] as Token[];
const TIERS: readonly Tier[] = ["truecolor", "256", "16", "mono"];

describe("every token round-trips through the ANSI → Ink bridge", () => {
  for (const tier of TIERS) {
    it(`at the ${tier} tier`, () => {
      for (const token of TOKENS) {
        const segments = parseAnsiSegments(style(" x ", token, tier));
        expect(segments, `${JSON.stringify(token)} @ ${tier}`).toEqual([{ text: " x ", ...inkStyle(token, tier) }]);
      }
    });
  }

  it("layered tokens survive too (a selected row, a link)", () => {
    for (const tier of TIERS) {
      for (const tokens of [["cb", "sel"], ["cyan", "u"], ["green", "sel"]] as Token[][]) {
        expect(parseAnsiSegments(style("row", tokens, tier)), `${tokens.join("+")} @ ${tier}`).toEqual([
          { text: "row", ...inkStyle(tokens, tier) }
        ]);
      }
    }
  });

  it("backgrounds, underline and inverse are all present where the tier paints them", () => {
    const [chip] = parseAnsiSegments(style(" p ", "pk", "truecolor"));
    expect(chip?.backgroundColor).toBe("#e9b44c");
    const [link] = parseAnsiSegments(style("docs ↗", ["cyan", "u"], "256"));
    expect(link?.underline).toBe(true);
    const [mono] = parseAnsiSegments(style(" p ", "pk", "mono"));
    expect(mono?.inverse).toBe(true);
  });
});
