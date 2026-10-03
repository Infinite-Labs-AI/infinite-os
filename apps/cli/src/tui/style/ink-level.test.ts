import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import React from "react";

import { renderToString, Text } from "../ink/renderer.js";
import { resolveTheme } from "../theme.js";
import { drawsToTerminal, inkColorLevel, syncInkColorLevel } from "./ink-level.js";

// Stock Ink paints through chalk's singleton, whose level comes from chalk's
// own terminal sniffing. Our tier must win, or hex is re-quantized (dim → lilac).
type Chalk = { level: number };
let inkChalk: Chalk;
let before = 0;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const chalkPath = createRequire(require.resolve("ink")).resolve("chalk");
  inkChalk = ((await import(pathToFileURL(chalkPath).href)) as { default: Chalk }).default;
  before = inkChalk.level;
});

afterEach(() => {
  inkChalk.level = before;
});

describe("inkColorLevel", () => {
  it("maps each tier to the chalk level that paints it, keeping bold and inverse under mono", () => {
    expect(inkColorLevel("truecolor")).toBe(3);
    expect(inkColorLevel("256")).toBe(2);
    expect(inkColorLevel("16")).toBe(1);
    expect(inkColorLevel("mono")).toBe(1);
    expect(inkColorLevel("plain")).toBe(0);
  });
});

describe("syncInkColorLevel", () => {
  it("sets the level on the chalk instance stock Ink uses, and the restore puts it back", () => {
    inkChalk.level = 2;
    const restore = syncInkColorLevel("truecolor");
    expect(inkChalk.level).toBe(3);
    restore();
    expect(inkChalk.level).toBe(2);
  });

  it("stops chalk re-quantizing the truecolor dim grey when chalk sniffed only 256 (COLORTERM=24bit)", () => {
    const theme = resolveTheme({ COLORTERM: "24bit", TERM: "xterm-256color" });
    expect(theme.tier).toBe("truecolor");
    inkChalk.level = 2;
    const paintDim = () => renderToString(React.createElement(Text, { color: theme.color.muted }, "x"), { columns: 20 });
    expect(paintDim()).toContain("\u001b[38;5;103m");
    const restore = syncInkColorLevel(theme.tier);
    try {
      expect(paintDim()).toContain("\u001b[38;2;109;121;134m");
    } finally {
      restore();
    }
  });

  it("keeps Ink's inverse chips under mono even when chalk sniffed no colour", () => {
    inkChalk.level = 0;
    const restore = syncInkColorLevel("mono");
    try {
      expect(renderToString(React.createElement(Text, { inverse: true, bold: true }, " p "), { columns: 20 })).toContain("\u001b[7m");
    } finally {
      restore();
    }
  });
});

describe("drawsToTerminal", () => {
  it("is false for a stream that only claims to be a TTY (no terminal fd behind it)", () => {
    const fake = Object.assign(new PassThrough(), { isTTY: true });
    expect(drawsToTerminal(fake)).toBe(false);
    expect(drawsToTerminal({ fd: -1, isTTY: true })).toBe(false);
  });
});
