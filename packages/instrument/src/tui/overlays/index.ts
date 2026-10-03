// The overlay for each ask kind (a missing kind does not compile).
import type { AskKind } from "../../wizard/contracts/asks.js"
import { agentQuestionsOverlay } from "./agent-questions.js"
import { confirmOverlay } from "./confirm.js"
import { linkCodeOverlay } from "./link-code.js"
import { mergeReadyOverlay } from "./merge-ready.js"
import { multiOverlay } from "./multi.js"
import { planOverlay } from "./plan.js"
import { singleOverlay } from "./single.js"
import { teammateCommentsOverlay } from "./teammate-comments.js"
import { textOverlay } from "./text.js"
import { ttyHandoverOverlay } from "./tty-handover.js"
import type { Overlay } from "./types.js"

// Each entry's state type is private to its overlay; the UI keeps it opaque.
type AnyOverlay<K extends AskKind> = Overlay<K, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export const OVERLAYS: { readonly [K in AskKind]: AnyOverlay<K> } = {
  "link-code": linkCodeOverlay,
  confirm: confirmOverlay,
  single: singleOverlay,
  multi: multiOverlay,
  text: textOverlay,
  plan: planOverlay,
  "agent-questions": agentQuestionsOverlay,
  "teammate-comments": teammateCommentsOverlay,
  "merge-ready": mergeReadyOverlay,
  "tty-handover": ttyHandoverOverlay
}

export { answered } from "./types.js"
export type { Overlay, OverlayContext, OverlayView } from "./types.js"
