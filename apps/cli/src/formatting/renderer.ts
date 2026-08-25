import { ansi, resolveTheme, type Theme } from "../tui/theme.js";
import { displayWidth, padEndCells, truncateCells } from "../tui/lib/display-width.js";
import { resolveCliRenderSurface } from "../tui/runtime/render-surface.js";
import { formatMarkdownForTerminal, styleInlineMarkdown } from "./markdown.js";

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
  const theme = options.theme ?? resolveTheme();
  const color = options.color ?? Boolean(options.stream?.isTTY && !process.env.NO_COLOR);
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
  const width = Math.max(36, Math.min(100, columns - 2));
  const inner = width - 4;
  const label = `${theme.brand.icon} ${options.title ?? theme.brand.name}`.trim();
  const title = ` ${label} `;
  const titleWidth = displayWidth(title);
  const border = (value: string) => ansi(theme, "primary", value, options.color);
  const titleText = (value: string) => ansi(theme, "primaryBright", value, options.color);
  const text = (value: string) => ansi(theme, "text", value, options.color);
  const top = `${border("╭─")}${titleText(title)}${border(`${"─".repeat(Math.max(0, width - titleWidth - 3))}╮`)}`;
  const bottom = border(`╰${"─".repeat(width - 2)}╯`);
  const body = formatMarkdownForTerminal(message.trim() || "No answer was produced.", inner).map((line) =>
    styleInlineMarkdown(line, Boolean(options.color))
  );

  return [
    top,
    ...body.map((line) => `${border("│")} ${text(padEndCells(line, inner))} ${border("│")}`),
    bottom
  ].join("\n");
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
  const visible = truncateCells(parts.filter(Boolean).join("  |  "), width).replace(/\s+\|\s*…$/, " …");

  return ansi(theme, "muted", padEndCells(visible, width), options.color);
}

export function shouldUseInteractiveRenderer(stream: RenderStream, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCliRenderSurface(stream, env) !== "plain";
}

function clampColumns(columns: number): number {
  return Math.max(40, Math.min(160, Number.isFinite(columns) ? Math.floor(columns) : 88));
}

function clampStatusColumns(columns: number): number {
  return Math.max(12, Math.min(160, Number.isFinite(columns) ? Math.floor(columns) : 88));
}
