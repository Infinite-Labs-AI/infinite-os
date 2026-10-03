import { explicitTier, resolveTier } from "./tier.js";

// Light-background detection (SPEC §3.2): ask the terminal for its background
// with OSC 11 before Ink mounts, so a light profile gets the 16 tier (the
// user's own palette) instead of r4's greys and whites on white. COLORFGBG is
// the fallback, read by resolveTier; with neither, the background is dark.
//
// A DA1 query goes out right after OSC 11. Nearly every terminal answers DA1,
// and answers in order, so its reply marks the end of the OSC 11 reply (or
// shows there is none) without sitting out the whole timeout, and no late
// reply lands in Ink's input as typed text.

export type Background = "light" | "dark";

/** OSC 11 query (background colour), then DA1 (primary device attributes) as the sentinel. */
export const BACKGROUND_QUERY = "\u001b]11;?\u0007\u001b[c";

// eslint-disable-next-line no-control-regex
const OSC11_REPLY = /\u001b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?(?:\u0007|\u001b\\)/iu;
// eslint-disable-next-line no-control-regex
const OSC11_REPLIES = /\u001b\]11;[^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
// eslint-disable-next-line no-control-regex
const DA1_REPLY = /\u001b\[\?[0-9;]*c/u;
// eslint-disable-next-line no-control-regex
const DA1_REPLIES = /\u001b\[\?[0-9;]*c/gu;
// A reply cut off by the timeout: never hand half an escape back as typing.
// eslint-disable-next-line no-control-regex
const PARTIAL_REPLY = /\u001b(?:\]11;[^\u0007\u001b]*|\[\?[0-9;]*)?$/u;

/** Read an OSC 11 reply (`rgb:RRRR/GGGG/BBBB`) as light or dark; undefined without one. */
export function parseBackgroundReply(data: string): Background | undefined {
  const match = OSC11_REPLY.exec(data);
  if (!match) {
    return undefined;
  }
  const [r, g, b] = match.slice(1, 4).map((hex) => Number.parseInt(hex, 16) / (16 ** hex.length - 1));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.5 ? "light" : "dark";
}

export interface ProbeInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  unshift?(chunk: Buffer | string): void;
}

export interface ProbeOutput {
  write(data: string): unknown;
}

/**
 * Ask the terminal for its background, in raw mode, for at most `timeoutMs`
 * (SPEC: 100 ms). Leaves stdin paused in the raw mode it found, with any keys
 * typed meanwhile handed back to it.
 */
export function probeBackground(
  input: ProbeInput,
  output: ProbeOutput,
  options: { timeoutMs?: number } = {}
): Promise<Background | undefined> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.resolve(undefined);
  }
  const setRawMode = input.setRawMode.bind(input);
  const wasRaw = Boolean(input.isRaw);
  return new Promise((resolve) => {
    let buffer = "";
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      input.off("data", onData);
      if (!wasRaw) {
        setRawMode(false);
      }
      input.pause();
      const typed = buffer.replace(OSC11_REPLIES, "").replace(DA1_REPLIES, "").replace(PARTIAL_REPLY, "");
      if (typed && input.unshift) {
        input.unshift(Buffer.from(typed, "utf8"));
      }
      resolve(parseBackgroundReply(buffer));
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (DA1_REPLY.test(buffer)) {
        finish();
      }
    };
    const timer = setTimeout(finish, options.timeoutMs ?? 100);
    setRawMode(true);
    input.on("data", onData);
    input.resume();
    output.write(BACKGROUND_QUERY);
  });
}

/**
 * Probe only when the answer can change something: the tier would paint r4's
 * 256 or truecolor greys, and nothing has pinned the tier or the background.
 * Not over SSH, where a reply can outlast the timeout and reach the composer.
 */
export function shouldProbeBackground(env: NodeJS.ProcessEnv): boolean {
  if (env.SSH_TTY || env.SSH_CONNECTION) {
    return false;
  }
  if (env.INFINITE_BACKGROUND || env.COLORFGBG || env.FORCE_COLOR || explicitTier(env)) {
    return false;
  }
  const tier = resolveTier(env, { isTTY: true });
  return tier === "truecolor" || tier === "256";
}

/** At session start, before Ink mounts: record a light or dark background in `INFINITE_BACKGROUND`. */
export async function detectTerminalBackground(
  env: NodeJS.ProcessEnv,
  input: ProbeInput,
  output: ProbeOutput,
  probe: (input: ProbeInput, output: ProbeOutput) => Promise<Background | undefined> = probeBackground
): Promise<void> {
  if (!shouldProbeBackground(env)) {
    return;
  }
  const background = await probe(input, output);
  if (background) {
    env.INFINITE_BACKGROUND = background;
  }
}
