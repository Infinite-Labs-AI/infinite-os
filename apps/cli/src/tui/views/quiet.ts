// The quiet view (terminal-r4 "Steps only"): behind-the-scenes calls (a
// playbook read, a capability check). It prints only its step line; a degraded
// step prints in amber. Nothing else, so a quiet call never crowds the answer.
import { fitLine, paint, viewText } from "./primitives.js";
import { bodyOf } from "./things.js";
import type { KindRenderer } from "./types.js";

export const renderQuiet: KindRenderer<"quiet"> = (view, ctx) => {
  const body = bodyOf(view);
  const stepLine = viewText(body.stepLine);
  return {
    detail: stepLine ? [paint(fitLine(stepLine, ctx.width), body.degraded === true ? "warning" : "muted", ctx)] : [],
    footnotes: [],
    keys: [],
    okKey: null,
    rowCount: 0
  };
};
