import { createHash } from "node:crypto";

/**
 * Deterministic JSON for Meta entity metadata: object keys sorted, `undefined` members dropped,
 * `undefined`/`null` scalars rendered as `null`. Key order from the provider (or from a jsonb
 * round-trip) never changes the result.
 */
export function canonicalMetaAdsJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalMetaAdsJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalMetaAdsJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The `payload_hash` of a `meta_ads_entity_versions` row. A new version is written only when this
 * fingerprint changes.
 */
export function metaAdsEntityVersionFingerprint(metadata: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalMetaAdsJson(metadata)).digest("hex");
}
