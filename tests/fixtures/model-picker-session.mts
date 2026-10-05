import { readFileSync } from "node:fs";
import {
  createDesktopModelPicker,
  decodeDesktopModels
} from "../../apps/cli/src/desktop/model-selection.js";
import type { DesktopStatus } from "../../apps/cli/src/desktop-app-client.js";
// Isolated PTY fixture: real Ink session + real terminal selection persistence,
// synthetic provider readiness, no database or model/API requests.
import { writeInfiniteOsModelSelection } from "@infinite-os/config";
import { createTerminalModelPicker } from "../../apps/cli/src/terminal-model-picker.js";
import { runInkInteractiveSession } from "../../apps/cli/src/tui/ink/interactive-session.js";
if (process.env.MODEL_PICKER_FIXTURE !== "1" || !process.env.GROWTH_OS_HOME) {
  throw new Error("Use a throwaway GROWTH_OS_HOME and MODEL_PICKER_FIXTURE=1.");
}
writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.5" });
const picker =
  process.env.MODEL_PICKER_MODE === "desktop"
    ? createDesktopModelPicker(
        process.env,
        async () =>
          ({
            terminalModels: decodeDesktopModels(
              JSON.parse(
                readFileSync(process.env.MODEL_PICKER_CATALOG!, "utf8")
              )
            )
          }) as DesktopStatus
      )
    : createTerminalModelPicker(
        process.env,
        async () => true,
        undefined,
        async () => ({ ready: true })
      );
await runInkInteractiveSession({
  title: "Infinite",
  topBar: { workspace: "Example workspace" },
  modelPicker: picker,
  async onSubmitLine() {
    return {
      messages: [
        {
          kind: "slash",
          role: "system",
          text: "Fixture: no model requests are sent."
        }
      ]
    };
  }
});
