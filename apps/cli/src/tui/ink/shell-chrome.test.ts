import { describe, expect, it } from "vitest";

import { keyBarHints, keyBarLine, type KeyHint } from "../keys/keymap.js";
import { stripAnsi } from "../lib/display-width.js";
import { resolveTheme, type Theme } from "../theme.js";
import type { Tier } from "../style/tokens.js";
import {
  GOLDEN,
  R4_SOURCES_NOT_CONNECTED,
  R4_SOURCES_OK,
  goldenCells,
  goldenText,
  renderedCells,
  type GoldenLine
} from "./__fixtures__/r4-chrome.js";
import { composerLine } from "./composer-line.js";
import { bootBodyLines, ruleLine, stepsRuleLine, topBarLines, type TopBarData } from "./top-bar.js";

const theme = (tier: Tier): Theme => resolveTheme({ INFINITE_COLOR: tier }, { isTTY: true });
const TRUECOLOR = theme("truecolor");
const OK: TopBarData = { workspace: "Infinite workspace", sources: R4_SOURCES_OK, throughApp: true };
const NOT_CONNECTED: TopBarData = { workspace: "Infinite workspace", sources: R4_SOURCES_NOT_CONNECTED, throughApp: true };

function expectGolden(line: string, golden: GoldenLine, tier: Tier = "truecolor"): void {
  expect(stripAnsi(line).replace(/\s+$/u, "")).toBe(goldenText(golden));
  expect(renderedCells(line)).toEqual(goldenCells(golden, tier));
}

describe("the top bar (terminal-r4 row 0, D1)", () => {
  it("draws the brand chip, the workspace and the dots, broken sources first (region-topbar-ok)", () => {
    expectGolden(topBarLines(OK, 100, TRUECOLOR)[0]!, GOLDEN.topbarOk);
  });

  it("leads with an asked source that is missing, in amber (region-topbar-not-connected)", () => {
    expectGolden(topBarLines(NOT_CONNECTED, 100, TRUECOLOR)[0]!, GOLDEN.topbarNotConnected);
  });

  it("drops the dots that do not fit in a narrow window (region-topbar-narrow-60)", () => {
    expectGolden(topBarLines(OK, 60, TRUECOLOR)[0]!, GOLDEN.topbarNarrow60);
  });

  it("says `through the Infinite app` on the right only when the whole line fits (boot--c160)", () => {
    expectGolden(topBarLines(OK, 160, TRUECOLOR)[0]!, GOLDEN.topbarWide160);
    expect(stripAnsi(topBarLines({ ...OK, throughApp: false }, 160, TRUECOLOR)[0]!)).not.toContain("through the Infinite app");
  });

  it("is followed by a thin rule in the line grey (region-rule)", () => {
    const [, rule] = topBarLines(OK, 100, TRUECOLOR);
    expectGolden(rule!, GOLDEN.rule100);
    expect(rule).toBe(ruleLine(100, TRUECOLOR));
  });

  it("draws no dots when the sources are unknown: it never guesses what is connected", () => {
    const [bar] = topBarLines({ workspace: "Infinite workspace", throughApp: true }, 100, TRUECOLOR);
    expect(stripAnsi(bar!)).not.toMatch(/[●⊘]/u);
    expect(stripAnsi(bar!)).toContain("Infinite workspace");
    expect(stripAnsi(bar!)).toContain("through the Infinite app");
  });

  it("is the brand chip alone with no data", () => {
    expect(stripAnsi(topBarLines(undefined, 40, TRUECOLOR)[0]!).trimEnd()).toBe(" ∞ Infinite");
  });

  it("scrubs control characters out of the workspace and source names", () => {
    const [bar] = topBarLines({ workspace: "Acme\u001b[2J", sources: [{ label: "GA4\u0007", state: "connected" }] }, 80, TRUECOLOR);
    expect(stripAnsi(bar!)).toContain("  Acme   ● GA4");
    expect(bar).not.toContain("\u001b[2J");
    expect(bar).not.toContain("\u0007");
  });

  it("matches at the 256 tier with the palette's own indices", () => {
    expectGolden(topBarLines(OK, 100, theme("256"))[0]!, GOLDEN.topbarOk, "256");
  });

  it("prints the chip as same-width brackets and no escape at all when plain", () => {
    const [bar, rule] = topBarLines(OK, 100, theme("plain"));
    expect(bar).not.toContain("\u001b");
    expect(bar!.startsWith("[∞ Infinite]  Infinite workspace   ⊘ Shopify ● GA4")).toBe(true);
    expect(rule).toBe("─".repeat(100));
  });

  it("keeps the chip inverse and paints no colour under NO_COLOR (mono)", () => {
    const [bar] = topBarLines(OK, 100, resolveTheme({ NO_COLOR: "1" }, { isTTY: true }));
    expect(bar).not.toMatch(/\u001b\[[0-9;]*(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])[;m]/u);
    expect(bar).toContain("\u001b[1;7m ∞ Infinite ");
  });
});

