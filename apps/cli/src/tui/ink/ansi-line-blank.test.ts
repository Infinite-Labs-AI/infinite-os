import React from "react";
import { describe, expect, it } from "vitest";

import { Box, renderToString } from "./renderer.js";
import { AnsiLine } from "./transcript-app.js";

// The r4 layout's blank rows (between the question and the answer, before the
// Steps) are empty strings; an empty Ink Text takes no row, so they vanished.
describe("AnsiLine keeps a blank line's row", () => {
  it("draws an empty line as a blank row", () => {
    const out = renderToString(
      React.createElement(Box, { flexDirection: "column" }, ...["❯ question", "", "∞ answer"].map((line, index) => React.createElement(AnsiLine, { key: index, line })))
    );
    expect(out.split("\n").map((row) => row.trimEnd())).toEqual(["❯ question", "", "∞ answer"]);
  });
});
