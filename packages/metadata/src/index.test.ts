import { describe, expect, it } from "vitest";

import { JOURNEY_ENTITY_TYPES } from "@infinite-os/core";

import {
  approveJourneyTemplateSuggestion,
  createJourneyTemplateSuggestion,
  describeContextCard,
  listContextCards,
  rejectJourneyTemplateSuggestion,
  searchContextCards,
  seedContextCards,
  type ContextCard,
  type JourneyTemplateCard
} from "./index.js";

describe("metadata context cards", () => {
  it("seeds every context card type and base journey templates", () => {
    const cards = seedContextCards();

    expect(new Set(cards.map((card) => card.cardType))).toEqual(
      new Set([
        "source_capability",
        "entity_definition",
        "outcome_definition",
        "policy_definition",
        "path_template",
        "journey_template",
        "glossary",
        "example_plan",
        "unsupported_case"
      ])
    );
    expect(listContextCards(cards, { cardType: "journey_template" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "touchpoint_to_signup",
          journeyStatus: "seed"
        }),
        expect.objectContaining({
          key: "touchpoint_to_paid_conversion",
          journeyStatus: "seed"
        }),
        expect.objectContaining({
          key: "touchpoint_to_active_paid",
          journeyStatus: "seed"
        }),
        expect.objectContaining({
          key: "touchpoint_to_ltv",
          journeyStatus: "seed"
        }),
        expect.objectContaining({
          key: "behavior_window_to_conversion",
          journeyStatus: "seed"
        }),
        expect.objectContaining({
          key: "signup_cohort_to_retention",
          journeyStatus: "seed"
        }),
        expect.objectContaining({
          key: "entity_to_downstream_outcome",
          journeyStatus: "seed"
        })
      ])
    );
  });

  it("finds paid conversion channel entity and outcome context without a vector DB", () => {
    const results = searchContextCards(
      seedContextCards(),
      "paid conversion channel"
    );

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cardType: "entity_definition",
          key: "channel"
        }),
        expect.objectContaining({
          cardType: "outcome_definition",
          key: "paid_conversion"
        })
      ])
    );
  });

  it("finds Meta LTV capability limits", () => {
    const results = searchContextCards(seedContextCards(), "Meta LTV");

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cardType: expect.stringMatching(/source_capability|unsupported_case/),
          summary: expect.stringMatching(
            /campaign\/day aggregate|cannot answer user-level LTV/i
          )
        })
      ])
    );
  });

  it("describes cards without returning raw payloads or provider truth rows", () => {
    const cards = seedContextCards();
    const searchResult = searchContextCards(
      cards,
      "paid conversion channel"
    )[0];
    const description = describeContextCard(
      cards,
      "source_capability:meta_ads"
    );

    expect(searchResult).toBeDefined();
    expect(description).toBeDefined();
    const helperOutput = JSON.stringify([searchResult, description]);
    expect(helperOutput).not.toContain('"payload"');
    expect(helperOutput).not.toContain("raw_payload");
    expect(helperOutput).not.toContain("providerTruthRows");
    expect(helperOutput).not.toContain("posthog_event_truth");
    expect(helperOutput).not.toContain("stripe_customers");
    expect(helperOutput).not.toContain("stripe_invoices");
  });

  it("seeds policy cards for every referenced seed policy", () => {
    const cards = seedContextCards();
    const policyKeys = new Set(
      cards
        .filter((card) => card.cardType === "policy_definition")
        .map((card) => card.key)
    );
    const referencedPolicyIds = new Set(
      cards.flatMap((card) => {
        if (card.cardType === "outcome_definition") {
          return card.payload.requiredPolicies;
        }
        if (card.cardType === "journey_template") {
          return card.payload.requiredPolicies;
        }
        return [];
      })
    );

    for (const policyId of referencedPolicyIds) {
      expect(policyKeys.has(policyId), policyId).toBe(true);
    }
  });

  it("keeps seed journey planning cards on the shared journey entity vocabulary", () => {
    const allowedEntityTypes = new Set<string>(JOURNEY_ENTITY_TYPES);
    const cards = seedContextCards();
    const journeyTemplates = cards.filter(
      (card): card is ContextCard<"journey_template"> =>
        card.cardType === "journey_template"
    );
    const pathTemplates = cards.filter(
      (card): card is ContextCard<"path_template"> =>
        card.cardType === "path_template"
    );
    const examplePlans = cards.filter(
      (card): card is ContextCard<"example_plan"> =>
        card.cardType === "example_plan"
    );

    for (const card of journeyTemplates) {
      for (const entityType of card.payload.allowedEntityTypes) {
        expect(allowedEntityTypes.has(entityType), card.key).toBe(true);
      }
    }
    for (const card of pathTemplates) {
      expect(
        allowedEntityTypes.has(card.payload.fromEntityType),
        card.key
      ).toBe(true);
    }
    for (const card of examplePlans) {
      expect(
        allowedEntityTypes.has(card.payload.plan.entityType),
        card.key
      ).toBe(true);
    }
  });

  it("matches every provider on multi-provider entity cards", () => {
    const results = listContextCards(seedContextCards(), {
      cardType: "entity_definition",
      provider: "meta_ads"
    });

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "channel" }),
        expect.objectContaining({ key: "campaign" })
      ])
    );
  });
});

