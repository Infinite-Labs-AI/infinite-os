import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { chip, inkStyle, sgrAttributes, sgrClose, sgrForeground, sgrOpen, sgrParams, style } from "./sgr.js";
import { resolveTier } from "./tier.js";
import { R4_CANVAS, R4_TOKENS, TIERS, TONE_TOKENS, type Tier, type Token } from "./tokens.js";

interface PaletteToken {
  fg?: string;
  bg?: string;
  bold?: boolean;
  underline?: boolean;
  fg_256?: number;
  bg_256?: number;
  design_only?: boolean;
  sgr: Record<Tier, string>;
}

const palette = JSON.parse(readFileSync(new URL("./__fixtures__/palette.json", import.meta.url), "utf8")) as {
  canvas: { bg: string; fg: string };
  tokens: Record<string, PaletteToken>;
};

const printable = Object.entries(palette.tokens).filter(([, spec]) => !spec.design_only) as Array<[Token, PaletteToken]>;
const COLOUR_TIERS = ["truecolor", "256", "16"] as const;
const ESC = "\u001b";
const SGR_RE = /\u001b\[([0-9;]*)m/gu;

/** Every SGR parameter list in a string. */
function sgrs(text: string): string[] {
  return [...text.matchAll(SGR_RE)].map((match) => match[1] ?? "");
}

/** True when a parameter list sets a colour (3x, 4x, 9x, 10x, 38, 48). */
function setsColour(params: string): boolean {
  return params.split(";").some((value) => {
    const code = Number(value);
    return (code >= 30 && code <= 49) || (code >= 90 && code <= 107);
  });
}

describe("the token table is the palette", () => {
  it("has exactly the palette's printable tokens (the design-only one is never printed)", () => {
    expect(["", ...Object.keys(R4_TOKENS)].sort()).toEqual(printable.map(([name]) => name).sort());
    expect(Object.keys(palette.tokens).filter((name) => palette.tokens[name]!.design_only)).toEqual(["mag"]);
    expect(R4_CANVAS).toEqual(palette.canvas);
  });

  it("carries every token's hex, 256 index and attributes", () => {
    for (const [name, spec] of printable) {
      if (name === "") {
        continue;
      }
      const ours = R4_TOKENS[name];
      expect(ours.fg, name).toBe(spec.fg);
      expect(ours.bg, name).toBe(spec.bg);
      expect(ours.bold ?? false, name).toBe(spec.bold ?? false);
      expect(ours.underline ?? false, name).toBe(spec.underline ?? false);
      expect(ours.c256?.fg, name).toBe(spec.fg_256);
      expect(ours.c256?.bg, name).toBe(spec.bg_256);
    }
  });

  for (const tier of ["truecolor", "256", "16", "mono"] as const) {
    it(`emits the palette's SGR for every token at the ${tier} tier`, () => {
      for (const [name, spec] of printable) {
        expect(sgrParams(name, tier), `${JSON.stringify(name)} @ ${tier}`).toBe(spec.sgr[tier]);
      }
    });
  }

  it("prints no escape at the plain tier, and chips keep their width as brackets", () => {
    for (const [name, spec] of printable) {
      const out = style(" k ", name, "plain");
      expect(out, name).not.toContain(ESC);
      expect(out, name).toBe(spec.sgr.plain === "text only" ? " k " : "[k]");
    }
    expect(style(" ∞ Infinite ", "inv", "plain")).toBe("[∞ Infinite]");
    expect(style(" Pause Hook B ", "tag", "plain")).toBe("[Pause Hook B]");
  });

  it("maps every tone to its token, with only the needs-you tone bold", () => {
    expect(TONE_TOKENS).toEqual({ ok: "green", ask: "ab", warn: "amber", bad: "red", busy: "cyan", muted: "dim", cmdl_only: "bb" });
  });
});

describe("style()", () => {
  it("never emits a full reset, at any tier, for any token", () => {
    for (const tier of TIERS) {
      for (const [name] of printable) {
        const out = style("x", name, tier) + chip("p", tier) + chip("p", tier, true);
        expect(sgrs(out).some((params) => params === "" || params.split(";").includes("0")), `${JSON.stringify(name)} @ ${tier}`).toBe(false);
      }
    }
  });

  it("closes with the specific resets for what it opened", () => {
    expect(style("x", "dim", "truecolor")).toBe(`${ESC}[38;2;109;121;134mx${ESC}[39m`);
    expect(style("x", "b", "256")).toBe(`${ESC}[1;38;5;231mx${ESC}[22;39m`);
    expect(style(" p ", "pk", "16")).toBe(`${ESC}[1;30;43m p ${ESC}[22;39;49m`);
    expect(style(" p ", "pk", "mono")).toBe(`${ESC}[1;7m p ${ESC}[22;27m`);
    expect(style("link", ["cyan", "u"], "truecolor")).toBe(`${ESC}[4;38;2;86;200;232mlink${ESC}[24;39m`);
    expect(style("x", "", "truecolor")).toBe(`${ESC}[39mx${ESC}[39m`);
    expect(sgrClose("sel", "truecolor")).toBe(`${ESC}[49m`);
  });

  it("layers tokens: the later colour wins and attributes add up", () => {
    expect(sgrParams(["cb", "sel"], "truecolor")).toBe("1;38;2;86;200;232;48;2;27;47;58");
    expect(sgrParams(["green", "sel"], "256")).toBe("38;5;78;48;5;235");
    expect(sgrParams(["dim", "b"], "16")).toBe("1;97");
  });

  it("a token nested inside a chip keeps the chip's background", () => {
    for (const tier of COLOUR_TIERS) {
      const line = `${sgrOpen("key", tier)} a ${style("x", "dim", tier)} b ${sgrClose("key", tier)}`;
      const afterInner = line.slice(line.indexOf("x") + 1, line.indexOf(" b "));
      expect(sgrs(afterInner), tier).toEqual(["39"]);
    }
  });

  it("returns empty text untouched", () => {
    expect(style("", "pk", "truecolor")).toBe("");
  });

  it("applies foreground overrides at the truecolor tier only", () => {
    expect(sgrParams("cyan", "truecolor", { cyan: "#FF00FF" })).toBe("38;2;255;0;255");
    expect(sgrParams("", "truecolor", { "": "#F0FFFF" })).toBe("38;2;240;255;255");
    expect(sgrParams("cyan", "256", { cyan: "#FF00FF" })).toBe("38;5;81");
    expect(sgrParams("cyan", "truecolor", { cyan: "not a hex" })).toBe("38;2;86;200;232");
  });

  it("switches only the foreground with sgrForeground", () => {
    expect(sgrForeground("b", "truecolor")).toBe(`${ESC}[38;2;255;255;255m`);
    expect(sgrForeground("", "16")).toBe(`${ESC}[39m`);
    expect(sgrForeground("sel", "truecolor")).toBe("");
    expect(sgrForeground("dim", "mono")).toBe("");
  });
});

describe("chip()", () => {
  it("pads the key inside its background, and the OK key is amber", () => {
    expect(chip("p", "truecolor")).toBe(`${ESC}[38;2;255;255;255;48;2;42;52;64m p ${ESC}[39;49m`);
    expect(chip("p", "truecolor", true)).toBe(`${ESC}[1;38;2;10;13;17;48;2;233;180;76m p ${ESC}[22;39;49m`);
    expect(chip("tab", "plain")).toBe("[tab]");
    expect(chip("p", "mono")).toBe(`${ESC}[7m p ${ESC}[27m`);
  });
});

describe("NO_COLOR and TERM=dumb, end to end", () => {
  const tty = { isTTY: true };

  it("NO_COLOR keeps bold, underline and inverse but sets no colour", () => {
    const tier = resolveTier({ NO_COLOR: "1", COLORTERM: "truecolor", TERM: "xterm-256color" }, tty);
    expect(tier).toBe("mono");
    const out = printable.map(([name]) => style(" x ", name, tier)).join("") + chip("p", tier, true);
    expect(sgrs(out).some(setsColour)).toBe(false);
    expect(out).toContain(`${ESC}[1;7m`);
    expect(out).toContain(`${ESC}[4m`);
  });

  it("TERM=dumb prints no escape at all", () => {
    const tier = resolveTier({ TERM: "dumb", COLORTERM: "truecolor" }, tty);
    expect(tier).toBe("plain");
    const out = printable.map(([name]) => style(" x ", name, tier)).join("") + chip("p", tier, true);
    expect(out).not.toContain(ESC);
  });
});

describe("inkStyle()", () => {
  it("resolves colours to the tier, never a raw hex below truecolor", () => {
    expect(inkStyle("dim", "truecolor")).toEqual({ color: "#6d7986" });
    expect(inkStyle("dim", "256")).toEqual({ color: "ansi256(243)" });
    expect(inkStyle("dim", "16")).toEqual({ color: "blackBright" });
    expect(inkStyle("dim", "mono")).toEqual({});
    expect(inkStyle("pk", "truecolor")).toEqual({ color: "#0a0d11", backgroundColor: "#e9b44c", bold: true });
    expect(inkStyle("pk", "256")).toEqual({ color: "ansi256(232)", backgroundColor: "ansi256(179)", bold: true });
    expect(inkStyle("pk", "16")).toEqual({ color: "black", backgroundColor: "yellow", bold: true });
    expect(inkStyle("pk", "mono")).toEqual({ bold: true, inverse: true });
    expect(inkStyle("key", "16")).toEqual({ color: "whiteBright", backgroundColor: "blackBright" });
    expect(inkStyle(["cyan", "u"], "256")).toEqual({ color: "ansi256(81)", underline: true });
    expect(inkStyle("", "truecolor")).toEqual({});
    for (const [name] of printable) {
      expect(inkStyle(name, "plain"), name).toEqual({});
    }
  });

  it("spells named colours the vendored Ink's way when it draws", () => {
    expect(inkStyle("key", "16", { form: "infinite" })).toEqual({ color: "ansi:whiteBright", backgroundColor: "ansi:blackBright" });
    expect(inkStyle("dim", "256", { form: "infinite" })).toEqual({ color: "ansi256(243)" });
  });
});

describe("sgrAttributes()", () => {
  it("adds bold, underline and inverse one escape each, and ends exactly those", () => {
    expect(sgrAttributes({ bold: true, inverse: true }, "truecolor")).toEqual({ open: `${ESC}[1m${ESC}[7m`, close: `${ESC}[22;27m` });
    expect(sgrAttributes({ underline: true }, "mono")).toEqual({ open: `${ESC}[4m`, close: `${ESC}[24m` });
    expect(sgrAttributes({ bold: true }, "plain")).toEqual({ open: "", close: "" });
    expect(sgrAttributes({}, "256")).toEqual({ open: "", close: "" });
  });
});
