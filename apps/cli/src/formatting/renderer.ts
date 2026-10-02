import { colorEnabled, resolveTheme, ansi, type Theme } from "../tui/theme.js";
import { padEndCells, truncateCells } from "../tui/lib/display-width.js";
import { answerLines } from "../tui/app/answer-column.js";
import { resolveCliRenderSurface } from "../tui/runtime/render-surface.js";

interface RenderStream {
  columns?: number;
  isTTY?: boolean;
}

export interface CliRendererOptions {
  color?: boolean;
  stream?: RenderStream;
  theme?: Theme;
}

export interface CliRenderer {
  renderAssistant(message: string): string;
  renderStatus(parts: readonly string[]): string;
}

export function createCliRenderer(options: CliRendererOptions = {}): CliRenderer {
  const theme = options.theme ?? resolveTheme(process.env, options.stream ?? { isTTY: false });
  // The theme's tier already says what this terminal gets (NO_COLOR keeps bold; a pipe gets none).
  const color = options.color ?? (Boolean(options.stream?.isTTY) && colorEnabled(theme));
  const columns = clampColumns(options.stream?.columns ?? 88);

  return {
    renderAssistant(message) {
      return renderAssistantResponsePanel(message, { color, columns, theme });
    },
    renderStatus(parts) {
      return renderStatusFooter(parts, { color, columns, theme });
    }
  };
}

/**
 * The answer as the terminal prints it (terminal-r4): `∞ answer`, markdown,
 * hung under its first word, at the window's full width. No box and no width
 * cap. `title` is the answering project (`Infinite — Acme`), printed dim after
 * the mark when it says more than the brand name.
 */
export function renderAssistantResponsePanel(
  message: string,
  options: {
    color?: boolean;
    columns?: number;
    theme?: Theme;
    title?: string;
  } = {}
): string {
  const theme = options.theme ?? resolveTheme();
  const columns = clampColumns(options.columns ?? 88);
  const title = options.title?.trim();
  return answerLines(message.trim() || "No answer was produced.", columns, { color: Boolean(options.color), theme }, {
    label: title && title !== theme.brand.name ? title : undefined
  }).join("\n");
}

export function renderStatusFooter(
  parts: readonly string[],
  options: {
    color?: boolean;
    columns?: number;
    theme?: Theme;
  } = {}
): string {
  const theme = options.theme ?? resolveTheme();
  const width = clampStatusColumns(options.columns ?? 88);
  const visible = dropDanglingSeparator(truncateCells(parts.filter(Boolean).join("  |  "), width));

  return ansi(theme, "muted", padEndCells(visible, width), options.color);
}

// "x  |  …" → "x …": a separator cut off right before the ellipsis. Scans by hand rather
// than with /\s+\|\s*…$/, which backtracks polynomially on long runs of spaces.
function dropDanglingSeparator(value: string): string {
  if (!value.endsWith("…")) return value;
  let end = value.length - 1;
  while (end > 0 && /\s/.test(value[end - 1]!)) end -= 1;
  if (end === 0 || value[end - 1] !== "|") return value;
  const pipe = end - 1;
  let start = pipe;
  while (start > 0 && /\s/.test(value[start - 1]!)) start -= 1;
  return start < pipe ? `${value.slice(0, start)} …` : value;
}

export function shouldUseInteractiveRenderer(stream: RenderStream, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCliRenderSurface(stream, env) !== "plain";
}

/** The window's width, at least 20: no upper cap (eval M3). */
function clampColumns(columns: number): number {
  return Math.max(20, Number.isFinite(columns) ? Math.floor(columns) : 88);
}

function clampStatusColumns(columns: number): number {
  return Math.max(12, Number.isFinite(columns) ? Math.floor(columns) : 88);
}
