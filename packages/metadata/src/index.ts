import { JOURNEY_ENTITY_TYPES, type JourneyEntityType } from "@infinite-os/core";

export type ContextCardType =
  | "source_capability"
  | "entity_definition"
  | "outcome_definition"
  | "policy_definition"
  | "path_template"
  | "journey_template"
  | "glossary"
  | "example_plan"
  | "unsupported_case";

export type ContextCardSource = "seed" | "operator" | "learned_verified";

export type Provider =
  | "posthog"
  | "stripe"
  | "shopify"
  | "meta_ads"
  | "ga4"
  | "x";

export type ActorGrain = "person" | "account" | "both";

export type JourneyFactType =
  | "touchpoint"
  | "behavior"
  | "conversion"
  | "billing"
  | "lifecycle";

export type JourneyTemplateStatus =
  | "seed"
  | "suggested"
  | "approved"
  | "rejected"
  | "deprecated";

export type SourceCapabilityCard = {
  id: string;
  provider: Provider;
  hasActorIdentity: boolean;
  hasCampaignTouchpoints: boolean;
  hasRevenueEvents: boolean;
  supportedEntities: string[];
  unsupportedQuestions: string[];
  freshnessSource: string;
};

export type EntityDefinitionCard = {
  id: string;
  label: string;
  entityType: string;
  actorGrain: ActorGrain;
  definition: string;
  synonyms: string[];
  sourceProviders: Provider[];
  compatibleOutcomeIds: string[];
};

export type OutcomeDefinitionCard = {
  id: string;
  label: string;
  actorGrain: ActorGrain;
  requiredFacts: string[];
  requiredPolicies: string[];
  defaultWindow?: string;
};

export type PolicyDefinitionCard = {
  id: string;
  label: string;
  version: number;
  appliesTo: string[];
  rules: string[];
  caveats: string[];
};

export type PathTemplateCard = {
  id: string;
  label: string;
  fromEntityType: JourneyEntityType;
  toOutcomeId: string;
  requiredJourneyTemplateIds: string[];
  description: string;
};

export type JourneyTemplateCard = {
  id: string;
  label: string;
  actorGrain: ActorGrain;
  steps: Array<{
    stepId: string;
    factType: JourneyFactType;
    required: boolean;
    outcomeId?: string;
    maxGap?: string;
  }>;
  allowedEntityTypes: JourneyEntityType[];
  requiredPolicies: string[];
  status: JourneyTemplateStatus;
  version: number;
};

export type GlossaryCard = {
  id: string;
  terms: Array<{
    term: string;
    aliases: string[];
    definition: string;
  }>;
};

export type ExamplePlanCard = {
  id: string;
  question: string;
  plan: {
    intent: string;
    entityType: JourneyEntityType;
    outcomeId: string;
    journeyTemplateId: string;
  };
  contextCardIds: string[];
};

export type UnsupportedCaseCard = {
  id: string;
  questionPattern: string;
  reason: string;
  explanation: string;
  saferAlternatives: string[];
  relatedProvider?: Provider;
};

type ContextCardPayloadByType = {
  source_capability: SourceCapabilityCard;
  entity_definition: EntityDefinitionCard;
  outcome_definition: OutcomeDefinitionCard;
  policy_definition: PolicyDefinitionCard;
  path_template: PathTemplateCard;
  journey_template: JourneyTemplateCard;
  glossary: GlossaryCard;
  example_plan: ExamplePlanCard;
  unsupported_case: UnsupportedCaseCard;
};

export type ContextCard<TType extends ContextCardType = ContextCardType> = {
  [K in ContextCardType]: {
    id: string;
    cardType: K;
    key: string;
    title: string;
    searchableText: string;
    payload: ContextCardPayloadByType[K];
    version: number;
    source: ContextCardSource;
    tags: string[];
  };
}[TType];

export type ContextCardFilter = {
  cardType?: ContextCardType | readonly ContextCardType[];
  source?: ContextCardSource | readonly ContextCardSource[];
  key?: string;
  provider?: Provider | readonly Provider[];
  status?: JourneyTemplateStatus | readonly JourneyTemplateStatus[];
  tags?: readonly string[];
  includeUnapprovedJourneyTemplates?: boolean;
};

export type ContextCardSummary = {
  id: string;
  cardType: ContextCardType;
  key: string;
  title: string;
  summary: string;
  version: number;
  source: ContextCardSource;
  tags: string[];
  journeyStatus?: JourneyTemplateStatus;
  relevanceScore?: number;
};

export type ContextCardDescription = ContextCardSummary & {
  details: Record<string, unknown>;
};

export type JourneyTemplateSuggestion = {
  id: string;
  workspaceId: string;
  proposedBySessionId?: string;
  question: string;
  template: JourneyTemplateCard;
  status: Extract<JourneyTemplateStatus, "suggested" | "approved" | "rejected">;
  reviewerActorId?: string;
  reviewedAt?: string;
  createdAt: string;
  rejectionReason?: string;
};

