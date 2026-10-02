import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { r4Segments } from "../../formatting/r4-segments.test-util.js";
import { INFINITE_R4_THEME } from "../theme.js";
import { headLine } from "./primitives.js";
import { STATE_HEAD, stateHeadFor } from "./states.js";

// "Hit a limit" (terminal-r4 flow-images-05): the head is `$ Hit a limit` in
// plain amber. Nothing failed, so it is never red; and it does not need the
// person, so it is not the bold amber of `▣ Needs your OK`. Cmd+L draws the
// same state as its hollow amber chip with the same words; this test and the
// desktop's state-word tests keep the two in step.
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../style/golden/__goldens__/flow-images-05-hit-a-limit--c100.json", import.meta.url)), "utf8")
) as { lines: { text: string; style: string }[][] };

describe("the Hit a limit head (terminal-r4 flow-images-05)", () => {
  it("is `$ Hit a limit` in the warn tone", () => {
    expect(STATE_HEAD.hit_limit).toEqual({ glyph: "$", words: "Hit a limit", tone: "warn" });
    expect(stateHeadFor({ state: "hit_limit" })).toEqual({ glyph: "$", words: "Hit a limit", tone: "warn" });
  });

  it("r4 paints it amber, not bold amber and not red", () => {
    const segment = golden.lines.flat().find((item) => item.text === "$ Hit a limit");
    expect(segment?.style).toBe("amber");
  });

  it("the terminal paints the same cells: the title chip, then `$ Hit a limit` in amber", () => {
    const view = { kind: "images", title: "Make 3 creatives", state: "hit_limit" } as unknown as AnswerViewV1;
    const head = headLine(view, {
      width: 100, color: true, theme: INFINITE_R4_THEME, selected: 0, tab: 0, page: 0, explainOpen: false, showHiddenColumns: false,
      caps: { open: false, copy: false, watch: false, retry: false }
    } as never);
    const goldenHead = golden.lines.find((line) => line.some((item) => item.text === "$ Hit a limit"))!;
    expect(r4Segments(head)).toEqual(goldenHead);
  });

  it("the needs-you heads keep the bold amber for themselves", () => {
    expect(STATE_HEAD.needs_yes.tone).toBe("ask");
    expect(STATE_HEAD.needs_answer.tone).toBe("ask");
    expect(STATE_HEAD.hit_limit.tone).not.toBe("ask");
    expect(STATE_HEAD.hit_limit.tone).not.toBe("bad");
  });
});
