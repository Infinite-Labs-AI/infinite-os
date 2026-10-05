import {
  claudeCliReadiness,
  terminalClaudeSelection
} from "./claude-cli-model-client.js";
import {
  modelOption,
  readInfiniteOsModelSelection,
  resolveTerminalModelSelection,
  writeTerminalModelSelection
} from "@infinite-os/config";
import type { ModelPickerAdapter } from "./tui/ink/model-picker.js";
import { boundedTerminalText } from "./desktop/confirm-in-session.js";

export const MODEL_PICKER_GUIDANCE =
  "Choose a terminal chat model with /model inside infinite local.\nUse infinite local model list, infinite local model status, or infinite local model use <provider> <model> for the shared default.";
export function createTerminalModelPicker(
  env: NodeJS.ProcessEnv,
  codexReady: () => Promise<boolean>,
  connectCodex?: ModelPickerAdapter["connectCodex"],
  claudeReady: () => Promise<{ ready: boolean; detail?: string }> = () =>
    claudeCliReadiness(env)
): ModelPickerAdapter {
  const ready = async (provider: string) =>
    provider === "claude" ? (await claudeReady()).ready : codexReady();
  return {
    ...(connectCodex ? { connectCodex } : {}),
    async load() {
      const resolved = resolveTerminalModelSelection(env);
      const cliClaude = terminalClaudeSelection(env);
      return {
        current: cliClaude ?? resolved.selection,
        allowClaude: true,
        ready: { codex: await ready("codex"), claude: await ready("claude") },
        warning: cliClaude && resolved.source !== "terminal" ? "The saved Claude model is not listed in the local picker." : resolved.warning
      };
    },
    async save(selection) {
      if (!(await ready(selection.provider)))
        return selection.provider === "claude"
          ? "Run claude auth login with your Claude subscription, then try /model again. Nothing changed."
          : "Codex sign-in needed. Run /codex login, then try /model again. Model unchanged.";
      writeTerminalModelSelection(selection, env);
      const resolved = resolveTerminalModelSelection(env);
      const label = modelOption(selection.provider, selection.model)!.label;
      if (resolved.source === "env")
        return `Saved ${label}, but your environment selects ${display(resolved.selection)} for terminal chat.`;
      return `Model set: ${label}, effort ${selection.effort ?? "Default"}.\nApplies from your next message.`;
    }
  };
}
function display(
  selection: { provider?: string; model?: string; effort?: string } | undefined
): string {
  if (!selection?.provider || !selection.model) return "not selected";
  return `${selection.provider} · ${boundedTerminalText(selection.model, 100, "unknown")} · effort ${selection.effort ?? "Default"}`;
}
export function terminalModelStatus(env: NodeJS.ProcessEnv): string {
  const resolved = resolveTerminalModelSelection(env);
  const cliClaude = terminalClaudeSelection(env);
  const terminal = cliClaude ? {selection:cliClaude,source:"terminal",warning:undefined} : resolved;
  const shared = readInfiniteOsModelSelection({
    ...env,
    GROWTH_OS_MODEL_PROVIDER: undefined,
    GROWTH_OS_MODEL_NAME: undefined
  });
  return `Terminal chat: ${display(terminal.selection)} (${terminal.source}${terminal.source === "env" ? " override" : ""})\nShared app default: ${display(shared)}${terminal.warning ? `\n${terminal.warning}` : ""}`;
}
