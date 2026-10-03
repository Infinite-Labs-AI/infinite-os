import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  boundedTerminalText,
  scrubTerminalControls,
  terminalOutputText,
  terminalText
} from "./terminal-text.js";

const ESC = "\u001b";

// One scrubber for every TTY entry point: the in-session confirm surfaces, the
// receipt lines, the keymap, the view renderers AND the one-shot `infinite app`
// client (which used to carry a private copy). The same cases run against the
// single-line and the line-break-preserving entry points.
describe("one terminal scrubber for every entry point", () => {
  const cases: [string, string, string][] = [
    ["CSI color", `Pause${ESC}[31m now`, "Pause now"],
    ["CSI clear screen", `a${ESC}[2Jb`, "ab"],
    ["OSC title (BEL)", `x${ESC}]0;evil\u0007y`, "xy"],
    ["OSC 8 link (ST)", `x${ESC}]8;;https://e.example${ESC}\\y`, "xy"],
    ["C1 CSI", "a\u009b31mb", "ab"],
    ["bidi override", "abc‮def", "abc def"],
    ["bidi isolate", "abc⁦def⁩", "abc def"],
    ["NUL and BEL", "a\u0000b\u0007c", "a b c"]
  ];
  it.each(cases)("terminalText strips %s", (_label, input, expected) => {
    expect(terminalText(input)).toBe(expected);
  });
  it.each(cases)("terminalOutputText strips %s", (_label, input, expected) => {
    expect(terminalOutputText(input)).toBe(expected);
  });

  it("terminalOutputText keeps line breaks and expands tabs; terminalText folds them", () => {
    expect(terminalOutputText("one\r\ntwo\rthree\n\tfour")).toBe("one\ntwo\nthree\n  four");
    expect(terminalText("one\r\ntwo\rthree\n\tfour")).toBe("one two three four");
  });

  it("the one-shot client has no private scrubber left", () => {
    const client = readFileSync(fileURLToPath(new URL("../desktop-app-client.ts", import.meta.url)), "utf8");
    expect(client).not.toMatch(/function (scanTerminalText|terminalText|terminalOutputText|boundedTerminalText|skipControlSequence|skipControlString)\b/);
    expect(client).toMatch(/from "\.\/desktop\/terminal-text\.js"/);
  });
});

describe("terminal text scrub on non-string input", () => {
  // A decoded view only vouches for its envelope, so a body field can arrive as
  // an array or a length-carrying object. The scrub must never throw on it.
  it.each([
    ["an array", ["boom"]],
    ["a length-carrying object", { length: 2 }],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined]
  ])("terminalText returns the fallback for %s", (_label, value) => {
    expect(terminalText(value as unknown as string, "Confirm")).toBe("Confirm");
  });

  it("boundedTerminalText and scrubTerminalControls do not throw on an array", () => {
    expect(boundedTerminalText(["x"] as unknown as string, 10, "fb")).toBe("fb");
    expect(scrubTerminalControls(["x"] as unknown as string)).toBe("");
  });

  it("still scrubs a real string", () => {
    expect(terminalText("Pause\u001b[31m now")).toBe("Pause now");
  });
});
