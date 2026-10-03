// Wave 3 r1 (TJ-9): a turn committed to scrollback (a finished turn too tall
// for the live region, or the turn before a new line) never offers a key:
// no key acts there. Its focused view is drawn as scrollback, so a table
// names what it hid in words (`+ CPM hidden`), never `→ to see`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnswerViewV1 } from "@infinite-os/types";
import { describe, expect, it } from "vitest";

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { stripAnsi } from "../lib/text.js";
import { resolveTheme } from "../theme.js";
import type { Msg } from "../types.js";
import { resolveViewKey, viewFocusAfterTurnDone } from "./focus.js";
import { renderCommittedTurn, renderLiveTurn } from "./layout.js";

const theme = resolveTheme({});
const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const fixture = (name: string): AnswerViewV1 => decodeAnswerView(JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")))!;
const messages: Msg[] = [{ role: "user", text: "how are the ads doing?" }, { role: "assistant", text: "Here they are." }];

describe("a committed turn names no key (TJ-9)", () => {
  for (const name of ["numbers-ads", "numbers-week-today", "meta-level-ads"]) {
    for (const width of [48, 60, 80]) {
      it(`${name} at ${width} columns: the live turn may say → to see, the committed copy never does`, () => {
        const view = fixture(name);
        const engaged = resolveViewKey("", viewFocusAfterTurnDone(view, { open: true, watch: true, retry: false }), { tab: true });
        const live = renderLiveTurn({ messages, views: [view], focus: engaged, width, color: false, theme, timeZone: "UTC" }).lines.map(stripAnsi).join("\n");
        const committed = renderCommittedTurn({ messages, views: [view], focus: engaged, width, color: false, theme, timeZone: "UTC" }).map(stripAnsi).join("\n");
        if (live.includes("→ to see")) expect(committed).toMatch(/hidden/u);
        expect(committed).not.toMatch(/→ to see|j k|m for more|\bc copy\b|\(o\)/u);
        for (const line of committed.split("\n")) expect(line.length, line).toBeLessThanOrEqual(width);
      });
    }
  }
});
