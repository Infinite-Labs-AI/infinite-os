// Every word a customer reads about the setup checks lives here.
//
// Same rule the Meta delivery copy follows: name the SYMPTOM, the CAUSE, the exact REMEDY, and the
// CONSEQUENCE of ignoring it. These defects all look healthy from every other angle — the page
// renders, the tag installs, the lanes verify — so the sentence has to carry the whole explanation
// or the customer will believe the green rows over us.
//
// The `likely` findings lead with "Worth checking:" and say plainly what would make them wrong. A
// check that accuses confidently and is wrong once gets muted forever, and a muted check is worse
// than no check at all.
import type { ConversionLane } from "./contract.js"

export function describeLane(lane: ConversionLane): string {
  return `\`${lane.selector}\` on ${lane.event}`
}

/** The night's bug: the attribute is on a control inside the form, not on the form. */
export function wrongElementMessage(input: {
  value: string
  tag: string
  firing: readonly ConversionLane[]
  missed: readonly ConversionLane[]
  file: string
  line: number
}): string {
  const missed = input.missed.map(describeLane).join(", ")
  const firing = input.firing.map(describeLane).join(", ")
  const wanted = input.missed[0]?.requiredTag ?? "form"
  return (
    `\`data-conversion="${input.value}"\` is on a <${input.tag}> INSIDE a <${wanted}> at ` +
    `${input.file}:${input.line}. The runtime reads this attribute through more than one listener: ` +
    `${firing} matches here, and ${missed} does not, because that lane requires the attribute to be ` +
    `on the <${wanted}> element itself. So this is counted the moment the control is CLICKED — ` +
    `before the form validates, before it posts, and whether or not it ever succeeds — instead of ` +
    `when the ${wanted} is submitted. Move the attribute onto the enclosing <${wanted}> tag and ` +
    `leave the control unmarked. Until you do, this ${wanted}'s numbers count attempts as ` +
    `completions: they are wrong in the flattering direction, a broken submit shows up as a healthy ` +
    `conversion rate, and \`infinite-tag\` will not re-offer the element because the marking step ` +
    `treats any \`data-conversion\` as already handled.`
  )
}

/** The attribute is present but spelled with a value nothing consumes. */
export function unknownValueMessage(input: {
  value: string
  tag: string
  known: readonly string[]
  file: string
  line: number
}): string {
  return (
    `\`data-conversion="${input.value}"\` at ${input.file}:${input.line} is not a value the runtime ` +
    `reads. It switches on exactly: ${input.known.map((value) => `"${value}"`).join(", ")}. Any ` +
    `other value is inert — the element looks marked to a reviewer AND to \`infinite-tag\`, whose ` +
    `marking step skips anything already carrying \`data-conversion\`, so it will never be proposed ` +
    `for marking either. Change it to one of the values above if this <${input.tag}> is a conversion, ` +
    `or delete the attribute and re-run \`npx infinite-tag harness\` so it can be marked properly. ` +
    `Left as is, this element is silently untracked and looks tracked, which is the one state no ` +
    `report will ever flag.`
  )
}

/** The attribute is there, but source cannot say what it evaluates to. */
export function unreadableConversionMessage(input: { tag: string; file: string; line: number }): string {
  return (
    `A <${input.tag}> at ${input.file}:${input.line} carries \`data-conversion\` with a computed ` +
    `value, so this check cannot tell which lane it lands in. That is not a pass and not a failure: ` +
    `open the page in a browser, click the control, and confirm in the Infinite ledger that exactly ` +
    `one event lands and it is the one you meant.`
  )
}

export function contractUnreadableMessage(): string {
  return (
    `The \`data-conversion\` contract could not be read out of this build's browser runtime, so no ` +
    `placement could be checked. This is NOT "nothing wrong" — it is a check that did not run. ` +
    `Re-install \`infinite-tag\` and re-run; if it persists, report it with your infinite-tag version.`
  )
}

