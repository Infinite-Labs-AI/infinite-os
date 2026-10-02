import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { resolveInkRenderer } from "./ink/renderer-choice.js";
import {
  inkStyle,
  parseHex,
  sgrClose,
  sgrForeground,
  sgrOpen,
  style,
  type InkColorForm,
  type InkStyle,
  type TokenOverrides,
  type TokenStyle
} from "./style/sgr.js";
import { explicitTier, resolveTier, tierHasColor, tierPaints, type TierStream } from "./style/tier.js";
import type { Tier, Token } from "./style/tokens.js";

// The CLI's theme. Colour comes from the r4 style tokens (`style/`); the old
// roles (`primary`, `muted`, …) stay as aliases so every call site keeps
// working, and they now paint in r4 colours at the session's colour tier.

export interface ThemeColors {
  primary: string;
  primaryBright: string;
  primaryDeep: string;
  text: string;
  muted: string;
  background: string;
  panelBackground: string;
  success: string;
  warning: string;
  error: string;
  line: string;
  ask: string;
  link: string;
  hatch: string;
  blue: string;
  cmdl: string;
}

export interface ThemeBrand {
  name: string;
  icon: string;
  prompt: string;
  welcome: string;
  goodbye: string;
  tool: string;
  helpHeader: string;
}

export interface Theme {
  brand: ThemeBrand;
  /**
   * Each role's colour for an Ink `<Text color>`, already resolved to `tier`:
   * `"#rrggbb"` (truecolor), `"ansi256(n)"` (256), a named colour (16), or
   * `""` for no colour (body text in the default foreground, NO_COLOR, plain).
   */
  color: ThemeColors;
  /** The colour tier everything paints at (see `style/tier.ts`). */
  tier: Tier;
  /** A skin's hexes. They replace the r4 colours at the truecolor tier only. */
  skin?: Partial<ThemeColors>;
}

type ThemeDefinition = {
  brand?: Partial<ThemeBrand>;
  color?: Partial<ThemeColors>;
  /** A skin for a light background: it paints at the 16 tier so the user's palette keeps contrast. */
  light?: true;
};

/** The old roles, plus the r4 ones every renderer can now ask for. */
export type AnsiRole =
  | "primary"
  | "primaryBright"
  | "text"
  | "muted"
  | "success"
  | "warning"
  | "error"
  | "line"
  | "ask"
  | "link"
  | "hatch"
  | "blue"
  | "cmdl";

/** What a role paints as: its r4 token(s). */
export const ROLE_TOKENS: Readonly<Record<AnsiRole, TokenStyle>> = {
  primary: "cyan",
  primaryBright: "b",
  text: "",
  muted: "dim",
  success: "green",
  warning: "amber",
  error: "red",
  line: "line",
  ask: "ab",
  link: ["cyan", "u"],
  hatch: "hatch",
  blue: "blue",
  cmdl: "bb"
};

/** A role, or r4 tokens directly. */
export type ThemeStyle = AnsiRole | TokenStyle;

/** The tokens a role or token style paints as. */
export function themeTokens(value: ThemeStyle): TokenStyle {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ROLE_TOKENS, value)
    ? ROLE_TOKENS[value as AnsiRole]
    : (value as TokenStyle);
}

/**
 * Which token foregrounds a skin colour replaces, applied in this order so
 * the specific role wins (`ask` over `warning` for `ab`, `cmdl` over `blue` for `bb`).
 */
const SKIN_TOKENS: ReadonlyArray<readonly [keyof ThemeColors, readonly Token[]]> = [
  ["primary", ["cyan", "cb"]],
  ["primaryBright", ["b"]],
  ["text", [""]],
  ["muted", ["dim"]],
  ["success", ["green", "gb"]],
  ["warning", ["amber", "ab"]],
  ["error", ["red", "rb"]],
  ["line", ["line"]],
  ["hatch", ["hatch"]],
  ["blue", ["blue", "bb"]],
  ["ask", ["ab"]],
  ["cmdl", ["bb"]]
];

