import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput } from "./renderer.js";

import { GROWTH_TAGLINE } from "./rocket-banner.js";
import { resolveTheme, type Theme } from "../theme.js";

// "INFINITE" in the ANSI-Shadow block-letter style. Six fixed-width rows; the
// shimmer only recolours column bands, never changes the glyphs, so every frame
// is the same width/height.
const INFINITE_ART: readonly string[] = [
  " ██╗███╗   ██╗███████╗██╗███╗   ██╗██╗████████╗███████╗",
  " ██║████╗  ██║██╔════╝██║████╗  ██║██║╚══██╔══╝██╔════╝",
  " ██║██╔██╗ ██║█████╗  ██║██╔██╗ ██║██║   ██║   █████╗  ",
  " ██║██║╚██╗██║██╔══╝  ██║██║╚██╗██║██║   ██║   ██╔══╝  ",
  " ██║██║ ╚████║██║     ██║██║ ╚████║██║   ██║   ███████╗",
  " ╚═╝╚═╝  ╚═══╝╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝   ╚═╝   ╚══════╝"
];
const ART_WIDTH = INFINITE_ART[0].length; // 54
const MIN_BIG_COLUMNS = ART_WIDTH + 4;

const SHIMMER_TICK_MS = 120;
const BAND = 3; // chars per colour band — a light sweeps across the wordmark

function animationEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.INFINITE_NO_ANIMATION !== "1" && env.INFINITE_NO_ANIMATION !== "true";
}

// Slice a row into BAND-wide spans and colour each from a neon ramp offset by
// the tick, so a bright crest travels left→right across the letters.
function gradientSpans(text: string, tick: number, theme: Theme): React.ReactNode[] {
  const ramp = [
    theme.color.primaryDeep,
    theme.color.primary,
    theme.color.primaryBright,
    theme.color.primary
  ];
  const spans: React.ReactNode[] = [];
  for (let i = 0; i < text.length; i += BAND) {
    const band = text.slice(i, i + BAND);
    const color = ramp[(Math.floor(i / BAND) + tick) % ramp.length];
    spans.push(
      <Text color={color} key={i}>
        {band}
      </Text>
    );
  }
  return spans;
}

/**
 * First-run welcome: a big shimmering INFINITE wordmark, the brand tagline, and
 * a "press Enter to launch" call-to-action that hands off into the session
 * (which lands on the rocket home banner). Enter / Esc / Ctrl-C all dismiss.
 * Rendered as its own Ink app before the interactive session starts.
 */
export function InfiniteWelcome({
  columns = 88,
  theme,
  animate,
  onLaunch
}: {
  columns?: number;
  theme?: Theme;
  animate?: boolean;
  /** Called when the user dismisses (Enter/Esc/Ctrl-C). Defaults to app.exit(). */
  onLaunch?: () => void;
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
  // CTA pulses between bright and primary roughly every ~600ms.
  const ctaHot = Math.floor(tick / 5) % 2 === 0;
  const ctaColor = ctaHot ? t.color.primaryBright : t.color.primary;

  return (
    <Box alignItems="center" flexDirection="column" paddingY={1} width={columns}>
      {big ? (
        INFINITE_ART.map((row, index) => (
          <Text key={index} wrap="truncate-end">
            {gradientSpans(row, tick + index, t)}
          </Text>
        ))
      ) : (
        <Text wrap="truncate-end">
          <Text color={t.color.primaryBright}>{"∞  "}</Text>
          {gradientSpans("INFINITE", tick, t)}
        </Text>
      )}
      <Box marginTop={1}>
        <Text color={t.color.primaryBright}>∞ </Text>
        <Text color={t.color.muted}>{GROWTH_TAGLINE}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={t.color.muted}>press </Text>
        <Text bold color={ctaColor}>Enter ↵</Text>
        <Text color={t.color.muted}> to launch</Text>
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
