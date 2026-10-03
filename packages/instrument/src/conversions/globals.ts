// The managed helper globals: the bytes the site's own code calls (decisions 9 and 13, §3j.6).
//
// infinite-tag is NOT a runtime dependency of a customer's site, so "the helpers ship inside infinite-tag"
// means MANAGED CODE infinite-tag writes (scout S5 fact 16): window globals in the managed block (static
// HTML and Vite) or in the Next bootstrap, plus typed, no-op-safe wrappers exported from the managed Next
// module. Nothing here runs on its own: every global waits for the site's code to call it.
//
//   infiniteTrack(name, props?, { gate? })                 ./track.ts
//   infiniteTrackThenNavigate(event, hrefOrAnchor, name, props?)  ./navigate.ts
//   infiniteIdentify(id) / infiniteReset()                 ./identify.ts
//   infiniteMetaMirror(metaEventName, metaEventId, { wait?, identity?, budgetMs?, gate? })
//                                                          ../providers/meta-browser/mirror.ts
//   infiniteCampaign()                                     ../attribution/capture.ts (first-touch capture)
//
// Each is defined only if absent, so a second managed block (or an upgrade racing an old one) is inert.
// Consent: every helper follows the Infinite hook for the site's consent mode (the runtime's own check
// where the runtime runs), plus the optional per-call `gate`. The GA4/PostHog helpers (track, navigate,
// identify) follow the recorded decision and the consent mode but NOT the DNT/GPC default, matching the
// providers' own page views; the Meta mirror and the campaign capture keep DNT/GPC as a no. Nothing here
// adds, changes or reads a cookie banner.
import { buildLandingAttributionScript } from "../attribution/capture.js"
import type { MetaBrowserGate } from "../providers/meta-browser/consent.js"
import { consentAllowsSource } from "../providers/meta-browser/consent.js"
import { buildMetaMirrorScript } from "../providers/meta-browser/mirror.js"
import { isHtmlInjectedFramework, type InstallInstruction, type SupportedFramework, type WorkspaceInstallArtifacts } from "../types.js"

import { identifySource } from "./identify.js"
import { trackThenNavigateSource } from "./navigate.js"
import { UNSAFE_TEXT_SOURCE } from "./scrub.js"
import { helperCoreSource, trackSource } from "./track.js"

/** Every window global the helper script defines. */
export const CONVERSION_HELPER_GLOBALS = [
  "infiniteTrack",
  "infiniteTrackThenNavigate",
  "infiniteIdentify",
  "infiniteReset",
  "infiniteMetaMirror",
  "infiniteCampaign"
] as const

export interface ConversionHelpersOptions {
  /** The site's Infinite consent mode. Absent = `not_required`. */
  consentMode?: "required" | "not_required"
  /** The site's own hosts (a referrer on one of them is not a campaign source). */
  ownHosts?: string[]
  /** The installed Meta pixel the mirror fires on (B16); absent → the mirror fires nothing. */
  metaPixelId?: string | null
}

function indent(source: string): string {
  return source
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join("\n")
}

/** The helper script as plain browser source (no `<script>` wrapper). */
export function buildConversionHelpersScript(options: ConversionHelpersOptions = {}): string {
  const mode = options.consentMode === "required" ? "required" : "not_required"
  // Meta's mirror and the campaign capture: DNT/GPC without a grant means no.
  const gate: MetaBrowserGate = { kind: "infinite-consent", mode }
  // GA4/PostHog conversions: the recorded decision and the consent mode only, exactly the visitors whose
  // native page views those providers already count (P2-4).
  const conversionGate: MetaBrowserGate = { kind: "infinite-consent", mode, privacySignal: "ignored" }
  return [
    "(function () {",
    '  if (typeof window.infiniteTrack === "function") return;',
    indent(consentAllowsSource(conversionGate)),
    indent(UNSAFE_TEXT_SOURCE),
    indent(helperCoreSource()),
    indent(trackSource()),
    indent(trackThenNavigateSource()),
    indent(identifySource()),
    "})();",
    buildMetaMirrorScript({ gate, pixelId: options.metaPixelId ?? null }),
    buildLandingAttributionScript({ ownHosts: options.ownHosts ?? [], gate })
  ].join("\n")
}

/** The helper options a plan's artifacts imply. */
export function conversionHelpersOptions(artifacts: WorkspaceInstallArtifacts): ConversionHelpersOptions {
  return {
    consentMode: artifacts.infinite?.consentMode === "required" ? "required" : "not_required",
    ownHosts: [
      ...new Set([
        ...(artifacts.productionHosts ?? []),
        ...(artifacts.infinite?.productionHosts ?? []),
        ...(artifacts.hostGuard?.exempt ?? [])
      ])
    ],
    // The chosen pixel (the keys step's choice = the relay binding), managed or adopted (§3z.10, B16).
    metaPixelId: artifacts.meta?.pixelId ?? null
  }
}

