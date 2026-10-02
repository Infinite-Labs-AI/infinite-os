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
import { maskPixelId } from "../meta-live/copy.js"

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

/** The managed `_fbc` capture is installed in a shared entry. */
export function clickIdManagedCaptureMessage(input: { file: string }): string {
  return (
    `infinite-tag's managed click-id capture runs in ${input.file}, a shared entry that loads on ` +
    `every route. On the page a visitor lands on it saves the ad's \`fbclid\` into Meta's own ` +
    `\`_fbc\` cookie — last click wins — even when the pixel itself is blocked or still waiting, so ` +
    `a later conversion can still be credited to the ad. That is the setup being right; it is not ` +
    `proof a cookie was written on your live site.`
  )
}

export function clickIdUndeterminedMessage(): string {
  return (
    `No \`fbq('init', …)\` was found in this repo's source, so neither click-id capture nor Meta's ` +
    `automatic events could be checked. A pixel injected by a tag manager, by the hosting edge, or by ` +
    `a dependency is invisible from here — this is "not checked", not "not needed". If you run Meta ` +
    `ads, confirm by hand that the pixel is present on your landing pages and not only on the pages ` +
    `that convert.`
  )
}

/** Where a grouped finding was seen: the named files, then how many more. */
export interface FileList {
  files: readonly string[]
  remaining: number
}

function fileList(input: FileList): string {
  const named = input.files.join(", ")
  return input.remaining > 0 ? `${named} and ${input.remaining} more` : named
}

/** A pixel infinite-tag installed without the automatic-events opt-out before init. */
export function metaAutoConfigManagedOnMessage(input: FileList & { pixelId: string; reason: string }): string {
  return (
    `The Meta pixel infinite-tag installed in ${fileList(input)} (pixel ${maskPixelId(input.pixelId)}) ` +
    `${autoConfigReasonText(input.reason)}. With automatic events on, Meta's pixel sends button ` +
    `clicks and page details from your visitors' pages on its own, which infinite-tag never turns ` +
    `on. This is infinite-tag's own managed code: re-run \`npx infinite-tag install\` to restore it, ` +
    `and do not hand-edit the managed block.`
  )
}

/** A pixel the site already had, with automatic events on. Information, never an edit. */
export function metaAutoConfigAdoptedOnMessage(input: FileList & { pixelId: string; reason: string }): string {
  return (
    `Worth checking: the Meta pixel already on your site in ${fileList(input)} (pixel ` +
    `${maskPixelId(input.pixelId)}) ${autoConfigReasonText(input.reason)}, so Meta collects automatic ` +
    `events (button clicks, page details) from your pages. infinite-tag leaves pixels it did not ` +
    `install untouched. To turn them off, add \`fbq('set', 'autoConfig', false, '<pixel id>')\` ` +
    `before that pixel's \`fbq('init', …)\`. Automatic events are not what improves matching; ` +
    `Manual Advanced Matching is.`
  )
}

export function metaAutoConfigOffMessage(input: FileList & { pixelId: string }): string {
  return (
    `The Meta pixel in ${fileList(input)} (pixel ${maskPixelId(input.pixelId)}) switches automatic ` +
    `events off before init. That is the setup being right in the source; it is not a check of the ` +
    `live page.`
  )
}

export function metaAutoConfigUndeterminedMessage(input: Partial<FileList> & { pixelId?: string; reason: string }): string {
  if (!input.pixelId || !input.files || input.files.length === 0) {
    return (
      `No \`fbq('init', …)\` was found in this repo's source, so Meta's automatic events could not ` +
      `be checked. A pixel loaded by a tag manager or the hosting edge is invisible from here — this ` +
      `is "not checked", not "off".`
    )
  }
  return (
    `Could not tell whether Meta's automatic events are off for pixel ${maskPixelId(input.pixelId)} ` +
    `in ${fileList({ files: input.files, remaining: input.remaining ?? 0 })}: ${undeterminedReasonText(input.reason)}. ` +
    `This is "not checked", not "off".`
  )
}

function undeterminedReasonText(reason: string): string {
  switch (reason) {
    case "autoconfig_unreadable":
      return "its autoConfig call does not use literal values"
    case "opt_out_commented":
      return "its only `fbq('set', 'autoConfig', false, …)` sits inside a comment, so it may never run"
    default:
      return "its init could not be read"
  }
}

