import { describe, expect, it } from "vitest";

import { boundedTerminalText, scrubTerminalControls, terminalText } from "./terminal-text.js";

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
