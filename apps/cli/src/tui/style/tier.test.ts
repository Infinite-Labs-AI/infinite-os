import { describe, expect, it } from "vitest";

import { resolveTier, tierHasColor, tierPaints } from "./tier.js";

const tty = { isTTY: true };
const pipe = { isTTY: false };

describe("resolveTier", () => {
  it("honours INFINITE_COLOR above everything", () => {
    expect(resolveTier({ INFINITE_COLOR: "truecolor", NO_COLOR: "1" }, pipe)).toBe("truecolor");
    expect(resolveTier({ INFINITE_COLOR: "256", COLORTERM: "truecolor" }, tty)).toBe("256");
    expect(resolveTier({ INFINITE_COLOR: "16" }, tty)).toBe("16");
    expect(resolveTier({ INFINITE_COLOR: "MONO" }, tty)).toBe("mono");
    expect(resolveTier({ INFINITE_COLOR: "plain", COLORTERM: "truecolor" }, tty)).toBe("plain");
    expect(resolveTier({ INFINITE_COLOR: "sparkly", COLORTERM: "truecolor" }, tty)).toBe("truecolor");
    expect(resolveTier({ INFINITE_COLOR: "constructor", COLORTERM: "truecolor" }, tty)).toBe("truecolor");
  });

  it("prints plain to a pipe, to TERM=dumb and under INFINITE_PLAIN_OUTPUT, even with NO_COLOR", () => {
    expect(resolveTier({ COLORTERM: "truecolor" }, pipe)).toBe("plain");
    expect(resolveTier({ TERM: "dumb", COLORTERM: "truecolor" }, tty)).toBe("plain");
    expect(resolveTier({ TERM: "dumb", NO_COLOR: "1" }, tty)).toBe("plain");
    expect(resolveTier({ INFINITE_PLAIN_OUTPUT: "1", COLORTERM: "truecolor" }, tty)).toBe("plain");
    expect(resolveTier({ FORCE_COLOR: "3" }, pipe)).toBe("plain");
  });

  it("drops to mono under a non-empty NO_COLOR", () => {
    expect(resolveTier({ NO_COLOR: "1", COLORTERM: "truecolor" }, tty)).toBe("mono");
    expect(resolveTier({ NO_COLOR: "1", FORCE_COLOR: "3" }, tty)).toBe("mono");
    expect(resolveTier({ NO_COLOR: "", COLORTERM: "truecolor" }, tty)).toBe("truecolor");
  });

  it("follows FORCE_COLOR 0–3, with 0 meaning no escapes at all (plain, so chips bracket)", () => {
    expect(resolveTier({ FORCE_COLOR: "0", COLORTERM: "truecolor" }, tty)).toBe("plain");
    expect(resolveTier({ FORCE_COLOR: "1", COLORTERM: "truecolor" }, tty)).toBe("16");
    expect(resolveTier({ FORCE_COLOR: "2" }, tty)).toBe("256");
    expect(resolveTier({ FORCE_COLOR: "3", TERM: "xterm" }, tty)).toBe("truecolor");
  });

  it("uses the 16 tier on a light background so the user's palette keeps contrast", () => {
    expect(resolveTier({ COLORFGBG: "0;15", COLORTERM: "truecolor" }, tty)).toBe("16");
    expect(resolveTier({ COLORFGBG: "0;default;7", TERM: "xterm-256color" }, tty)).toBe("16");
    expect(resolveTier({ COLORFGBG: "15;0", COLORTERM: "truecolor" }, tty)).toBe("truecolor");
    expect(resolveTier({ COLORFGBG: "0;15", FORCE_COLOR: "3" }, tty)).toBe("truecolor");
  });

  it("takes the probed background (INFINITE_BACKGROUND) ahead of COLORFGBG", () => {
    expect(resolveTier({ INFINITE_BACKGROUND: "light", COLORTERM: "truecolor" }, tty)).toBe("16");
    expect(resolveTier({ INFINITE_BACKGROUND: "light", TERM_PROGRAM: "Apple_Terminal" }, tty)).toBe("16");
    expect(resolveTier({ INFINITE_BACKGROUND: "dark", COLORFGBG: "0;15", COLORTERM: "truecolor" }, tty)).toBe("truecolor");
    expect(resolveTier({ INFINITE_BACKGROUND: "light", FORCE_COLOR: "3" }, tty)).toBe("truecolor");
  });

  it("finds truecolor from COLORTERM, TERM and TERM_PROGRAM", () => {
    expect(resolveTier({ COLORTERM: "truecolor" }, tty)).toBe("truecolor");
    expect(resolveTier({ COLORTERM: "24bit" }, tty)).toBe("truecolor");
    expect(resolveTier({ TERM: "xterm-kitty" }, tty)).toBe("truecolor");
    expect(resolveTier({ TERM: "xterm-ghostty" }, tty)).toBe("truecolor");
    expect(resolveTier({ TERM: "wezterm" }, tty)).toBe("truecolor");
    expect(resolveTier({ TERM_PROGRAM: "vscode", TERM: "xterm-256color" }, tty)).toBe("truecolor");
    expect(resolveTier({ TERM_PROGRAM: "WezTerm" }, tty)).toBe("truecolor");
    expect(resolveTier({ TERM_PROGRAM: "ghostty" }, tty)).toBe("truecolor");
    expect(resolveTier({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.4", TERM: "xterm-256color" }, tty)).toBe("truecolor");
    expect(resolveTier({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "2.9.1", TERM: "xterm-256color" }, tty)).toBe("256");
    expect(resolveTier({ TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color" }, tty)).toBe("256");
  });

  it("clamps tmux to 256 unless COLORTERM says truecolor", () => {
    expect(resolveTier({ TMUX: "/tmp/tmux-501/default,1,0", TERM: "tmux-256color" }, tty)).toBe("256");
    expect(resolveTier({ TMUX: "/tmp/tmux-501/default,1,0", TERM_PROGRAM: "vscode" }, tty)).toBe("256");
    expect(resolveTier({ TMUX: "/tmp/tmux-501/default,1,0", COLORTERM: "truecolor" }, tty)).toBe("truecolor");
  });

  it("gives Apple Terminal and *-256color terminals 256, and everything else 16", () => {
    expect(resolveTier({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm" }, tty)).toBe("256");
    expect(resolveTier({ TERM: "xterm-256color" }, tty)).toBe("256");
    expect(resolveTier({ TERM: "screen-256color" }, tty)).toBe("256");
    expect(resolveTier({ TERM: "xterm" }, tty)).toBe("16");
    expect(resolveTier({}, tty)).toBe("16");
  });

  it("says which tiers paint at all, and which paint colour", () => {
    expect(["truecolor", "256", "16", "mono", "plain"].map((tier) => tierPaints(tier as never))).toEqual([true, true, true, true, false]);
    expect(["truecolor", "256", "16", "mono", "plain"].map((tier) => tierHasColor(tier as never))).toEqual([true, true, true, false, false]);
  });
});
