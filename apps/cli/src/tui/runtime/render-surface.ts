export type CliRenderSurface = "plain" | "raw" | "chrome" | "ink";

interface SurfaceStream {
  isTTY?: boolean;
}

export function resolveCliRenderSurface(
  stream: SurfaceStream,
  env: NodeJS.ProcessEnv = process.env
): CliRenderSurface {
  const requested = normalizeRenderSurface(env.INFINITE_RENDER_SURFACE);
  if (!stream.isTTY || isTruthy(env.INFINITE_PLAIN_OUTPUT) || requested === "plain") {
    return "plain";
  }
  if (requested) {
    return requested;
  }
  if (isTruthy(env.INFINITE_TUI_CHROME)) {
    return "chrome";
  }
  return "ink";
}

export function usesTranscriptRenderSurface(surface: CliRenderSurface): boolean {
  return surface === "chrome" || surface === "ink";
}

function normalizeRenderSurface(value: string | undefined): CliRenderSurface | undefined {
  const normalized = value?.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) {
    return undefined;
  }
  if (normalized === "plain" || normalized === "text" || normalized === "none") {
    return "plain";
  }
  if (normalized === "raw" || normalized === "terminal") {
    return "raw";
  }
  if (normalized === "chrome" || normalized === "app-chrome" || normalized === "transcript") {
    return "chrome";
  }
  if (normalized === "ink" || normalized === "tui" || normalized === "alternate" || normalized === "alternate-screen") {
    return "ink";
  }
  return undefined;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes" || value?.toLowerCase() === "on";
}
