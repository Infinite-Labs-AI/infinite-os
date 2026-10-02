import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { decodeStatusConnections, topBarSourcesFromConnections } from "../../../desktop/status-connections.js";
import { getTurnState, resetTurnState } from "../../app/turn-store.js";
import { statusConnectionRows, topBarData } from "./feed-chrome.js";
import { feedSteps } from "./feed-steps.js";
import { loadR4Fixture } from "./fixtures.js";

// Tier 1 draws its screens through the live path: the Steps from bridge frames
// that carry the app's words (step.words.v1), the top bar's dots from a
// `/v1/status` payload (status.connections.v1). These checks keep the feeds
// honest: if a feed went back to writing labels or sources straight into the
// session, a matching golden would no longer prove the live path.
const NOW = Date.UTC(2026, 9, 1, 10, 44, 0);
const ratchet = JSON.parse(
  readFileSync(fileURLToPath(new URL("./__goldens__/expected-fail.json", import.meta.url)), "utf8")
) as { expectedFail: Record<string, string>; matchedEver: string[] };

describe("the golden feeds go through the live path", () => {
  afterEach(() => {
    resetTurnState();
  });

  it("a step's label and result come from its frames' words, never from the tool's name", () => {
    const turn = loadR4Fixture("flow-numbers-01-ready").turn!;
    feedSteps(turn, NOW);
    const steps = getTurnState().steps;
    expect(steps.map(({ label, result, status }) => ({ label, result, status }))).toEqual(
      turn.steps.map((step) => ({ label: step.label, result: step.result, status: step.status }))
    );
    for (const step of steps) {
      expect(step.name).toMatch(/^mcp__r4__step_\d+$/u);
      expect(step.label).not.toMatch(/mcp|__|step_/u);
    }
  });

  it("a waiting step is the transport's requires_confirmation, or its card's view", () => {
    feedSteps({ question: "q", answer: "a", views: [], steps: [{ label: "waiting for your OK", start: 0, end: 1, result: "pause 1 ad", status: "wait" }] }, NOW);
    expect(getTurnState().steps).toMatchObject([{ label: "waiting for your OK", status: "wait", result: "pause 1 ad" }]);
  });

  it("a running step has started and not completed; its result is its latest progress", () => {
    const turn = loadR4Fixture("flow-pause-02-working").turn!;
    feedSteps(turn, NOW);
    const running = getTurnState().steps.filter((step) => step.endedAt === null);
    expect(running.map((step) => step.label)).toEqual(turn.steps.filter((step) => step.status === "run").map((step) => step.label));
    expect(getTurnState().tools.map((tool) => tool.latestPreview)).toEqual(turn.steps.filter((step) => step.status === "run").map((step) => step.result));
  });

  it("the top bar's dots are the status payload's connections, decoded", () => {
    for (const screen of ["boot", "flow-numbers-05-not-connected"]) {
      const fixture = loadR4Fixture(screen);
      const rows = statusConnectionRows(fixture);
      expect(rows.every((row) => ["connected", "broken", "off"].includes(row.status))).toBe(true);
      expect(topBarData(fixture)).toEqual({
        workspace: fixture.session.workspace,
        sources: topBarSourcesFromConnections(decodeStatusConnections(rows)!),
        throughApp: true
      });
      expect(topBarData(fixture).sources).toHaveLength(fixture.session.connections.length);
    }
  });

  it("the Steps and top bar region goldens must match (they are on no expected-fail list)", () => {
    const regions = ["region-steps", "region-steps-two", "region-topbar-ok", "region-topbar-not-connected", "region-topbar-narrow-60"];
    for (const id of regions.flatMap((region) => [region, `${region}@256`])) {
      expect(ratchet.matchedEver, id).toContain(id);
      expect(Object.keys(ratchet.expectedFail), id).not.toContain(id);
    }
  });
});
