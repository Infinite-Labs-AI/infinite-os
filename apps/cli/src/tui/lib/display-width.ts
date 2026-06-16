const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

export const stripAnsi = (value: string) => value.replace(ANSI_RE, "");

export function displayWidth(value: string): number {
  let width = 0;

  for (const char of stripAnsi(value)) {
    if (char === "\n" || char === "\r") {
      continue;
    }

    const code = char.codePointAt(0) ?? 0;

    if (isZeroWidth(code)) {
      continue;
    }

    width += isWide(code) ? 2 : 1;
  }

  return width;
}

export function padEndCells(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - displayWidth(value)))}`;
}

export function truncateCells(value: string, width: number): string {
  if (displayWidth(value) <= width) {
    return value;
  }

  if (width <= 1) {
    return "…".slice(0, width);
  }

  let out = "";
  let used = 0;

  for (const char of stripAnsi(value)) {
    const code = char.codePointAt(0) ?? 0;
    const next = isZeroWidth(code) ? 0 : isWide(code) ? 2 : 1;

    if (used + next > width - 1) {
      break;
    }

    out += char;
    used += next;
  }

  return `${out}…`;
}

function isZeroWidth(code: number): boolean {
  return (
    code === 0 ||
    code === 0x200d ||
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0xfe00 && code <= 0xfe0f)
  );
}

function isWide(code: number): boolean {
  return (
    code >= 0x1100 &&
    (
      code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    )
  );
}
