import {
  ANSWER_VIEW_KINDS,
  ANSWER_VIEW_STATES,
  type AnswerViewV1,
  type ToolViewFrameV1
} from "@infinite-os/types";

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
 */
const KINDS = new Set<string>(ANSWER_VIEW_KINDS);
const STATES = new Set<string>(ANSWER_VIEW_STATES);

export function decodeAnswerView(value: unknown): AnswerViewV1 | null {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    !KINDS.has(String(value.kind)) ||
    !STATES.has(String(value.state))
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
  return value as unknown as AnswerViewV1;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
