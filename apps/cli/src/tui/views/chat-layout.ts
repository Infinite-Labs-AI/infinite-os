// How the latest chat turn is laid out (one-column default, 2026-10-15).
//
// A turn is ONE column at every width, as a chat reads: the question, then
// each tool call as one compact line, then the answer's words in full, then
// each card under them at the whole width. Finished, it prints into
// scrollback the same way, its calls kept in place.
//
// Two columns (answer left, cards right, the Steps strip below: the r4
// layout) are for a turn that asks for them (`asksSideBySide`): words in the
// question that ask for a side-by-side view, or a `compare` card.
import type { AnswerViewV1 } from "@infinite-os/types";

import type { Msg } from "../types.js";

/**
 * Words in a question that ask for two columns. Deliberately narrow: "compare"
 * alone is an everyday word ("compared to last week") and does not split a
 * turn; a `compare` card does.
 */
const SIDE_BY_SIDE_WORDS = /\bside[\s-]by[\s-]side\b|\b(?:two|2)[\s-]col(?:umn)?s?\b|\bsplit[\s-]view\b|\bdashboard\b/iu;

/** The latest question of the turn (the last user line that is not a `/` command). */
function latestQuestion(messages: readonly Msg[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index]!;
    if (msg.role === "user" && msg.kind === undefined && !msg.text.trimStart().startsWith("/")) {
      return msg.text;
    }
  }
  return "";
}

/**
 * Whether this turn asked for two columns: its question says so
 * (`side by side`, `two columns`, `split view`, `dashboard`), or one of its
 * cards is a `compare`.
 */
export function asksSideBySide(messages: readonly Msg[], views: readonly Pick<AnswerViewV1, "kind">[] = []): boolean {
  return SIDE_BY_SIDE_WORDS.test(latestQuestion(messages)) || views.some((view) => view.kind === "compare");
}

/**
 * The key bar's words for `tab` when nothing else names it: `switch side` on a
 * turn drawn side by side (`twoColumns`); `to card` in one column, which has
 * no sides (tab moves the keys onto the turn's card).
 */
export function tabSideWords(twoColumns = false): string {
  return twoColumns ? "switch side" : "to card";
}