/** True when the plan asked for the helpers (`artifacts.conversions.helpers === true`). */
export function conversionHelpersWanted(artifacts: WorkspaceInstallArtifacts): boolean {
  return artifacts.conversions?.helpers === true
}

/**
 * The plan instruction that carries the helper script into the managed block. It has no `provider`
 * (the helpers serve every tool) and is marked `helpers: true` so the framework adapters pick it up.
 */
export function conversionHelpersInstruction(
  framework: SupportedFramework,
  artifacts: WorkspaceInstallArtifacts
): InstallInstruction {
  const script = buildConversionHelpersScript(conversionHelpersOptions(artifacts))
  const html = isHtmlInjectedFramework(framework)
  return {
    path: html ? "index.html" : "lib/infinite-analytics.ts",
    action: html ? "modify" : "create",
    description: html
      ? "Add the managed conversion helpers (infiniteTrack, infiniteTrackThenNavigate, infiniteIdentify, infiniteReset, infiniteMetaMirror, infiniteCampaign) to the managed block. Your code calls them; they never run on their own."
      : "Add the managed conversion helpers to the managed analytics module, with typed wrappers your code imports.",
    snippet: html ? ["<script>", script, "</script>"].join("\n") : script,
    helpers: true
  }
}

/**
 * The typed wrappers the managed Next module exports. Before hydration (the bootstrap runs from a
 * `useEffect`) the globals do not exist yet, so every wrapper degrades: tracking does nothing, an anchor
 * click is left to the browser, a button or programmatic navigation goes now, and the mirror resolves
 * at once.
 */
