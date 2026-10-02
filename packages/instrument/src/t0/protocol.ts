// The wire format between the wizard (`run.ts`) and the sandboxed T0 child (`child.ts`) — lane O6.
//
// The parent sends SESSIONS: each is one throwaway browser profile (a cookie jar, local and session
// storage, one virtual clock) and a list of ACTIONS run in order (load a page, click, advance time,
// wipe storage, call a page function). The child answers with RECORDINGS only: every request the page
// tried to make (all cancelled; nothing leaves the child), the timeline of pixel / gtag / navigation
// calls, cookies, and what the analytics stubs saw. Grading happens in the parent (`scenarios.ts`),
// never in the child, so the child stays small and dumb. Everything here is JSON.

export const T0_PROTOCOL_VERSION = 1 as const

/** A script the page runs: inline code, in document order. */
export interface T0Script {
  code: string
  /** For error messages: `index.html#2`, `bootstrapSource`. */
  label: string
}

/** What a loaded page is made of. */
export interface T0PageSource {
  /** Full HTML (head + body); inline `<script>`s run in document order, `src` scripts per `resources`. */
  html?: string
  /** Extra inline scripts run after the HTML's own (e.g. a decoded Next `bootstrapSource`). */
  scripts?: T0Script[]
  /** Same-origin script bodies by URL path (`/js/app.js`), run when the page loads them. */
  resources?: Record<string, string>
}

/** A synthetic network answer for a page's fetch / XHR (nothing is ever really sent). */
export interface T0ResponseRule {
  /** Matches when the request URL contains this text. */
  urlIncludes: string
  method?: string
  status?: number
  json?: unknown
  text?: string
  delayMs?: number
  /** Never answers (an ad blocker, a dead endpoint). */
  hang?: boolean
}

export interface T0LoaderBehaviour {
  /** `gtag/js`: `load` runs the GA4 stub; `blocked` never loads (an ad blocker). */
  gtag?: "load" | "blocked"
  /** `fbevents.js`. */
  fbevents?: "load" | "blocked"
  /** PostHog `array.js`. */
  posthog?: "load" | "blocked"
  /** When `event_callback` fires: after the delay (default), never, or twice. */
  ga4EventCallback?: "fires" | "never" | "twice"
  ga4EventCallbackDelayMs?: number
  /** How long a Meta `/tr` request takes to complete (default 30 ms); `never` = it never completes. */
  metaTrDelayMs?: number | "never"
  /** How long a loader takes to load (default 10 ms). */
  loadDelayMs?: number
  /** `navigator.sendBeacon` answers false (the browser refused the payload). */
  beaconRefuses?: boolean
}

export interface T0LoadAction {
  kind: "load"
  label: string
  url: string
  source: T0PageSource
  referrer?: string
  doNotTrack?: "1" | "0" | null
  globalPrivacyControl?: boolean
  /** Web storage access throws (Safari private mode, some in-app browsers). */
  storageBlocked?: boolean
  /** Cookie writes are silently dropped. */
  cookiesBlocked?: boolean
  /** `navigator.webdriver` (default false; the runtime returns early when true). */
  webdriver?: boolean
  responses?: T0ResponseRule[]
  loaders?: T0LoaderBehaviour
  /** Virtual ms to run after the scripts (default 1500). */
  settleMs?: number
}

export interface T0ClickAction {
  kind: "click"
  label: string
  selector: string
  /** Virtual ms to run after the click (default 1500). */
  settleMs?: number
}

export interface T0AdvanceAction {
  kind: "advance"
  label: string
  ms: number
}

export interface T0ClearStorageAction {
  kind: "clear_storage"
  label: string
  local: boolean
  session: boolean
}

export interface T0SetStorageAction {
  kind: "set_storage"
  label: string
  area: "local" | "session"
  key: string
  value: string
}

/** Evaluate an expression in the page (e.g. call a helper); a returned promise is awaited on virtual time. */
export interface T0EvalAction {
  kind: "eval"
  label: string
  expression: string
  settleMs?: number
}

