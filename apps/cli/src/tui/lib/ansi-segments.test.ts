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

describe("parseAnsiSegments carries every r4 attribute", () => {
  it("keeps backgrounds, underline, inverse and faint", () => {
    const line = `${ESC}[38;2;255;255;255;48;2;42;52;64m p ${ESC}[39;49m ${ESC}[4mlink${ESC}[24m ${ESC}[7msel${ESC}[27m ${ESC}[2mfaint${ESC}[22m`;
    expect(parseAnsiSegments(line)).toEqual([
      { text: " p ", color: "#ffffff", backgroundColor: "#2a3440" },
      { text: " " },
      { text: "link", underline: true },
      { text: " " },
      { text: "sel", inverse: true },
      { text: " " },
      { text: "faint", dim: true }
    ]);
  });

  it("keeps 256-colour indices and named colours as they are (the user's palette stays theirs)", () => {
    const line = `${ESC}[38;5;243mdim${ESC}[39m ${ESC}[48;5;235msel${ESC}[49m ${ESC}[36mcyan${ESC}[39m ${ESC}[1;97;100mtag${ESC}[22;39;49m ${ESC}[30;43mok${ESC}[39;49m`;
    expect(parseAnsiSegments(line)).toEqual([
      { text: "dim", color: "ansi256(243)" },
      { text: " " },
      { text: "sel", backgroundColor: "ansi256(235)" },
      { text: " " },
      { text: "cyan", color: "cyan" },
      { text: " " },
      { text: "tag", color: "whiteBright", backgroundColor: "blackBright", bold: true },
      { text: " " },
      { text: "ok", color: "black", backgroundColor: "yellow" }
    ]);
  });

  it("ends a token inside a chip without ending the chip's background", () => {
    const line = `${ESC}[38;2;255;255;255;48;2;42;52;64m a ${ESC}[38;2;109;121;134mx${ESC}[39m b ${ESC}[39;49m`;
    expect(parseAnsiSegments(line)).toEqual([
      { text: " a ", color: "#ffffff", backgroundColor: "#2a3440" },
      { text: "x", color: "#6d7986", backgroundColor: "#2a3440" },
      { text: " b ", backgroundColor: "#2a3440" }
    ]);
  });

  it("22 ends both bold and faint; 0 and an empty SGR end everything", () => {
    const line = `${ESC}[1;2;4;7;48;5;1mA${ESC}[22mB${ESC}[mC${ESC}[1;4mD${ESC}[0mE`;
    expect(parseAnsiSegments(line)).toEqual([
      { text: "A", backgroundColor: "ansi256(1)", bold: true, dim: true, underline: true, inverse: true },
      { text: "B", backgroundColor: "ansi256(1)", underline: true, inverse: true },
      { text: "C" },
      { text: "D", bold: true, underline: true },
      { text: "E" }
    ]);
  });
});