export function nextHelperWrappersSource(): string {
  return [
    "export type InfiniteEventProps = Record<string, string | number | boolean>",
    "export interface InfiniteGateOption {",
    "  /** Your own consent check. The helper sends nothing unless it returns true. */",
    "  gate?: () => boolean",
    "}",
    "export interface InfiniteClickEvent {",
    "  preventDefault(): void",
    "  defaultPrevented?: boolean",
    "  button?: number",
    "  metaKey?: boolean",
    "  ctrlKey?: boolean",
    "  shiftKey?: boolean",
    "  altKey?: boolean",
    "  /** The element the handler is attached to (React and the DOM set it). */",
    "  currentTarget?: unknown",
    "  /** The element the click landed on. */",
    "  target?: unknown",
    "}",
    "export type InfiniteNavigationTarget = string | { href: string; getAttribute?(name: string): string | null }",
    "export interface InfiniteMetaMirrorOptions extends InfiniteGateOption {",
    '  /** "request" (default): resolve when the pixel request completed, or at the budget. */',
    '  wait?: "request" | "none"',
    "  /** Raw values for Manual Advanced Matching; hashed by the pixel helper, never here. */",
    "  identity?: { email?: string; externalId?: string }",
    "  /** At most 400 ms (the default). */",
    "  budgetMs?: number",
    "}",
    "export interface InfiniteCampaign {",
    '  campaignProvenance: "tab" | "cookie" | "none"',
    "  browserContext: string",
    "  [key: string]: string",
    "}",
    "",
    "type InfiniteHelperWindow = {",
    "  infiniteTrack?: (name: string, props?: InfiniteEventProps, options?: InfiniteGateOption) => boolean",
    "  infiniteTrackThenNavigate?: (",
    "    event: InfiniteClickEvent | null | undefined,",
    "    target: InfiniteNavigationTarget,",
    "    name: string,",
    "    props?: InfiniteEventProps",
    "  ) => void",
    "  infiniteIdentify?: (id: string) => boolean",
    "  infiniteReset?: () => boolean",
    "  infiniteMetaMirror?: (metaEventName: string, metaEventId: string | null | undefined, options?: InfiniteMetaMirrorOptions) => Promise<void>",
    "  infiniteCampaign?: () => InfiniteCampaign",
    "  location: { href: string; assign(url: string): void }",
    "  open(url: string, target?: string, features?: string): unknown",
    "}",
    "",
    "function infiniteHelpers(): InfiniteHelperWindow | null {",
    '  return typeof window === "undefined" ? null : (window as unknown as InfiniteHelperWindow)',
    "}",
    "",
    "/** Send one named event to PostHog and GA4. Never to Meta. */",
    "export function infiniteTrack(name: string, props?: InfiniteEventProps, options?: InfiniteGateOption): boolean {",
    "  const helpers = infiniteHelpers()",
    "  if (!helpers || typeof helpers.infiniteTrack !== \"function\") return false",
    "  try {",
    "    return helpers.infiniteTrack(name, props, options) === true",
    "  } catch {",
    "    return false",
    "  }",
    "}",
    "",
    "/** Does the browser's own default action already go there? Only an unprevented click on an <a> with that href. */",
    "function infiniteBrowserFollows(event: InfiniteClickEvent | null | undefined, target: InfiniteNavigationTarget, destination: URL, base: string): boolean {",
    "  if (!event || event.defaultPrevented) return false",
    "  const anchorTo = (candidate: unknown): boolean => {",
    "    if (!candidate || typeof candidate !== \"object\") return false",
    "    const element = candidate as { tagName?: unknown; href?: unknown }",
    "    if (typeof element.tagName !== \"string\" || !/^(a|area)$/i.test(element.tagName)) return false",
    "    if (typeof element.href !== \"string\" || element.href.length === 0) return false",
    "    try {",
    "      return new URL(element.href, base).href === destination.href",
    "    } catch {",
    "      return false",
    "    }",
    "  }",
    "  if (anchorTo(event.currentTarget)) return true",
    "  if (!anchorTo(target)) return false",
    "  const clicked = event.target",
    "  const container = target as { contains?: (node: unknown) => boolean }",
    "  try {",
    "    return !!clicked && (clicked === target || (typeof container.contains === \"function\" && container.contains(clicked) === true))",
    "  } catch {",
    "    return false",
    "  }",
    "}",
    "",
    "/**",
    " * Record a click, then go there once GA4 has the hit (at most 1 s). Works on a <button> or a",
    " * programmatic call too: when the browser would not navigate by itself, the helper does.",
    " */",
    "export function infiniteTrackThenNavigate(",
    "  event: InfiniteClickEvent | null | undefined,",
    "  target: InfiniteNavigationTarget,",
    "  name: string,",
    "  props?: InfiniteEventProps",
    "): void {",
    "  const helpers = infiniteHelpers()",
    "  if (!helpers) return",
    "  if (typeof helpers.infiniteTrackThenNavigate === \"function\") {",
    "    try {",
    "      helpers.infiniteTrackThenNavigate(event, target, name, props)",
    "      return",
    "    } catch {",
    "      // fall through: never strand the visitor",
    "    }",
    "  }",
    "  // Not hydrated yet: nothing is tracked, and the visitor still gets where they clicked.",
    "  let destination: URL",
    "  try {",
    "    destination = new URL(typeof target === \"string\" ? target : target.href, helpers.location.href)",
    "  } catch {",
    "    return",
    "  }",
    "  if (destination.protocol !== \"https:\" && destination.protocol !== \"http:\") return",
    "  if (event && event.defaultPrevented && typeof target === \"object\" && typeof (target as { tagName?: unknown }).tagName === \"string\") return",
    "  if (infiniteBrowserFollows(event, target, destination, helpers.location.href)) return",
    "  try {",
    "    if (event && !event.defaultPrevented) event.preventDefault()",
    "  } catch {",
    "    // a synthetic event without preventDefault",
    "  }",
    "  const opensElsewhere = typeof target === \"object\" && typeof target.getAttribute === \"function\" && target.getAttribute(\"target\") === \"_blank\"",
    "  if (opensElsewhere) helpers.open(destination.href, \"_blank\", \"noopener\")",
    "  else helpers.location.assign(destination.href)",
    "}",
    "",
    "/** Join this visitor's PostHog history to your stable account id (never an email). */",
    "export function infiniteIdentify(id: string): boolean {",
    "  const helpers = infiniteHelpers()",
    "  if (!helpers || typeof helpers.infiniteIdentify !== \"function\") return false",
    "  try {",
    "    return helpers.infiniteIdentify(id) === true",
    "  } catch {",
    "    return false",
    "  }",
    "}",
    "",
    "/** Forget the person on sign-out. */",
    "export function infiniteReset(): boolean {",
    "  const helpers = infiniteHelpers()",
    "  if (!helpers || typeof helpers.infiniteReset !== \"function\") return false",
    "  try {",
    "    return helpers.infiniteReset() === true",
    "  } catch {",
    "    return false",
    "  }",
    "}",
    "",
    "/**",
    " * The browser twin of a Meta server event, ONLY with the metaEventId your server got back from",
    " * reportInfiniteOutcome. null means Infinite is not sending one: nothing fires. Await it before navigating.",
    " */",
    "export function infiniteMetaMirror(",
    "  metaEventName: string,",
    "  metaEventId: string | null | undefined,",
    "  options?: InfiniteMetaMirrorOptions",
    "): Promise<void> {",
    "  const helpers = infiniteHelpers()",
    "  if (!helpers || typeof helpers.infiniteMetaMirror !== \"function\") return Promise.resolve()",
    "  try {",
    "    return Promise.resolve(helpers.infiniteMetaMirror(metaEventName, metaEventId, options)).then(",
    "      () => undefined,",
    "      () => undefined",
    "    )",
    "  } catch {",
    "    return Promise.resolve()",
    "  }",
    "}",
    "",
    "/** The first-touch campaign, in the form your server passes on to reportInfiniteOutcome. */",
    "export function infiniteCampaign(): InfiniteCampaign {",
    "  const helpers = infiniteHelpers()",
    '  const none: InfiniteCampaign = { campaignProvenance: "none", browserContext: "unknown" }',
    "  if (!helpers || typeof helpers.infiniteCampaign !== \"function\") return none",
    "  try {",
    "    return helpers.infiniteCampaign()",
    "  } catch {",
    "    return none",
    "  }",
    "}"
  ].join("\n")
}
