// Tokens → escape codes and Ink props. The only place an SGR is built.
//
// A span opens with one SGR and closes with SPECIFIC resets (22 bold,
// 24 underline, 27 inverse, 39 foreground, 49 background), never a full
// reset (`0`), so a token painted inside a chip ends without ending the
// chip's background.

import { R4_TOKENS, type Tier, type Token, type TokenSpec } from "./tokens.js";

const ESC = "\u001b[";

/** One token, or several layered left to right (a later colour wins; attributes add up). */
export type TokenStyle = Token | readonly Token[];

/** Foreground hexes that replace a token's own at the truecolor tier (a user skin). */
export type TokenOverrides = Partial<Record<Token, string>>;

type Colour =
  | { kind: "default" }
  | { kind: "hex"; hex: string }
  | { kind: "256"; index: number }
  | { kind: "16"; code: number };

interface Resolved {
  fg?: Colour;
  bg?: Colour;
  bold: boolean;
  underline: boolean;
  inverse: boolean;
  brackets: boolean;
}

/** What a token set comes to at a tier. */
function resolve(style: TokenStyle, tier: Tier, overrides?: TokenOverrides): Resolved {
  const out: Resolved = { bold: false, underline: false, inverse: false, brackets: false };
  for (const token of tokenList(style)) {
    const spec: TokenSpec = token === "" ? {} : R4_TOKENS[token];
    if (tier === "plain") {
      out.brackets ||= spec.brackets === true;
      continue;
    }
    if (tier === "mono") {
      out.bold ||= spec.mono?.bold === true;
      out.underline ||= spec.mono?.underline === true;
      out.inverse ||= spec.mono?.inverse === true;
      continue;
    }
    out.bold ||= spec.bold === true;
    out.underline ||= spec.underline === true;
    const fg = colourAt(tier, token === "" ? undefined : spec.fg, spec.c256?.fg, spec.c16?.fg, tier === "truecolor" ? overrides?.[token] : undefined);
    if (fg) {
      out.fg = fg;
    } else if (token === "") {
      out.fg = { kind: "default" };
    }
    const bg = colourAt(tier, spec.bg, spec.c256?.bg, spec.c16?.bg);
    if (bg) {
      out.bg = bg;
    }
  }
  return out;
}

function colourAt(tier: Tier, hex: string | undefined, index256: number | undefined, code16: number | undefined, override?: string): Colour | undefined {
  if (tier === "truecolor") {
    const value = override && parseHex(override) ? override : hex;
    return value ? { kind: "hex", hex: value.startsWith("#") ? value : `#${value}` } : undefined;
  }
  if (tier === "256") {
    return index256 === undefined ? undefined : { kind: "256", index: index256 };
  }
  if (tier === "16") {
    return code16 === undefined ? undefined : { kind: "16", code: code16 };
  }
  return undefined;
}

function tokenList(style: TokenStyle): readonly Token[] {
  return typeof style === "string" ? [style] : style;
}

function colourParams(colour: Colour, layer: "fg" | "bg"): string {
  switch (colour.kind) {
    case "default":
      return layer === "fg" ? "39" : "49";
    case "hex": {
      const [r, g, b] = parseHex(colour.hex) ?? [0, 0, 0];
      return `${layer === "fg" ? 38 : 48};2;${r};${g};${b}`;
    }
    case "256":
      return `${layer === "fg" ? 38 : 48};5;${colour.index}`;
    case "16":
      return String(colour.code);
  }
}

/**
 * The SGR parameters that turn a token set on at a tier: bold, underline,
 * inverse, then foreground, then background (`1;38;2;…;48;2;…`). Empty when
 * the tier paints nothing for it.
 */
export function sgrParams(style: TokenStyle, tier: Tier, overrides?: TokenOverrides): string {
  const r = resolve(style, tier, overrides);
  const params: string[] = [];
  if (r.bold) params.push("1");
  if (r.underline) params.push("4");
  if (r.inverse) params.push("7");
  if (r.fg) params.push(colourParams(r.fg, "fg"));
  if (r.bg) params.push(colourParams(r.bg, "bg"));
  return params.join(";");
}

/** The escape that turns a token set on ("" when the tier paints nothing for it). */
export function sgrOpen(style: TokenStyle, tier: Tier, overrides?: TokenOverrides): string {
  const params = sgrParams(style, tier, overrides);
  return params ? `${ESC}${params}m` : "";
}

/** The escape that turns exactly that token set off again: 22, 24, 27, 39, 49. Never `0`. */
export function sgrClose(style: TokenStyle, tier: Tier): string {
  const r = resolve(style, tier);
  const params: string[] = [];
  if (r.bold) params.push("22");
  if (r.underline) params.push("24");
  if (r.inverse) params.push("27");
  if (r.fg) params.push("39");
  if (r.bg) params.push("49");
  return params.length ? `${ESC}${params.join(";")}m` : "";
}

