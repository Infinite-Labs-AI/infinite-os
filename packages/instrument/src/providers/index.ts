import type { ProviderAdapter, ProviderId } from "../types.js"

import { ga4ProviderAdapter } from "./ga4.js"
import { infiniteProviderAdapter } from "./infinite.js"
import { metaProviderAdapter } from "./meta.js"
import { posthogProviderAdapter } from "./posthog.js"
import { xProviderAdapter } from "./x.js"

export const providerAdapters: Record<ProviderId, ProviderAdapter> = {
  infinite: infiniteProviderAdapter,
  ga4: ga4ProviderAdapter,
  posthog: posthogProviderAdapter,
  x: xProviderAdapter,
  meta: metaProviderAdapter
}

export function getProviderAdapter(providerId: ProviderId): ProviderAdapter {
  return providerAdapters[providerId]
}
