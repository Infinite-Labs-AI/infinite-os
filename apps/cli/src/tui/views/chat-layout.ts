// How the latest chat turn is laid out (2026-10-15, one-column rework). Three
// layouts, chosen by a LOCAL option while the new default is reviewed: the
// shipped default does not change until it is decided.
//
//   split         today's r4 layout: from 80 columns the latest turn is two
//                 columns (answer left, cards right) with the Steps strip below.
//   flow          V1, "Claude-like": ONE column at every width. The question,
//                 then each tool step as one compact line, then the answer's
//                 words in full, then each card inline under them at the whole
//                 width. No Gantt strip and no rule between words and card.
//   flow-compact  V2: the same flow, but each card starts compact (its head and
//                 a one-line verdict) and opens in place once the keys are on
//                 it (tab). A card that asks for an OK or an answer never folds.
//
// Both flow layouts keep the two-column layout for a turn that asks for it
// (`asksSideBySide`): words in the question that ask for a side-by-side view,
// or a `compare` card.
//
// The option: `INFINITE_CHAT_LAYOUT=flow` or `INFINITE_CHAT_LAYOUT=flow-compact`
// in the environment. Unset (or anything else) is `split`.
import type { AnswerViewV1 } from "@infinite-os/types";

import type { Msg } from "../types.js";

export type ChatLayout = "split" | "flow" | "flow-compact";

/** The environment variable that picks the layout (a local option; see the header). */
export const CHAT_LAYOUT_ENV = "INFINITE_CHAT_LAYOUT";

/** The layout this process draws in: the env option, else `split` (today's default). */
export function chatLayout(env: NodeJS.ProcessEnv = process.env): ChatLayout {
  const value = (env[CHAT_LAYOUT_ENV] ?? "").trim().toLowerCase();
  return value === "flow" || value === "flow-compact" ? value : "split";
}

/** Whether the layout is one of the one-column flows (V1 or V2). */
export function isFlow(layout: ChatLayout): boolean {
  return layout !== "split";
}

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
 * The key bar's words for `tab` when nothing else names it: `switch side` in
 * the split layout and on a turn drawn side by side (`twoColumns`); `to card`
 * in the flows' one column, which has no sides (tab moves the keys onto the
 * turn's card).
 */
export function tabSideWords(layout: ChatLayout = chatLayout(), twoColumns = false): string {
  return isFlow(layout) && !twoColumns ? "to card" : "switch side";
}
