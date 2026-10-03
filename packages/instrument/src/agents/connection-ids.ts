// The connection's public provider IDs, for the post-turn gate (§3f.9: "a provider-ID literal that differs
// from the connection IDs" is a hit). Built from `bridge.keys()` (public IDs only, §3b). The runner REQUIRES
// them (review O3 F8): with none, every legitimate ID edit of jobs 4, 5 and 7 would be flagged as foreign.
import type { TagKeys } from "../wizard/contracts/bridge.js"

export function connectionIdsFromKeys(keys: TagKeys): string[] {
  const out = new Set<string>()
  for (const stream of keys.ga4?.streams ?? []) if (stream.measurementId) out.add(stream.measurementId)
  if (keys.posthog?.projectKey) out.add(keys.posthog.projectKey)
  for (const pixel of keys.meta?.pixels ?? []) if (pixel.pixelId) out.add(pixel.pixelId)
  if (keys.infinite?.siteSourceKey) out.add(keys.infinite.siteSourceKey)
  return [...out].sort()
}
