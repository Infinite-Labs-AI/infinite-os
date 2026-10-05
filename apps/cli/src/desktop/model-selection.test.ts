import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  MODEL_CATALOG,
  writeInfiniteOsModelSelection,
  readTerminalModelFile
} from "@infinite-os/config";
import {
  createDesktopModelPicker,
  desktopModelFromFile,
  requireDesktopModel
} from "./model-selection.js";
import type { DesktopStatus } from "../desktop-app-client.js";
const homes: string[] = [];
afterEach(() =>
  homes
    .splice(0)
    .forEach((home) => rmSync(home, { recursive: true, force: true }))
);
const models = [
  {
    provider: "codex",
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna Medium",
    efforts: ["low", "medium", "high"],
    connected: true,
    selectable: true
  },
  {
    provider: "claude-cli",
    id: "claude-opus-4-8",
    label: "Opus 4.8 Medium",
    efforts: ["low", "medium", "high"],
    connected: true,
    selectable: true
  }
] as const;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "desktop-picker-"));
  homes.push(dir);
  return { HOME: dir, GROWTH_OS_HOME: dir };
}
it("uses exactly the advertised choices, ignores env/shared fallback, and clears to Desktop default", async () => {
  const env = {
    ...fixture(),
    GROWTH_OS_MODEL_PROVIDER: "codex",
    GROWTH_OS_MODEL_NAME: "gpt-6.1-sol"
  };
  writeInfiniteOsModelSelection({ provider: "codex", model: "gpt-5.5" }, env);
  const shared = readFileSync(join(env.GROWTH_OS_HOME, "config.yml"), "utf8");
  const picker = createDesktopModelPicker(
    env,
    async () => ({ terminalModels: models }) as unknown as DesktopStatus
  );
  expect(desktopModelFromFile(env)).toBeUndefined();
  expect((await picker.load()).options?.map((m) => m.id)).toEqual([
    "",
    "gpt-5.6-luna",
    "claude-opus-4-8"
  ]);
  await picker.save({
    provider: "claude",
    model: "claude-opus-4-8",
    effort: "high"
  });
  expect(desktopModelFromFile(env)).toEqual({
    provider: "claude-cli",
    modelId: "claude-opus-4-8",
    effort: "high"
  });
  await picker.save({ provider: "codex", model: "gpt-5.6-luna" });
  expect(readTerminalModelFile(env)?.model).toBe("gpt-5.6-luna");
  expect(MODEL_CATALOG.some((m) => m.id === "gpt-5.6-luna")).toBe(false);
  await picker.clear!();
  expect(desktopModelFromFile(env)).toBeUndefined();
  expect(readFileSync(join(env.GROWTH_OS_HOME, "config.yml"), "utf8")).toBe(
    shared
  );
});
it("does not save a disconnected or unsupported choice", async () => {
  const env = fixture();
  const status = {
    terminalModels: models.map((m) => ({ ...m, connected: false }))
  } as unknown as DesktopStatus;
  const picker = createDesktopModelPicker(env, async () => status);
  await expect(
    picker.save({ provider: "claude", model: "claude-opus-4-8" })
  ).rejects.toThrow(/Connect/);
  expect(readTerminalModelFile(env)).toBeUndefined();
  expect(() =>
    requireDesktopModel({}, { provider: "codex", modelId: "gpt-5.5" })
  ).toThrow(/Update/);
});

it("sends Medium explicitly for a Desktop-backed terminal choice", async () => {
  const e = fixture();
  const picker = createDesktopModelPicker(e, async () => ({ terminalModels: models }) as unknown as DesktopStatus);
  await picker.save({ provider: "codex", model: "gpt-5.6-luna", effort: "medium" });
  expect(desktopModelFromFile(e)).toEqual({ provider: "codex", modelId: "gpt-5.6-luna", effort: "medium" });
});
