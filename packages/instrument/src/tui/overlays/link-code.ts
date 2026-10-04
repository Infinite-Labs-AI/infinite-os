// `link-code` (§3d.3): display only. Shows the 4-digit code the Infinite app's approval card shows, so the
// user can check they match. ESC cancels (`__cancelled__`); approval closes it from the step's side.
import { ASK_CANCELLED } from "../../wizard/contracts/asks.js"
import type { Overlay } from "./types.js"
import { OVERLAY_TEXT_CAPS } from "./types.js"

export const linkCodeOverlay: Overlay<"link-code", Record<string, never>> = {
  kind: "link-code",
  init: () => ({}),
  render(payload, _state, ctx) {
    const s = ctx.styles
    const code = payload.code.replace(/[^0-9]/g, "").split("").join(" ")
    return {
      heading: "Link to Infinite",
      question: "Approve this in the Infinite app, and check the code there matches this one.",
      body: [
        `Site: ${s.bold(ctx.sanitize(payload.site.repoLabel, OVERLAY_TEXT_CAPS.label))}`,
        // §3y P3-9: a single-app repo's app root is "."; it is never printed.
        payload.site.appRoot === "." || payload.site.appRoot === ""
          ? `Folder: ${s.bold(ctx.sanitize(payload.site.folderLabel, OVERLAY_TEXT_CAPS.label))}`
          : `Folder: ${s.bold(ctx.sanitize(payload.site.folderLabel, OVERLAY_TEXT_CAPS.label))} (app: ${ctx.sanitize(payload.site.appRoot, OVERLAY_TEXT_CAPS.label)})`,
        "",
        `   ${s.bold(s.accent(code))}`,
        "",
        s.dim(`${ctx.spinner} waiting for you to approve it in the Infinite app…`)
      ],
      keys: ["ESC cancel"]
    }
  },
  onKey(_payload, state, key) {
    if (key.name === "escape") return { state, answer: ASK_CANCELLED }
    return { state }
  }
}
