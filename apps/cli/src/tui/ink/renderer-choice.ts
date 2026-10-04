// Which Ink backend draws the session. Pure (no Ink import), so the theme can
// spell colours the way that backend expects without loading a renderer.

export type CliInkRenderer = "stock" | "infinite";

export function resolveInkRenderer(env: NodeJS.ProcessEnv = process.env): CliInkRenderer {
  const requested = env.INFINITE_INK_RENDERER?.trim().toLowerCase();
  // "infinite" is canonical; "hermes"/"hermes-ink" stay accepted as legacy aliases.
  return requested === "infinite" || requested === "hermes" || requested === "hermes-ink"
    ? "infinite"
    : "stock";
}
