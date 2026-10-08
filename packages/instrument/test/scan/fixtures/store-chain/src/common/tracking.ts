import { restrictedTrackingRoutes } from "./trackingPolicy";

interface TrackingWindow extends Window {
  gtag?: (...args: unknown[]) => void;
  fbq?: (...args: unknown[]) => void;
}

function trackingAllowed(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem("fernwood-consent") === "granted";
}

export function trackGoogleEvent(
  event: string,
  properties?: Record<string, unknown>
): boolean {
  if (!trackingAllowed()) return false;
  (window as TrackingWindow).gtag?.("event", event, properties ?? {});
  return true;
}

async function getPostHog() {
  const { default: posthog } = await import("posthog-js");
  return posthog;
}

export async function capturePostHog(
  eventName: string,
  properties: Record<string, unknown>,
  sendInstantly = false
): Promise<boolean> {
  const posthog = await getPostHog();
  if (!posthog || !trackingAllowed()) return false;
  posthog.capture(
    eventName,
    properties,
    sendInstantly ? { send_instantly: true } : undefined
  );
  return true;
}

export function trackAnalyticsPageView(path: string) {
  if (restrictedTrackingRoutes.some((route) => path.startsWith(route))) return;
  trackGoogleEvent("page_view", { page_path: path });
  void capturePostHog("$pageview", { $current_url: window.location.href });
  (window as TrackingWindow).fbq?.("track", "PageView");
}
