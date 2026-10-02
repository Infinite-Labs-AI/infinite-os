import { afterEach, describe, expect, it } from "vitest";

import { displayWidth, stripAnsi } from "../tui/lib/display-width.js";
import { resetTurnState } from "../tui/app/turn-store.js";
import { createInteractiveProgressReporter } from "./live-activity.js";

// The one-shot TTY path streams the answer line by line (StreamingAssistantFrame).
// Synthetic data only: infinite-os is public.
function streamAnswer(text: string, columns = 88): string {
  const chunks: string[] = [];
  const progress = createInteractiveProgressReporter(
    { columns, isTTY: true, write: (chunk: string) => chunks.push(chunk) > 0 },
    { animate: true, now: () => 1_000 }
  );
  progress.progress({ type: "message.delta", stage: "message", message: "", text });
  progress.progress({ type: "message.complete", stage: "message", message: "", text: "" });
  progress.stop();
  return stripAnsi(chunks.join(""));
}

afterEach(() => {
  resetTurnState();
});

describe("a streamed code block prints as code, never as markdown line by line", () => {
  it("keeps dunder names, # comments and indents, and drops the fences", () => {
    const out = streamAnswer("Here:\n```py\ndef __init__(self):\n# c\n    return 1\n- key: value\n```\nafter **bold**\n");
    const lines = out.split("\n");
    expect(out).toContain("def __init__(self):");
    expect(lines).toContain("    # c");
    expect(lines).toContain("        return 1");
    expect(lines).toContain("    - key: value");
    expect(out).not.toContain("```");
    expect(lines).toContain("  after bold");
  });

  it("a table row inside a fence stays as written", () => {
    const out = streamAnswer("```\n| a | b |\n| --- | --- |\n```\n");
    expect(out).toContain("| a | b |");
    expect(out).toContain("| --- | --- |");
  });

  it("an answer that ends inside a fence keeps its markers (no held-open stripping in code)", () => {
    const out = streamAnswer("```sh\necho **not bold**\nrm -rf _build");
    expect(out).toContain("echo **not bold**");
    expect(out).toContain("rm -rf _build");
  });

  it("a backtick fence inside a tilde fence is code, and only a matching fence closes it", () => {
    const out = streamAnswer("Fenced:\n~~~md\n```js\nx\n```\n~~~\ndone\n");
    const lines = out.split("\n");
    expect(lines).toContain("    ```js");
    expect(lines).toContain("    ```");
    expect(lines).toContain("  done");
  });

  it("a long code line wraps with ↩ like a code block in the answer", () => {
    const out = streamAnswer(`\`\`\`\n${"x".repeat(60)}\n\`\`\`\n`, 40);
    expect(out).toContain("↩");
    expect(out.split("\n").every((line) => line.length <= 40)).toBe(true);
  });
});

describe("the one-shot stream's tables and progress rows are r4's", () => {
  it("a streamed table is the r4 table, with a Total row set apart", () => {
    const out = streamAnswer("| Ad | Spend |\n| --- | ---: |\n| Hook A | 100 |\n| Total | 100 |\n\nDone.\n");
    const lines = out.split("\n");
    expect(lines).toContain("∞ ┌────────┬───────┐");
    expect(lines).toContain("  ├────────┼───────┤");
    expect(lines).toContain("  │ Total  │   100 │");
  });

  it("a streamed table too wide for the window names what it dropped, never 'widen by' (it is printed once)", () => {
    const out = streamAnswer("| Campaign | Spend | Clicks | Note | CTR |\n| --- | ---: | ---: | --- | ---: |\n| Spring | $1,200 | 3,400 | Ran longer | 2.1% |\n\n", 44);
    expect(out).toMatch(/hidden/u);
    expect(out).not.toMatch(/widen by/u);
  });

  it("progress rows carry no gutter and no wide glyph", async () => {
    const { formatInteractiveProgress } = await import("./progress.js");
    const lines = [
      formatInteractiveProgress({ stage: "tool", message: "Running run_breakdown_query." }, 1_000),
      formatInteractiveProgress({ stage: "recall", message: "Recalled context." }, 1_000),
      formatInteractiveProgress({ type: "tool.generating", stage: "tool", message: "", name: "run_breakdown_query" }, 1_000),
      formatInteractiveProgress({ type: "tool.complete", stage: "tool", message: "", toolId: "t", name: "run_breakdown_query", status: "ok" }, 1_000),
      formatInteractiveProgress({ type: "thinking.delta", stage: "thinking", message: "", text: "hmm" } as never, 1_000)
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/[┊⚡\u{1F300}-\u{1FAFF}]/u);
      expect(displayWidth(line)).toBe(Array.from(line).length);
    }
  });
});
