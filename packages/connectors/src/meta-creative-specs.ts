/**
 * Transport-level validation for the two raw AdCreative objects a caller may hand `create_meta_creative`:
 *
 * - `degreesOfFreedomSpec` → AdCreative.degrees_of_freedom_spec. Its `creative_features_spec` is the
 *   per-feature Advantage+ creative enhancement switch (each feature `{ enroll_status: OPT_IN|OPT_OUT }`).
 *   The old `standard_enhancements` bundle is deprecated since Marketing API v22.0, so a caller that wants
 *   enhancements OFF must name every feature it wants off. WHICH features, and on or off, is the caller's
 *   product policy; this module only refuses a malformed object before anything reaches Meta.
 * - `assetFeedSpec` → AdCreative.asset_feed_spec. A multi-asset creative (e.g. placement asset
 *   customization: one picture in several sizes with a rule per placement, optionally several texts).
 *   Media is referenced the way the Graph API documents it: an image by `hash` or `url` ("either url or
 *   hash is required"), a video by `video_id`. Nothing is downloaded or uploaded here.
 *
 * The engine does not BUILD a feed. A caller builds it; the engine refuses shapes that could only fail at Meta
 * (or, worse, succeed as something the caller did not mean) and passes the rest verbatim. It builds ONE default:
 * a creative whose caller names no `degreesOfFreedomSpec` gets `metaCreativeEnhancementsAllOff()` — every documented
 * enhancement OFF — so no path (the terminal's `meta creative create`, an older host) creates a creative with
 * Meta's own Advantage+ defaults silently. A caller that wants an enhancement ON says so explicitly.
 *
 * `META_CREATIVE_WRITE_FEATURES` is the capability list an embedding host checks BEFORE sending either
 * field. An older engine silently drops input keys it does not know, so a host that sends
 * `degreesOfFreedomSpec` to an engine without this list would believe an enhancement was switched off
 * when it never reached Meta. Hosts must fail CLOSED on a missing feature.
 */

export const META_CREATIVE_WRITE_FEATURES = ["degrees_of_freedom_spec", "asset_feed_spec"] as const;
export type MetaCreativeWriteFeature = (typeof META_CREATIVE_WRITE_FEATURES)[number];

export type MetaCreativeFeatureEnrollStatus = "OPT_IN" | "OPT_OUT";

export interface MetaDegreesOfFreedomSpec {
  creative_features_spec: Record<string, { enroll_status: MetaCreativeFeatureEnrollStatus }>;
}

/** A raw asset_feed_spec. Validated for the media/text shapes below; every other key passes verbatim. */
export type MetaAssetFeedSpec = Record<string, unknown>;

export class MetaCreativeSpecError extends Error {
  readonly code = "invalid_creative_spec";
  constructor(message: string) {
    super(`invalid_creative_spec: ${message}`);
    this.name = "MetaCreativeSpecError";
  }
}

/**
 * Every `creative_features_spec` feature Meta documents (Advantage+ Creative — Get started, read 2026-09-27). The
 * deprecated `standard_enhancements` bundle (v22+) is not one of them. Music is not a creative_features_spec feature
 * at all: only a feed with an empty `asset_feed_spec.audios` switches it off, so this default cannot.
 */
export const META_CREATIVE_ENHANCEMENT_FEATURES = [
  "adapt_to_placement",
  "add_text_overlay",
  "creative_stickers",
  "description_automation",
  "enhance_cta",
  "image_animation",
  "image_background_gen",
  "image_brightness_and_contrast",
  "image_templates",
  "image_text_translation",
  "image_touchups",
  "image_uncrop",
  "inline_comment",
  "media_type_automation",
  "pac_relaxation",
  "product_extensions",
  "reveal_details_over_time",
  "text_optimizations",
  "text_translation",
  "translate_voiceover",
  "video_auto_crop",
  "video_filtering",
  "video_uncrop",
] as const;

/** A fresh degrees_of_freedom_spec with every documented enhancement OFF — create_meta_creative's default. */
export function metaCreativeEnhancementsAllOff(): MetaDegreesOfFreedomSpec {
  return {
    creative_features_spec: Object.fromEntries(
      META_CREATIVE_ENHANCEMENT_FEATURES.map((feature) => [feature, { enroll_status: "OPT_OUT" as const }])
    ),
  };
}

const FEATURE_KEY = /^[a-z][a-z0-9_]{0,79}$/;
const ENROLL_STATUSES = new Set<string>(["OPT_IN", "OPT_OUT"]);
const MAX_FEATURES = 200;
const MAX_FEED_BYTES = 64 * 1024;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The validated degrees_of_freedom_spec, rebuilt from scratch so no unexpected key rides along.
 * Only `creative_features_spec` is accepted: every other degrees_of_freedom_spec member
 * (`degrees_of_freedom_type`, `*_transformation_types`) is a legacy opt-in surface this engine never sends.
 */
