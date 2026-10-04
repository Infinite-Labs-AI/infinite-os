// Parses the ANSI-annotated lines produced by the string renderers (the
// transcript, the answer views) into structured segments with explicit
// colour and attributes. The Ink transcript renders these as nested
// `<Text color=… backgroundColor=… underline inverse>` nodes (see `AnsiLine`),
// so styling rides on Ink's native props rather than embedded escape codes,
// which keeps it portable across the stock `ink` and vendored `@infinite-os/ink`
// backends behind the renderer seam.
//
// Colours keep the form the renderer chose for its tier: `38;2` becomes
// `"#rrggbb"`, `38;5;n` stays `"ansi256(n)"` and 30–37/90–97 stay named
// (`"cyan"`, `"blackBright"`), so the user's own palette keeps deciding what
// the 16 colours look like and chalk never re-quantizes a hex.

import { namedColor } from "../style/sgr.js";

export interface AnsiSegment {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  /** Faint (SGR 2). */
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
}

type SegmentStyle = Omit<AnsiSegment, "text">;

const ESC = String.fromCharCode(27);
const SGR_RE = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");

function toHex(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Reads an extended colour (`2;r;g;b` or `5;n`) after the 38/48 at `params[i]`: the colour, and how many params it used. */
function extendedColour(params: readonly number[], i: number): [string | undefined, number] {
  if (params[i + 1] === 2) {
    return [toHex(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0), 4];
  }
  if (params[i + 1] === 5) {
    return [`ansi256(${params[i + 2] ?? 0})`, 2];
  }
  return [undefined, 0];
}

/** Applies one SGR's parameters to a style. Specific resets end only their own attribute. */
function applySgr(state: SegmentStyle, params: readonly number[]): SegmentStyle {
  let next: SegmentStyle = { ...state };
  for (let i = 0; i < params.length; i += 1) {
    const code = params[i]!;
    if (code === 0) {
      next = {};
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 23) {
      delete next.italic;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 24) {
      delete next.underline;
    } else if (code === 7) {
      next.inverse = true;
    } else if (code === 27) {
      delete next.inverse;
    } else if (code === 9) {
      next.strikethrough = true;
    } else if (code === 29) {
      delete next.strikethrough;
    } else if (code === 39) {
      delete next.color;
    } else if (code === 49) {
      delete next.backgroundColor;
    } else if (code === 38 || code === 48) {
      const [colour, used] = extendedColour(params, i);
      if (colour && code === 38) {
        next.color = colour;
      } else if (colour) {
        next.backgroundColor = colour;
      }
      i += used;
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      next.color = namedColor(code);
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      next.backgroundColor = namedColor(code);
    }
  }
  return next;
}

export function parseAnsiSegments(line: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let state: SegmentStyle = {};
  let buffer = "";
  let lastIndex = 0;

  const flush = () => {
    if (buffer) {
      segments.push({ text: buffer, ...state });
      buffer = "";
    }
  };

  SGR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_RE.exec(line)) !== null) {
    // Text preceding this escape carries the style established so far.
    buffer += line.slice(lastIndex, match.index);
    flush();
    state = applySgr(state, (match[1] || "0").split(";").map((value) => (value === "" ? 0 : Number.parseInt(value, 10))));
    lastIndex = SGR_RE.lastIndex;
  }

  buffer += line.slice(lastIndex);
  flush();

  return segments;
}
