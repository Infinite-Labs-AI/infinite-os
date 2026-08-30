import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  productHelpText,
  productUpdateText,
  localHelpText
} from "./help-text.js";

describe("help text split", () => {
  it("product help advertises the shared Desktop agent, not a local product lane", () => {
    const t = productHelpText();
    expect(t).toContain("⌘L");
    expect(t).toContain("Same account. Same workspace. Same agent.");
    expect(t).toContain("npx infinite-os@latest");
    expect(t).toContain("infinite://onboarding");
  });
  it("local help retains the engine commands", () => {
    expect(localHelpText()).toContain("sources");
  });
  it("local help examples use the `infinite local` namespace (bare forms are rejected now)", () => {
    const t = localHelpText();
    expect(t).toContain("infinite local connect x");
    expect(t).toContain("infinite local connect meta");
    expect(t).toContain("infinite local sync meta 30_days");
    expect(t).toContain("infinite local sync all incremental");
    // The router rejects the bare forms, so the examples must never show them.
    expect(t).not.toContain("  infinite connect");
    expect(t).not.toContain("  infinite sync");
  });
  it("product help covers the turn surface + app + onboarding", () => {
    const t = productHelpText();
    expect(t).toContain('infinite "message"');
    expect(t).toContain("infinite app");
    expect(t).toContain("infinite://onboarding");
  });

  it("product help and update contain no customer local/Docker fallback copy", () => {
    const forbidden = /trial|infinite local|docker|self-host|local engine/i;
    for (const text of [productHelpText(), productUpdateText()]) {
      expect(text).not.toMatch(forbidden);
    }
  });
});

describe("copy accuracy (design invariant 8)", () => {
  // BYO inference goes to the user's own Codex/Anthropic account, so the
  // product must never claim "thinking never leaves your machine"; and the
  // repo is MIT open source, never "source-available".
  const BANNED = [/thinking never leaves/i, /source[- ]available/i];

  it("help text never claims local-only thinking or a source-available license", () => {
    for (const copy of [productHelpText(), localHelpText()]) {
      for (const banned of BANNED) {
        expect(copy).not.toMatch(banned);
      }
    }
  });

  it("product help states the accurate BYO + license copy", () => {
    const t = productHelpText();
    expect(t).toMatch(/prompts run on your own Codex or Anthropic\s+account/);
    expect(t).toContain("MIT open source");
  });

  it("top-level repo copy stays accurate too", () => {
    for (const doc of ["README.md", "AGENTS.md", "SECURITY.md"]) {
      const text = readFileSync(
        fileURLToPath(new URL(`../../../${doc}`, import.meta.url)),
        "utf8"
      );
      for (const banned of BANNED) {
        expect(text, doc).not.toMatch(banned);
      }
    }
  });
});