export function normalizeMetaDegreesOfFreedomSpec(value: unknown): MetaDegreesOfFreedomSpec {
  if (!plainRecord(value)) throw new MetaCreativeSpecError("degreesOfFreedomSpec must be an object");
  const extra = Object.keys(value).filter((key) => key !== "creative_features_spec");
  if (extra.length > 0) {
    throw new MetaCreativeSpecError(`degreesOfFreedomSpec only accepts creative_features_spec (got ${extra.join(", ")})`);
  }
  const features = value.creative_features_spec;
  if (!plainRecord(features)) throw new MetaCreativeSpecError("degreesOfFreedomSpec.creative_features_spec must be an object");
  const keys = Object.keys(features);
  if (keys.length === 0) throw new MetaCreativeSpecError("degreesOfFreedomSpec.creative_features_spec names no feature");
  if (keys.length > MAX_FEATURES) throw new MetaCreativeSpecError(`degreesOfFreedomSpec.creative_features_spec names more than ${MAX_FEATURES} features`);
  const out: MetaDegreesOfFreedomSpec["creative_features_spec"] = {};
  for (const key of keys) {
    if (!FEATURE_KEY.test(key)) throw new MetaCreativeSpecError(`creative feature "${key}" is not a snake_case feature key`);
    const setting = features[key];
    if (!plainRecord(setting) || Object.keys(setting).some((field) => field !== "enroll_status")) {
      throw new MetaCreativeSpecError(`creative feature "${key}" must be exactly { enroll_status }`);
    }
    const status = setting.enroll_status;
    if (typeof status !== "string" || !ENROLL_STATUSES.has(status)) {
      throw new MetaCreativeSpecError(`creative feature "${key}" enroll_status must be OPT_IN or OPT_OUT`);
    }
    out[key] = { enroll_status: status as MetaCreativeFeatureEnrollStatus };
  }
  return { creative_features_spec: out };
}

function httpsUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function textItems(feed: Record<string, unknown>, key: "bodies" | "titles" | "descriptions"): void {
  const items = feed[key];
  if (items === undefined) return;
  if (!Array.isArray(items) || items.length === 0) throw new MetaCreativeSpecError(`assetFeedSpec.${key} must be a non-empty array when present`);
  items.forEach((item, index) => {
    if (!plainRecord(item) || !nonEmptyString(item.text)) {
      throw new MetaCreativeSpecError(`assetFeedSpec.${key}[${index}] must be an object with non-empty text`);
    }
  });
}

/**
 * The asset_feed_spec as sent, after refusing the shapes that cannot be what the caller meant:
 * no media, an image with neither `hash` nor an https `url`, a video without `video_id`, or an
 * empty text entry. The object is returned verbatim (deep-copied) — this engine does not own the
 * product decisions inside a feed (rules, labels, formats).
 */
export function normalizeMetaAssetFeedSpec(value: unknown): MetaAssetFeedSpec {
  if (!plainRecord(value)) throw new MetaCreativeSpecError("assetFeedSpec must be an object");
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_FEED_BYTES) throw new MetaCreativeSpecError(`assetFeedSpec is larger than ${MAX_FEED_BYTES} bytes`);
  const feed = JSON.parse(serialized) as Record<string, unknown>;
  const images = feed.images;
  const videos = feed.videos;
  if (images !== undefined && !Array.isArray(images)) throw new MetaCreativeSpecError("assetFeedSpec.images must be an array");
  if (videos !== undefined && !Array.isArray(videos)) throw new MetaCreativeSpecError("assetFeedSpec.videos must be an array");
  const imageList = (images as unknown[] | undefined) ?? [];
  const videoList = (videos as unknown[] | undefined) ?? [];
  if (imageList.length + videoList.length === 0) throw new MetaCreativeSpecError("assetFeedSpec carries no image or video");
  imageList.forEach((image, index) => {
    if (!plainRecord(image) || !(nonEmptyString(image.hash) || httpsUrl(image.url))) {
      throw new MetaCreativeSpecError(`assetFeedSpec.images[${index}] needs a hash or an https url`);
    }
  });
  videoList.forEach((video, index) => {
    if (!plainRecord(video) || !nonEmptyString(video.video_id)) {
      throw new MetaCreativeSpecError(`assetFeedSpec.videos[${index}] needs a video_id`);
    }
  });
  textItems(feed, "bodies");
  textItems(feed, "titles");
  textItems(feed, "descriptions");
  return feed;
}

/** Whether a feed references any video — the CLI kill timer is budgeted per media kind. */
export function metaAssetFeedHasVideo(feed: MetaAssetFeedSpec): boolean {
  return Array.isArray(feed.videos) && feed.videos.length > 0;
}
