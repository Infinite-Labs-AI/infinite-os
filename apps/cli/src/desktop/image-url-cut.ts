// The terminal never prints an image URL (terminal-r4 "Images"). An images
// view's every string goes through this cut before it is drawn: its body,
// and the shell around it (title, explain, state reason, caveats, next steps,
// truncation, the approval words and the receipt). An `appLink` is the
// host's own place, not an image link, so it is kept (for `o`).
//
// Shared by the views (tui/views) and the receipt lines (desktop), so both
// cut the same way.

/** Anything URL-shaped is cut from image text. */
const URL_LIKE = /\b(?:https?|ftp|data|blob):\S*/giu;
const HAS_URL = /\b(?:https?|ftp|data|blob):/iu;

/** The text with every URL-shaped run cut (and the gap it left closed). */
export function cutUrls(text: string): string {
  if (!HAS_URL.test(text)) {
    return text;
  }
  return text.replace(URL_LIKE, "").replace(/[ \t]{2,}/gu, " ").trim();
}

/**
 * The view to draw: an images view with every URL-shaped run cut from its
 * strings (deep, `appLink` kept); any other view as it is.
 */
export function printableImagesView<T>(view: T): T {
  if (!isRecord(view) || view.kind !== "images") {
    return view;
  }
  return cutDeep(view) as T;
}

function cutDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return cutUrls(value);
  }
  if (depth > 32 || typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cutDeep(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = key === "appLink" ? item : cutDeep(item, depth + 1);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
