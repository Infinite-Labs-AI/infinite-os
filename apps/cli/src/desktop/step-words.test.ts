import { describe, expect, it } from "vitest";

import { MAX_STEP_WORD_CHARS, STEP_WORDS_CAPABILITY, decodeStepWords, stepWordsOf } from "./step-words.js";

describe("step words (step.words.v1)", () => {
  it("names the capability the bridge advertises", () => {
    expect(STEP_WORDS_CAPABILITY).toBe("step.words.v1");
  });

  it("reads a label, and a result when the frame has one", () => {
    expect(decodeStepWords({ label: "checking the catalog" })).toEqual({ label: "checking the catalog" });
    expect(decodeStepWords({ label: "checking the catalog", result: "3 rows" })).toEqual({
      label: "checking the catalog",
      result: "3 rows"
    });
  });

  it("is nothing without a usable label", () => {
    for (const value of [undefined, null, "checking", 3, [], {}, { label: "" }, { label: "   " }, { label: 7 }, { result: "3 rows" }]) {
      expect(decodeStepWords(value)).toBeNull();
    }
  });

  it("scrubs control sequences and collapses whitespace", () => {
    expect(decodeStepWords({ label: "\u001b[31mchecking\u001b[0m   the\ncatalog", result: "\u001b]0;x\u0007 3 rows " })).toEqual({
      label: "checking the catalog",
      result: "3 rows"
    });
  });

  it("cuts a label or a result past 48 characters with an ellipsis", () => {
    const long = "checking every single row of the whole catalog twice over";
    const words = decodeStepWords({ label: long, result: long });
    expect(words!.label).toBe("checking every single row of the whole catalog…");
    expect(Array.from(words!.label).length).toBeLessThanOrEqual(MAX_STEP_WORD_CHARS);
    expect(words!.result).toBe(words!.label);
    const exact = "x".repeat(MAX_STEP_WORD_CHARS);
    expect(decodeStepWords({ label: exact })!.label).toBe(exact);
    expect(decodeStepWords({ label: `${exact}y` })!.label).toBe(`${"x".repeat(MAX_STEP_WORD_CHARS - 1)}…`);
  });

  it.each([
    ["a namespaced tool id", "mcp__sample_app__list_sample_rows"],
    ["a snake_case tool id", "list_sample_rows"],
    ["a call with JSON arguments", 'List Sample Rows("{\\"level\\":\\"row\\"}")'],
    ["a JSON object", '{"level":"row"}'],
    ["a JSON list", "[1, 2]"],
    ["a URL", "open https://example.test/rows"],
    ["a long numeric id", "row 120213456789012"],
    ["an opaque token", "call 01HZX9ABCDEFGHJKMNPQRSTVWX"]
  ])("refuses %s as a label, so the step falls back to its generic label", (_what, label) => {
    expect(decodeStepWords({ label })).toBeNull();
  });

  it("drops a result that is not display text and keeps the label", () => {
    expect(decodeStepWords({ label: "checking the catalog", result: '{"rows":3}' })).toEqual({ label: "checking the catalog" });
    expect(decodeStepWords({ label: "checking the catalog", result: "sample_rows" })).toEqual({ label: "checking the catalog" });
    expect(decodeStepWords({ label: "checking the catalog", result: 3 })).toEqual({ label: "checking the catalog" });
  });

  it("keeps ordinary results: counts, money, dates, short notes in brackets", () => {
    for (const result of ["3 rows", "$1,234.50", "1 of 3 (2 failed)", "up to 2026-09-30", "12,345 rows", "not connected"]) {
      expect(decodeStepWords({ label: "checking the catalog", result })?.result).toBe(result);
    }
  });

  it("reads the words a progress event carries", () => {
    expect(stepWordsOf({ type: "tool.start", words: { label: "checking the catalog" } })).toEqual({ label: "checking the catalog" });
    expect(stepWordsOf({ type: "tool.start" })).toBeNull();
    expect(stepWordsOf(null)).toBeNull();
  });
});
