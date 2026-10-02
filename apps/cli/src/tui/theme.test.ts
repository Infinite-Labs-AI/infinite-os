import { describe, expect, it } from "vitest";

import { style } from "./style/sgr.js";
import {
  ROLE_TOKENS,
  DEFAULT_THEME,
  INFINITE_NEON_THEME,
  ansi,
  ansiFg,
  colorEnabled,
  resolveTheme,
  themeInkStyle,
  type AnsiRole
} from "./theme.js";

const ESC = "\u001b";
const truecolor = { COLORTERM: "truecolor" };

describe("the old theme roles are aliases over the r4 tokens", () => {
  it("maps every role to its token", () => {
    expect(ROLE_TOKENS).toEqual({
      primary: "cyan",
      primaryBright: "b",
      text: "",
      muted: "dim",
      success: "green",
      warning: "amber",
      error: "red",
      line: "line",
      ask: "ab",
      link: ["cyan", "u"],
      hatch: "hatch",
      blue: "blue",
      cmdl: "bb"
    });
  });

  it("paints each role exactly as its token, closing with specific resets", () => {
    for (const role of Object.keys(ROLE_TOKENS) as AnsiRole[]) {
      expect(ansi(DEFAULT_THEME, role, "x"), role).toBe(style("x", ROLE_TOKENS[role], "truecolor"));
    }
    expect(ansi(DEFAULT_THEME, "muted", "x")).toBe(`${ESC}[38;2;109;121;134mx${ESC}[39m`);
    expect(ansi(DEFAULT_THEME, "muted", "x", false)).toBe("x");
    expect(ansi(DEFAULT_THEME, "pk", " p ")).toBe(style(" p ", "pk", "truecolor"));
  });

  it("never closes with a full reset", () => {
    for (const role of Object.keys(ROLE_TOKENS) as AnsiRole[]) {
      expect(ansi(DEFAULT_THEME, role, "x"), role).not.toMatch(/\u001b\[0?m/u);
    }
  });

  it("switches only the foreground with ansiFg", () => {
    expect(ansiFg(DEFAULT_THEME, "primary")).toBe(`${ESC}[38;2;86;200;232m`);
    expect(ansiFg(DEFAULT_THEME, "primaryBright")).toBe(`${ESC}[38;2;255;255;255m`);
    expect(ansiFg(DEFAULT_THEME, "text")).toBe(`${ESC}[39m`);
    expect(ansiFg(resolveTheme({ TERM: "xterm-256color" }), "muted")).toBe(`${ESC}[38;5;243m`);
    expect(ansiFg(resolveTheme({ NO_COLOR: "1" }), "muted")).toBe("");
  });
});

describe("resolveTheme picks the tier", () => {
  it("defaults to the r4 colours at truecolor", () => {
    const theme = resolveTheme(truecolor);
    expect(theme.tier).toBe("truecolor");
    expect(theme.color.primary).toBe("#56c8e8");
    expect(theme.color.muted).toBe("#6d7986");
    expect(theme.color.line).toBe("#3a4653");
    expect(theme.color.success).toBe("#6fd08c");
    expect(theme.color.warning).toBe("#e9b44c");
    expect(theme.color.error).toBe("#ef6b73");
    expect(theme.color.text).toBe("");
    expect(DEFAULT_THEME.tier).toBe("truecolor");
    expect(DEFAULT_THEME.color).toEqual(theme.color);
  });

  it("hands Ink 256 indices at the 256 tier, never a hex chalk would re-quantize", () => {
    const theme = resolveTheme({ TERM: "xterm-256color" });
    expect(theme.tier).toBe("256");
    expect(theme.color.muted).toBe("ansi256(243)");
    expect(theme.color.primary).toBe("ansi256(81)");
    expect(Object.values(theme.color).some((value) => value.startsWith("#"))).toBe(false);
  });

  it("hands Ink named colours at the 16 tier", () => {
    const theme = resolveTheme({ TERM: "xterm" });
    expect(theme.tier).toBe("16");
    expect(theme.color.muted).toBe("blackBright");
    expect(theme.color.primary).toBe("cyan");
  });

  it("gives Ink no colour at all under NO_COLOR, and keeps attributes", () => {
    const theme = resolveTheme({ NO_COLOR: "1", COLORTERM: "truecolor" });
    expect(theme.tier).toBe("mono");
    expect(Object.values(theme.color).every((value) => value === "")).toBe(true);
    expect(colorEnabled(theme)).toBe(true);
    expect(ansi(theme, "primaryBright", "x")).toBe(`${ESC}[1mx${ESC}[22m`);
    expect(ansi(theme, "muted", "x")).toBe("x");
    expect(themeInkStyle(theme, "pk")).toEqual({ bold: true, inverse: true });
  });

  it("prints plain under TERM=dumb and to a pipe", () => {
    const dumb = resolveTheme({ TERM: "dumb", COLORTERM: "truecolor" });
    expect(dumb.tier).toBe("plain");
    expect(colorEnabled(dumb)).toBe(false);
    expect(ansi(dumb, "primary", "x")).toBe("x");
    expect(ansi(dumb, "pk", " p ")).toBe("[p]");
    expect(resolveTheme(truecolor, { isTTY: false }).tier).toBe("plain");
    expect(resolveTheme(truecolor, { isTTY: true }).tier).toBe("truecolor");
  });

  it("resolves Ink props for a role or token at the theme's tier", () => {
    expect(themeInkStyle(DEFAULT_THEME, "link")).toEqual({ color: "#56c8e8", underline: true });
    expect(themeInkStyle(resolveTheme({ TERM: "xterm-256color" }), ["cb", "sel"])).toEqual({
      color: "ansi256(81)",
      backgroundColor: "ansi256(235)",
      bold: true
    });
  });
});

describe("skins override the r4 hexes at the truecolor tier only", () => {
  it("keeps the old neon look available as a skin", () => {
    const neon = resolveTheme({ INFINITE_THEME: "neon", ...truecolor });
    expect(neon.color.primary).toBe("#00D5FF");
    expect(neon.color.text).toBe("#EAFBFF");
    expect(ansi(neon, "primary", "x")).toBe(`${ESC}[38;2;0;213;255mx${ESC}[39m`);
    expect(INFINITE_NEON_THEME.color.primary).toBe("#00D5FF");
  });

  it("ignores a skin's hexes below truecolor", () => {
    const neon = resolveTheme({ INFINITE_THEME: "neon", TERM: "xterm-256color" });
    expect(neon.color.primary).toBe("ansi256(81)");
    expect(ansi(neon, "primary", "x")).toBe(`${ESC}[38;5;81mx${ESC}[39m`);
  });

  it("falls back to the r4 colour for roles a skin does not set", () => {
    const slate = resolveTheme({ INFINITE_THEME: "slate", ...truecolor });
    expect(slate.color.primary).toBe("#54C6FF");
    expect(slate.color.line).toBe("#3a4653");
  });

  it("puts the light skins on the 16 tier so the user's palette keeps contrast", () => {
    expect(resolveTheme({ INFINITE_THEME: "daylight", ...truecolor }).tier).toBe("16");
    expect(resolveTheme({ INFINITE_THEME: "light", TERM: "xterm-256color" }).tier).toBe("16");
    expect(resolveTheme({ INFINITE_THEME: "light", NO_COLOR: "1" }).tier).toBe("mono");
    expect(resolveTheme({ INFINITE_THEME: "light", INFINITE_COLOR: "truecolor" }).tier).toBe("truecolor");
  });
});
