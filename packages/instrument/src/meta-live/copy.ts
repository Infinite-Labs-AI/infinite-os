// Every word a customer reads about the Meta delivery check lives here.
//
// The rule these sentences follow: name the SYMPTOM, the CAUSE, the exact REMEDY, and the
// CONSEQUENCE of ignoring it. "Pixel unhealthy" is useless — the failure this check exists for looks
// perfectly healthy from every other angle, so the message has to carry the whole explanation or the
// customer will believe Events Manager's green dot over us.
import { META_TRAFFIC_PERMISSIONS_HELP, type MetaDeliveryFinding } from "./config-probe.js"

/** Events Manager path, written once so every message says the same thing. */
const TRAFFIC_PERMISSIONS_PATH =
  "Events Manager → Data sources → your pixel → Settings → Traffic permissions"

/** What is lost while the block stands. Appended to every blocked message. */
const BLOCKED_CONSEQUENCE =
  "Until then the browser pixel sends nothing and no _fbp/_fbc cookie is written, so ad clicks " +
  "arrive with no click id and Meta cannot attribute any conversion to a specific ad — the spend " +
  "still happens, the attribution does not, and the creative gets blamed."

/**
 * `masked` keeps whole pixel ids out of logs and shared terminal output without making the message
 * useless — the customer recognises their own pixel from the first six digits.
 */
export function maskPixelId(pixelId: string): string {
  return pixelId.length <= 10 ? pixelId : `${pixelId.slice(0, 6)}…${pixelId.slice(-4)}`
}

/** The first and most important line of the finding: what to do about it. */
export function metaDeliveryHeadline(finding: MetaDeliveryFinding): string {
  const pixel = maskPixelId(finding.pixelId)
  switch (finding.kind) {
    case "blocked":
      return (
        `Meta pixel ${pixel} is BLOCKED FROM TRANSMITTING on ${finding.domain} ` +
        `(blockReason=${finding.blockReason}, lockWebpage=${finding.lockWebpage}). ` +
        `The pixel still loads, still registers and still counts events locally — Meta drops every ` +
        `send at its end. Add ${finding.domain} to the pixel's allow list at ` +
        `${TRAFFIC_PERMISSIONS_PATH}: ${META_TRAFFIC_PERMISSIONS_HELP}. ${BLOCKED_CONSEQUENCE}`
      )
    case "source_blocked":
      return (
        `${finding.domain} is on Meta pixel ${pixel}'s BLOCK list, so every browser event from it is ` +
        `discarded. Remove ${finding.domain} from the blocked domains at ${TRAFFIC_PERMISSIONS_PATH}: ` +
        `${META_TRAFFIC_PERMISSIONS_HELP}. ${BLOCKED_CONSEQUENCE}`
      )
    case "pixel_not_found":
      return (
        `Meta serves no configuration for pixel ${pixel} — the id on ${finding.domain} does not ` +
        `resolve to a pixel (HTTP 404). Check the id in Events Manager → Data sources; a wrong or ` +
        `deleted id means every event on this site has always gone nowhere.`
      )
    case "unknown":
      return (
        `Could not check whether Meta pixel ${pixel} is allowed to transmit on ${finding.domain} — ` +
        `${finding.detail}. This is NOT a pass: rerun the check before trusting the pixel.`
      )
    case "allowed":
      return (
        `Meta pixel ${pixel} is allowed to transmit on ${finding.domain} (no traffic-permission ` +
        `block). That proves Meta will ACCEPT sends from this domain; it is not proof an event ` +
        `arrived — only Events Manager → Test Events shows that.`
      )
  }
}

/** True when the finding is a definite negative the customer must act on. */
export function isMetaDeliveryFailure(finding: MetaDeliveryFinding): boolean {
  return (
    finding.kind === "blocked" ||
    finding.kind === "source_blocked" ||
    finding.kind === "pixel_not_found"
  )
}

/** Lane reason when nothing on the page initialises a Meta pixel. */
export const META_NO_PIXEL_ON_PAGE_REASON =
  "no fbq('init', …) was found on the loaded page, so there is no Meta pixel to check"

/**
 * The reason an ALLOWED result is still `not_verifiable`. Meta has no install-time read-back; this
 * check can prove a pixel is SILENCED but never that an event landed, and saying otherwise would
 * mint the false green the whole check exists to prevent.
 */
export function metaAllowedReason(findings: MetaDeliveryFinding[]): string {
  const pixels = findings.map((finding) => maskPixelId(finding.pixelId)).join(", ")
  return (
    `delivery is not blocked for ${pixels} (Traffic Permissions checked live), but Meta has no ` +
    `install-time read-back — open Events Manager → Test Events to confirm an event arrived`
  )
}