describe("the boot frame's body (D4)", () => {
  it("is an empty answer area and the Steps rule", () => {
    const body = bootBodyLines(100, TRUECOLOR);
    expect(body).toHaveLength(9);
    expect(body.slice(0, 8).every((line) => line === "")).toBe(true);
    expectGolden(body[8]!, GOLDEN.steps100);
    expect(stepsRuleLine(100, TRUECOLOR)).toBe(body[8]);
  });

  it("shrinks its answer area to the rows it has, keeping the Steps rule", () => {
    expect(bootBodyLines(100, TRUECOLOR, 3)).toHaveLength(3);
    expect(bootBodyLines(100, TRUECOLOR, 1)).toEqual([stepsRuleLine(100, TRUECOLOR)]);
  });
});

describe("the composer row (region-composer-*)", () => {
  it("is a cyan prompt and the dim placeholder when idle", () => {
    expectGolden(composerLine(100, TRUECOLOR), GOLDEN.composerIdle);
  });

  it("carries a busy note in brackets", () => {
    expectGolden(composerLine(100, TRUECOLOR, { note: "the pause finishes either way" }), GOLDEN.composerBusy);
  });

  it("is cut to the width, never wrapped", () => {
    const line = stripAnsi(composerLine(20, TRUECOLOR, { note: "a very long note that cannot fit" }));
    expect(line).toBe("❯ Ask Infinite… (a …");
  });
});

describe("the key bar (region-keybar-*, the last row)", () => {
  const card = (okKey: string, okLabel: string, extra: Partial<Parameters<typeof keyBarHints>[0]> = {}) =>
    keyBarHints({ focus: "card", busy: false, okKey, okLabel, caps: { open: false, watch: false, retry: false }, ...extra });

  it("always ends with tab switch side and / commands (region-keybar-quiet)", () => {
    expectGolden(keyBarLine([], 100, TRUECOLOR), GOLDEN.keybarQuiet);
  });

  it("draws the state's keys as chips first (region-keybar-numbers)", () => {
    const hints: KeyHint[] = [{ key: "j k", label: "row" }, { key: "→", label: "columns" }, { key: "o", label: "open" }];
    expectGolden(keyBarLine(hints, 100, TRUECOLOR), GOLDEN.keybarNumbers);
  });

  it("leads with the card's OK key as an amber chip and a bold label (region-keybar-approval-pause)", () => {
    expectGolden(keyBarLine(card("p", "pause"), 100, TRUECOLOR), GOLDEN.keybarApprovalPause);
  });

  it("keeps v view before the OK key on a send card (region-keybar-approval-email)", () => {
    expectGolden(keyBarLine(card("s", "send", { card: { view: true } }), 100, TRUECOLOR), GOLDEN.keybarApprovalEmail);
  });

  it("shows tab and / once even when the state's keys already offer them", () => {
    const line = stripAnsi(keyBarLine([{ key: "j k", label: "move" }, { key: "tab", label: "switch side" }], 100, TRUECOLOR));
    expect(line.match(/ tab /gu)).toHaveLength(1);
    expect(line.trimEnd().endsWith(" tab  switch side    /  commands")).toBe(true);
  });

  it("puts esc stop first while a turn runs, once (D6)", () => {
    const busy = keyBarHints({ focus: "composer", busy: true, okKey: null, caps: { open: false, watch: false, retry: false } });
    const line = stripAnsi(keyBarLine(busy, 100, TRUECOLOR));
    expect(line.startsWith(" esc  stop    tab  switch side")).toBe(true);
    expect(line.match(/esc/gu)).toHaveLength(1);
  });

  it("is cut to the width with … on the key that does not fit", () => {
    const line = stripAnsi(keyBarLine(card("p", "Pause", { explain: true }), 30, TRUECOLOR));
    expect(line).toHaveLength(30);
    expect(line.endsWith("…")).toBe(true);
  });

  it("prints chips as same-width brackets when plain", () => {
    expect(keyBarLine([], 100, theme("plain"))).toBe("[tab] switch side   [/] commands");
  });
});