const BASE_BRAND: ThemeBrand = {
  name: "Infinite",
  icon: "∞",
  prompt: "❯",
  welcome: "Type a message, /help, or /exit.",
  goodbye: "Goodbye.",
  tool: "┊",
  helpHeader: "Infinite commands"
};

const NEON_COLORS: Partial<ThemeColors> = {
  primary: "#00D5FF",
  primaryBright: "#7DF9FF",
  primaryDeep: "#0B5CFF",
  text: "#EAFBFF",
  muted: "#5FBBD8",
  background: "#06131F",
  panelBackground: "#081B2A",
  success: "#33F6A6",
  warning: "#FFD166",
  error: "#FF5C8A"
};

const BUILTIN_SKINS = {
  r4: {},
  neon: { color: NEON_COLORS },
  mono: {
    brand: { name: "Infinite Mono", prompt: "›" },
    color: {
      primary: "#C8D0D9",
      primaryBright: "#F4F7FA",
      primaryDeep: "#8C97A3",
      text: "#F2F4F7",
      muted: "#8A96A3",
      background: "#111418",
      panelBackground: "#171B20",
      success: "#B8D4C2",
      warning: "#E5D18A",
      error: "#F29B9B"
    }
  },
  slate: {
    brand: { name: "Infinite Slate" },
    color: {
      primary: "#54C6FF",
      primaryBright: "#B7ECFF",
      primaryDeep: "#2F7DD3",
      text: "#ECF7FF",
      muted: "#7BA6BD",
      background: "#08131C",
      panelBackground: "#0E1F2C",
      success: "#58D5A7",
      warning: "#EACB6B",
      error: "#FF7390"
    }
  },
  daylight: {
    brand: { name: "Infinite Daylight" },
    light: true,
    color: {
      primary: "#0066CC",
      primaryBright: "#003D7A",
      primaryDeep: "#004E9A",
      text: "#17202A",
      muted: "#5D7285",
      background: "#F7FBFF",
      panelBackground: "#EAF4FF",
      success: "#087A4D",
      warning: "#9A6500",
      error: "#C4314B"
    }
  }
} as const satisfies Record<string, ThemeDefinition>;

/** The Ink backend is chosen once per process (see `ink/renderer.ts`); colours are spelled its way. */
const INK_FORM: InkColorForm = resolveInkRenderer() === "infinite" ? "infinite" : "stock";

/** The r4 look at truecolor: the default, and what tests render with. */
export const INFINITE_R4_THEME: Theme = buildTheme(BUILTIN_SKINS.r4, "truecolor");
export const INFINITE_NEON_THEME: Theme = buildTheme(BUILTIN_SKINS.neon, "truecolor");
export const INFINITE_MONO_THEME: Theme = buildTheme(BUILTIN_SKINS.mono, "truecolor");
export const INFINITE_SLATE_THEME: Theme = buildTheme(BUILTIN_SKINS.slate, "truecolor");
export const INFINITE_DAYLIGHT_THEME: Theme = buildTheme(BUILTIN_SKINS.daylight, "16");

export const DEFAULT_THEME = INFINITE_R4_THEME;

const BUILTIN_THEME_SKINS = {
  r4: BUILTIN_SKINS.r4,
  "infinite-r4": BUILTIN_SKINS.r4,
  default: BUILTIN_SKINS.r4,
  "infinite-neon": BUILTIN_SKINS.neon,
  neon: BUILTIN_SKINS.neon,
  mono: BUILTIN_SKINS.mono,
  slate: BUILTIN_SKINS.slate,
  daylight: BUILTIN_SKINS.daylight,
  light: BUILTIN_SKINS.daylight
} as const satisfies Record<string, ThemeDefinition>;

export type BuiltinThemeName = keyof typeof BUILTIN_THEME_SKINS;

/**
 * The theme for this terminal: the skin named by `INFINITE_CLI_SKIN`,
 * `INFINITE_SKIN` or `INFINITE_THEME` (a built-in name or a user skin file),
 * painted at the colour tier `resolveTier` picks. Without a `stream` the
 * caller is drawing to a terminal; pass one to let a pipe select `plain`.
 */