export type CreateJourneyTemplateSuggestionInput = {
  id?: string;
  workspaceId: string;
  proposedBySessionId?: string;
  question: string;
  template: Omit<JourneyTemplateCard, "status" | "version"> & {
    status?: JourneyTemplateStatus;
    version?: number;
  };
  now?: string;
  blockedTemplateKeys?: readonly string[];
};

export type ApproveJourneyTemplateSuggestionInput = {
  suggestion: JourneyTemplateSuggestion;
  cards?: readonly ContextCard[];
  reviewerActorId?: string;
  now?: string;
  source?: Extract<ContextCardSource, "operator" | "learned_verified">;
};

export type ApprovedJourneyTemplateSuggestion = {
  suggestion: JourneyTemplateSuggestion;
  contextCard: ContextCard<"journey_template">;
};

export type RejectJourneyTemplateSuggestionInput = {
  suggestion: JourneyTemplateSuggestion;
  reviewerActorId?: string;
  reason?: string;
  now?: string;
};

export function seedContextCards(): ContextCard[] {
  return [
    sourceCapability("posthog", {
      title: "PostHog behavior source capability",
      hasActorIdentity: true,
      hasCampaignTouchpoints: true,
      hasRevenueEvents: false,
      supportedEntities: ["person", "session", "event", "page", "channel"],
      unsupportedQuestions: [
        "billing revenue",
        "subscription churn without Stripe",
        "LTV without billing joins"
      ],
      freshnessSource: "PostHog sync status",
      tags: ["behavior", "events", "touchpoints", "channel"],
      searchableText:
        "PostHog supports actor session event origin behavior facts, person identity, UTM channel touchpoints, landing pages, and behavior windows."
    }),
    sourceCapability("stripe", {
      title: "Stripe billing source capability",
      hasActorIdentity: true,
      hasCampaignTouchpoints: false,
      hasRevenueEvents: true,
      supportedEntities: [
        "customer",
        "invoice",
        "subscription",
        "product",
        "price"
      ],
      unsupportedQuestions: [
        "pre-signup acquisition paths without PostHog",
        "ad campaign attribution by itself"
      ],
      freshnessSource: "Stripe sync status",
      tags: ["billing", "revenue", "subscription", "ltv"],
      searchableText:
        "Stripe supports customer invoice subscription billing facts, paid conversion evidence, recognized revenue, active paid lifecycle, and LTV windows after identity resolution."
    }),
    sourceCapability("ga4", {
      title: "GA4 aggregate traffic source capability",
      hasActorIdentity: false,
      hasCampaignTouchpoints: true,
      hasRevenueEvents: false,
      supportedEntities: ["page", "traffic_source", "campaign"],
      unsupportedQuestions: [
        "person-level conversion paths",
        "user-level LTV attribution",
        "raw event reconstruction"
      ],
      freshnessSource: "GA4 sync status",
      tags: ["traffic", "aggregate", "page", "campaign"],
      searchableText:
        "GA4 supports aggregate traffic facts, pages, traffic source, and campaign summaries but not person-level conversion paths or user-level LTV attribution."
    }),
    sourceCapability("meta_ads", {
      title: "Meta Ads campaign/day aggregate source capability",
      hasActorIdentity: false,
      hasCampaignTouchpoints: true,
      hasRevenueEvents: false,
      supportedEntities: ["campaign", "ad_account", "day"],
      unsupportedQuestions: [
        "user-level LTV attribution",
        "person-level paid conversion paths",
        "actor-level ad touchpoints"
      ],
      freshnessSource: "Meta Ads sync status",
      tags: ["paid", "campaign", "aggregate", "ltv", "unsupported"],
      searchableText:
        "Meta Ads current support is campaign/day aggregate reporting for spend, clicks, and campaign performance. Campaign/day aggregates alone cannot answer user-level LTV or actor-level paid conversion paths."
    }),
    sourceCapability("x", {
      title: "X public content source capability",
      hasActorIdentity: false,
      hasCampaignTouchpoints: false,
      hasRevenueEvents: false,
      supportedEntities: ["post", "profile"],
      unsupportedQuestions: [
        "actor-level reaction graph",
        "private conversion paths",
        "user-level downstream LTV"
      ],
      freshnessSource: "X sync status",
      tags: ["content", "public_metrics", "profile"],
      searchableText:
        "X supports authored post and profile public metrics, not an actor-level reaction graph or private conversion journey."
    }),
    sourceCapability("shopify", {
      title: "Shopify commerce source capability",
      hasActorIdentity: true,
      hasCampaignTouchpoints: false,
      hasRevenueEvents: true,
      supportedEntities: ["order", "product", "customer"],
      unsupportedQuestions: [
        "full subscription churn",
        "pre-order behavior paths without another source"
      ],
      freshnessSource: "Shopify sync status",
      tags: ["commerce", "orders", "products", "customers"],
      searchableText:
        "Shopify supports order, product, customer, and commerce facts but not full subscription churn without a subscription billing source."
    }),
    entity("channel", {
      label: "Acquisition channel",
      actorGrain: "person",
      definition:
        "A normalized marketing or referral origin such as paid social, organic search, direct, referral, or email.",
      synonyms: [
        "utm_source",
        "utm_medium",
        "source",
        "medium",
        "paid channel",
        "conversion channel"
      ],
      sourceProviders: ["posthog", "ga4", "meta_ads"],
      compatibleOutcomeIds: [
        "signup",
        "paid_conversion",
        "active_paid",
        "ltv_12m"
      ]
    }),
    entity("page", {
      label: "Landing or content page",
      actorGrain: "person",
      definition:
        "A page URL, route, or content entry that can precede signup, conversion, or activation.",
      synonyms: ["landing page", "url", "route", "content"],
      sourceProviders: ["posthog", "ga4"],
      compatibleOutcomeIds: ["signup", "paid_conversion", "active_paid"]
    }),
    entity("campaign", {
      label: "Campaign",
      actorGrain: "both",
      definition:
        "A marketing campaign identifier or name. Some sources expose only aggregate campaign/day facts.",
      synonyms: [
        "ad campaign",
        "utm_campaign",
        "Meta campaign",
        "paid campaign"
      ],
      sourceProviders: ["posthog", "ga4", "meta_ads"],
      compatibleOutcomeIds: ["signup", "paid_conversion"]
    }),
    entity("person", {
      label: "Person actor",
      actorGrain: "person",
      definition:
        "A resolved individual actor used for event, conversion, billing, lifecycle, and LTV joins.",
      synonyms: ["user", "visitor", "customer", "actor"],
      sourceProviders: ["posthog", "stripe", "shopify"],
      compatibleOutcomeIds: [
        "signup",
        "paid_conversion",
        "active_paid",
        "retention",
        "ltv_12m"
      ]
    }),
    entity("product", {
      label: "Product",
      actorGrain: "both",
      definition:
        "A Stripe or Shopify product used for paid conversion, revenue, and lifecycle segmentation.",
      synonyms: ["sku", "price", "plan", "subscription product"],
      sourceProviders: ["stripe", "shopify"],
      compatibleOutcomeIds: ["paid_conversion", "active_paid", "ltv_12m"]
    }),
    outcome("signup", {
      label: "Signup",
      actorGrain: "person",
      requiredFacts: ["conversion:signup", "actor_identity"],
      requiredPolicies: ["identity_resolution_v1"],
      defaultWindow: "30d"
    }),
    outcome("paid_conversion", {
      label: "Paid conversion",
      actorGrain: "person",
      requiredFacts: [
        "conversion:signup_or_checkout",
        "billing:paid_invoice_or_order",
        "actor_identity"
      ],
      requiredPolicies: ["identity_resolution_v1", "paid_conversion_v1"],
      defaultWindow: "90d"
    }),
    outcome("active_paid", {
      label: "Active paid lifecycle",
      actorGrain: "person",
      requiredFacts: [
        "billing:subscription_or_recent_order",
        "lifecycle:active_paid"
      ],
      requiredPolicies: ["identity_resolution_v1", "lifecycle_state_v1"],
      defaultWindow: "30d"
    }),
    outcome("ltv_12m", {
      label: "Twelve month LTV",
      actorGrain: "person",
      requiredFacts: [
        "billing:paid_revenue",
        "actor_identity",
        "ltv_window:12m"
      ],
      requiredPolicies: ["identity_resolution_v1", "ltv_window_v1"],
      defaultWindow: "12m"
    }),
    outcome("retention", {
      label: "Retention",
      actorGrain: "person",
      requiredFacts: ["cohort:signup", "behavior:return_or_active_state"],
      requiredPolicies: ["identity_resolution_v1", "retention_window_v1"],
      defaultWindow: "30d"
    }),
    policy("identity_resolution_v1", {
      label: "Identity resolution policy",
      version: 1,
      appliesTo: ["person", "customer", "account"],
      rules: [
        "Use stable provider identifiers or hashed identity joins.",
        "Do not invent actor links when source identity is missing."
      ],
      caveats: [
        "Low actor-resolution coverage must be returned as low_coverage, not silently ignored."
      ]
    }),
    policy("paid_conversion_v1", {
      label: "Paid conversion policy",
      version: 1,
      appliesTo: ["paid_conversion", "active_paid"],
      rules: [
        "A paid conversion requires a paid invoice, order, or equivalent positive billing fact."
      ],
      caveats: ["Ad clicks or page visits alone are not paid conversions."]
    }),
    policy("ltv_window_v1", {
      label: "LTV window policy",
      version: 1,
      appliesTo: ["ltv_12m", "revenue"],
      rules: [
        "LTV windows must declare duration, currency handling, and actor grain."
      ],
      caveats: [
        "Campaign/day ad aggregates cannot become user-level LTV without actor identity joins."
      ]
    }),
    policy("lifecycle_state_v1", {
      label: "Lifecycle state policy",
      version: 1,
      appliesTo: ["active_paid", "churned", "reactivated"],
      rules: [
        "Active paid requires explicit paid billing or active subscription evidence.",
        "Churn requires explicit cancellation evidence; absence of recent activity is not churn."
      ],
      caveats: [
        "Lifecycle state answers must name the policy version and evidence source."
      ]
    }),
    policy("retention_window_v1", {
      label: "Retention window policy",
      version: 1,
      appliesTo: ["retention", "cohort"],
      rules: [
        "Retention windows must declare cohort start, activity definition, and measurement window.",
        "Users without resolvable actor identity count toward low coverage rather than inferred retention."
      ],
      caveats: [
        "Behavior-only retention is not equivalent to paid retention unless billing evidence is included."
      ]
    }),
    pathTemplate("channel_to_paid_conversion", {
      label: "Channel to paid conversion",
      fromEntityType: "channel",
      toOutcomeId: "paid_conversion",
      requiredJourneyTemplateIds: ["touchpoint_to_paid_conversion"],
      description:
        "Rank acquisition channels by downstream paid conversions using touchpoint, actor identity, and billing facts."
    }),
    pathTemplate("page_to_paid_conversion", {
      label: "Page to paid conversion",
      fromEntityType: "page",
      toOutcomeId: "paid_conversion",
      requiredJourneyTemplateIds: ["touchpoint_to_paid_conversion"],
      description:
        "Rank pages by downstream paid conversion after a bounded touchpoint window."
    }),
    journeyTemplate({
      id: "touchpoint_to_signup",
      label: "Touchpoint to signup",
      actorGrain: "person",
      allowedEntityTypes: ["channel", "page", "campaign"],
      requiredPolicies: ["identity_resolution_v1"],
      steps: [
        {
          stepId: "first_touch",
          factType: "touchpoint",
          required: true,
          maxGap: "30d"
        },
        {
          stepId: "signup",
          factType: "conversion",
          required: true,
          outcomeId: "signup"
        }
      ]
    }),
    journeyTemplate({
      id: "touchpoint_to_paid_conversion",
      label: "Touchpoint to paid conversion",
      actorGrain: "person",
      allowedEntityTypes: ["channel", "page", "campaign"],
      requiredPolicies: ["identity_resolution_v1", "paid_conversion_v1"],
      steps: [
        {
          stepId: "touchpoint",
          factType: "touchpoint",
          required: true,
          maxGap: "90d"
        },
        {
          stepId: "paid_conversion",
          factType: "billing",
          required: true,
          outcomeId: "paid_conversion"
        }
      ]
    }),
    journeyTemplate({
      id: "touchpoint_to_active_paid",
      label: "Touchpoint to active paid",
      actorGrain: "person",
      allowedEntityTypes: ["channel", "page", "campaign"],
      requiredPolicies: ["identity_resolution_v1", "lifecycle_state_v1"],
      steps: [
        {
          stepId: "touchpoint",
          factType: "touchpoint",
          required: true,
          maxGap: "90d"
        },
        {
          stepId: "active_paid_state",
          factType: "lifecycle",
          required: true,
          outcomeId: "active_paid"
        }
      ]
    }),
    journeyTemplate({
      id: "touchpoint_to_ltv",
      label: "Touchpoint to LTV",
      actorGrain: "person",
      allowedEntityTypes: ["channel", "page", "campaign", "product"],
      requiredPolicies: ["identity_resolution_v1", "ltv_window_v1"],
      steps: [
        {
          stepId: "touchpoint",
          factType: "touchpoint",
          required: true,
          maxGap: "90d"
        },
        {
          stepId: "revenue_window",
          factType: "billing",
          required: true,
          outcomeId: "ltv_12m"
        }
      ]
    }),
    journeyTemplate({
      id: "behavior_window_to_conversion",
      label: "Behavior window to conversion",
      actorGrain: "person",
      allowedEntityTypes: ["event_item", "page", "behavior"],
      requiredPolicies: ["identity_resolution_v1", "paid_conversion_v1"],
      steps: [
        {
          stepId: "bounded_behavior",
          factType: "behavior",
          required: true,
          maxGap: "30d"
        },
        {
          stepId: "conversion",
          factType: "conversion",
          required: true,
          outcomeId: "paid_conversion"
        }
      ]
    }),
    journeyTemplate({
      id: "signup_cohort_to_retention",
      label: "Signup cohort to retention",
      actorGrain: "person",
      allowedEntityTypes: ["event_item", "channel", "page"],
      requiredPolicies: ["identity_resolution_v1", "retention_window_v1"],
      steps: [
        {
          stepId: "cohort_signup",
          factType: "conversion",
          required: true,
          outcomeId: "signup"
        },
        {
          stepId: "retained_activity",
          factType: "behavior",
          required: true,
          outcomeId: "retention",
          maxGap: "30d"
        }
      ]
    }),
    journeyTemplate({
      id: "entity_to_downstream_outcome",
      label: "Entity to downstream outcome",
      actorGrain: "both",
      allowedEntityTypes: ["channel", "page", "campaign", "product", "behavior"],
      requiredPolicies: ["identity_resolution_v1"],
      steps: [
        {
          stepId: "entity_exposure",
          factType: "touchpoint",
          required: true,
          maxGap: "90d"
        },
        { stepId: "downstream_outcome", factType: "conversion", required: true }
      ]
    }),
    glossary("growth_journey_terms", {
      terms: [
        {
          term: "paid conversion",
          aliases: ["paid customer", "first payment", "paid signup"],
          definition:
            "A conversion backed by a paid billing fact, not only a click or signup."
        },
        {
          term: "channel",
          aliases: ["utm source", "utm medium", "acquisition source"],
          definition:
            "A normalized origin used to group acquisition touchpoints."
        },
        {
          term: "LTV",
          aliases: ["lifetime value", "customer value"],
          definition:
            "Revenue accumulated over an explicit policy-versioned time window."
        }
      ]
    }),
    examplePlan("which_channels_lead_to_paid_customers", {
      question: "Which channels lead to paid customers?",
      plan: {
        intent: "rank_entities_by_outcome",
        entityType: "channel",
        outcomeId: "paid_conversion",
        journeyTemplateId: "touchpoint_to_paid_conversion"
      },
      contextCardIds: [
        "entity_definition:channel",
        "outcome_definition:paid_conversion",
        "journey_template:touchpoint_to_paid_conversion:v1"
      ]
    }),
    unsupportedCase("meta_ads_campaign_ltv", {
      questionPattern: "Meta LTV or Meta campaign lifetime value",
      reason: "unsupported_provider_grain",
      explanation:
        "Current Meta Ads support is campaign/day aggregate reporting. Those aggregates cannot answer user-level LTV because they lack actor identity, billing joins, and person-level paid conversion paths.",
      saferAlternatives: [
        "Report Meta campaign/day spend and clicks.",
        "Use PostHog or another actor-level touchpoint source joined to Stripe for LTV."
      ],
      relatedProvider: "meta_ads"
    }),
    unsupportedCase("ga4_person_level_conversion_paths", {
      questionPattern: "GA4 person-level conversion paths",
      reason: "unsupported_provider_grain",
      explanation:
        "GA4 seed support is aggregate traffic context. It is not an approved person-level conversion path source in this local-first plan.",
      saferAlternatives: [
        "Use PostHog actor/session facts for person-level paths.",
        "Use GA4 for aggregate traffic summaries."
      ]
    })
  ];
}

