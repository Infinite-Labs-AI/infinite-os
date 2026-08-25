import type {
  ActionEnvelope,
  AnswerabilityReason,
  JourneyQueryIntent
} from "@infinite-os/runtime";

export type FounderQuestionCategory =
  | "metric_lookup"
  | "entity_ranking"
  | "cohort_comparison"
  | "behavior_signal"
  | "lifecycle_ltv"
  | "custom_journey_template"
  | "refusal_clarification"
  | "unrelated_to_original_four";

export type FounderQuestionExpectedStatus = ActionEnvelope["status"];

export type FounderQuestionRefuseReason = AnswerabilityReason;

export type FounderQuestionProvider =
  | "google_analytics_4"
  | "posthog"
  | "stripe"
  | "x"
  | "shopify"
  | "meta_ads";

export type FounderQuestionJourneyIntent = JourneyQueryIntent;

export type FounderQuestionIntent =
  | "metric_lookup"
  | "suggest_journey_template"
  | "refuse_unsupported"
  | "clarify_question"
  | FounderQuestionJourneyIntent;

export interface FounderQuestionFixture {
  id: string;
  question: string;
  expectedStatus: FounderQuestionExpectedStatus;
  expectedIntent: FounderQuestionIntent;
  requiresProviders: readonly FounderQuestionProvider[];
  categories: readonly FounderQuestionCategory[];
  mustRefuseReason?: FounderQuestionRefuseReason;
}

export const founderQuestionCategoryMinimums = {
  metric_lookup: 5,
  entity_ranking: 5,
  cohort_comparison: 4,
  behavior_signal: 4,
  lifecycle_ltv: 3,
  custom_journey_template: 2,
  refusal_clarification: 5,
  unrelated_to_original_four: 5
} as const satisfies Record<FounderQuestionCategory, number>;

