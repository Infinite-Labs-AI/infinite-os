import type { ProductSurface, SetupProviderId } from "./types.js";

export type RecommendationProviderId =
  | SetupProviderId
  | "meta"
  | "stripe"
  | "linkedin"
  | "tiktok";

export type RecommendationTrack = "v1" | "v2";
export type RecommendationStatus = "recommended" | "deferred" | "not_applicable";
export type RecommendationReasonCode =
  | "web_default"
  | "explicit_founder_request"
  | "already_present"
  | "developer_billing_friction"
  | "not_in_v1_scope"
  | "surface_not_supported";
export type RecommendationOrchestration = "queue_now" | "resume_existing" | "defer" | "skip";
export type RecommendationCostTag = "free" | "free_tier" | "developer_billing" | "v2_deferred";

export interface RecommendationPresence {
  hasAccount?: boolean;
  installState?: "installed" | "not_installed" | "unknown";
}

export interface SetupRecommendationContext {
  productSurface: ProductSurface;
  founderRequestedProviders?: Iterable<RecommendationProviderId>;
  existingProviders?: Partial<Record<RecommendationProviderId, RecommendationPresence>>;
}

export interface SetupRecommendation {
  provider: RecommendationProviderId;
  status: RecommendationStatus;
  track: RecommendationTrack;
  orchestration: RecommendationOrchestration;
  reasonCode: RecommendationReasonCode;
  costTag: RecommendationCostTag;
  implementable: boolean;
  rationale: string;
  sources: readonly string[];
}

interface ProviderPolicy {
  provider: RecommendationProviderId;
  track: RecommendationTrack;
  costTag: RecommendationCostTag;
  sources: readonly string[];
}

const V1_PROVIDERS = ["ga4", "posthog", "x"] as const satisfies readonly SetupProviderId[];
const RECOMMENDATION_ORDER = [
  "ga4",
  "posthog",
  "x",
  "meta",
  "stripe",
  "linkedin",
  "tiktok"
] as const satisfies readonly RecommendationProviderId[];

const SOURCE_SPEC = "docs/superpowers/specs/2026-06-07-setup-analytics-integration-design.md";
const SOURCE_GA4 = "docs/superpowers/research/2026-06-07-setup-providers/01-ga4.md";
const SOURCE_POSTHOG = "docs/superpowers/research/2026-06-07-setup-providers/03-posthog.md";
const SOURCE_X = "docs/superpowers/research/2026-06-07-setup-providers/04-x.md";
const SOURCE_FRICTION = "docs/superpowers/research/2026-06-07-setup-providers/05-cross-oauth-credential-reality.md";
const SOURCE_BUNDLE = "docs/superpowers/research/2026-06-07-setup-providers/README.md";

const PROVIDER_POLICIES: Record<RecommendationProviderId, ProviderPolicy> = {
  ga4: {
    provider: "ga4",
    track: "v1",
    costTag: "free",
    sources: [SOURCE_SPEC, SOURCE_GA4, SOURCE_FRICTION]
  },
  posthog: {
    provider: "posthog",
    track: "v1",
    costTag: "free_tier",
    sources: [SOURCE_SPEC, SOURCE_POSTHOG, SOURCE_FRICTION]
  },
  x: {
    provider: "x",
    track: "v1",
    costTag: "developer_billing",
    sources: [SOURCE_SPEC, SOURCE_X, SOURCE_FRICTION]
  },
  meta: {
    provider: "meta",
    track: "v2",
    costTag: "v2_deferred",
    sources: [SOURCE_SPEC, SOURCE_FRICTION]
  },
  stripe: {
    provider: "stripe",
    track: "v2",
    costTag: "v2_deferred",
    sources: [SOURCE_SPEC, SOURCE_FRICTION]
  },
  linkedin: {
    provider: "linkedin",
    track: "v2",
    costTag: "v2_deferred",
    sources: [SOURCE_SPEC, SOURCE_BUNDLE]
  },
  tiktok: {
    provider: "tiktok",
    track: "v2",
    costTag: "v2_deferred",
    sources: [SOURCE_SPEC, SOURCE_BUNDLE]
  }
};

