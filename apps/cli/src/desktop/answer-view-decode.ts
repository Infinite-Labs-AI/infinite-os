import {
  ANSWER_VIEW_KINDS,
  ANSWER_VIEW_LIMITS,
  ARCHIVE_ASSET_ID_PATTERN,
  ANSWER_VIEW_STATES,
  type AnswerViewV1,
  type CreativeDraftFrameV1,
  type ToolViewFrameV1
} from "@infinite-os/types";

import { terminalText } from "./terminal-text.js";

/**
 * Structural decode of the answer view contract (`@infinite-os/types`
 * `answer-view.ts`) as it arrives over the Desktop bridge.
 *
 * Decoding checks only the envelope: a known `v`, `kind` and `state`, plus the
 * fields every renderer reads first. Anything it does not recognise decodes to
 * `null`, so a newer Desktop (a new kind, a new contract version) degrades to
 * "no view" and the turn's text answer stays the answer. Unknown extra fields
 * are left in place and ignored. Kind renderers still read every body field
 * defensively and send every string through terminal text scrubbing: the
 * decoder never vouches for a value, only for the shape.
 *
 * Deviation from the plan's C8 code block: `kind` and `state` must be strings
 * before the set lookup. The plan's `KINDS.has(String(value.kind))` let
 * `kind: ["change"]` and `state: { toString() { return "done" } }` decode as
 * valid views (wave-1 adversarial review). The contract types also do not
 * enforce one level of `sections` nesting, or `legs` being required outside
 * `composite`, so kind renderers (T8) must cap recursion and check types.
 *
 * A few body fields ARE cleaned here (contract revision 3): a change target's
 * `path` and `creativeRef` (see `cleanChangeTarget`), and the short host words
 * `ListBodyV1.nameLabel`, `RecordBodyV1.status` and `LeaderV1.detail`, also in
 * a composite's sections one level deep (see `cleanShortWords`). The view is
 * copied, never mutated, and only when it carries one of those keys: a view
 * without them (an older Desktop never sends them) is returned as it came.
 * `stateReason.step` (revision 3) is bounded the same way (see
 * `cleanStateReasonStep`).
 */
const KINDS = new Set<string>(ANSWER_VIEW_KINDS);
const STATES = new Set<string>(ANSWER_VIEW_STATES);

export function decodeAnswerView(value: unknown): AnswerViewV1 | null {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.kind !== "string" ||
    !KINDS.has(value.kind) ||
    typeof value.state !== "string" ||
    !STATES.has(value.state)
  ) {
    return null;
  }
  if (
    typeof value.title !== "string" ||
    typeof value.tool !== "string" ||
    !isRecord(value.body) ||
    !isRecord(value.scope) ||
    !Array.isArray(value.caveats)
  ) {
    return null;
  }
  let body: Record<string, unknown> = value.body;
  if (value.kind === "change" && isRecord(body.target)) {
    const target = body.target;
    if ("path" in target || "creativeRef" in target) {
      body = { ...body, target: cleanChangeTarget(target) };
    }
  }
  body = cleanShortWords(value.kind, body, true);
  const stateReason = cleanStateReasonStep(value.stateReason);
  if (body === value.body && stateReason === value.stateReason) return value as unknown as AnswerViewV1;
  return { ...value, body, ...(stateReason === value.stateReason ? {} : { stateReason }) } as unknown as AnswerViewV1;
}

/**
 * A state reason with its revision 3 `step` (the Steps row's short word)
 * bounded like the other short host words: scrubbed and cut to
 * `maxShortTextChars` with `…`, or withheld (the rest of the reason kept)
 * when it is not a string or scrubs to nothing. Anything else is returned
 * as it came.
 */
function cleanStateReasonStep(reason: unknown): unknown {
  if (!isRecord(reason) || !("step" in reason)) return reason;
  const { step, ...rest } = reason;
  const words = cleanShortText(step);
  return words === undefined ? rest : { ...rest, step: words };
}