export function listContextCards(
  cards: readonly ContextCard[],
  filter: ContextCardFilter = {}
): ContextCardSummary[] {
  return cards
    .filter((card) => matchesFilter(card, filter))
    .map(summaryForCard);
}

export function searchContextCards(
  cards: readonly ContextCard[],
  query: string
): ContextCardSummary[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }

  return cards
    .filter((card) => matchesFilter(card, {}))
    .map((card) => ({ card, score: scoreCard(card, query, tokens) }))
    .filter((result) => result.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.card.title.localeCompare(right.card.title)
    )
    .map(({ card, score }) => ({
      ...summaryForCard(card),
      relevanceScore: score
    }));
}

export function describeContextCard(
  cards: readonly ContextCard[],
  id: string,
  options: Pick<ContextCardFilter, "includeUnapprovedJourneyTemplates"> = {}
): ContextCardDescription | undefined {
  const card = cards.find((candidate) => candidate.id === id);
  if (!card || !matchesFilter(card, options)) {
    return undefined;
  }

  return {
    ...summaryForCard(card),
    details: publicDetailsForCard(card)
  };
}

export function createJourneyTemplateSuggestion(
  input: CreateJourneyTemplateSuggestionInput
): JourneyTemplateSuggestion {
  const templateKey = input.template.id;
  if (input.blockedTemplateKeys?.includes(templateKey)) {
    throw new Error(
      `Journey template suggestion is blocked after rejection: ${templateKey}`
    );
  }
  assertAllowedJourneyEntityTypes(input.template);

  const template: JourneyTemplateCard = {
    ...input.template,
    status: "suggested",
    version: input.template.version ?? 1
  };

  return {
    id:
      input.id ??
      `journey_template_suggestion:${slugify(input.workspaceId)}:${slugify(template.id)}`,
    workspaceId: input.workspaceId,
    proposedBySessionId: input.proposedBySessionId,
    question: input.question,
    template,
    status: "suggested",
    createdAt: input.now ?? new Date().toISOString()
  };
}

