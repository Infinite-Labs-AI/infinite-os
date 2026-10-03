// The caption gate (round 4; the same rule in both renderers): an answer that
// comes with a view (a card) shows at most two sentences above it. The rest
// is FOLDED, never dropped, rewritten or summarised: the terminal draws a dim
// `… more (?)` line under the two sentences, `?` opens the rest in the live
// turn, and scrollback prints the folded rest under the view as a dim
// paragraph. A turn with no view is never touched.
//
// A sentence ends at `.`, `!`, `?` or `…` (and any closing markdown or quote
// right after it) followed by whitespace and then an uppercase letter, a
// digit, an opening quote or bracket, or the end of the text. A line break
// followed by a non-empty line ends one too, and every markdown list item is
// one (so is a markdown table or a fenced block: never cut between its rows). Not a break: decimals and money (`$12.34`, `1.5x`, `v1.2`), `e.g.`,
// `i.e.`, `vs.`, `etc.`, `a.m.`, `p.m.`, single-letter initials, dots inside a
// host, an email or a file name (`example.com/a.b`), ranges (`Sep 29–30`).
import type { Msg } from "../types.js";

/** At most this many sentences show above a view. */
export const CAPTION_SENTENCES = 2;

/** What the gate shows, verbatim from the start of the text, and the folded rest (null = nothing folded). */
export interface CaptionGate {
  shown: string;
  rest: string | null;
}

const ABBREVIATIONS = new Set(["e.g.", "i.e.", "vs.", "etc.", "a.m.", "p.m."]);
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/u;
// A terminator, then any closing markdown, bracket or quote, then whitespace.
const TERMINATOR = /[.!?…]+[*_`)\]"'”’]*(?=\s)/gu;
const OPENS_SENTENCE = /^[\p{Lu}\p{N}"'“‘«([]/u;

/** Whether the word that ends at a terminator is an abbreviation or an initial (no break). */
function isAbbreviation(word: string): boolean {
  const bare = word.replace(/^[("'“‘[*_`]+/u, "").replace(/[*_`)\]"'”’]+$/u, "");
  const lower = bare.toLowerCase();
  return ABBREVIATIONS.has(lower) || /^\p{L}\.$/u.test(bare) || /^(?:\p{L}\.){2,}$/u.test(bare);
}

/** Where each sentence of `text` ends (offsets just past its last character, ascending). */
export function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  let offset = 0;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const start = offset;
    offset += line.length + 1;
    const content = line.replace(/\s+$/u, "");
    if (!content.trim()) continue;
    // A markdown table or a fenced block is ONE, like a list item: it is never cut between its rows.
    const block = blockEnd(lines, index);
    if (block > index) {
      for (let next = index + 1; next <= block; next += 1) offset += lines[next]!.length + 1;
      ends.push(offset - 1 - (lines[block]!.length - lines[block]!.replace(/\s+$/u, "").length));
      index = block;
      continue;
    }
    if (!LIST_ITEM.test(line)) {
      for (const match of content.matchAll(TERMINATOR)) {
        const after = match.index + match[0].length;
        const next = content.slice(after).trimStart();
        if (!next || !OPENS_SENTENCE.test(next)) continue;
        const word = /(\S+)$/u.exec(content.slice(0, after))?.[1] ?? "";
        if (isAbbreviation(word)) continue;
        ends.push(start + after);
      }
    }
    // A non-empty line ends a sentence where it ends: before a line break that
    // a non-empty line follows, or at the end of the text. A list item is one.
    ends.push(start + content.length);
  }
  return ends;
}

/** The last line of the table or fenced block that starts at `index` (`index` itself when none starts there). */
function blockEnd(lines: readonly string[], index: number): number {
  const line = lines[index]!;
  if (/^\s*\|/u.test(line)) {
    let last = index;
    while (last + 1 < lines.length && /^\s*\|/u.test(lines[last + 1]!)) last += 1;
    return last;
  }
  if (/^\s*(?:```|~~~)/u.test(line)) {
    const fence = line.trim().slice(0, 3);
    for (let last = index + 1; last < lines.length; last += 1) {
      if (lines[last]!.trim().startsWith(fence)) return last;
    }
    return lines.length - 1;
  }
  return index;
}

/** The first `max` sentences of `text`, verbatim, and the folded rest. */
export function captionGate(text: string, max = CAPTION_SENTENCES): CaptionGate {
  const ends = sentenceEnds(text);
  if (ends.length <= max) {
    return { shown: text, rest: null };
  }
  const cut = ends[max - 1]!;
  return { shown: text.slice(0, cut), rest: text.slice(cut).replace(/^\s+/u, "").replace(/\s+$/u, "") };
}

/**
 * The gate over a turn's messages: the answer's sentences count across every
 * answer message of the turn (the question, notes and tool output never
 * count). An answer past the second sentence keeps only what came before it;
 * a later one is folded whole (its text emptied, so it draws nothing). `rest`
 * is everything folded, in order, a blank line between answers.
 */
export function gateAnswerMessages(messages: readonly Msg[], max = CAPTION_SENTENCES): { messages: Msg[]; rest: string | null } {
  let used = 0;
  const rest: string[] = [];
  const shown = messages.map((msg): Msg => {
    if (msg.role !== "assistant" || msg.kind !== undefined || !msg.text.trim()) {
      return msg;
    }
    if (used >= max) {
      rest.push(msg.text.trim());
      return { ...msg, text: "" };
    }
    const gate = captionGate(msg.text, max - used);
    used += Math.min(max - used, sentenceEnds(msg.text).length);
    if (gate.rest === null) {
      return msg;
    }
    rest.push(gate.rest);
    return { ...msg, text: gate.shown };
  });
  return { messages: shown, rest: rest.length ? rest.join("\n\n") : null };
}