/** A client-side route change (`history.pushState`), then settle. */
export interface T0NavigateSpaAction {
  kind: "spa_navigate"
  label: string
  path: string
  settleMs?: number
}

export type T0Action = T0LoadAction | T0ClickAction | T0AdvanceAction | T0ClearStorageAction | T0SetStorageAction | T0EvalAction | T0NavigateSpaAction

export interface T0Session {
  id: string
  actions: T0Action[]
  /** Cookies the browser already holds before the first load (`name=value; Domain=…`). */
  cookies?: string[]
}

export interface T0ChildRequest {
  protocol: typeof T0_PROTOCOL_VERSION
  sessions: T0Session[]
}

export type T0RequestKind = "fetch" | "beacon" | "image" | "xhr" | "form" | "script" | "navigation"

/** One request the page tried to make. Every one is cancelled; nothing leaves the child. */
export interface T0Request {
  seq: number
  /** Virtual ms since the session began. */
  at: number
  /** Index of the action it happened in. */
  action: number
  kind: T0RequestKind
  method: string
  url: string
  body: string | null
  /** `page` = site code or a snippet; `stub:<tool>` = the stand-in for that vendor's library. */
  origin: "page" | "stub:ga4" | "stub:posthog" | "stub:meta"
}

export interface T0TimelineEntry {
  at: number
  action: number
  kind: "fbq" | "gtag" | "posthog" | "navigate" | "request"
  /** JSON-safe arguments (functions become "[function]"). */
  args: unknown[]
  /** The call was queued before the vendor library loaded and processed at load. */
  queued?: boolean
}

export interface T0ActionRecording {
  kind: T0Action["kind"]
  label: string
  /** Virtual ms at the start and end of the action. */
  startedAt: number
  endedAt: number
  url: string | null
  /** Errors thrown by page scripts or callbacks during the action (messages only). */
  scriptErrors: string[]
  /** `eval`: the JSON-safe result (an awaited promise's value). */
  result?: unknown
  /** `click`: whether the selector found an element. */
  found?: boolean
}

export interface T0PosthogInit {
  projectKey: string
  options: Record<string, unknown>
  /** The page path when `posthog.init` ran (D17: options differ on sensitive pages). */
  path: string
  action: number
}

export interface T0SessionRecording {
  id: string
  /** A crash of the session itself (not a page error). Non-null = the scenario is undetermined. */
  error: string | null
  actions: T0ActionRecording[]
  requests: T0Request[]
  timeline: T0TimelineEntry[]
  /** Every `document.cookie = …` assignment, in order, with the host it ran on. */
  cookieWrites: Array<{ host: string; value: string }>
  /** The cookies visible at the end, on the last page's host. */
  cookies: Array<{ name: string; value: string; domain: string }>
  posthogInits: T0PosthogInit[]
  /** Pixel ids `fbq('init')` registered (after fbevents loaded), in order. */
  metaPixels: string[]
  /** GA4 ids that `gtag('config')` registered, in order (after gtag.js loaded). */
  ga4Configs: string[]
  /** Global names defined at the end of each load (only the analytics ones T0 asks about). */
  globals: Array<{ action: number; defined: string[] }>
  /** Web storage at the end of the session (≤64 entries per area, values ≤2 KiB). */
  storage: Array<{ area: "local" | "session"; key: string; value: string }>
  /** Every web-storage write the page made, in order (≤500, values ≤2 KiB), for "nothing at rest" checks. */
  storageWrites: Array<{ action: number; area: "local" | "session"; key: string; value: string }>
}

export interface T0ChildResponse {
  protocol: typeof T0_PROTOCOL_VERSION
  pid: number
  sessions: T0SessionRecording[]
}

/** The globals T0 reports as defined/undefined after each load. */
export const T0_WATCHED_GLOBALS = [
  "gtag",
  "dataLayer",
  "posthog",
  "fbq",
  "twq",
  "infiniteMetaClickId",
  "infiniteMetaAdvancedMatch",
  "infiniteMetaMirror",
  "infiniteTrack",
  "infiniteTrackThenNavigate",
  "infiniteIdentify",
  "infiniteReset",
  "__infiniteAnalyticsRuntime"
] as const