export function approveJourneyTemplateSuggestion(
  input: ApproveJourneyTemplateSuggestionInput
): ApprovedJourneyTemplateSuggestion {
  if (input.suggestion.status === "rejected") {
    throw new Error(
      `Rejected journey template suggestions stay blocked: ${input.suggestion.id}`
    );
  }

  if (input.suggestion.status !== "suggested") {
    throw new Error(
      `Unsupported journey template suggestion status: ${input.suggestion.status}`
    );
  }

  const version = nextVersion(
    input.cards ?? [],
    "journey_template",
    input.suggestion.template.id
  );
  const approvedTemplate: JourneyTemplateCard = {
    ...input.suggestion.template,
    status: "approved",
    version
  };
  const contextCard = journeyTemplateContextCard(
    approvedTemplate,
    input.source ?? "operator"
  );
  const reviewedAt = input.now ?? new Date().toISOString();

  return {
    suggestion: {
      ...input.suggestion,
      template: approvedTemplate,
      status: "approved",
      reviewerActorId: input.reviewerActorId,
      reviewedAt
    },
    contextCard
  };
}

export function rejectJourneyTemplateSuggestion(
  input: RejectJourneyTemplateSuggestionInput
): JourneyTemplateSuggestion {
  return {
    ...input.suggestion,
    template: {
      ...input.suggestion.template,
      status: "rejected"
    },
    status: "rejected",
    reviewerActorId: input.reviewerActorId,
    reviewedAt: input.now ?? new Date().toISOString(),
    rejectionReason: input.reason
  };
}