export function buildSetupRecommendations(context: SetupRecommendationContext): SetupRecommendation[] {
  const requested = new Set(normalizeProviderIds(context.founderRequestedProviders));
  const existing = context.existingProviders ?? {};

  return RECOMMENDATION_ORDER.map((provider) => {
    const policy = PROVIDER_POLICIES[provider];
    const presence = existing[provider];
    const alreadyPresent = Boolean(presence?.hasAccount || presence?.installState === "installed");

    if (context.productSurface !== "web") {
      return {
        provider,
        status: "not_applicable",
        track: policy.track,
        orchestration: "skip",
        reasonCode: "surface_not_supported",
        costTag: policy.costTag,
        implementable: false,
        rationale: "The current setup flow only supports web analytics instrumentation, so this stays out of scope on mobile surfaces.",
        sources: policy.sources
      };
    }

    if (provider === "ga4") {
      return recommended(policy, "web_default", "queue_now",
        "GA4 is part of the default web stack from the research bundle because it is free and supports the full detect/setup/connect/sync path in V1."
      );
    }

    if (provider === "posthog") {
      return recommended(policy, "web_default", "queue_now",
        "PostHog is part of the default web stack from the research bundle because its free tier and V1 browser-assist flow cover product analytics cleanly."
      );
    }

    if (provider === "x") {
      if (alreadyPresent) {
        return recommended(policy, "already_present", "resume_existing",
          "X stays in the active queue when we already detect an existing account or install, so later orchestration can resume or verify it instead of dropping state."
        );
      }

      if (requested.has("x")) {
        return recommended(policy, "explicit_founder_request", "queue_now",
          "X only moves into the V1 queue on explicit founder request because the research bundle calls out developer-account billing and Ads-account/payment-card friction."
        );
      }

      return {
        provider,
        status: "deferred",
        track: policy.track,
        orchestration: "defer",
        reasonCode: "developer_billing_friction",
        costTag: policy.costTag,
        implementable: false,
        rationale:
          "X stays deferred by default because the 2026-06-07 research requires developer billing plus an Ads account with a payment method before pixel setup is even available.",
        sources: policy.sources
      };
    }

    return {
      provider,
      status: "deferred",
      track: policy.track,
      orchestration: "defer",
      reasonCode: "not_in_v1_scope",
      costTag: policy.costTag,
      implementable: false,
      rationale: "This provider is deliberately parked in the V2/deferred lane for setup, so V1 should display it as future work instead of trying to orchestrate it now.",
      sources: policy.sources
    };
  });
}

export function selectRecommendedV1Providers(recommendations: Iterable<SetupRecommendation>): SetupProviderId[] {
  const selected: SetupProviderId[] = [];

  for (const recommendation of recommendations) {
    if (
      recommendation.status === "recommended" &&
      recommendation.track === "v1" &&
      isSetupProviderId(recommendation.provider)
    ) {
      selected.push(recommendation.provider);
    }
  }

  return selected;
}

function recommended(
  policy: ProviderPolicy,
  reasonCode: Extract<RecommendationReasonCode, "web_default" | "explicit_founder_request" | "already_present">,
  orchestration: RecommendationOrchestration,
  rationale: string
): SetupRecommendation {
  return {
    provider: policy.provider,
    status: "recommended",
    track: policy.track,
    orchestration,
    reasonCode,
    costTag: policy.costTag,
    implementable: true,
    rationale,
    sources: policy.sources
  };
}

function normalizeProviderIds(value: Iterable<RecommendationProviderId> | undefined): RecommendationProviderId[] {
  if (!value) {
    return [];
  }

  const normalized: RecommendationProviderId[] = [];
  const seen = new Set<RecommendationProviderId>();

  for (const provider of value) {
    if (!isRecommendationProviderId(provider) || seen.has(provider)) {
      continue;
    }
    seen.add(provider);
    normalized.push(provider);
  }

  return normalized;
}

function isSetupProviderId(provider: RecommendationProviderId): provider is SetupProviderId {
  return (V1_PROVIDERS as readonly string[]).includes(provider);
}

function isRecommendationProviderId(provider: string): provider is RecommendationProviderId {
  return (RECOMMENDATION_ORDER as readonly string[]).includes(provider);
}
