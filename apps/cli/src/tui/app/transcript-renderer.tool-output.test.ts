import { describe, expect, it } from "vitest";

import { stripAnsi } from "../lib/display-width.js";
import { buildToolTrailLine } from "../lib/text.js";
import { resolveTheme } from "../theme.js";
import { renderInfiniteTranscript } from "./transcript-renderer.js";

// Tool output is data the tool returned, not markdown the model wrote. It must
// read the same at every window width: no bold from `__init__`, no bullets from
// a `- removed` diff line, no heading from a `# comment`.
describe("transcript tool output", () => {
  const theme = resolveTheme();

  it("keeps a tool row exactly as the tool returned it at a narrow width", () => {
    const text = "wrote src/__init__.py and a*b*c\n- removed\n+ added\n# comment";
    for (const color of [false, true]) {
      const out = stripAnsi(renderInfiniteTranscript({ messages: [{ role: "tool", text }] }, { columns: 40, theme, color }));
      expect(out).toContain("src/__init__.py");
      expect(out).toContain("a*b*c");
      expect(out).toContain("- removed");
      expect(out).toContain("+ added");
      expect(out).toContain("# comment");
      expect(out).not.toContain("•");
    }
  });

  it("shows the same tool-trail detail whether it fits inline or wraps", () => {
    const tool = buildToolTrailLine("read_file", "src", false, "read src/__init__.py and a*b*c then __main__", 1.2);
    const msg = { role: "tool" as const, kind: "trail" as const, text: "", tools: [tool] };
    const wide = renderInfiniteTranscript({ messages: [msg] }, { columns: 120, theme });
    const narrow = renderInfiniteTranscript({ messages: [msg] }, { columns: 48, theme });
    for (const out of [wide, narrow]) {
      const flat = out.replace(/\s+/g, " ");
      expect(flat).toContain("src/__init__.py");
      expect(flat).toContain("a*b*c");
      expect(flat).toContain("__main__");
    }
    expect(narrow.split("\n").length).toBeGreaterThan(wide.split("\n").length);
  });

  it("still renders markdown in the assistant's own trail text", () => {
    const msg = { role: "tool" as const, kind: "trail" as const, text: "**bold** and - x\n- item" };
    const out = renderInfiniteTranscript({ messages: [msg] }, { columns: 60, theme });
    expect(out).not.toContain("**");
    expect(out).toContain("• item");
  });
});
