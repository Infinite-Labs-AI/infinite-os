import { describe, expect, it } from "vitest";

import { renderToString } from "./renderer.js";
import { InfiniteWelcome } from "./infinite-welcome.js";
import { GROWTH_TAGLINE } from "./rocket-banner.js";
import { resolveTheme } from "../theme.js";
import React from "react";

function render(columns: number): string {
  return renderToString(
    React.createElement(InfiniteWelcome, { columns, theme: resolveTheme(), animate: false }),
    { columns }
  );
}

describe("InfiniteWelcome", () => {
  it("renders the big block INFINITE wordmark on a wide terminal", () => {
    const out = render(88);
    // Pieces of the ANSI-shadow art + the CTA.
    expect(out).toContain("██╗");
    expect(out).toContain("███████╗");
    expect(out).toContain(GROWTH_TAGLINE);
    expect(out).toContain("Enter ↵");
    expect(out).toContain("to launch");
  });

  it("falls back to the compact wordmark on a narrow terminal", () => {
    const out = render(40);
    expect(out).toContain("∞");
    expect(out).toContain("INFINITE");
    expect(out).toContain(GROWTH_TAGLINE);
    expect(out).toContain("to launch");
    // The 54-col block art cannot fit at 40 cols.
    expect(out).not.toContain("███████╗");
  });
});