export function resolveTheme(env: NodeJS.ProcessEnv = process.env, stream: TierStream = { isTTY: true }): Theme {
  // Renderers call this on every frame (`theme ?? resolveTheme()`): the same
  // terminal must give the same object, or every memoised render recomputes.
  const key = JSON.stringify([Boolean(stream.isTTY), ...THEME_ENV_KEYS.map((name) => env[name] ?? null)]);
  const cached = THEME_CACHE.get(key);
  if (cached) {
    return cached;
  }
  if (THEME_CACHE.size >= 32) {
    THEME_CACHE.clear();
  }
  const theme = computeTheme(env, stream);
  THEME_CACHE.set(key, theme);
  return theme;
}

/** Everything in the environment that decides the theme (the skin and the colour tier). */
const THEME_ENV_KEYS = [
  "INFINITE_CLI_SKIN",
  "INFINITE_SKIN",
  "INFINITE_THEME",
  "INFINITE_SKIN_FILE",
  "INFINITE_SKIN_DIR",
  "GROWTH_OS_HOME",
  "HOME",
  "INFINITE_COLOR",
  "INFINITE_PLAIN_OUTPUT",
  "NO_COLOR",
  "FORCE_COLOR",
  "COLORFGBG",
  "COLORTERM",
  "TMUX",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION"
] as const;

const THEME_CACHE = new Map<string, Theme>();

function computeTheme(env: NodeJS.ProcessEnv, stream: TierStream): Theme {
  const rawName = env.INFINITE_CLI_SKIN ?? env.INFINITE_SKIN ?? env.INFINITE_THEME;
  const requested = normalizeThemeName(rawName);
  const definition: ThemeDefinition = requested
    ? BUILTIN_THEME_SKINS[requested]
    : loadUserTheme(rawName, env) ?? BUILTIN_SKINS.r4;
  let tier = resolveTier(env, stream);
  if (definition.light && tierHasColor(tier) && !explicitTier(env)) {
    tier = "16";
  }
  return buildTheme(definition, tier);
}

/** Whether output under this theme carries any escape codes (only the `plain` tier does not). */
export function colorEnabled(theme: Theme): boolean {
  return tierPaints(theme.tier);
}

/** Paint `value` in a role (or r4 tokens) at the theme's tier; plain when `enabled` is false. */
export function ansi(theme: Theme, role: ThemeStyle, value: string, enabled = true): string {
  return enabled ? style(value, themeTokens(role), theme.tier, skinOverrides(theme)) : value;
}

/** The SGR that switches only the foreground to a role ("" when the tier paints no colour). */
export function ansiFg(theme: Theme, role: ThemeStyle): string {
  return sgrForeground(themeTokens(role), theme.tier, skinOverrides(theme));
}

/** The escapes that open and close a role (or r4 tokens) at the theme's tier ("" where nothing is painted). */
export function ansiSpan(theme: Theme, role: ThemeStyle): { open: string; close: string } {
  const tokens = themeTokens(role);
  return { open: sgrOpen(tokens, theme.tier, skinOverrides(theme)), close: sgrClose(tokens, theme.tier) };
}

/** Ink `Text` props for a role (or r4 tokens) at the theme's tier. */
export function themeInkStyle(theme: Theme, role: ThemeStyle): InkStyle {
  return inkStyle(themeTokens(role), theme.tier, { form: INK_FORM, overrides: skinOverrides(theme) });
}

function buildTheme(definition: ThemeDefinition, tier: Tier): Theme {
  const skin = definition.color && Object.keys(definition.color).length ? { ...definition.color } : undefined;
  const overrides = tokenOverrides(skin);
  const ink = (value: TokenStyle) => inkStyle(value, tier, { form: INK_FORM, overrides });
  const skinHex = (key: keyof ThemeColors) => (tier === "truecolor" ? skin?.[key] : undefined);
  const color = Object.fromEntries(
    (Object.keys(ROLE_TOKENS) as AnsiRole[]).map((role) => [role, ink(ROLE_TOKENS[role]).color ?? ""])
  ) as Record<AnsiRole, string>;
  return {
    brand: { ...BASE_BRAND, ...definition.brand },
    color: {
      ...color,
      primaryDeep: skinHex("primaryDeep") ?? ink("cyan").color ?? "",
      background: skinHex("background") ?? "",
      panelBackground: skinHex("panelBackground") ?? ink("sel").backgroundColor ?? ""
    },
    tier,
    ...(skin ? { skin } : {})
  };
}