/** A form that submits and says nothing. Deliberately phrased as a question, not a verdict. */
export function silentFormMessage(input: {
  file: string
  line: number
  submitVia: string
  leadSignal: string
}): string {
  return (
    `Worth checking: the <form> at ${input.file}:${input.line} submits (${input.submitVia}) and ` +
    `emits no conversion event — there is no \`data-conversion\` on the form or anywhere inside it, ` +
    `no \`data-analytics-cta-id\` on its submit control, and no analytics call in this file. It ` +
    `looks like a lead form (${input.leadSignal}). A form like this is usually the most valuable ` +
    `event on the site and the easiest one to miss, because a missing event is indistinguishable ` +
    `from nobody filling it in — the harness's receipt lanes can only ask whether an event arrived, ` +
    `and nothing here ever tries to send one. If it IS a conversion, add \`data-conversion="signup"\` ` +
    `to the <form> tag itself (not to the button — see the placement check) and re-run verify. If it ` +
    `is NOT — search, filtering, login, newsletter, comments — ignore this line; this check writes ` +
    `nothing and changes nothing. Ignored, the cost is that every submission stays invisible, so ads ` +
    `and pages that actually produce customers cannot be told apart from ones that produce nothing.`
  )
}

export function formUndeterminedMessage(input: { file: string; line: number }): string {
  return (
    `The <form> at ${input.file}:${input.line} has no conversion marking, and this file already ` +
    `calls an analytics API directly, so whether that call covers this form's submit could not be ` +
    `determined from source. Check the handler by hand; do not assume either way.`
  )
}

const FBC_GUIDANCE =
  "Meta's own guidance is explicit: save the _fbp and _fbc cookies as early as possible, and do " +
  "not retrieve them only from down-funnel events."

/** The pixel exists, but only where a visitor ARRIVES is where the click id can be captured. */
export function clickIdNotAtLandingMessage(input: {
  initFiles: readonly string[]
  sharedCandidates: readonly string[]
}): string {
  return (
    `A Meta pixel initialises only in page-scoped files (${input.initFiles.join(", ")}), not in a ` +
    `shared entry point. Meta writes the \`_fbc\` click-id cookie from the \`fbclid\` parameter on ` +
    `the URL of the page the pixel runs on, and an ad click puts \`fbclid\` on the LANDING url only ` +
    `— by the time a visitor reaches a conversion or thank-you page it is gone, and the pixel there ` +
    `has nothing to save. ${FBC_GUIDANCE} Move the pixel bootstrap into the entry the whole site ` +
    `loads (${input.sharedCandidates.join(" or ")}) so it runs on the first page a visitor lands on. ` +
    `Until then every conversion you send reaches Meta with no click id: Meta cannot attribute it to ` +
    `the ad that produced it, the campaign reads as unprofitable, and the creative gets blamed for ` +
    `spend that actually worked.`
  )
}

/** Multi-page site where some pages an ad can land on never boot the pixel. */
export function clickIdMissingPagesMessage(input: {
  withPixel: readonly string[]
  withoutPixel: readonly string[]
  remaining: number
}): string {
  const missing = input.withoutPixel.join(", ")
  const more = input.remaining > 0 ? ` and ${input.remaining} more` : ""
  return (
    `A Meta pixel initialises on ${input.withPixel.join(", ")} but NOT on ${missing}${more}. Any of ` +
    `those pages can be an ad's landing page — ads link deep, not only to the home page — and the ` +
    `\`fbclid\` on that first URL is the only chance to write the \`_fbc\` click id. A visitor who ` +
    `lands on an uninstrumented page keeps no click id for the rest of the session, no matter how ` +
    `well instrumented the later pages are. ${FBC_GUIDANCE} Re-run \`npx infinite-tag harness\` so ` +
    `every page gets the same managed block, or add the bootstrap to the pages above by hand. ` +
    `Ignored, the conversions those visitors produce arrive at Meta unattributable, and the ads that ` +
    `sent them look like the ads that do not work.`
  )
}

export function clickIdPresentMessage(input: { file: string }): string {
  return (
    `A Meta pixel initialises in ${input.file}, a shared entry that loads on every route, so it is ` +
    `present on the first page a visitor lands on and can read \`fbclid\` into \`_fbc\` there. That ` +
    `is the setup being right; it is not proof a cookie was written — a pixel blocked by Traffic ` +
    `Permissions writes no \`_fbp\`/\`_fbc\` at all, which is what the \`meta\` verification lane ` +
    `checks separately.`
  )
}

export function clickIdUndeterminedMessage(): string {
  return (
    `No \`fbq('init', …)\` was found in this repo's source, so click-id capture could not be ` +
    `checked. A pixel injected by a tag manager, by the hosting edge, or by a dependency is invisible ` +
    `from here — this is "not checked", not "not needed". If you run Meta ads, confirm by hand that ` +
    `the pixel is present on your landing pages and not only on the pages that convert.`
  )
}