const STATUS_TONES = new Set(["ok", "warn", "bad", "muted"]);

/**
 * A body with its revision 3 short words kept bounded, or the same body when
 * it carries none of them:
 * - `list` `nameLabel`, `numbers` `leaders[].detail`: scrubbed for the TTY and
 *   cut to `maxShortTextChars` with `…`; not a string, or nothing left once
 *   scrubbed, withholds the field (it is dropped, the rest kept).
 * - `record` `status`: rebuilt from `word` (cleaned the same way) and `tone`;
 *   a tone outside `StatusWordV1`'s four, or a withheld word, withholds it.
 * - `numbers` and `health` `sections`: each section's body the same way, one
 *   level only (the contract nests sections one level).
 */
function cleanShortWords(kind: string, body: Record<string, unknown>, top: boolean): Record<string, unknown> {
  let out = body;
  const set = (key: string, cleaned: unknown): void => {
    const { [key]: _dropped, ...rest } = out;
    out = cleaned === undefined ? rest : { ...rest, [key]: cleaned };
  };
  if (kind === "list" && "nameLabel" in body) set("nameLabel", cleanShortText(body.nameLabel));
  if (kind === "record" && "status" in body) set("status", cleanStatusWord(body.status));
  if (kind === "numbers" && Array.isArray(body.leaders) && body.leaders.some((leader) => isRecord(leader) && "detail" in leader)) {
    set("leaders", body.leaders.map((leader: unknown) => {
      if (!isRecord(leader) || !("detail" in leader)) return leader;
      const { detail, ...rest } = leader;
      const words = cleanShortText(detail);
      return words === undefined ? rest : { ...rest, detail: words };
    }));
  }
  if (top && (kind === "numbers" || kind === "health") && Array.isArray(body.sections)) {
    let changed = false;
    const sections = body.sections.map((section: unknown) => {
      if (!isRecord(section) || typeof section.kind !== "string" || !isRecord(section.body)) return section;
      const cleaned = cleanShortWords(section.kind, section.body, false);
      if (cleaned === section.body) return section;
      changed = true;
      return { ...section, body: cleaned };
    });
    if (changed) set("sections", sections);
  }
  return out;
}

/** Short host words scrubbed and capped, or `undefined` (withheld) when not a string or empty once scrubbed. */
function cleanShortText(value: unknown): string | undefined {
  const words = typeof value === "string" ? terminalText(value) : "";
  return words ? capChars(words, ANSWER_VIEW_LIMITS.maxShortTextChars) : undefined;
}

function cleanStatusWord(value: unknown): { word: string; tone: string } | undefined {
  if (!isRecord(value) || typeof value.tone !== "string" || !STATUS_TONES.has(value.tone)) return undefined;
  const word = cleanShortText(value.word);
  return word === undefined ? undefined : { word, tone: value.tone };
}

/**
 * A change target with its revision 3 fields kept bounded, or dropped whole
 * when malformed (never half-kept):
 * - `path`: an array of 1 to `maxTargetPathParts` strings. Each part is
 *   scrubbed for the TTY (escapes, controls and bidi gone, whitespace
 *   collapsed, ends trimmed) and capped at `maxTargetPathPartChars` with `…`.
 *   More parts, a non-string part or a part that scrubs to nothing drops the
 *   path: a shortened path would name the wrong parents.
 * - `creativeRef`: rebuilt from its one key, `archiveAssetId`, when that is
 *   an archive id (the contract's `ARCHIVE_ASSET_ID_PATTERN`: no `/`, so a URL,
 *   a data URI or a file path never passes); anything riding along is dropped.
 */
function cleanChangeTarget(target: Record<string, unknown>): Record<string, unknown> {
  const { path, creativeRef, ...rest } = target;
  const parts = cleanTargetPath(path);
  const picture = isRecord(creativeRef) && typeof creativeRef.archiveAssetId === "string" && ARCHIVE_ASSET_ID_PATTERN.test(creativeRef.archiveAssetId)
    ? { archiveAssetId: creativeRef.archiveAssetId }
    : null;
  return { ...rest, ...(picture ? { creativeRef: picture } : {}), ...(parts ? { path: parts } : {}) };
}

