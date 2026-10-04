import { describe, expect, it } from "vitest";

import { resolveTheme } from "../theme.js";
import { getTurnState } from "./turn-store.js";
import { renderInfiniteTranscript } from "./transcript-renderer.js";

// The per-answer border label (`∞ Infinite — <project>`) is sourced two ways:
// completed answers carry a frozen `Msg.title`; the in-flight answer reads the
// live `agentTitle`. Both must render, and absence must degrade to the bare
// brand name (never a dangling separator).
describe("transcript agent title", () => {
  const theme = resolveTheme();

  it("renders the frozen per-message project label on a completed answer", () => {
    const out = renderInfiniteTranscript(
      { messages: [{ role: "assistant", text: "Your views are up 12%.", title: "Infinite — Acme" }] },
      { columns: 80, theme }
    );

    expect(out).toContain("Infinite — Acme");
  });

  it("does not relabel a message that was frozen under a different project", () => {
    const out = renderInfiniteTranscript(
      {
        // The live project switched to "Beta", but this older answer keeps "Acme".
        agentTitle: "Infinite — Beta",
        messages: [{ role: "assistant", text: "rtk numbers", title: "Infinite — Acme" }]
      },
      { columns: 80, theme }
    );

    expect(out).toContain("Infinite — Acme");
    expect(out).not.toContain("Infinite — Beta");
  });

  it("labels the in-flight (streaming) answer with the active project via agentTitle", () => {
    const state = { ...getTurnState(), streaming: "crunching the numbers…" };
    const out = renderInfiniteTranscript({ agentTitle: "Infinite — Acme", state }, { columns: 80, theme });

    expect(out).toContain("Infinite — Acme");
  });

  it("an unlabeled answer is just `∞ answer` (r4: no box, no title, no dangling separator)", () => {
    const out = renderInfiniteTranscript(
      { messages: [{ role: "assistant", text: "hello" }] },
      { columns: 80, theme }
    );

    expect(out).toBe("∞ hello");
  });

  it("a labeled answer prints its project dim after the mark, the answer hung under it", () => {
    const out = renderInfiniteTranscript(
      { messages: [{ role: "assistant", text: "hello", title: "Infinite — Acme" }] },
      { columns: 80, theme }
    );

    expect(out.split("\n")).toEqual(["∞ Infinite — Acme", "  hello"]);
  });
});