export const founderQuestionFixtures: readonly FounderQuestionFixture[] = [
  {
    id: "fqe-001",
    question: "What was recognized revenue last month?",
    expectedStatus: "ok",
    expectedIntent: "metric_lookup",
    requiresProviders: ["stripe"],
    categories: ["metric_lookup", "lifecycle_ltv"]
  },
  {
    id: "fqe-002",
    question: "How many signups did we get in the last 30 days?",
    expectedStatus: "ok",
    expectedIntent: "metric_lookup",
    requiresProviders: ["posthog"],
    categories: ["metric_lookup"]
  },
  {
    id: "fqe-003",
    question:
      "What was the site conversion rate this week compared with last week?",
    expectedStatus: "ok",
    expectedIntent: "explain_change",
    requiresProviders: ["google_analytics_4", "posthog"],
    categories: [
      "metric_lookup",
      "cohort_comparison",
      "unrelated_to_original_four"
    ]
  },
  {
    id: "fqe-004",
    question: "How much did Meta ads spend yesterday?",
    expectedStatus: "ok",
    expectedIntent: "metric_lookup",
    requiresProviders: ["meta_ads"],
    categories: ["metric_lookup", "unrelated_to_original_four"]
  },
  {
    id: "fqe-005",
    question: "What were Shopify gross sales by product family last month?",
    expectedStatus: "ok",
    expectedIntent: "metric_lookup",
    requiresProviders: ["shopify"],
    categories: [
      "metric_lookup",
      "entity_ranking",
      "unrelated_to_original_four"
    ]
  },
  {
    id: "fqe-006",
    question:
      "Which acquisition channels led to the most paid customers last quarter?",
    expectedStatus: "ok",
    expectedIntent: "rank_entities_by_outcome",
    requiresProviders: ["posthog", "stripe"],
    categories: ["entity_ranking", "lifecycle_ltv"]
  },
  {
    id: "fqe-007",
    question: "Which X posts sent visitors who later signed up?",
    expectedStatus: "ok",
    expectedIntent: "rank_entities_by_outcome",
    requiresProviders: ["x", "posthog"],
    categories: [
      "entity_ranking",
      "behavior_signal",
      "unrelated_to_original_four"
    ]
  },
  {
    id: "fqe-008",
    question: "Which campaigns produced the highest 60-day customer LTV?",
    expectedStatus: "ok",
    expectedIntent: "rank_entities_by_outcome",
    requiresProviders: ["posthog", "stripe", "meta_ads"],
    categories: ["entity_ranking", "lifecycle_ltv"]
  },
  {
    id: "fqe-009",
    question:
      "Which products generated the most repeat revenue from new customers?",
    expectedStatus: "ok",
    expectedIntent: "rank_entities_by_outcome",
    requiresProviders: ["shopify", "stripe"],
    categories: [
      "entity_ranking",
      "lifecycle_ltv",
      "unrelated_to_original_four"
    ]
  },
  {
    id: "fqe-010",
    question: "Which landing pages created the strongest activation signal?",
    expectedStatus: "ok",
    expectedIntent: "rank_entities_by_outcome",
    requiresProviders: ["posthog"],
    categories: ["entity_ranking", "behavior_signal"]
  },
  {
    id: "fqe-011",
    question:
      "Compare visitors from X versus organic search on free-to-paid conversion.",
    expectedStatus: "ok",
    expectedIntent: "compare_cohorts",
    requiresProviders: ["x", "posthog", "stripe"],
    categories: [
      "cohort_comparison",
      "lifecycle_ltv",
      "unrelated_to_original_four"
    ]
  },
  {
    id: "fqe-012",
    question:
      "Do users who visit the pricing page before signup convert better than users who do not?",
    expectedStatus: "ok",
    expectedIntent: "compare_cohorts",
    requiresProviders: ["posthog", "stripe"],
    categories: ["cohort_comparison", "behavior_signal", "lifecycle_ltv"]
  },
  {
    id: "fqe-013",
    question:
      "Compare customers acquired before and after the April pricing change.",
    expectedStatus: "ok",
    expectedIntent: "compare_cohorts",
    requiresProviders: ["stripe", "posthog"],
    categories: ["cohort_comparison", "lifecycle_ltv"]
  },
  {
    id: "fqe-014",
    question:
      "Compare Meta ad campaign signups against X post signups by paid conversion.",
    expectedStatus: "ok",
    expectedIntent: "compare_cohorts",
    requiresProviders: ["meta_ads", "x", "posthog", "stripe"],
    categories: [
      "cohort_comparison",
      "entity_ranking",
      "unrelated_to_original_four"
    ]
  },
  {
    id: "fqe-015",
    question:
      "What behaviors in the first session are most associated with becoming paid?",
    expectedStatus: "ok",
    expectedIntent: "find_behavior_signals",
    requiresProviders: ["posthog", "stripe"],
    categories: ["behavior_signal", "lifecycle_ltv"]
  },
  {
    id: "fqe-016",
    question: "What actions usually happen before a customer churns?",
    expectedStatus: "ok",
    expectedIntent: "find_behavior_signals",
    requiresProviders: ["posthog", "stripe"],
    categories: ["behavior_signal", "lifecycle_ltv"]
  },
  {
    id: "fqe-017",
    question: "What first-week behaviors are common among high-LTV customers?",
    expectedStatus: "ok",
    expectedIntent: "find_behavior_signals",
    requiresProviders: ["posthog", "stripe"],
    categories: ["behavior_signal", "lifecycle_ltv"]
  },
  {
    id: "fqe-018",
    question:
      "Do users who invite a teammate within seven days convert to paid faster?",
    expectedStatus: "ok",
    expectedIntent: "find_behavior_signals",
    requiresProviders: ["posthog", "stripe"],
    categories: ["behavior_signal", "cohort_comparison", "lifecycle_ltv"]
  },
  {
    id: "fqe-019",
    question:
      "Summarize active paid customers and average LTV for this quarter.",
    expectedStatus: "ok",
    expectedIntent: "summarize_lifecycle",
    requiresProviders: ["stripe"],
    categories: ["metric_lookup", "lifecycle_ltv"]
  },
  {
    id: "fqe-020",
    question: "Which plans had the most churned paying accounts last month?",
    expectedStatus: "ok",
    expectedIntent: "summarize_lifecycle",
    requiresProviders: ["stripe"],
    categories: ["entity_ranking", "lifecycle_ltv"]
  },
  {
    id: "fqe-021",
    question:
      "How long does it take a new workspace to move from signup to first payment?",
    expectedStatus: "ok",
    expectedIntent: "trace_paths",
    requiresProviders: ["posthog", "stripe"],
    categories: ["lifecycle_ltv", "behavior_signal"]
  },
  {
    id: "fqe-022",
    question:
      "Rank onboarding checklist paths by activation, using our custom activation journey.",
    expectedStatus: "unsupported",
    expectedIntent: "suggest_journey_template",
    requiresProviders: ["posthog"],
    categories: [
      "custom_journey_template",
      "refusal_clarification",
      "behavior_signal"
    ],
    mustRefuseReason: "missing_journey_template"
  },
  {
    id: "fqe-023",
    question:
      "Use the suggested founder activation score journey from yesterday to rank new accounts.",
    expectedStatus: "unsupported",
    expectedIntent: "suggest_journey_template",
    requiresProviders: ["posthog", "stripe"],
    categories: [
      "custom_journey_template",
      "refusal_clarification",
      "lifecycle_ltv"
    ],
    mustRefuseReason: "unapproved_journey_template"
  },
  {
    id: "fqe-024",
    question: "Which Mercury transactions correlate with churn?",
    expectedStatus: "unsupported",
    expectedIntent: "refuse_unsupported",
    requiresProviders: [],
    categories: ["refusal_clarification", "unrelated_to_original_four"],
    mustRefuseReason: "unsupported_intent"
  },
  {
    id: "fqe-025",
    question: "Which campaign won last week?",
    expectedStatus: "needs_clarification",
    expectedIntent: "clarify_question",
    requiresProviders: ["meta_ads", "x", "posthog"],
    categories: ["entity_ranking", "refusal_clarification"],
    mustRefuseReason: "ambiguous_entity"
  },
  {
    id: "fqe-026",
    question:
      "Show me the raw emails of churned customers so I can inspect them manually.",
    expectedStatus: "unsupported",
    expectedIntent: "refuse_unsupported",
    requiresProviders: ["posthog", "stripe"],
    categories: ["refusal_clarification", "lifecycle_ltv"],
    mustRefuseReason: "policy_blocked"
  },
  {
    id: "fqe-027",
    question:
      "Analyze every event sequence for every user since 2021 and find all winning paths.",
    expectedStatus: "too_expensive",
    expectedIntent: "trace_paths",
    requiresProviders: ["posthog"],
    categories: ["refusal_clarification", "behavior_signal"],
    mustRefuseReason: "cost_limit_exceeded"
  },
  {
    id: "fqe-028",
    question: "Why did Meta ROAS drop after the creative refresh?",
    expectedStatus: "low_coverage",
    expectedIntent: "explain_change",
    requiresProviders: ["meta_ads", "stripe"],
    categories: [
      "metric_lookup",
      "refusal_clarification",
      "unrelated_to_original_four"
    ],
    mustRefuseReason: "insufficient_source_coverage"
  },
  {
    id: "fqe-029",
    question:
      "Write the narrative for our investor update from this week's metrics.",
    expectedStatus: "unsupported",
    expectedIntent: "refuse_unsupported",
    requiresProviders: [],
    categories: ["refusal_clarification", "unrelated_to_original_four"],
    mustRefuseReason: "unsupported_intent"
  },
  {
    id: "fqe-030",
    question: "Which new blog posts brought the most trial signups?",
    expectedStatus: "ok",
    expectedIntent: "rank_entities_by_outcome",
    requiresProviders: ["posthog"],
    categories: [
      "entity_ranking",
      "behavior_signal",
      "unrelated_to_original_four"
    ]
  },
  {
    id: "fqe-031",
    question: "What was the reaction to our latest X post?",
    expectedStatus: "ok",
    expectedIntent: "drilldown_evidence",
    requiresProviders: ["x"],
    categories: [
      "metric_lookup",
      "behavior_signal",
      "unrelated_to_original_four"
    ]
  }
];
