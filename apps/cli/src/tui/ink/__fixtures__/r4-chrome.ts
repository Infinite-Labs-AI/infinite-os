// terminal-r4's shell chrome as synthetic goldens (top bar, rules, composer,
// key bar, boot), copied from the design's synthetic dump, plus a cell
// comparator: a rendered line and a golden compare character by character,
// each character with the look it is painted in, whatever the escape layout.
//
// Synthetic data only (this repository is public).

import { parseAnsiSegments } from "../../lib/ansi-segments.js";
import { inkStyle } from "../../style/sgr.js";
import type { Tier, Token } from "../../style/tokens.js";

/** One golden segment: its text and its r4 style (tokens, space separated; "" is body text). */
export interface GoldenSegment {
  text: string;
  style: string;
}

export type GoldenLine = readonly GoldenSegment[];

const s = (text: string, style = ""): GoldenSegment => ({ text, style });

export const R4_SOURCES_OK = [
  { label: "Shopify", state: "broken" },
  { label: "GA4", state: "connected" },
  { label: "Stripe", state: "connected" },
  { label: "PostHog", state: "connected" },
  { label: "Google Ads", state: "connected" },
  { label: "Meta", state: "connected" }
] as const;

export const R4_SOURCES_NOT_CONNECTED = [
  { label: "Shopify", state: "broken" },
  { label: "GA4", state: "connected" },
  { label: "Stripe", state: "connected" },
  { label: "PostHog", state: "connected" },
  { label: "Google Ads", state: "missing" },
  { label: "Meta", state: "connected" }
] as const;

export const GOLDEN = {
  /** region-topbar-ok (100 cols): the right-hand words do not fit, so they are left out. */
  topbarOk: [
    s(" ∞ Infinite ", "inv"),
    s("  Infinite workspace   "),
    s("⊘ Shopify", "red"),
    s(" "),
    s("● GA4 ● Stripe ● PostHog ● Google Ads ● Meta", "green")
  ],
  /** region-topbar-not-connected (100 cols): the asked source that is missing leads, in amber. */
  topbarNotConnected: [
    s(" ∞ Infinite ", "inv"),
    s("  Infinite workspace   "),
    s("⊘ Google Ads", "amber"),
    s(" "),
    s("⊘ Shopify", "red"),
    s(" "),
    s("● GA4 ● Stripe ● PostHog ● Meta", "green")
  ],
  /** region-topbar-narrow-60: dots that do not fit are dropped. */
  topbarNarrow60: [
    s(" ∞ Infinite ", "inv"),
    s("  Infinite workspace   "),
    s("⊘ Shopify", "red"),
    s(" "),
    s("● GA4 ● Stripe", "green")
  ],
  /** boot--c160 row 0: the whole line fits, so `through the Infinite app` sits on the right. */
  topbarWide160: [
    s(" ∞ Infinite ", "inv"),
    s("  Infinite workspace   "),
    s("⊘ Shopify", "red"),
    s(" "),
    s("● GA4 ● Stripe ● PostHog ● Google Ads ● Meta", "green"),
    s(" ".repeat(46)),
    s("through the Infinite app", "dim")
  ],
  /** boot--c160 rows 2-17: the empty answer pane and the split's separator (the wide layout, 120 cols and up). */
  bootPane160: [s(" ".repeat(41)), s("│", "line")],
  /** region-rule (100 cols). */
  rule100: [s("─".repeat(100), "line")],
  /** The boot frame's Steps rule (boot--c100 row 10). */
  steps100: [s("─", "line"), s(" "), s("Steps", "b"), s(" "), s("─".repeat(92), "line")],
  composerIdle: [s("❯", "cyan"), s(" "), s("Ask Infinite…", "dim")],
  composerBusy: [s("❯", "cyan"), s(" "), s("Ask Infinite… (the pause finishes either way)", "dim")],
  keybarQuiet: [s(" tab ", "key"), s(" switch side   "), s(" / ", "key"), s(" commands")],
  keybarNumbers: [
    s(" j k ", "key"), s(" row   "), s(" → ", "key"), s(" columns   "), s(" o ", "key"), s(" open   "),
    s(" tab ", "key"), s(" switch side   "), s(" / ", "key"), s(" commands")
  ],
  keybarApprovalPause: [
    s(" p ", "pk"), s(" "), s("pause", "b"), s("   "), s(" n ", "key"), s(" dismiss   "),
    s(" tab ", "key"), s(" switch side   "), s(" / ", "key"), s(" commands")
  ],
  keybarApprovalEmail: [
    s(" v ", "key"), s(" view   "), s(" s ", "pk"), s(" "), s("send", "b"), s("   "), s(" n ", "key"), s(" dismiss   "),
    s(" tab ", "key"), s(" switch side   "), s(" / ", "key"), s(" commands")
  ]
} satisfies Record<string, GoldenLine>;

const BACKGROUND_TOKENS = new Set(["key", "pk", "inv", "tag", "sel"]);

/**
 * Each character with its look, normalized the way the goldens are: a space
 * with no background and no underline has no look (it is invisible), and
 * trailing invisible spaces are dropped (the CLI never has to print them).
 */
function normalize(cells: Array<[string, string]>): string[] {
  const out = cells.map(([char, look]) => {
    const parsed = JSON.parse(look) as { backgroundColor?: string; underline?: boolean; inverse?: boolean };
    const invisible = char === " " && !parsed.backgroundColor && !parsed.underline && !parsed.inverse;
    return `${char}\u0000${invisible ? "{}" : look}`;
  });
  while (out.length && out[out.length - 1]!.endsWith("\u0000{}") && out[out.length - 1]!.startsWith(" ")) {
    out.pop();
  }
  return out;
}

function look(props: Record<string, unknown>): string {
  const kept = Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined && value !== false));
  return JSON.stringify(kept, Object.keys(kept).sort());
}

/** The cells of a rendered ANSI line. */
export function renderedCells(line: string): string[] {
  return normalize(
    parseAnsiSegments(line).flatMap(({ text, ...props }) => [...text].map((char): [string, string] => [char, look(props)]))
  );
}

/** The cells a golden line paints at a tier (its tokens resolved the way the CLI resolves them). */
export function goldenCells(line: GoldenLine, tier: Tier = "truecolor"): string[] {
  return normalize(
    line.flatMap(({ text, style }) => {
      const tokens = (style ? style.split(" ") : [""]) as Token[];
      const props = inkStyle(tokens, tier);
      // Faint and italic never appear in the chrome; inkStyle carries the rest.
      return [...text].map((char): [string, string] => [char, look({ ...props })]);
    })
  );
}

/** Whether a golden segment style paints a background (a chip). */
export function paintsBackground(style: string): boolean {
  return style.split(" ").some((token) => BACKGROUND_TOKENS.has(token));
}

/** The plain text of a golden line, trailing spaces dropped. */
export function goldenText(line: GoldenLine): string {
  return line.map((segment) => segment.text).join("").replace(/\s+$/u, "");
}
