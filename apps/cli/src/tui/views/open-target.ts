// The place `o` opens in the app (T12, app.open.v1). A view names a place as
// an app link (`{ place, label, params?, url? }`); the terminal sends the
// desktop's /v1/open only `place` and its string `params`. It never reads
// `url` (the bridge strips it, and a URL could only ever open a browser) and
// never opens anything itself: the desktop's router decides, in its own
// active workspace.
import { isRecord } from "./primitives.js";

/**
 * The words for the `o` key, on a card's key line and on the key bar alike
 * (live T4: they must agree): `open in <place>` when the app link names itself
 * that way (r4 `o open in Library`, `o open in Meta Ads`), else `open`. Never
 * a link's other words (`Posts`, a fix sentence): those read as the place, not
 * the key, and stay on the view's own `↗ … (o)` line.
 */
export function openKeyLabel(label: string): string {
  const named = /^open in\s+(.+)$/iu.exec(label.trim());
  return named ? `open in ${named[1]}` : "open";
}

/** What `o` sends: a registered place and its params, nothing else. */
export interface AppOpenTarget {
  place: string;
  params?: Record<string, string>;
}

/** The open target an app link names, or null when it names no place. */
export function appOpenTarget(link: unknown): AppOpenTarget | null {
  if (!isRecord(link) || typeof link.place !== "string") return null;
  const place = link.place.trim();
  if (!place) return null;
  const params = isRecord(link.params)
    ? Object.fromEntries(
        Object.entries(link.params).filter((entry): entry is [string, string] => typeof entry[1] === "string")
      )
    : {};
  return Object.keys(params).length ? { place, params } : { place };
}
