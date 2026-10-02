import { describe, expect, it } from "vitest";

import { style } from "../style/sgr.js";
import { DEFAULT_THEME, resolveTheme, type Theme } from "../theme.js";
import { paint, toneRole } from "./primitives.js";

const ESC = "\u001b";
const on = (theme: Theme = DEFAULT_THEME) => ({ color: true, theme });

describe("paint", () => {
  it("paints a role in its r4 token and closes with specific resets, never 0m", () => {
    expect(paint("x", "muted", on())).toBe(`${ESC}[38;2;109;121;134mx${ESC}[39m`);
    expect(paint("x", "warning", on())).toBe(style("x", "amber", "truecolor"));
    expect(paint("x", "muted", on(), { bold: true, inverse: true })).not.toMatch(/\u001b\[0?m/u);
  });

  it("paints r4 tokens directly: chips, the needs-you head, links", () => {
    expect(paint(" Pause Hook B ", "tag", on())).toBe(style(" Pause Hook B ", "tag", "truecolor"));
    expect(paint("▣ Needs your OK", "ab", on())).toBe(style("▣ Needs your OK", "ab", "truecolor"));
    expect(paint("open ↗", ["cyan", "u"], on())).toBe(`${ESC}[4;38;2;86;200;232mopen ↗${ESC}[24;39m`);
  });

  it("adds bold and inverse on top of a role, and ends exactly those", () => {
    expect(paint(" Item ", "text", on(), { bold: true, inverse: true })).toBe(`${ESC}[39m${ESC}[1m${ESC}[7m Item ${ESC}[22;27m${ESC}[39m`);
  });

  it("prints plain text when colour is off or the tier is plain", () => {
    expect(paint("x", "muted", { color: false, theme: DEFAULT_THEME })).toBe("x");
    const dumb = resolveTheme({ TERM: "dumb" });
    expect(paint("x", "muted", on(dumb), { bold: true })).toBe("x");
    expect(paint(" p ", "pk", on(dumb))).toBe("[p]");
  });

  it("keeps attributes and drops colour under NO_COLOR", () => {
    const mono = resolveTheme({ NO_COLOR: "1" });
    expect(paint("x", "muted", on(mono))).toBe("x");
    expect(paint("x", "muted", on(mono), { inverse: true })).toBe(`${ESC}[7mx${ESC}[27m`);
    expect(paint(" p ", "pk", on(mono))).toBe(`${ESC}[1;7m p ${ESC}[22;27m`);
  });

  it("paints at the theme's tier", () => {
    expect(paint("x", "muted", on(resolveTheme({ TERM: "xterm-256color" })))).toBe(`${ESC}[38;5;243mx${ESC}[39m`);
    expect(paint("x", "muted", on(resolveTheme({ TERM: "xterm" })))).toBe(`${ESC}[90mx${ESC}[39m`);
  });
});

describe("toneRole", () => {
  it("maps each tone to its r4 role, with needs-you bold amber", () => {
    expect(toneRole("ok")).toBe("success");
    expect(toneRole("ask")).toBe("ask");
    expect(toneRole("warn")).toBe("warning");
    expect(toneRole("bad")).toBe("error");
    expect(toneRole("busy")).toBe("primary");
    expect(toneRole("muted")).toBe("muted");
    expect(toneRole("cmdl_only")).toBe("cmdl");
    expect(paint("▣ Needs your OK", toneRole("ask"), on())).toBe(style("▣ Needs your OK", "ab", "truecolor"));
    expect(paint("⌘ Do this in Cmd+L", toneRole("cmdl_only"), on())).toBe(style("⌘ Do this in Cmd+L", "bb", "truecolor"));
  });
});
