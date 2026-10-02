import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput } from "./renderer.js";

import { resolveTheme, themeInkStyle, type Theme } from "../theme.js";
import { GROWTH_TAGLINE, INFINITE_ART, MIN_BIG_COLUMNS } from "./infinite-wordmark.js";
import { DITHER } from "./retro-style.js";

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
// █ swapped for the level's block glyph (█/▓/▒) in its token, at the theme's tier.
function ditherRow(line: string, rowIndex: number, tick: number, theme: Theme): React.ReactNode {
  const scanRow = Math.floor(tick / SCAN_EVERY_TICKS) % INFINITE_ART.length;
  const level = Math.max(
    0,
    Math.min(DITHER.length - 1, BASE_LEVELS[rowIndex] - (rowIndex === scanRow ? 2 : 0))
  );
  const { glyph, token } = DITHER[level];
  return (
    <Text {...themeInkStyle(theme, token)} key={rowIndex} wrap="truncate-end">
      {line.replace(/█/g, glyph)}
    </Text>
  );
}

/**
 * First-run welcome: a big dithered INFINITE wordmark (3D block-shadow, black &
 * white — no hue), the brand tagline, and a "press ENTER to launch" CTA that
 * hands off into the session (which opens on the first-run inventory and the
 * boot frame). Enter / Esc / Ctrl-C all dismiss. Its own Ink app, before the
 * session starts. Painted in r4 tokens at the session's colour tier.
 */
export function InfiniteWelcome({
  columns = 88,
  animate,
  onLaunch,
  theme
}: {
  columns?: number;
  animate?: boolean;
  /** Called when the user dismisses (Enter/Esc/Ctrl-C). Defaults to app.exit(). */
  onLaunch?: () => void;
  theme?: Theme;
}) {
  const t = theme ?? resolveTheme();
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
  // The CTA's "ENTER" pulses bright↔dim roughly every ~600ms.
  const cta = themeInkStyle(t, Math.floor(tick / 5) % 2 === 0 ? "b" : "dim");
  const dim = themeInkStyle(t, "dim");

  return (
    <Box alignItems="center" flexDirection="column" paddingY={1} width={columns}>
      {big ? (
        INFINITE_ART.map((row, index) => ditherRow(row, index, tick, t))
      ) : (
        <Text wrap="truncate-end">
          <Text {...themeInkStyle(t, "cyan")}>{"∞  "}</Text>
          <Text {...themeInkStyle(t, "b")}>INFINITE</Text>
        </Text>
      )}
      <Box marginTop={1}>
        <Text {...themeInkStyle(t, "cyan")}>∞ </Text>
        <Text {...dim}>{GROWTH_TAGLINE.toUpperCase()}</Text>
        <Text {...themeInkStyle(t, "cyan")}> ∞</Text>
      </Box>
      <Box marginTop={1}>
        <Text {...dim}>press </Text>
        <Text {...cta}>ENTER ↵</Text>
        <Text {...dim}> to launch</Text>
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
  theme?: Theme;
}): Promise<void> {
  await new Promise<void>((resolve) => {
    const instance = render(
      <InfiniteWelcome
        columns={options.columns ?? options.output?.columns}
        onLaunch={() => instance.unmount()}
        theme={options.theme}
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
