import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
  color: ThemeColors;
}

type ThemeDefinition = {
  brand?: Partial<ThemeBrand>;
  color?: Partial<ThemeColors>;
};

export const INFINITE_NEON_THEME: Theme = {
  brand: {
    name: "Infinite",
    icon: "∞",
    prompt: "❯",
    welcome: "Type a message, /help, or /exit.",
    goodbye: "Goodbye.",
    tool: "┊",
    helpHeader: "Infinite commands"
  },
  color: {
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
  }
};

export const INFINITE_MONO_THEME: Theme = buildTheme({
  brand: {
    name: "Infinite Mono",
    prompt: "›"
  },
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
});

export const INFINITE_SLATE_THEME: Theme = buildTheme({
  brand: {
    name: "Infinite Slate"
  },
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
});

export const INFINITE_DAYLIGHT_THEME: Theme = buildTheme({
  brand: {
    name: "Infinite Daylight"
  },
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
});

export const DEFAULT_THEME = INFINITE_NEON_THEME;

export type AnsiRole = keyof Pick<ThemeColors, "primary" | "primaryBright" | "text" | "muted" | "success" | "warning" | "error">;

export const BUILTIN_THEMES = {
  "infinite-neon": INFINITE_NEON_THEME,
  neon: INFINITE_NEON_THEME,
  default: INFINITE_NEON_THEME,
  mono: INFINITE_MONO_THEME,
  slate: INFINITE_SLATE_THEME,
  daylight: INFINITE_DAYLIGHT_THEME,
  light: INFINITE_DAYLIGHT_THEME
} as const;

export type BuiltinThemeName = keyof typeof BUILTIN_THEMES;

export function resolveTheme(env: NodeJS.ProcessEnv = process.env): Theme {
  const rawName = env.INFINITE_CLI_SKIN ?? env.INFINITE_SKIN ?? env.INFINITE_THEME;
  const requested = normalizeThemeName(rawName);
  if (requested) {
    return BUILTIN_THEMES[requested];
  }

  return loadUserTheme(rawName, env) ?? DEFAULT_THEME;
}

export function ansi(theme: Theme, role: AnsiRole, value: string, enabled = true): string {
  if (!enabled) {
    return value;
  }

  const rgb = parseHex(theme.color[role]);
  if (!rgb) {
    return value;
  }

  return `\u001b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${value}\u001b[0m`;
}

function buildTheme(definition: ThemeDefinition): Theme {
  return {
    brand: { ...INFINITE_NEON_THEME.brand, ...definition.brand },
    color: { ...INFINITE_NEON_THEME.color, ...definition.color }
  };
}

function loadUserTheme(name: string | undefined, env: NodeJS.ProcessEnv): Theme | undefined {
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

function loadThemeFile(path: string): Theme | undefined {
  try {
    const fullPath = resolve(path);
    if (!existsSync(fullPath)) {
      return undefined;
    }
    const raw = readFileSync(fullPath, "utf8");
    const definition = fullPath.endsWith(".json")
      ? parseJsonTheme(raw)
      : parseYamlTheme(raw);
    return definition ? buildTheme(definition) : undefined;
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
  return normalized && normalized in BUILTIN_THEMES ? normalized as BuiltinThemeName : undefined;
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

function parseHex(value: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value);

  if (!match) {
    return null;
  }

  const numeric = Number.parseInt(match[1]!, 16);

  return [(numeric >> 16) & 0xff, (numeric >> 8) & 0xff, numeric & 0xff];
}