const OVERRIDES = new WeakMap<object, TokenOverrides | undefined>();

function skinOverrides(theme: Theme): TokenOverrides | undefined {
  if (!theme.skin || theme.tier !== "truecolor") {
    return undefined;
  }
  if (!OVERRIDES.has(theme.skin)) {
    OVERRIDES.set(theme.skin, tokenOverrides(theme.skin));
  }
  return OVERRIDES.get(theme.skin);
}

function tokenOverrides(skin: Partial<ThemeColors> | undefined): TokenOverrides | undefined {
  if (!skin) {
    return undefined;
  }
  const out: TokenOverrides = {};
  for (const [key, tokens] of SKIN_TOKENS) {
    const hex = skin[key];
    if (hex && parseHex(hex)) {
      for (const token of tokens) {
        out[token] = hex;
      }
    }
  }
  return out;
}

function loadUserTheme(name: string | undefined, env: NodeJS.ProcessEnv): ThemeDefinition | undefined {
  const directPath = env.INFINITE_SKIN_FILE?.trim();
  if (directPath) {
    return loadThemeFile(directPath);
  }

  const normalized = name?.trim();
  if (!normalized) {
    return undefined;
  }

  const candidates = skinSearchDirs(env).flatMap((dir) => [
    join(dir, `${normalized}.yaml`),
    join(dir, `${normalized}.yml`),
    join(dir, `${normalized}.json`)
  ]);

  for (const candidate of candidates) {
    const loaded = loadThemeFile(candidate);
    if (loaded) {
      return loaded;
    }
  }

  return undefined;
}

function loadThemeFile(path: string): ThemeDefinition | undefined {
  try {
    const fullPath = resolve(path);
    if (!existsSync(fullPath)) {
      return undefined;
    }
    const raw = readFileSync(fullPath, "utf8");
    const definition = fullPath.endsWith(".json")
      ? parseJsonTheme(raw)
      : parseYamlTheme(raw);
    return definition;
  } catch {
    return undefined;
  }
}

function parseJsonTheme(raw: string): ThemeDefinition | undefined {
  const parsed = JSON.parse(raw) as unknown;
  return themeDefinitionFromUnknown(parsed);
}

function parseYamlTheme(raw: string): ThemeDefinition | undefined {
  const root: Record<string, unknown> = {};
  let section: "branding" | "colors" | undefined;

  for (const line of raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    const trimmed = stripYamlComment(line).trimEnd();
    if (!trimmed.trim()) {
      continue;
    }

    const sectionMatch = /^([A-Za-z0-9_-]+):\s*$/.exec(trimmed);
    if (sectionMatch) {
      const nextSection = normalizeSkinKey(sectionMatch[1] ?? "");
      section = nextSection === "branding" || nextSection === "colors" ? nextSection : undefined;
      if (section && !root[section]) {
        root[section] = {};
      }
      continue;
    }

    const pair = /^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(trimmed);
    if (!pair) {
      continue;
    }
    const nested = /^\s+/.test(trimmed);
    if (!nested) {
      section = undefined;
    }
    const key = normalizeSkinKey(pair[1] ?? "");
    const value = unquoteYamlValue(pair[2] ?? "");
    if (nested && (section === "branding" || section === "colors")) {
      (root[section] as Record<string, string>)[key] = value;
    } else {
      root[key] = value;
    }
  }

  return themeDefinitionFromUnknown(root);
}