function sourceCapability(
  provider: Provider,
  input: Omit<SourceCapabilityCard, "id" | "provider"> & {
    title: string;
    searchableText: string;
    tags: string[];
  }
): ContextCard<"source_capability"> {
  const payload: SourceCapabilityCard = { ...input, id: provider, provider };
  return {
    id: `source_capability:${provider}`,
    cardType: "source_capability",
    key: provider,
    title: input.title,
    searchableText: input.searchableText,
    payload,
    version: 1,
    source: "seed",
    tags: input.tags
  };
}

function entity(
  id: string,
  input: Omit<EntityDefinitionCard, "id" | "entityType">
): ContextCard<"entity_definition"> {
  const payload: EntityDefinitionCard = { ...input, id, entityType: id };
  return {
    id: `entity_definition:${id}`,
    cardType: "entity_definition",
    key: id,
    title: input.label,
    searchableText: [
      input.label,
      input.definition,
      input.synonyms.join(" "),
      input.compatibleOutcomeIds.join(" "),
      input.sourceProviders.join(" ")
    ].join(" "),
    payload,
    version: 1,
    source: "seed",
    tags: ["entity", id, ...input.synonyms]
  };
}

function outcome(
  id: string,
  input: Omit<OutcomeDefinitionCard, "id">
): ContextCard<"outcome_definition"> {
  const payload: OutcomeDefinitionCard = { ...input, id };
  return {
    id: `outcome_definition:${id}`,
    cardType: "outcome_definition",
    key: id,
    title: input.label,
    searchableText: [
      input.label,
      id,
      input.requiredFacts.join(" "),
      input.requiredPolicies.join(" "),
      input.defaultWindow ?? ""
    ].join(" "),
    payload,
    version: 1,
    source: "seed",
    tags: ["outcome", id]
  };
}