/** The escape that switches only the foreground (no bold, no background). */
export function sgrForeground(style: TokenStyle, tier: Tier, overrides?: TokenOverrides): string {
  const fg = resolve(style, tier, overrides).fg;
  return fg ? `${ESC}${colourParams(fg, "fg")}m` : "";
}

/**
 * Paint `text` in a token set at a tier. Under `plain` nothing is emitted,
 * and a chip (`" k "` in `key`, `pk`, `inv` or `tag`) becomes `"[k]"`, the
 * same width.
 */
export function style(text: string, tokens: TokenStyle, tier: Tier, overrides?: TokenOverrides): string {
  if (!text) {
    return text;
  }
  if (tier === "plain") {
    return resolve(tokens, tier).brackets ? bracketed(text) : text;
  }
  const open = sgrOpen(tokens, tier, overrides);
  return open ? `${open}${text}${sgrClose(tokens, tier)}` : text;
}

/**
 * Escapes that add bold, underline or inverse on top of whatever is already
 * painted, and end exactly those (22, 24, 27). Nothing under `plain`.
 */
export function sgrAttributes(attrs: { bold?: boolean; underline?: boolean; inverse?: boolean }, tier: Tier): { open: string; close: string } {
  if (tier === "plain") {
    return { open: "", close: "" };
  }
  const on = [attrs.bold ? "1" : "", attrs.underline ? "4" : "", attrs.inverse ? "7" : ""].filter(Boolean);
  const off = [attrs.bold ? "22" : "", attrs.underline ? "24" : "", attrs.inverse ? "27" : ""].filter(Boolean);
  return {
    open: on.map((code) => `${ESC}${code}m`).join(""),
    close: off.length ? `${ESC}${off.join(";")}m` : ""
  };
}

/** A key chip: `" k "` on the key background, or the OK key's amber (`ok`). `"[k]"` when plain. */
export function chip(key: string, tier: Tier, ok = false): string {
  return style(` ${key} `, ok ? "pk" : "key", tier);
}

function bracketed(text: string): string {
  return text.length >= 2 && text.startsWith(" ") && text.endsWith(" ") ? `[${text.slice(1, -1)}]` : text;
}

// ── Ink ──

/** Ink `Text` props for a token set. Colours are already resolved to the tier. */
export interface InkStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

/** Which Ink backend draws: stock `ink`, or the vendored fork (named colours as `ansi:<name>`). */
export type InkColorForm = "stock" | "infinite";

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/** The 16-colour name for an SGR colour code (30–37/90–97 fg, 40–47/100–107 bg). */
export function namedColor(code: number): string | undefined {
  const base = code % 10;
  const bright = code >= 90;
  const name = NAMES[base];
  return name === undefined || base > 7 ? undefined : bright ? `${name}Bright` : name;
}

/** A colour as the given Ink backend spells it. Hex and `ansi256(n)` pass as they are. */
export function toInkColor(color: string | undefined, form: InkColorForm): string | undefined {
  if (!color || form === "stock" || color.startsWith("#") || color.startsWith("ansi256(") || color.startsWith("ansi:")) {
    return color;
  }
  return `ansi:${color}`;
}

function inkColour(colour: Colour | undefined, form: InkColorForm): string | undefined {
  if (!colour) {
    return undefined;
  }
  switch (colour.kind) {
    case "default":
      return undefined;
    case "hex":
      return colour.hex;
    case "256":
      return `ansi256(${colour.index})`;
    case "16":
      return toInkColor(namedColor(colour.code), form);
  }
}

/**
 * Ink props for a token set at a tier: truecolor → `"#rrggbb"`, 256 →
 * `"ansi256(n)"`, 16 → a named colour, mono → attributes only, plain →
 * nothing. Never hand Ink a raw hex below truecolor: chalk would re-quantize
 * it (the dim grey turns lilac at 256 colours).
 */
export function inkStyle(tokens: TokenStyle, tier: Tier, options: { form?: InkColorForm; overrides?: TokenOverrides } = {}): InkStyle {
  const r = resolve(tokens, tier, options.overrides);
  const form = options.form ?? "stock";
  const out: InkStyle = {};
  const color = inkColour(r.fg, form);
  const backgroundColor = inkColour(r.bg, form);
  if (color) out.color = color;
  if (backgroundColor) out.backgroundColor = backgroundColor;
  if (r.bold) out.bold = true;
  if (r.underline) out.underline = true;
  if (r.inverse) out.inverse = true;
  return out;
}

export function parseHex(value: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value);
  if (!match) {
    return null;
  }
  const numeric = Number.parseInt(match[1]!, 16);
  return [(numeric >> 16) & 0xff, (numeric >> 8) & 0xff, numeric & 0xff];
}
