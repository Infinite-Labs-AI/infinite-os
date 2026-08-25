// Parses the ANSI-annotated lines produced by the string transcript renderer
// (`renderInfiniteTranscript` with `color: true`) into structured segments with
// explicit color/emphasis. The Ink transcript renders these as nested
// `<Text color=…>` nodes, so coloring rides on Ink's native props rather than
// embedded escape codes — which keeps it portable across the stock `ink` and
// vendored `@infinite-os/ink` backends behind the renderer seam.

export interface AnsiSegment {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
}

const ESC = String.fromCharCode(27);
const SGR_RE = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");

const BASE16: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128],
  [0, 128, 128], [192, 192, 192], [128, 128, 128], [255, 0, 0], [0, 255, 0],
  [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]
];

function toHex(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

// Maps an xterm 256-color index to RGB. Used defensively in case a source
// (e.g. a tmux capture) downsamples truecolor to the 256-color palette.
function color256(index: number): [number, number, number] {
  if (index < 16) {
    const [r, g, b] = BASE16[index]!;
    return [r, g, b];
  }
  if (index < 232) {
    const n = index - 16;
    const level = (value: number) => (value === 0 ? 0 : 55 + value * 40);
    return [level(Math.floor(n / 36)), level(Math.floor((n % 36) / 6)), level(n % 6)];
  }
  const gray = 8 + (index - 232) * 10;
  return [gray, gray, gray];
}

export function parseAnsiSegments(line: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let color: string | undefined;
  let bold = false;
  let italic = false;
  let strike = false;
  let buffer = "";
  let lastIndex = 0;

  const flush = () => {
    if (!buffer) {
      return;
    }
    const segment: AnsiSegment = { text: buffer };
    if (color) {
      segment.color = color;
    }
    if (bold) {
      segment.bold = true;
    }
    if (italic) {
      segment.italic = true;
    }
    if (strike) {
      segment.strikethrough = true;
    }
    segments.push(segment);
    buffer = "";
  };

  SGR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_RE.exec(line)) !== null) {
    // Text preceding this escape carries the style established so far.
    buffer += line.slice(lastIndex, match.index);
    flush();

    const params = (match[1] || "0").split(";").map((value) => (value === "" ? 0 : Number.parseInt(value, 10)));
    for (let i = 0; i < params.length; i += 1) {
      const code = params[i];
      if (code === 0) {
        color = undefined;
        bold = false;
        italic = false;
        strike = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 3) {
        italic = true;
      } else if (code === 23) {
        italic = false;
      } else if (code === 9) {
        strike = true;
      } else if (code === 29) {
        strike = false;
      } else if (code === 39) {
        color = undefined;
      } else if (code === 38) {
        if (params[i + 1] === 2) {
          color = toHex(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0);
          i += 4;
        } else if (params[i + 1] === 5) {
          const [r, g, b] = color256(params[i + 2] ?? 0);
          color = toHex(r, g, b);
          i += 2;
        }
      } else if (code >= 30 && code <= 37) {
        const [r, g, b] = BASE16[code - 30]!;
        color = toHex(r, g, b);
      } else if (code >= 90 && code <= 97) {
        const [r, g, b] = BASE16[code - 90 + 8]!;
        color = toHex(r, g, b);
      }
    }

    lastIndex = SGR_RE.lastIndex;
  }

  buffer += line.slice(lastIndex);
  flush();

  return segments;
}