function policy(
  id: string,
  input: Omit<PolicyDefinitionCard, "id">
): ContextCard<"policy_definition"> {
  const payload: PolicyDefinitionCard = { ...input, id };
  return {
    id: `policy_definition:${id}:v${input.version}`,
    cardType: "policy_definition",
    key: id,
    title: input.label,
    searchableText: [
      input.label,
      input.appliesTo.join(" "),
      input.rules.join(" "),
      input.caveats.join(" ")
    ].join(" "),
    payload,
    version: input.version,
    source: "seed",
    tags: ["policy", id]
  };
}

function pathTemplate(
  id: string,
  input: Omit<PathTemplateCard, "id">
): ContextCard<"path_template"> {
  const payload: PathTemplateCard = { ...input, id };
  return {
    id: `path_template:${id}:v1`,
    cardType: "path_template",
    key: id,
    title: input.label,
    searchableText: [
      input.label,
      input.fromEntityType,
      input.toOutcomeId,
      input.requiredJourneyTemplateIds.join(" "),
      input.description
    ].join(" "),
    payload,
    version: 1,
    source: "seed",
    tags: ["path_template", input.fromEntityType, input.toOutcomeId]
  };
}

function journeyTemplate(
  input: Omit<JourneyTemplateCard, "status" | "version">
): ContextCard<"journey_template"> {
  return journeyTemplateContextCard(
    { ...input, status: "seed", version: 1 },
    "seed"
  );
}

