import { describe, expect, it } from "vitest";

import { makeGa4PromptSelector } from "./provisioner.js";

const CANDIDATE = {
  accountId: "accounts/1",
  accountName: "Ultima Inc",
  propertyId: "properties/100",
  displayName: "Main Site",
  stream: { measurementId: "G-AAA111" },
  matchesSite: false
};

const ACCOUNTS = [{ accountId: "accounts/1", accountName: "Ultima Inc" }];

const MORE_OPTIONS_LABEL = "Don't see the right account? More options…";
const CREATE_ACCOUNT_LABEL =
  "➕ Create a new Google Analytics account (browser step — pauses setup)";
const BACK_LABEL = "← Back";

function fakePrompter(answer: (question: string, choices?: string[]) => string) {
  const notes: string[] = [];
  const asks: Array<{ question: string; choices?: string[] }> = [];
  return {
    notes,
    asks,
    prompt: {
      async ask(question: string, choices?: string[]) {
        asks.push({ question, choices });
        return answer(question, choices);
      },
      note(message: string) {
        notes.push(message);
      }
    }
  };
}

describe("makeGa4PromptSelector", () => {
  it("keeps the create-account row off the main picker, behind More options", async () => {
    const { prompt, asks } = fakePrompter((_q, choices) => choices![0]!);
    await makeGa4PromptSelector(prompt)({
      websiteUrl: "https://acme.test",
      candidates: [CANDIDATE],
      accounts: ACCOUNTS
    });

    const choices = asks[0]!.choices!;
    expect(choices).toContain(
      "➕ Create a new GA4 property for acme.test (Infinite creates it for you now)"
    );
    // The one row that pauses setup for a manual browser step must never be a
    // direct arrow-key mis-commit away: it lives behind the More options sub-step.
    expect(choices).toContain(MORE_OPTIONS_LABEL);
    expect(choices.some((choice) => choice.includes("Google Analytics account"))).toBe(false);
    expect(choices[choices.length - 1]).toBe(MORE_OPTIONS_LABEL);
  });

  it("echoes the committed choice when an existing property is picked", async () => {
    const { prompt, notes } = fakePrompter(
      (_q, choices) => choices!.find((c) => c.includes("properties/100"))!
    );
    const selection = await makeGa4PromptSelector(prompt)({
      websiteUrl: "https://acme.test",
      candidates: [CANDIDATE],
      accounts: ACCOUNTS
    });

    expect(selection).toMatchObject({ kind: "use_property", propertyId: "properties/100" });
    expect(notes).toContain("GA4: using the existing property Main Site — properties/100.");
  });

  it("echoes that a new property will be created on the spot", async () => {
    const { prompt, notes } = fakePrompter(
      (_q, choices) => choices!.find((c) => c.startsWith("➕ Create a new GA4 property"))!
    );
    const selection = await makeGa4PromptSelector(prompt)({
      websiteUrl: "https://acme.test",
      candidates: [CANDIDATE],
      accounts: ACCOUNTS
    });

    expect(selection).toMatchObject({ kind: "create_property", accountId: "accounts/1" });
    expect(notes).toContain("GA4: creating a new property for acme.test now — no browser step needed.");
  });

  it("commits account creation only through the More options sub-step and echoes the pause", async () => {
    const { prompt, notes, asks } = fakePrompter(
      (_q, choices) =>
        choices!.find((c) => c.includes("Google Analytics account")) ??
        choices!.find((c) => c === MORE_OPTIONS_LABEL)!
    );
    const selection = await makeGa4PromptSelector(prompt)({
      websiteUrl: "https://acme.test",
      candidates: [CANDIDATE],
      accounts: ACCOUNTS
    });

    expect(selection).toMatchObject({ kind: "create_account" });
    expect(asks).toHaveLength(2);
    expect(asks[1]!.choices).toEqual([CREATE_ACCOUNT_LABEL, BACK_LABEL]);
    expect(notes).toContain(
      "GA4: you chose to create a new Google Analytics account — setup pauses while you do that in the browser, then resume."
    );
  });

  it("returns to the main picker when the founder picks Back in the sub-step", async () => {
    let mainAsks = 0;
    const { prompt, asks } = fakePrompter((_q, choices) => {
      if (choices!.includes(BACK_LABEL)) {
        return BACK_LABEL;
      }
      mainAsks += 1;
      return mainAsks === 1
        ? MORE_OPTIONS_LABEL
        : choices!.find((c) => c.includes("properties/100"))!;
    });
    const selection = await makeGa4PromptSelector(prompt)({
      websiteUrl: "https://acme.test",
      candidates: [CANDIDATE],
      accounts: ACCOUNTS
    });

    expect(selection).toMatchObject({ kind: "use_property", propertyId: "properties/100" });
    expect(asks).toHaveLength(3);
    expect(asks[2]!.question).toBe(asks[0]!.question);
    // No create-account echo: the choice was never committed.
  });

  it("echoes the safe-default fallback when the prompter returns an unknown answer", async () => {
    const { prompt, notes, asks } = fakePrompter(() => "something unrecognized");
    const selection = await makeGa4PromptSelector(prompt)({
      websiteUrl: "https://acme.test",
      candidates: [CANDIDATE],
      accounts: ACCOUNTS
    });

    // No site match → the safe default (entries[0]) is create_property.
    expect(selection).toMatchObject({ kind: "create_property" });
    expect(asks).toHaveLength(1);
    expect(notes).toContain("GA4: creating a new property for acme.test now — no browser step needed.");
  });

  it("falls back to the safe default when the founder keeps bouncing through More options", async () => {
    // Main picker always answers More options; the sub-step always answers something
    // unrecognized (treated like Back). The loop must terminate on the safe default
    // instead of spinning forever with a weird prompter.
    const { prompt, notes, asks } = fakePrompter((_q, choices) =>
      choices!.includes(BACK_LABEL) ? "something unrecognized" : MORE_OPTIONS_LABEL
    );
    const selection = await makeGa4PromptSelector(prompt)({
      websiteUrl: "https://acme.test",
      candidates: [CANDIDATE],
      accounts: ACCOUNTS
    });

    expect(selection).toMatchObject({ kind: "create_property", accountId: "accounts/1" });
    expect(asks.length).toBeLessThanOrEqual(6);
    expect(notes).toContain("GA4: creating a new property for acme.test now — no browser step needed.");
  });
});