function themeDefinitionFromUnknown(value: unknown): ThemeDefinition | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const branding = isRecord(row.branding) ? row.branding : {};
  const colors = isRecord(row.colors) ? row.colors : {};
  const brand: Partial<ThemeBrand> = {};
  const color: Partial<ThemeColors> = {};

  copyString(brand, "name", stringValue(branding.agentName) ?? stringValue(branding.agent_name) ?? stringValue(row.name));
  copyString(brand, "icon", stringValue(branding.icon));
  copyString(brand, "prompt", stringValue(branding.promptSymbol) ?? stringValue(branding.prompt_symbol));
  copyString(brand, "welcome", stringValue(branding.welcome));
  copyString(brand, "goodbye", stringValue(branding.goodbye));
  copyString(brand, "tool", stringValue(row.toolPrefix) ?? stringValue(row.tool_prefix));
  copyString(brand, "helpHeader", stringValue(branding.helpHeader) ?? stringValue(branding.help_header));

  copyHex(color, "primary", colors.responseBorder, colors.response_border, colors.bannerBorder, colors.banner_border, colors.uiAccent, colors.ui_accent);
  copyHex(color, "primaryBright", colors.bannerTitle, colors.banner_title, colors.statusBarStrong, colors.status_bar_strong);
  copyHex(color, "primaryDeep", colors.inputRule, colors.input_rule, colors.bannerAccent, colors.banner_accent);
  copyHex(color, "text", colors.bannerText, colors.banner_text, colors.prompt, colors.statusBarText, colors.status_bar_text);
  copyHex(color, "muted", colors.bannerDim, colors.banner_dim, colors.statusBarDim, colors.status_bar_dim, colors.sessionBorder, colors.session_border);
  copyHex(color, "background", colors.statusBarBg, colors.status_bar_bg);
  copyHex(color, "panelBackground", colors.completionMenuBg, colors.completion_menu_bg, colors.voiceStatusBg, colors.voice_status_bg);
  copyHex(color, "success", colors.uiOk, colors.ui_ok, colors.statusBarGood, colors.status_bar_good);
  copyHex(color, "warning", colors.uiWarn, colors.ui_warn, colors.statusBarWarn, colors.status_bar_warn);
  copyHex(color, "error", colors.uiError, colors.ui_error, colors.statusBarBad, colors.status_bar_bad, colors.statusBarCritical, colors.status_bar_critical);

  return Object.keys(brand).length || Object.keys(color).length ? { brand, color } : undefined;
}

function skinSearchDirs(env: NodeJS.ProcessEnv): string[] {
  return [
    env.INFINITE_SKIN_DIR,
    env.GROWTH_OS_HOME ? join(env.GROWTH_OS_HOME, "skins") : undefined,
    env.HOME ? join(env.HOME, ".growth-os", "skins") : undefined
  ].filter((dir): dir is string => Boolean(dir?.trim()));
}

function normalizeThemeName(value: string | undefined): BuiltinThemeName | undefined {
  const normalized = value?.trim().toLowerCase().replace(/_/g, "-");
  return normalized && Object.prototype.hasOwnProperty.call(BUILTIN_THEME_SKINS, normalized) ? normalized as BuiltinThemeName : undefined;
}

function stripYamlComment(line: string): string {
  let quoted: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === "'" || char === "\"") && line[index - 1] !== "\\") {
      quoted = quoted === char ? undefined : quoted ?? char;
    }
    if (char === "#" && !quoted) {
      return line.slice(0, index);
    }
  }
  return line;
}

function unquoteYamlValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeSkinKey(value: string): string {
  return value.replace(/[-_]+([a-zA-Z0-9])/g, (_, char: string) => char.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function copyString<T extends Record<string, unknown>, K extends keyof T>(target: T, key: K, value: string | undefined): void {
  if (value) {
    target[key] = value as T[K];
  }
}

function copyHex<K extends keyof ThemeColors>(target: Partial<ThemeColors>, key: K, ...values: unknown[]): void {
  const value = values.find((candidate) => typeof candidate === "string" && parseHex(candidate));
  if (typeof value === "string") {
    target[key] = value as ThemeColors[K];
  }
}
