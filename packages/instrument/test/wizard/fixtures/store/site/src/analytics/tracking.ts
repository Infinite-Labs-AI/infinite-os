/**
 * Third-party trackers + cookie consent.
 *
 * Everything here waits for the visitor to accept the cookie banner. Until then
 * GA4 runs in Consent Mode "denied" with no script loaded, PostHog is not
 * initialised and the Meta pixel is not loaded at all.
 */
import posthog from "posthog-js";

type GtagFn = (...args: unknown[]) => void;

interface FbqFn {
  (...args: unknown[]): void;
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[];
  push: FbqFn;
  loaded: boolean;
  version: string;
}

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag?: GtagFn;
    fbq?: FbqFn;
    _fbq?: FbqFn;
  }
}

const GA_ID = process.env.NEXT_PUBLIC_GA_ID ?? "";
const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "";
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
const META_PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID ?? "";

/**
 * The Meta pixel is kept off these pages: the checkout funnel and the mailing
 * list signup. We only use Meta for top-of-funnel PageView audiences.
 */
export const META_RESTRICTED_ROUTES = ["/cart", "/success", "/mailing-list"];

/* ------------------------------------------------------------------ */
/* Consent                                                             */
/* ------------------------------------------------------------------ */

export type ConsentState = "granted" | "denied" | "unset";

const CONSENT_KEY = "halden_cookie_consent";
const CONSENT_EVENT = "halden:consent-changed";
export const OPEN_COOKIE_SETTINGS_EVENT = "halden:open-cookie-settings";

const isBrowser = () => typeof window !== "undefined";

export function getConsent(): ConsentState {
  if (!isBrowser()) return "unset";
  try {
    const v = window.localStorage.getItem(CONSENT_KEY);
    return v === "granted" || v === "denied" ? v : "unset";
  } catch {
    return "unset";
  }
}

function storeConsent(state: Exclude<ConsentState, "unset">) {
  try {
    window.localStorage.setItem(CONSENT_KEY, state);
  } catch {
    // blocked storage: the choice applies to this page view only
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: state }));
}

/** Called by the cookie banner's Accept button. */
export function acceptTracking(currentPath: string) {
  storeConsent("granted");
  startTracking(currentPath);
  trackPageView(currentPath);
}

/** Called by the cookie banner's Decline button. */
export function declineTracking() {
  storeConsent("denied");
  stopTracking();
}

export function openCookieSettings() {
  if (!isBrowser()) return;
  window.dispatchEvent(new CustomEvent(OPEN_COOKIE_SETTINGS_EVENT));
}

/* ------------------------------------------------------------------ */
/* Loaders                                                             */
/* ------------------------------------------------------------------ */

let gaLoaded = false;
let posthogReady = false;
let metaLoaded = false;
const posthogQueue: Array<() => void> = [];

function pathOnly(url: string) {
  return url.split("?")[0].split("#")[0] || "/";
}

export function isMetaRestricted(url: string) {
  const path = pathOnly(url);
  return META_RESTRICTED_ROUTES.some((r) => path === r || path.startsWith(`${r}/`));
}

function ensureGtag(): GtagFn {
  window.dataLayer = window.dataLayer || [];
  if (!window.gtag) {
    window.gtag = function gtag() {
      // gtag.js expects the Arguments object, not an array
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer.push(arguments);
    };
    window.gtag("consent", "default", {
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "denied",
      functionality_storage: "granted",
      security_storage: "granted",
      wait_for_update: 500,
    });
    window.gtag("js", new Date());
  }
  return window.gtag;
}

function injectScript(src: string, id: string) {
  if (document.getElementById(id)) return;
  const s = document.createElement("script");
  s.id = id;
  s.async = true;
  s.src = src;
  document.head.appendChild(s);
}

function loadGa() {
  if (!GA_ID) return;
  const gtag = ensureGtag();
  gtag("consent", "update", {
    ad_storage: "granted",
    ad_user_data: "granted",
    ad_personalization: "granted",
    analytics_storage: "granted",
  });
  if (gaLoaded) return;
  gaLoaded = true;
  gtag("config", GA_ID, { send_page_view: false });
  injectScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`, "ga4-gtag");
}

function loadPosthog() {
  if (!POSTHOG_KEY) return;
  if (posthogReady) {
    posthog.opt_in_capturing();
    return;
  }
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    capture_pageview: false,
    persistence: "localStorage+cookie",
  });
  if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing();
  posthogReady = true;
  while (posthogQueue.length) posthogQueue.shift()?.();
}

function loadMetaPixel(currentPath: string) {
  if (!META_PIXEL_ID || metaLoaded || isMetaRestricted(currentPath)) return;
  metaLoaded = true;

  // Meta pixel base code
  if (!window.fbq) {
    const n = function (this: unknown) {
      // eslint-disable-next-line prefer-rest-params
      const args = arguments as unknown as unknown[];
      if (n.callMethod) n.callMethod.apply(n, args);
      else n.queue.push(args);
    } as unknown as FbqFn;
    if (!window._fbq) window._fbq = n;
    n.push = n;
    n.loaded = true;
    n.version = "2.0";
    n.queue = [];
    window.fbq = n;
    injectScript("https://connect.facebook.net/en_US/fbevents.js", "meta-pixel");
  }
  window.fbq("init", process.env.NEXT_PUBLIC_META_PIXEL_ID);
}

/** Starts every tracker the visitor has consented to. */
export function startTracking(currentPath: string) {
  if (!isBrowser() || getConsent() !== "granted") return;
  loadGa();
  loadPosthog();
  loadMetaPixel(currentPath);
}

/** Turns trackers off after a visitor declines (or withdraws) consent. */
export function stopTracking() {
  if (!isBrowser()) return;
  ensureGtag()("consent", "update", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
  });
  if (posthogReady) posthog.opt_out_capturing();
  posthogQueue.length = 0;
  if (metaLoaded && window.fbq) window.fbq("consent", "revoke");
}

/** Called once from _app on first mount. */
export function initTracking(currentPath: string) {
  if (!isBrowser()) return;
  ensureGtag();
  if (getConsent() === "granted") {
    startTracking(currentPath);
    trackPageView(currentPath);
  }
}

/* ------------------------------------------------------------------ */
/* Senders used by events.ts                                           */
/* ------------------------------------------------------------------ */

export function trackPageView(url: string) {
  if (!isBrowser() || getConsent() !== "granted") return;

  ensureGtag()("event", "page_view", {
    page_path: url,
    page_location: window.location.href,
    page_title: document.title,
  });

  capturePosthog("$pageview", { $current_url: window.location.href });

  if (isMetaRestricted(url)) return;
  if (!metaLoaded) loadMetaPixel(url);
  if (metaLoaded && window.fbq) window.fbq("track", "PageView");
}

export function sendGa(eventName: string, params: Record<string, unknown>) {
  if (!isBrowser() || getConsent() === "denied") return;
  ensureGtag()("event", eventName, params);
}

export function capturePosthog(eventName: string, props: Record<string, unknown>) {
  if (!isBrowser() || getConsent() === "denied" || !POSTHOG_KEY) return;
  const send = () => posthog.capture(eventName, props);
  if (posthogReady) send();
  else posthogQueue.push(send);
}
