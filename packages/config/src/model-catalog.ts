import type { InfiniteOsModelProvider } from "./growth-os-home.js";
export type ModelEffort = "low" | "medium" | "high" | "xhigh" | "max";
export interface ModelOption {
  provider: InfiniteOsModelProvider;
  id: string;
  label: string;
  default?: boolean;
  new?: boolean;
  efforts: readonly ModelEffort[];
}
const codexEfforts = ["low", "medium", "high", "xhigh"] as const;
// Verified: https://platform.claude.com/docs/en/build-with-claude/effort
// Both 5.5 models accept output_config.effort without a beta header.
const claudeEfforts = [...codexEfforts, "max"] as const;
export const MODEL_CATALOG: readonly ModelOption[] = [
  {
    provider: "codex",
    id: "gpt-6.1-sol",
    label: "Sol 6.1",
    new: true,
    efforts: codexEfforts
  },
  {
    provider: "codex",
    id: "gpt-5.5",
    label: "GPT-5.5",
    default: true,
    efforts: codexEfforts
  },
  { provider: "codex", id: "gpt-5.4", label: "GPT-5.4", efforts: codexEfforts },
  {
    provider: "claude",
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    new: true,
    efforts: claudeEfforts
  },
  {
    provider: "claude",
    id: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
    new: true,
    efforts: claudeEfforts
  },
  { provider: "claude", id: "claude-opus-4-8", label: "Opus 4.8", efforts: [] },
  { provider: "claude", id: "claude-opus-4-7", label: "Opus 4.7", efforts: [] },
  {
    provider: "claude",
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    default: true,
    efforts: []
  },
  {
    provider: "claude",
    id: "claude-sonnet-4-5",
    label: "Sonnet 4.5",
    efforts: []
  },
  {
    provider: "claude",
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    efforts: []
  }
];
export function modelOption(
  provider: string,
  model: string
): ModelOption | undefined {
  return MODEL_CATALOG.find(
    (option) => option.provider === provider && option.id === model
  );
}
export function supportedModelEffort(
  provider: string,
  model: string,
  effort: unknown
): ModelEffort | undefined {
  return modelOption(provider, model)?.efforts.find(
    (value) => value === effort
  );
}
