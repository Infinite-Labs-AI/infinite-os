import { describe, expect, it } from "vitest";

import { resolveCliRenderSurface } from "./render-surface.js";

const tty = { isTTY: true };

describe("resolveCliRenderSurface", () => {
  it("gives a dumb terminal the plain surface, never Ink", () => {
    expect(resolveCliRenderSurface(tty, { TERM: "dumb" })).toBe("plain");
    expect(resolveCliRenderSurface(tty, { TERM: "DUMB" })).toBe("plain");
    expect(resolveCliRenderSurface(tty, { TERM: "dumb", INFINITE_RENDER_SURFACE: "ink" })).toBe("plain");
  });

  it("keeps Ink for a colour terminal, and for NO_COLOR (which only drops colour)", () => {
    expect(resolveCliRenderSurface(tty, { TERM: "xterm-256color" })).toBe("ink");
    expect(resolveCliRenderSurface(tty, { TERM: "xterm-256color", NO_COLOR: "1" })).toBe("ink");
  });

  it("stays plain for a pipe and for INFINITE_PLAIN_OUTPUT", () => {
    expect(resolveCliRenderSurface({ isTTY: false }, { TERM: "xterm-256color" })).toBe("plain");
    expect(resolveCliRenderSurface(tty, { INFINITE_PLAIN_OUTPUT: "1" })).toBe("plain");
  });
});