export function metaSnippetCensusMessage(input: FileList & { issues: readonly string[] }): string {
  return (
    `infinite-tag's managed Meta block in ${fileList(input)} is not the shape it writes: ` +
    `${input.issues.join("; ")}. A duplicated init double-counts every page view, a second capture or ` +
    `matching accessor means the block was pasted twice (only the first copy runs, so an edited ` +
    `second copy silently does nothing), and a capture after init lets the pixel read \`_fbc\` ` +
    `before this click is in it. Re-run \`npx infinite-tag install\` to rewrite the block, and keep ` +
    `one managed block per page.`
  )
}

function autoConfigReasonText(reason: string): string {
  switch (reason) {
    case "opted_in":
      return "explicitly turns Meta's automatic events ON (`autoConfig` true)"
    case "opt_out_after_init":
      return "turns automatic events off only AFTER `init`, which Meta ignores"
    default:
      return "has no `fbq('set', 'autoConfig', false, …)` before `init`, so Meta's automatic events are ON by default"
  }
}

// ---- Wizard-era checks (lane O9): provider census, PostHog config, host guard, sensitive pages,
// Meta event id. Same rule: symptom, cause, remedy, consequence; `likely` findings lead with
// "Worth checking:".

function maskId(value: string): string {
  if (value.length <= 10) return `${value.slice(0, 3)}...`
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

export function providerDuplicateInitMessage(input: {
  tool: string
  id: string
  places: readonly string[]
  sameFile: boolean
}): string {
  const where = input.places.join(", ")
  if (input.sameFile) {
    return (
      `${input.tool} ${maskId(input.id)} is initialised ${input.places.length} times in one page (${where}). Every ` +
      `initialisation sends its own page view, so each visit is counted ${input.places.length} times and every rate ` +
      `built on page views is wrong by that factor. Keep one and delete the others.`
    )
  }
  return (
    `Worth checking: ${input.tool} ${maskId(input.id)} is initialised in a shared entry that loads on every page AND ` +
    `again elsewhere (${where}). On any page that renders both, every visit is counted twice. If the second one ` +
    `never renders on the same page as the first, ignore this line.`
  )
}

export function providerManagedAndAdoptedMessage(input: { tool: string; managed: string; adopted: string; sameFile: boolean }): string {
  return (
    `${input.sameFile ? "" : "Worth checking: "}${input.tool} is started twice: by infinite-tag's managed code in ` +
    `${input.managed} and by the site's own code in ${input.adopted}. Two owners of one tool double-count every ` +
    `page view and fight over its settings. Keep one: a plan line can remove the duplicate the site no longer needs.`
  )
}

export function providerGtmAndGtagMessage(input: { container: string; ga4Id: string; file: string }): string {
  return (
    `Worth checking: Google Tag Manager (${input.container}) and a hand-written gtag('config', ${maskId(input.ga4Id)}) ` +
    `both load in ${input.file}. If the container also fires a GA4 tag for the same id, every page view is counted ` +
    `twice. The container's contents are not read here; open it in Tag Manager and check.`
  )
}

export function providerMultipleIdsMessage(input: { tool: string; ids: ReadonlyArray<{ id: string; file: string }> }): string {
  return (
    `Worth checking: ${input.tool} is set up with ${input.ids.length} different ids ` +
    `(${input.ids.map((entry) => `${maskId(entry.id)} in ${entry.file}`).join(", ")}). That can be deliberate ` +
    `(two properties), or a leftover that sends half your data to an account nobody reads.`
  )
}

export function posthogUnreadableMessage(input: { file: string; line: number }): string {
  return (
    `The PostHog init at ${input.file}:${input.line} takes its options from a variable or expression, so its proxy, ` +
    `page-view and privacy settings could not be read from source. This is "not checked", not "fine".`
  )
}

export function posthogNotProxiedMessage(input: { file: string; line: number; apiHost: string }): string {
  return (
    `Worth checking: the site's PostHog at ${input.file}:${input.line} sends straight to ${input.apiHost}. Ad blockers ` +
    `drop requests to PostHog's own hosts, so a share of your visitors never reach PostHog at all. A plan line can ` +
    `route it through /ingest on your own domain (infinite-tag changes the site's PostHog only with your OK).`
  )
}

export function posthogSpaPageviewsMessage(input: { file: string; line: number }): string {
  return (
    `Worth checking: the site's PostHog at ${input.file}:${input.line} has neither \`defaults: '2025-05-24'\` (or ` +
    `newer) nor \`capture_pageview: 'history_change'\`, so on a single-page app client-side navigations may not be ` +
    `counted as page views and every page after the first goes missing.`
  )
}

export function posthogRegionMismatchMessage(input: { file: string; line: number; served: string; expected: string }): string {
  return (
    `The site's PostHog at ${input.file}:${input.line} sends to ${input.served}, but the connected PostHog project ` +
    `lives at ${input.expected}. Events sent to the wrong region land in no project you can read. Point api_host at ` +
    `the connected project's region.`
  )
}

export function posthogPrivacyChangedMessage(input: { file: string; option: string; before: string; after: string }): string {
  return (
    `\`${input.option}\` in ${input.file} changed from ${input.before} to ${input.after}. Session replay and click ` +
    `capture are the site owner's privacy and billing choices; infinite-tag never changes them without an approved ` +
    `sensitive-pages plan line. Revert this edit.`
  )
}

export function hostGuardMissingMessage(input: { tool: string; file: string; line: number; strict: boolean }): string {
  return (
    `${input.strict ? "" : "Worth checking: "}the site's own ${input.tool} at ${input.file}:${input.line} starts on every ` +
    `host — preview deploys (*.vercel.app), localhost and staging included — so previews and local testing send ` +
    `data into the real ${input.tool} and inflate its numbers. A plan line can wrap this init in infinite-tag's ` +
    `preview guard, which always lets your production domain through.`
  )
}

export function hostGuardPresentMessage(input: { tool: string; file: string; line: number }): string {
  return `The site's ${input.tool} at ${input.file}:${input.line} starts behind a host check, so previews stay silent.`
}

export function hostGuardSilencesProductionMessage(input: { tool: string; file: string; line: number; hosts: readonly string[] }): string {
  return (
    `The host check in front of ${input.tool} at ${input.file}:${input.line} does not let ${input.hosts.join(", ")} ` +
    `through, so the production site would send nothing. Production must always be exempt (decision 3): add the ` +
    `host to the guard's exempt list.`
  )
}

export function sensitivePagesMessage(input: { routes: readonly string[]; remaining: number }): string {
  const more = input.remaining > 0 ? ` and ${input.remaining} more` : ""
  return (
    `Worth checking: PostHog session replay and click capture are on for ${input.routes.length + input.remaining} ` +
    `sensitive page${input.routes.length + input.remaining === 1 ? "" : "s"} (${input.routes.join(", ")}${more}). ` +
    `Recordings of login, payment and confirmation pages can capture what people type there. A plan line can turn ` +
    `replay and click capture off on those pages only; nothing changes without your OK.`
  )
}

export function sensitivePagesHandledMessage(input: { file: string }): string {
  return `PostHog in ${input.file} already turns replay or click capture off for sensitive pages.`
}

export function metaEventIdPageBuiltMessage(input: { file: string; line: number }): string {
  return (
    `A Meta event id is built in the page at ${input.file}:${input.line}. Meta merges a browser event with its server ` +
    `twin only when both carry the SAME id, and the page cannot know the id the server sent — so this event is ` +
    `either counted twice or, when the server sent nothing, it is a phantom conversion. Fire the browser event only ` +
    `with the \`metaEventId\` the server returned (\`infiniteMetaMirror(metaEventId)\`), and stay silent when it is null.`
  )
}

export function metaEventIdUndeterminedMessage(input: { file: string; line: number }): string {
  return (
    `A Meta event id at ${input.file}:${input.line} comes from a variable, so whether it is the \`metaEventId\` the ` +
    `server returned could not be read from source. Check it by hand.`
  )
}

export function metaStandardOnClickMessage(input: { file: string; line: number; event: string }): string {
  return (
    `\`fbq('track', '${input.event}')\` fires from a click handler at ${input.file}:${input.line}. A click is not a ` +
    `${input.event}: it fires before the form validates or the payment succeeds, so Meta optimises your ads for ` +
    `clicks that never converted. Report the conversion from the server after it succeeds (\`reportInfiniteOutcome\`) ` +
    `and let the browser mirror it only with the server's \`metaEventId\`.`
  )
}
