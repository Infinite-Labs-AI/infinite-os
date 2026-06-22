import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput } from "./renderer.js";

import { INFINITE_ART, MIN_BIG_COLUMNS } from "./infinite-wordmark.js";
import { GROWTH_TAGLINE } from "./rocket-banner.js";
import { DITHER, RETRO } from "./retro-style.js";

const SHIMMER_TICK_MS = 120;
// Fixed top-bright → bottom-dim greyscale gradient per row; a scan line drifts
// downward, briefly lifting one row brighter (the retro "shimmer", no colour).
const BASE_LEVELS = [0, 1, 2, 3, 4, 5] as const;
const SCAN_EVERY_TICKS = 4;

function animationEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.INFINITE_NO_ANIMATION !== "1" && env.INFINITE_NO_ANIMATION !== "true";
}

// Shade one art row: the downward scan line lifts the row at `scanRow` two
// levels brighter; the rest follow the fixed gradient. Returns one <Text> with
// █ swapped for the level's block glyph (█/▓/▒) and coloured its grey.
function ditherRow(line: string, rowIndex: number, tick: number): React.ReactNode {
  const scanRow = Math.floor(tick / SCAN_EVERY_TICKS) % INFINITE_ART.length;
  const level = Math.max(
    0,
    Math.min(DITHER.length - 1, BASE_LEVELS[rowIndex] - (rowIndex === scanRow ? 2 : 0))
  );
  const { glyph, color } = DITHER[level];
  return (
    <Text color={color} key={rowIndex} wrap="truncate-end">
      {line.replace(/█/g, glyph)}
    </Text>
  );
}

/**
 * First-run welcome: a big dithered greyscale INFINITE wordmark (3D block-shadow,
 * pure black & white — no hue), the brand tagline, and a "press ENTER to launch"
 * CTA that hands off into the session (which lands on the rocket home banner).
 * Enter / Esc / Ctrl-C all dismiss. Its own Ink app, before the session starts.
 */
export function InfiniteWelcome({
  columns = 88,
  animate,
  onLaunch
}: {
  columns?: number;
  animate?: boolean;
  /** Called when the user dismisses (Enter/Esc/Ctrl-C). Defaults to app.exit(). */
  onLaunch?: () => void;
}) {
  const animated = animate ?? animationEnabled(process.env);
  const app = useApp();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!animated) {
      return;
    }
    const id = setInterval(() => setTick((value) => value + 1), SHIMMER_TICK_MS);

    return () => clearInterval(id);
  }, [animated]);

  useInput((_input, key) => {
    if (key.return || key.escape) {
      (onLaunch ?? app.exit)();
    }
  });

  const big = columns >= MIN_BIG_COLUMNS;
  // The CTA's "ENTER" pulses white↔grey roughly every ~600ms.
  const ctaColor = Math.floor(tick / 5) % 2 === 0 ? RETRO.white : RETRO.mid;

  return (
    <Box alignItems="center" flexDirection="column" paddingY={1} width={columns}>
      {big ? (
        INFINITE_ART.map((row, index) => ditherRow(row, index, tick))
      ) : (
        <Text wrap="truncate-end">
          <Text color={RETRO.white}>{"∞  "}</Text>
          <Text bold color={RETRO.light}>INFINITE</Text>
        </Text>
      )}
      <Box marginTop={1}>
        <Text color={RETRO.light}>∞ </Text>
        <Text color={RETRO.grey}>{GROWTH_TAGLINE.toUpperCase()}</Text>
        <Text color={RETRO.light}> ∞</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={RETRO.grey}>press </Text>
        <Text bold color={ctaColor}>ENTER ↵</Text>
        <Text color={RETRO.grey}> to launch</Text>
      </Box>
    </Box>
  );
}

/**
 * Render the welcome as a standalone Ink app and resolve once the user presses
 * Enter (or Esc/Ctrl-C). Used by the interactive launch path on first run.
 */
export async function runInfiniteWelcome(options: {
  columns?: number;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  errorOutput?: NodeJS.WriteStream;
}): Promise<void> {
  await new Promise<void>((resolve) => {
    const instance = render(
      <InfiniteWelcome
        columns={options.columns ?? options.output?.columns}
        onLaunch={() => instance.unmount()}
      />,
      {
        exitOnCtrlC: true,
        patchConsole: false,
        stderr: options.errorOutput,
        stdin: options.input,
        stdout: options.output
      }
    );
    instance.waitUntilExit().then(() => resolve());
  });
}
