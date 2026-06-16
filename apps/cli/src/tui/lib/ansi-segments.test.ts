import { describe, expect, it } from "vitest";

import { parseAnsiSegments } from "./ansi-segments.js";

const ESC = String.fromCharCode(27);
const fg = (r: number, g: number, b: number) => `${ESC}[38;2;${r};${g};${b}m`;
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const BOLD_OFF = `${ESC}[22m`;
const ITALIC = `${ESC}[3m`;
const ITALIC_OFF = `${ESC}[23m`;

describe("parseAnsiSegments", () => {
  it("returns a single uncolored segment for plain text", () => {
    expect(parseAnsiSegments("hello world")).toEqual([{ text: "hello world" }]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseAnsiSegments("")).toEqual([]);
  });

  it("maps a truecolor foreground to a hex color and resets to default", () => {
    const line = `${fg(0, 213, 255)}│${RESET} body`;

    expect(parseAnsiSegments(line)).toEqual([
      { text: "│", color: "#00d5ff" },
      { text: " body" }
    ]);
  });

  it("gives the border and the body distinct colors on a panel line", () => {
    const line = `${fg(0, 213, 255)}│${RESET} ${fg(234, 251, 255)}Revenue${RESET} ${fg(0, 213, 255)}│${RESET}`;
    const segments = parseAnsiSegments(line);

    const border = segments.find((s) => s.text === "│");
    const body = segments.find((s) => s.text === "Revenue");

    expect(border?.color).toBe("#00d5ff");
    expect(body?.color).toBe("#eafbff");
    expect(border?.color).not.toBe(body?.color);
    // text reconstruction is lossless
    expect(segments.map((s) => s.text).join("")).toBe("│ Revenue │");
  });

  it("tracks bold within a colored run without losing the color", () => {
    const line = `${fg(234, 251, 255)}Revenue is ${BOLD}up${BOLD_OFF} today${RESET}`;

    expect(parseAnsiSegments(line)).toEqual([
      { text: "Revenue is ", color: "#eafbff" },
      { text: "up", color: "#eafbff", bold: true },
      { text: " today", color: "#eafbff" }
    ]);
  });

  it("tracks italic spans", () => {
    const line = `${ITALIC}note${ITALIC_OFF} plain`;

    expect(parseAnsiSegments(line)).toEqual([
      { text: "note", italic: true },
      { text: " plain" }
    ]);
  });

  it("is lossless for a real assistant panel line with inline bold", () => {
    const line = `${fg(0, 213, 255)}│${RESET} ${fg(234, 251, 255)}Revenue is ${BOLD}up 14%${BOLD_OFF} today.${RESET} ${fg(0, 213, 255)}│${RESET}`;

    expect(parseAnsiSegments(line).map((s) => s.text).join("")).toBe("│ Revenue is up 14% today. │");
  });
});
