import { describe, expect, it } from "vitest";
import { renderStatusFooter } from "./renderer.js";

describe("renderStatusFooter", () => {
  const parts = ["Infinite", "gpt-5.4", "12s", "workspace"];

  it.each([
    [32, "Infinite  |  gpt-5.4  |  12s …  "],
    [31, "Infinite  |  gpt-5.4  |  12s  …"],
    [30, "Infinite  |  gpt-5.4  |  12s …"],
    [29, "Infinite  |  gpt-5.4  |  12s…"],
  ])("drops a dangling separator before the ellipsis at %i columns", (columns, expected) => {
    expect(renderStatusFooter(parts, { color: false, columns })).toBe(expected);
  });

  it("keeps separators that are not followed by the ellipsis", () => {
    expect(renderStatusFooter(["a", "b"], { color: false, columns: 12 })).toBe("a  |  b     ");
    expect(renderStatusFooter(["ab |", "cd"], { color: false, columns: 12 })).toBe("ab |  |  cd ");
    expect(renderStatusFooter(["abcdefghij", "b"], { color: false, columns: 13 })).toBe("abcdefghij  …");
    expect(renderStatusFooter(["abcdefghij", "b"], { color: false, columns: 14 })).toBe("abcdefghij …  ");
  });

  it("stays linear on long runs of spaces (no backtracking regex)", () => {
    const footer = renderStatusFooter([`a${" ".repeat(400)}`, "b"], { color: false, columns: 160 });
    expect(footer).toHaveLength(160);
    expect(footer.startsWith("a ")).toBe(true);
  });
});
