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
 * One body field IS cleaned here (contract revision 3): a change target's
 * `path` and `creativeRef` (see `cleanChangeTarget`). The view is copied,
 * never mutated, and only when the target carries either key.
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
  if (value.kind === "change" && isRecord(value.body) && isRecord(value.body.target)) {
    const target = value.body.target;
    if ("path" in target || "creativeRef" in target) {
      return { ...value, body: { ...value.body, target: cleanChangeTarget(target) } } as unknown as AnswerViewV1;
    }
  }
  return value as unknown as AnswerViewV1;
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
