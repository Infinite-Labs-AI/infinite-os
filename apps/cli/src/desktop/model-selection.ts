import {
  clearTerminalModelSelection,
  readTerminalModelFile,
  writeTerminalModelSelection,
  type ModelEffort,
  type ModelOption,
  type TerminalModelSelection
} from "@infinite-os/config";
import type { DesktopStatus } from "../desktop-app-client.js";
import type { ModelPickerAdapter } from "../tui/ink/model-picker.js";
import { boundedTerminalText } from "./confirm-in-session.js";
export const TURN_MODEL_CAPABILITY = "turn.model.v1";
export interface DesktopTurnModel {
  provider: "codex" | "claude-cli";
  modelId: string;
  effort?: ModelEffort;
}
export interface DesktopModelOption {
  provider: "codex" | "claude-cli";
  id: string;
  label: string;
  efforts: ModelEffort[];
  connected: boolean;
  selectable: boolean;
}
export function decodeDesktopModels(value: unknown): DesktopModelOption[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40)
    throw new Error("Desktop returned an invalid model catalog.");
  const seen = new Set<string>();
  return value.map((raw) => {
    if (
      !raw ||
      typeof raw !== "object" ||
      (raw.provider !== "codex" && raw.provider !== "claude-cli") ||
      typeof raw.id !== "string" ||
      !/^[a-z][a-z0-9.-]{0,99}$/.test(raw.id) ||
      typeof raw.label !== "string" ||
      !raw.label.trim() ||
      raw.label.length > 120 ||
      !Array.isArray(raw.efforts) ||
      raw.efforts.length > 5 ||
      raw.efforts.some(
        (e: unknown) =>
          !["low", "medium", "high", "xhigh", "max"].includes(String(e))
      ) ||
      typeof raw.connected !== "boolean" ||
      typeof raw.selectable !== "boolean"
    )
      throw new Error("Desktop returned an invalid model catalog.");
    const key = `${raw.provider}:${raw.id}`;
    if (seen.has(key)) throw new Error("Desktop returned duplicate models.");
    seen.add(key);
    return {
      provider: raw.provider,
      id: raw.id,
      label: boundedTerminalText(raw.label, 120, "Model"),
      efforts: [...raw.efforts],
      connected: raw.connected,
      selectable: raw.selectable
    };
  });
}
export function requireDesktopModel(
  status: Pick<DesktopStatus, "terminalModels">,
  model: DesktopTurnModel
): void {
  if (!status.terminalModels)
    throw new Error(
      "Update Infinite Desktop to use terminal model selection. Use /model default to clear the saved choice."
    );
  const option = status.terminalModels.find(
    (m) => m.provider === model.provider && m.id === model.modelId
  );
  if (!option)
    throw new Error(
      "This Desktop does not offer the saved terminal model. Choose /model or /model default."
    );
  if (!option.connected || !option.selectable)
    throw new Error(
      "Connect the selected provider in the app before sending. Nothing was sent."
    );
  if (model.effort !== undefined && !option.efforts.includes(model.effort))
    throw new Error(
      "This Desktop does not support the selected effort. Choose /model again."
    );
}
export function desktopModelFromFile(
  env: NodeJS.ProcessEnv
): DesktopTurnModel | undefined {
  const selected = readTerminalModelFile(env);
  return selected
    ? {
        provider: selected.provider === "claude" ? "claude-cli" : "codex",
        modelId: selected.model,
        ...(selected.effort ? { effort: selected.effort } : {})
      }
    : undefined;
}
function optionsFor(status: DesktopStatus): ModelOption[] {
  if (!status.terminalModels)
    throw new Error("Update Infinite Desktop to choose a terminal model.");
  return status.terminalModels.map((m) => ({
    provider: m.provider === "claude-cli" ? "claude" : "codex",
    id: m.id,
    label: m.label.replace(/\s+(low|medium|high|xhigh|max)$/i, ""),
    efforts: m.efforts
  }));
}
export function createDesktopModelPicker(
  env: NodeJS.ProcessEnv,
  getStatus: () => Promise<DesktopStatus>
): ModelPickerAdapter {
  return {
    async load() {
      const status = await getStatus();
      const choices = optionsFor(status);
      const selected = readTerminalModelFile(env);
      const ready = (provider: string) =>
        status.terminalModels!.some(
          (m) => m.provider === provider && m.connected && m.selectable
        );
      return {
        options: [
          {
            provider: "codex",
            id: "",
            label: "Use Desktop default",
            efforts: []
          },
          ...choices
        ],
        current: selected ?? { provider: "codex", model: "" },
        ready: { codex: ready("codex"), claude: ready("claude-cli") },
        allowClaude: true,
        connectInApp: true
      };
    },
    async save(selection: TerminalModelSelection) {
      const status = await getStatus();
      requireDesktopModel(status, {
        provider: selection.provider === "claude" ? "claude-cli" : "codex",
        modelId: selection.model,
        ...(selection.effort ? { effort: selection.effort } : {})
      });
      const choices = optionsFor(status);
      writeTerminalModelSelection(selection, env, choices);
      return `Model set: ${choices.find((m) => m.id === selection.model && m.provider === selection.provider)!.label}, effort ${selection.effort ?? "Default"}.\nApplies from your next message.`;
    },
    async clear() {
      clearTerminalModelSelection(env);
      return "Using Desktop default. Applies from your next message.";
    }
  };
}
