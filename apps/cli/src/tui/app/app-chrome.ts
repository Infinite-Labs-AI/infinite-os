import { renderStatusFooter } from "../../formatting/renderer.js";
import { displayWidth, padEndCells, truncateCells } from "../lib/display-width.js";
import { resolveCliRenderSurface, usesTranscriptRenderSurface } from "../runtime/render-surface.js";
import { ansi, resolveTheme, type Theme } from "../theme.js";
import { renderInfiniteTranscript, type InfiniteTranscriptInput } from "./transcript-renderer.js";

export interface InfiniteAppChromeInput {
  prompt?: {
    placeholder?: string;
    text?: string;
  };
  status?: readonly string[];
  title?: string;
  transcript: InfiniteTranscriptInput;
}

export interface InfiniteAppChromeOptions {
  color?: boolean;
  columns?: number;
  nowMs?: number;
  theme?: Theme;
}

interface ChromeContext {
  color: boolean;
  columns: number;
  theme: Theme;
}

export function renderInfiniteAppChrome(
  input: InfiniteAppChromeInput,
  options: InfiniteAppChromeOptions = {}
): string {
  const ctx: ChromeContext = {
    color: options.color ?? false,
    columns: clampColumns(options.columns ?? 88),
    theme: options.theme ?? resolveTheme()
  };
  const inner = Math.max(20, ctx.columns - 4);
  const innerCtx: ChromeContext = { ...ctx, columns: inner };
  const transcript = renderInfiniteTranscript(input.transcript, {
    color: ctx.color,
    columns: inner,
    nowMs: options.nowMs,
    theme: ctx.theme
  });
  const blocks = [
    transcript || ansi(ctx.theme, "muted", `${ctx.theme.brand.tool} ${ctx.theme.brand.welcome}`, ctx.color),
    renderStatusRule(input.status ?? [], innerCtx),
    renderComposer(input.prompt, innerCtx)
  ].filter((block) => block.length > 0);

  const rows = [renderFrameTop(input.title ?? ctx.theme.brand.name, ctx)];
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      rows.push(framedRow(line, ctx, inner));
    }
  }
  rows.push(renderFrameBottom(ctx));

  return rows.join("\n");
}

export function shouldUseInfiniteAppChrome(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return usesTranscriptRenderSurface(resolveCliRenderSurface(stream, env));
}

function renderFrameTop(title: string, ctx: ChromeContext): string {
  const label = ` ${ctx.theme.brand.icon} ${title} `;
  const fill = Math.max(0, ctx.columns - displayWidth(label) - 2);
  return ansi(ctx.theme, "primary", `╔${label}${"═".repeat(fill)}╗`, ctx.color);
}

function renderFrameBottom(ctx: ChromeContext): string {
  return ansi(ctx.theme, "primary", `╚${"═".repeat(Math.max(0, ctx.columns - 2))}╝`, ctx.color);
}

function framedRow(line: string, ctx: ChromeContext, inner: number): string {
  const bar = ansi(ctx.theme, "primary", "║", ctx.color);
  return `${bar} ${padEndCells(line, inner)} ${bar}`;
}

function renderStatusRule(parts: readonly string[], ctx: ChromeContext): string {
  if (!parts.length) {
    return ansi(ctx.theme, "muted", "─".repeat(ctx.columns), ctx.color);
  }

  return groupStatusParts(parts, ctx.columns)
    .map((group) => renderStatusFooter(group, {
      color: ctx.color,
      columns: ctx.columns,
      theme: ctx.theme
    }))
    .join("\n");
}

function renderComposer(prompt: InfiniteAppChromeInput["prompt"], ctx: ChromeContext): string {
  const promptText = prompt?.text?.trim() || ctx.theme.brand.prompt;
  const placeholder = prompt?.placeholder ?? ctx.theme.brand.welcome;
  const label = `${promptText} ${placeholder}`.trimEnd();
  return ansi(ctx.theme, "primaryBright", padEndCells(truncateCells(label, ctx.columns), ctx.columns), ctx.color);
}

function clampColumns(columns: number): number {
  return Math.max(40, Math.min(160, Number.isFinite(columns) ? Math.floor(columns) : 88));
}

function groupStatusParts(parts: readonly string[], columns: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];

  for (const part of parts) {
    const candidate = [...current, part];
    if (current.length && displayWidth(candidate.join("  |  ")) > columns) {
      groups.push(current);
      current = [part];
    } else {
      current = candidate;
    }
  }

  if (current.length) {
    groups.push(current);
  }

  return groups;
}
