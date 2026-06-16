import type { ProviderAdapter, ProviderId } from "../types.js"

import { ga4ProviderAdapter } from "./ga4.js"
import { posthogProviderAdapter } from "./posthog.js"
import { xProviderAdapter } from "./x.js"

export const providerAdapters: Record<ProviderId, ProviderAdapter> = {
  ga4: ga4ProviderAdapter,
  posthog: posthogProviderAdapter,
  x: xProviderAdapter
}

export function getProviderAdapter(providerId: ProviderId): ProviderAdapter {
  return providerAdapters[providerId]
}