function journeyTemplateContextCard(
  payload: JourneyTemplateCard,
  source: ContextCardSource
): ContextCard<"journey_template"> {
  assertAllowedJourneyEntityTypes(payload);

  return {
    id: `journey_template:${payload.id}:v${payload.version}`,
    cardType: "journey_template",
    key: payload.id,
    title: payload.label,
    searchableText: [
      payload.id,
      payload.label,
      payload.actorGrain,
      payload.allowedEntityTypes.join(" "),
      payload.requiredPolicies.join(" "),
      payload.status,
      payload.steps
        .map((step) =>
          [
            step.stepId,
            step.factType,
            step.outcomeId ?? "",
            step.maxGap ?? ""
          ].join(" ")
        )
        .join(" ")
    ].join(" "),
    payload,
    version: payload.version,
    source,
    tags: ["journey_template", payload.status, ...payload.allowedEntityTypes]
  };
}

function assertAllowedJourneyEntityTypes(
  template: Pick<JourneyTemplateCard, "id" | "allowedEntityTypes">
): void {
  const allowed = new Set<string>(JOURNEY_ENTITY_TYPES);
  const unsupported = template.allowedEntityTypes.filter(
    (entityType) => !allowed.has(entityType)
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported journey entity type in ${template.id}: ${unsupported.join(", ")}`
    );
  }
}

function glossary(
  id: string,
  input: Omit<GlossaryCard, "id">
): ContextCard<"glossary"> {
  const payload: GlossaryCard = { ...input, id };
  return {
    id: `glossary:${id}:v1`,
    cardType: "glossary",
    key: id,
    title: "Growth journey glossary",
    searchableText: input.terms
      .map((term) =>
        [term.term, term.aliases.join(" "), term.definition].join(" ")
      )
      .join(" "),
    payload,
    version: 1,
    source: "seed",
    tags: ["glossary", "terms"]
  };
}

function examplePlan(
  id: string,
  input: Omit<ExamplePlanCard, "id">
): ContextCard<"example_plan"> {
  const payload: ExamplePlanCard = { ...input, id };
  return {
    id: `example_plan:${id}:v1`,
    cardType: "example_plan",
    key: id,
    title: input.question,
    searchableText: [
      input.question,
      input.plan.intent,
      input.plan.entityType,
      input.plan.outcomeId,
      input.plan.journeyTemplateId,
      input.contextCardIds.join(" ")
    ].join(" "),
    payload,
    version: 1,
    source: "seed",
    tags: ["example_plan", input.plan.entityType, input.plan.outcomeId]
  };
}

function unsupportedCase(
  id: string,
  input: Omit<UnsupportedCaseCard, "id">
): ContextCard<"unsupported_case"> {
  const payload: UnsupportedCaseCard = { ...input, id };
  return {
    id: `unsupported_case:${id}:v1`,
    cardType: "unsupported_case",
    key: id,
    title: input.questionPattern,
    searchableText: [
      input.questionPattern,
      input.reason,
      input.explanation,
      input.saferAlternatives.join(" "),
      input.relatedProvider ?? ""
    ].join(" "),
    payload,
    version: 1,
    source: "seed",
    tags: [
      "unsupported_case",
      input.reason,
      input.relatedProvider ?? ""
    ].filter(Boolean)
  };
}

function matchesFilter(card: ContextCard, filter: ContextCardFilter): boolean {
  if (!matchesOneOrMany(card.cardType, filter.cardType)) {
    return false;
  }
  if (!matchesOneOrMany(card.source, filter.source)) {
    return false;
  }
  if (filter.key && card.key !== filter.key) {
    return false;
  }
  if (filter.tags && !filter.tags.every((tag) => card.tags.includes(tag))) {
    return false;
  }
  if (filter.provider && !matchesProvider(card, filter.provider)) {
    return false;
  }
  const journeyStatus = journeyStatusFor(card);
  if (!matchesOneOrMany(journeyStatus, filter.status)) {
    return false;
  }
  if (
    card.cardType === "journey_template" &&
    !filter.status &&
    !filter.includeUnapprovedJourneyTemplates &&
    !["seed", "approved"].includes(card.payload.status)
  ) {
    return false;
  }

  return true;
}

function matchesOneOrMany<T extends string>(
  value: T | undefined,
  expected: T | readonly T[] | undefined
): boolean {
  if (!expected) {
    return true;
  }
  if (!value) {
    return false;
  }
  return Array.isArray(expected)
    ? expected.includes(value)
    : value === expected;
}

function matchesProvider(
  card: ContextCard,
  providerFilter: Provider | readonly Provider[]
): boolean {
  const providers = Array.isArray(providerFilter)
    ? providerFilter
    : [providerFilter];
  return providersFor(card).some((provider) => providers.includes(provider));
}

function providersFor(card: ContextCard): Provider[] {
  if (card.cardType === "source_capability") {
    return [card.payload.provider];
  }
  if (card.cardType === "unsupported_case") {
    return card.payload.relatedProvider ? [card.payload.relatedProvider] : [];
  }
  if (card.cardType === "entity_definition") {
    return [...card.payload.sourceProviders];
  }
  return [];
}

function journeyStatusFor(
  card: ContextCard
): JourneyTemplateStatus | undefined {
  return card.cardType === "journey_template" ? card.payload.status : undefined;
}

function summaryForCard(card: ContextCard): ContextCardSummary {
  return {
    id: card.id,
    cardType: card.cardType,
    key: card.key,
    title: card.title,
    summary: firstSentence(card.searchableText),
    version: card.version,
    source: card.source,
    tags: [...card.tags],
    journeyStatus: journeyStatusFor(card)
  };
}

function publicDetailsForCard(card: ContextCard): Record<string, unknown> {
  switch (card.cardType) {
    case "source_capability":
      return {
        provider: card.payload.provider,
        hasActorIdentity: card.payload.hasActorIdentity,
        hasCampaignTouchpoints: card.payload.hasCampaignTouchpoints,
        hasRevenueEvents: card.payload.hasRevenueEvents,
        supportedEntities: [...card.payload.supportedEntities],
        unsupportedQuestions: [...card.payload.unsupportedQuestions],
        freshnessSource: card.payload.freshnessSource
      };
    case "entity_definition":
      return {
        entityType: card.payload.entityType,
        actorGrain: card.payload.actorGrain,
        definition: card.payload.definition,
        synonyms: [...card.payload.synonyms],
        sourceProviders: [...card.payload.sourceProviders],
        compatibleOutcomeIds: [...card.payload.compatibleOutcomeIds]
      };
    case "outcome_definition":
      return {
        actorGrain: card.payload.actorGrain,
        requiredFacts: [...card.payload.requiredFacts],
        requiredPolicies: [...card.payload.requiredPolicies],
        defaultWindow: card.payload.defaultWindow
      };
    case "policy_definition":
      return {
        policyVersion: card.payload.version,
        appliesTo: [...card.payload.appliesTo],
        rules: [...card.payload.rules],
        caveats: [...card.payload.caveats]
      };
    case "path_template":
      return {
        fromEntityType: card.payload.fromEntityType,
        toOutcomeId: card.payload.toOutcomeId,
        requiredJourneyTemplateIds: [
          ...card.payload.requiredJourneyTemplateIds
        ],
        description: card.payload.description
      };
    case "journey_template":
      return {
        actorGrain: card.payload.actorGrain,
        allowedEntityTypes: [...card.payload.allowedEntityTypes],
        requiredPolicies: [...card.payload.requiredPolicies],
        status: card.payload.status,
        templateVersion: card.payload.version,
        steps: card.payload.steps.map((step) => ({ ...step }))
      };
    case "glossary":
      return {
        terms: card.payload.terms.map((term) => ({
          ...term,
          aliases: [...term.aliases]
        }))
      };
    case "example_plan":
      return {
        question: card.payload.question,
        plan: { ...card.payload.plan },
        contextCardIds: [...card.payload.contextCardIds]
      };
    case "unsupported_case":
      return {
        questionPattern: card.payload.questionPattern,
        reason: card.payload.reason,
        explanation: card.payload.explanation,
        saferAlternatives: [...card.payload.saferAlternatives],
        relatedProvider: card.payload.relatedProvider
      };
  }
}

function scoreCard(
  card: ContextCard,
  query: string,
  queryTokens: readonly string[]
): number {
  const haystack = normalize(
    [card.key, card.title, card.searchableText, card.tags.join(" ")].join(" ")
  );
  const normalizedQuery = normalize(query);
  let score = haystack.includes(normalizedQuery) ? 8 : 0;

  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 2;
    }
    if (
      normalize(card.title).includes(token) ||
      normalize(card.key).includes(token)
    ) {
      score += 2;
    }
  }

  if (
    card.cardType === "unsupported_case" &&
    queryTokens.some((token) => haystack.includes(token))
  ) {
    score += 1;
  }

  return score;
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      normalize(value)
        .split(/\s+/)
        .filter((token) => token.length > 1)
    )
  );
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  const sentenceEnd = trimmed.search(/[.!?]/);
  return sentenceEnd >= 0 ? trimmed.slice(0, sentenceEnd + 1) : trimmed;
}

function nextVersion(
  cards: readonly ContextCard[],
  cardType: ContextCardType,
  key: string
): number {
  const versions = cards
    .filter((card) => card.cardType === cardType && card.key === key)
    .map((card) => card.version);
  return versions.length === 0 ? 1 : Math.max(...versions) + 1;
}

function slugify(value: string): string {
  return normalize(value).replace(/\s+/g, "_") || "template";
}