function cleanTargetPath(path: unknown): string[] | null {
  if (!Array.isArray(path) || path.length === 0 || path.length > ANSWER_VIEW_LIMITS.maxTargetPathParts) {
    return null;
  }
  const parts: string[] = [];
  for (const part of path) {
    const words = typeof part === "string" ? terminalText(part) : "";
    if (!words) return null;
    parts.push(capChars(words, ANSWER_VIEW_LIMITS.maxTargetPathPartChars));
  }
  return parts;
}

/** `text` cut to `max` characters (code points), the last one `…`, when it is longer. */
function capChars(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** A `tool.view` progress frame, or `null` when it is not one or its view does not decode. */
export function decodeToolViewFrame(data: unknown): ToolViewFrameV1 | null {
  if (
    !isRecord(data) ||
    data.type !== "tool.view" ||
    typeof data.viewId !== "string" ||
    typeof data.name !== "string"
  ) {
    return null;
  }
  const view = decodeAnswerView(data.view);
  return view
    ? {
        type: "tool.view",
        stage: "tool",
        message: typeof data.message === "string" ? data.message : view.title,
        viewId: data.viewId,
        name: data.name,
        view
      }
    : null;
}

/** True for any progress payload typed `tool.view`, whether or not it decodes. */
export function isToolViewFrameData(data: unknown): boolean {
  return isRecord(data) && data.type === "tool.view";
}

/** True for any progress payload typed `creative.draft`, whether or not it decodes. */
export function isCreativeDraftFrameData(data: unknown): boolean {
  return isRecord(data) && data.type === "creative.draft";
}

const DRAFT_STATUSES = new Set(["running", "done", "error"]);
/** The most pending entries a draft frame keeps (one per image being drawn). */
const MAX_DRAFT_PENDING = 64;

/**
 * A `creative.draft` progress frame (Cmd+L's image drafts, Codex or Infinite),
 * rebuilt from an allowlist: the contract's fields only, so a brief, a prompt
 * or an image URL can never ride along into the terminal. `null` when it is
 * not one or its required fields are missing.
 */
export function decodeCreativeDraftFrame(data: unknown): CreativeDraftFrameV1 | null {
  if (
    !isRecord(data) ||
    data.type !== "creative.draft" ||
    typeof data.runId !== "string" ||
    !data.runId ||
    typeof data.status !== "string" ||
    !DRAFT_STATUSES.has(data.status) ||
    !isFiniteNumber(data.count)
  ) {
    return null;
  }
  const pending = Array.isArray(data.pending)
    ? data.pending
        .filter(isRecord)
        .filter((item) => isFiniteNumber(item.startedAtMs) && (item.etaMs === null || isFiniteNumber(item.etaMs)))
        .slice(0, MAX_DRAFT_PENDING)
        .map((item) => ({ startedAtMs: item.startedAtMs as number, etaMs: item.etaMs as number | null }))
    : undefined;
  const error = isRecord(data.error) && typeof data.error.code === "string" && typeof data.error.message === "string"
    ? { code: data.error.code, message: data.error.message }
    : undefined;
  return {
    type: "creative.draft",
    runId: data.runId,
    status: data.status as CreativeDraftFrameV1["status"],
    count: data.count,
    format: typeof data.format === "string" ? data.format : "",
    aspectRatio: typeof data.aspectRatio === "string" ? data.aspectRatio : "",
    quality: typeof data.quality === "string" ? data.quality : "",
    ...(pending ? { pending } : {}),
    ...(isFiniteNumber(data.estimatedPerImageUsd) ? { estimatedPerImageUsd: data.estimatedPerImageUsd } : {}),
    ...(isFiniteNumber(data.perImageUsd) ? { perImageUsd: data.perImageUsd } : {}),
    ...(error ? { error } : {})
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
