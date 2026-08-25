import { describe, expect, it } from "vitest";

import {
  founderQuestionCategoryMinimums,
  founderQuestionFixtures,
  type FounderQuestionCategory
} from "./fixtures/founder-questions.js";

const NON_OK_STATUSES = new Set([
  "unsupported",
  "not_implemented",
  "low_coverage",
  "needs_clarification",
  "too_expensive",
  "error"
]);

describe("founder question fixture contract", () => {
  it("has enough coverage to guard against a narrow demo implementation", () => {
    expect(founderQuestionFixtures.length).toBeGreaterThanOrEqual(25);

    const noAnswerCases = founderQuestionFixtures.filter((fixture) =>
      NON_OK_STATUSES.has(fixture.expectedStatus)
    );
    expect(noAnswerCases.length).toBeGreaterThanOrEqual(5);

    const ids = new Set(founderQuestionFixtures.map((fixture) => fixture.id));
    expect(ids.size).toBe(founderQuestionFixtures.length);
  });

  it("keeps required fixture fields populated and refusal reasons explicit", () => {
    for (const fixture of founderQuestionFixtures) {
      expect(fixture.id).toMatch(/^fqe-\d{3}$/);
      expect(fixture.question.trim().length).toBeGreaterThan(15);
      expect(fixture.expectedStatus).toBeTruthy();
      expect(fixture.expectedIntent).toBeTruthy();
      expect(Array.isArray(fixture.requiresProviders)).toBe(true);
      expect(fixture.categories.length).toBeGreaterThan(0);

      if (NON_OK_STATUSES.has(fixture.expectedStatus)) {
        expect(fixture.mustRefuseReason).toBeTruthy();
      } else {
        expect(fixture.mustRefuseReason).toBeUndefined();
      }
    }
  });

  it("covers the required founder question categories", () => {
    const counts = new Map<FounderQuestionCategory, number>();

    for (const fixture of founderQuestionFixtures) {
      for (const category of fixture.categories) {
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }

    for (const [category, minimum] of Object.entries(
      founderQuestionCategoryMinimums
    ) as Array<[FounderQuestionCategory, number]>) {
      expect(counts.get(category) ?? 0, category).toBeGreaterThanOrEqual(
        minimum
      );
    }
  });

  it("covers answerability statuses and custom-template refusal reasons", () => {
    const statuses = new Set(
      founderQuestionFixtures.map((fixture) => fixture.expectedStatus)
    );
    expect(statuses).toContain("ok");
    expect(statuses).toContain("unsupported");
    expect(statuses).toContain("needs_clarification");
    expect(statuses).toContain("low_coverage");
    expect(statuses).toContain("too_expensive");

    const refusalReasons = new Set(
      founderQuestionFixtures
        .map((fixture) => fixture.mustRefuseReason)
        .filter((reason): reason is NonNullable<typeof reason> =>
          Boolean(reason)
        )
    );
    expect(refusalReasons).toContain("missing_journey_template");
    expect(refusalReasons).toContain("unapproved_journey_template");
  });

  it("does not collapse every fixture onto one provider or one intent", () => {
    const intents = new Set(
      founderQuestionFixtures.map((fixture) => fixture.expectedIntent)
    );
    const providers = new Set(
      founderQuestionFixtures.flatMap((fixture) => fixture.requiresProviders)
    );
    const providerSets = new Set(
      founderQuestionFixtures.map(
        (fixture) =>
          fixture.requiresProviders.slice().sort().join("+") || "none"
      )
    );

    expect(intents.size).toBeGreaterThan(5);
    expect(providers.size).toBeGreaterThanOrEqual(5);
    expect(providerSets.size).toBeGreaterThan(5);
  });
});
