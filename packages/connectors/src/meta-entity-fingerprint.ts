import { createHash } from "node:crypto";

/**
 * Deterministic JSON for Meta entity metadata: object keys sorted, `undefined` members dropped,
 * `undefined`/`null` scalars rendered as `null`. Key order from the provider (or from a jsonb
 * round-trip) never changes the result.
 */
export function canonicalMetaAdsJson(value: unknown): string {
  return canonicalJson(value, null);
}

/**
 * Object keys whose values are Meta-RENDERED media URLs, excluded (at every depth) from the entity
 * version fingerprint. They stay in the stored `metadata_json`; they just never mint a version.
 *
 * Every key here is a URL Meta renders for a media asset whose identity already lives in a stable
 * sibling that IS fingerprinted, and every one of them is reached only through the ad's
 * `creative{…}` expansion (campaign/adset field lists request none of them):
 *
 * - `thumbnail_url` — AdCreative preview (top level) and `asset_feed_spec.videos[].thumbnail_url`.
 *   For dynamic video creatives Meta serves it through the `emg1` image proxy and mints a new path
 *   on nearly every read; this alone produced 25–50 versions per creative in 5 days on a real
 *   account. Identity: `video_id` / `image_hash` / `asset_feed_spec.videos[].video_id`.
 * - `image_url` — AdCreative rendered image (top level) and
 *   `object_story_spec.video_data.image_url`. Identity: `image_hash` / `video_id`.
 * - `picture` — `object_story_spec.{link_data,child_attachments,photo_data,template_data}.picture`.
 *   Identity: the sibling `image_hash`.
 *
 * `metaAdsCreativeAssetDescriptors` already treats exactly these keys as "signed, expiring
 * capabilities" whose asset identity is the hash/video id; the fingerprint now agrees with it.
 *
 * Dropping them loses no real change: Meta AdCreatives are immutable apart from name/status, so
 * new media always arrives as a NEW creative id (which changes both the creative row and the ad's
 * `creative.id`), and the media's own ids/hashes above are still fingerprinted.
 *
 * Deliberately NOT excluded (a change to these IS a real change): ids, `image_hash`/`hash`,
 * `video_id`, names, `title`/`body`/`message`/text, `url_tags`, and advertiser-set destinations
 * such as `object_story_spec.link_data.link`, `asset_feed_spec.link_urls[].website_url`,
 * `call_to_action.value.link`. The generic key `url` (e.g. `asset_feed_spec.images[].url`) is also
 * kept: it is too broad a name to drop everywhere, and it was not observed to rotate.
 */
export const META_ADS_VOLATILE_FINGERPRINT_KEYS: ReadonlySet<string> = new Set([
  "thumbnail_url",
  "image_url",
  "picture",
]);

/**
 * The `payload_hash` of a `meta_ads_entity_versions` row: sha256 over the canonical metadata with
 * the volatile rendered-URL keys removed at every depth. A new version is written only when this
 * fingerprint changes. Metadata that carries none of those keys (every campaign/adset row) hashes
 * byte-identically to the legacy full-metadata fingerprint.
 */
export function metaAdsEntityVersionFingerprint(metadata: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(metadata, META_ADS_VOLATILE_FINGERPRINT_KEYS)).digest("hex");
}

function canonicalJson(value: unknown, omitKeys: ReadonlySet<string> | null): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, omitKeys)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => entry !== undefined && !omitKeys?.has(key))
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, omitKeys)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
