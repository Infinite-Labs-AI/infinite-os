import { describe, expect, it } from "vitest";

import { getTurnState } from "../app/turn-store.js";
import { resolveTheme } from "../theme.js";
import { ROCKET_BANNER_ROWS } from "./rocket-banner.js";
import {
  inkTranscriptRowCount,
  renderInkTranscriptToString
} from "./transcript-app.js";

const base = {
  columns: 88,
  nowMs: 5_000,
  status: ["session cli", "ready"],
  theme: resolveTheme(),
  title: "Infinite TUI",
  transcript: { messages: [], state: getTurnState() }
};

describe("home-screen rocket banner", () => {
  it("renders the booster + ∞ Infinite wordmark in the empty-transcript state", () => {
    const rendered = renderInkTranscriptToString({ ...base, homeBanner: true });

    expect(rendered).toContain("◢███◣");
    expect(rendered).toContain("╨");
    expect(rendered).toContain("∞ Infinite");
  });

  it("occupies exactly ROCKET_BANNER_ROWS rows", () => {
    // Count the banner's contribution: total rows minus top rule, status, composer.
    const withBanner = inkTranscriptRowCount({ ...base, homeBanner: true, showComposer: false });
    const withoutBanner = inkTranscriptRowCount({ ...base, homeBanner: false, showComposer: false });

    expect(withBanner - withoutBanner).toBe(ROCKET_BANNER_ROWS - 1);
  });

  it("keeps the composer-row prediction exactly equal to the rendered row count (PR #27 invariant)", () => {
    // showComposer:false is the prediction the live session uses to place the
    // native cursor; showComposer:true is the real render. They must agree.
    const predicted = inkTranscriptRowCount({ ...base, homeBanner: true, showComposer: false });
    const renderedRows = renderInkTranscriptToString({ ...base, homeBanner: true, showComposer: true })
      .replace(/\n+$/, "")
      .split("\n").length;

    expect(predicted).toBe(renderedRows - 1);
  });

  it("does not show the rocket when homeBanner is off (progress / non-home renders)", () => {
    const rendered = renderInkTranscriptToString({ ...base, homeBanner: false });

    expect(rendered).not.toContain("◢███◣");
  });
});