describe("journey template suggestions", () => {
  const customTemplate: Omit<JourneyTemplateCard, "status" | "version"> = {
    id: "campaign_to_team_activation",
    label: "Campaign to team activation",
    actorGrain: "account",
    allowedEntityTypes: ["campaign", "behavior"],
    requiredPolicies: ["identity_resolution_v1"],
    steps: [
      {
        stepId: "invite_sent",
        factType: "touchpoint",
        required: true,
        maxGap: "14d"
      },
      {
        stepId: "team_activation",
        factType: "behavior",
        required: true,
        outcomeId: "active_paid"
      }
    ]
  };

  it("keeps suggested templates out of approved context until approval", () => {
    const cards = seedContextCards();
    const suggestion = createJourneyTemplateSuggestion({
      workspaceId: "workspace",
      question: "Which campaigns create activated teams?",
      template: customTemplate,
      now: "2026-06-07T00:00:00.000Z"
    });

    expect(suggestion.status).toBe("suggested");
    expect(suggestion.template.status).toBe("suggested");
    expect(
      listContextCards(cards, {
        cardType: "journey_template",
        status: "approved"
      })
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: customTemplate.id })
      ])
    );
  });

  it("emits approved suggestions as versioned journey_template context cards", () => {
    const cards = seedContextCards();
    const suggestion = createJourneyTemplateSuggestion({
      workspaceId: "workspace",
      question: "Which campaigns create activated teams?",
      template: customTemplate,
      now: "2026-06-07T00:00:00.000Z"
    });

    const approved = approveJourneyTemplateSuggestion({
      suggestion,
      cards,
      reviewerActorId: "operator",
      now: "2026-06-07T01:00:00.000Z"
    });
    const withApproved: ContextCard[] = [...cards, approved.contextCard];

    expect(approved.suggestion.status).toBe("approved");
    expect(approved.contextCard).toMatchObject({
      cardType: "journey_template",
      key: customTemplate.id,
      version: 1,
      source: "operator",
      payload: expect.objectContaining({ status: "approved", version: 1 })
    });
    expect(
      listContextCards(withApproved, {
        cardType: "journey_template",
        status: "approved"
      })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: customTemplate.id,
          version: 1,
          journeyStatus: "approved"
        })
      ])
    );
    expect(() =>
      approveJourneyTemplateSuggestion({ suggestion: approved.suggestion })
    ).toThrow(/Unsupported journey template suggestion status/);
  });

  it("does not describe unapproved journey templates unless explicitly requested", () => {
    const cards = seedContextCards();
    const approved = approveJourneyTemplateSuggestion({
      suggestion: createJourneyTemplateSuggestion({
        workspaceId: "workspace",
        question: "Which campaigns create activated teams?",
        template: customTemplate,
        now: "2026-06-07T00:00:00.000Z"
      }),
      cards,
      now: "2026-06-07T01:00:00.000Z"
    });
    const suggestedCard: ContextCard = {
      ...approved.contextCard,
      payload: { ...approved.contextCard.payload, status: "suggested" },
      tags: ["journey_template", "suggested"]
    };

    expect(
      describeContextCard([suggestedCard], suggestedCard.id)
    ).toBeUndefined();
    expect(
      describeContextCard([suggestedCard], suggestedCard.id, {
        includeUnapprovedJourneyTemplates: true
      })
    ).toMatchObject({ journeyStatus: "suggested" });
  });

  it("increments approved context card versions and keeps rejected suggestions blocked", () => {
    const cards = seedContextCards();
    const firstApproval = approveJourneyTemplateSuggestion({
      suggestion: createJourneyTemplateSuggestion({
        workspaceId: "workspace",
        question: "Which campaigns create activated teams?",
        template: customTemplate,
        now: "2026-06-07T00:00:00.000Z"
      }),
      cards,
      now: "2026-06-07T01:00:00.000Z"
    });

    const secondApproval = approveJourneyTemplateSuggestion({
      suggestion: createJourneyTemplateSuggestion({
        workspaceId: "workspace",
        question: "Which campaigns create activated teams under the new rule?",
        template: customTemplate,
        now: "2026-06-07T02:00:00.000Z"
      }),
      cards: [...cards, firstApproval.contextCard],
      now: "2026-06-07T03:00:00.000Z"
    });
    expect(secondApproval.contextCard.version).toBe(2);

    const rejected = rejectJourneyTemplateSuggestion({
      suggestion: createJourneyTemplateSuggestion({
        workspaceId: "workspace",
        question: "Use a bad campaign journey?",
        template: { ...customTemplate, id: "bad_invite_journey" },
        now: "2026-06-07T04:00:00.000Z"
      }),
      reason: "insufficient evidence",
      now: "2026-06-07T05:00:00.000Z"
    });

    expect(rejected.status).toBe("rejected");
    expect(() =>
      approveJourneyTemplateSuggestion({ suggestion: rejected })
    ).toThrow(/stay blocked/);
    expect(() =>
      createJourneyTemplateSuggestion({
        workspaceId: "workspace",
        question: "Retry rejected journey",
        template: { ...customTemplate, id: "bad_invite_journey" },
        blockedTemplateKeys: [rejected.template.id]
      })
    ).toThrow(/blocked/);
  });

  it("rejects suggested templates with unsupported journey entity types", () => {
    expect(() =>
      createJourneyTemplateSuggestion({
        workspaceId: "workspace",
        question: "Which invites create activated teams?",
        template: {
          ...customTemplate,
          allowedEntityTypes: ["campaign", "invite"]
        } as unknown as Omit<JourneyTemplateCard, "status" | "version">
      })
    ).toThrow(/Unsupported journey entity type/);
  });
});
