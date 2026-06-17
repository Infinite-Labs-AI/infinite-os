import React, { useEffect, useState } from "react";
import { Text } from "./renderer.js";

import { RETRO } from "./retro-style.js";

/**
 * Fixed render height of the home-screen rocket banner, in terminal rows.
 *
 * This MUST equal the number of <Text> rows `RocketBanner` emits in *every*
 * frame (the pilot-flame flicker only swaps a glyph inside row 3 — it never
 * adds or removes a row). `inkTranscriptRowCount` reuses this constant for the
 * empty-transcript branch so the height prediction that positions the composer's
 * native cursor matches the live render exactly. If the banner ever rendered a
 * different row count than this, the native cursor would park a row off — the
 * class of bug PR #27 fixed. Keep this and the JSX below in lockstep.
 */
export const ROCKET_BANNER_ROWS = 4;

/** The brand tagline shown beneath the `∞ Infinite` wordmark (banner + welcome). */
export const GROWTH_TAGLINE = "the growth engineer's OS";

// Pilot-light flicker: a 4-frame cycle that only ever changes the single flame
// glyph on row 3 (and its colour). Upward glyphs only, so it always reads as a
// flame rather than a cursor. Frozen to frame 0 when animation is disabled.
interface FlameFrame {
  glyph: string;
  hot: boolean;
}
const FLAME_FRAMES: readonly FlameFrame[] = [
  { glyph: "▴", hot: false },
  { glyph: "▴", hot: true },
  { glyph: "▵", hot: false },
  { glyph: "▴", hot: true }
];
const FLAME_TICK_MS = 160;

function animationEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.INFINITE_NO_ANIMATION !== "1" && env.INFINITE_NO_ANIMATION !== "true";
}

/**
 * The persistent home-screen mascot: a parked SpaceX-style booster with a
 * flickering pilot flame, shown in the empty-transcript state next to the
 * `∞ Infinite` wordmark. This is the "lighter idle first" slice — only the
 * flame animates; the descent / suicide-burn / touchdown choreography lands
 * later on top of this same fixed-row banner.
 */
export function RocketBanner({
  animate
}: {
  /** Override the env-derived animation gate (tests / reduced-motion). */
  animate?: boolean;
} = {}) {
  const animated = animate ?? animationEnabled(process.env);
  const [flameTick, setFlameTick] = useState(0);

  useEffect(() => {
    if (!animated) {
      return;
    }
    const id = setInterval(() => setFlameTick((value) => value + 1), FLAME_TICK_MS);

    return () => clearInterval(id);
  }, [animated]);

  // Pure black & white to match the retro welcome — no hue. The pilot flame
  // flickers white-hot ↔ grey instead of orange.
  const flame = FLAME_FRAMES[flameTick % FLAME_FRAMES.length];
  const ship = RETRO.light;
  const pad = RETRO.grey;
  const brand = RETRO.white;
  const tagline = RETRO.grey;
  const flameColor = flame.hot ? RETRO.white : RETRO.mid;

  // Each row is its own truncate-end <Text> so a narrow terminal clips the
  // right-hand wordmark instead of wrapping the rocket onto a 5th row.
  return (
    <>
      <Text wrap="truncate-end">
        <Text color={ship}>   ▕█▏</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={ship}>  ◢███◣</Text>
        <Text>{"     "}</Text>
        <Text bold color={brand}>∞ Infinite</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={ship}>{" ╱  "}</Text>
        <Text color={flameColor}>{flame.glyph}</Text>
        <Text color={ship}>{"  ╲"}</Text>
        <Text>{"     "}</Text>
        <Text color={tagline}>{GROWTH_TAGLINE}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={pad}>──────╨──────</Text>
      </Text>
    </>
  );
}
