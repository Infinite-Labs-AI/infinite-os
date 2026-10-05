import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  infiniteOsHome,
  readInfiniteOsModelSelection,
  type InfiniteOsModelProvider
} from "./growth-os-home.js";
import { parseSimpleYaml } from "./index.js";
import {
  modelOption,
  supportedModelEffort,
  type ModelOption,
  MODEL_CATALOG,
  type ModelEffort
} from "./model-catalog.js";

export interface TerminalModelSelection {
  provider: InfiniteOsModelProvider;
  model: string;
  effort?: ModelEffort;
}
export interface TerminalModelResolution {
  selection?: TerminalModelSelection;
  source: "env" | "terminal" | "shared";
  warning?: string;
}
export function terminalModelPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  return join(infiniteOsHome(env), "terminal-model.yml");
}
function readTerminalModel(
  env: NodeJS.ProcessEnv
): Omit<TerminalModelResolution, "source"> {
  const path = terminalModelPath(env);
  if (!existsSync(path)) return {};
  const values = parseSimpleYaml(readFileSync(path, "utf8"));
  if (!modelOption(values.provider, values.model))
    return {
      warning: "Saved terminal model is unsupported; using the shared default."
    };
  const effort = supportedModelEffort(
    values.provider,
    values.model,
    values.effort
  );
  return {
    selection: {
      provider: values.provider as InfiniteOsModelProvider,
      model: values.model,
      ...(effort ? { effort } : {})
    },
    ...(values.effort && !effort
      ? { warning: "Saved effort is unsupported; using Default effort." }
      : {})
  };
}
export function readTerminalModelSelection(
  env: NodeJS.ProcessEnv = process.env
): TerminalModelSelection | undefined {
  return readTerminalModel(env).selection;
}
export function resolveTerminalModelSelection(
  env: NodeJS.ProcessEnv = process.env
): TerminalModelResolution {
  if (
    (env.GROWTH_OS_MODEL_PROVIDER === "codex" ||
      env.GROWTH_OS_MODEL_PROVIDER === "claude") &&
    env.GROWTH_OS_MODEL_NAME
  ) {
    return {
      source: "env",
      selection: {
        provider: env.GROWTH_OS_MODEL_PROVIDER,
        model: env.GROWTH_OS_MODEL_NAME
      }
    };
  }
  const terminal = readTerminalModel(env);
  if (terminal.selection) return { source: "terminal", ...terminal };
  const shared = readInfiniteOsModelSelection(env);
  return {
    source: "shared",
    ...(shared.provider && shared.model
      ? { selection: { provider: shared.provider, model: shared.model } }
      : {}),
    ...(terminal.warning ? { warning: terminal.warning } : {})
  };
}
export function writeTerminalModelSelection(
  selection: TerminalModelSelection,
  env: NodeJS.ProcessEnv = process.env,
  catalog: readonly ModelOption[] = MODEL_CATALOG
): void {
  const option = catalog.find(
    (m) => m.provider === selection.provider && m.id === selection.model
  );
  if (
    !option ||
    (selection.effort !== undefined &&
      !option.efforts.includes(selection.effort))
  ) {
    throw new Error("Unsupported terminal model or effort.");
  }
  mkdirSync(infiniteOsHome(env), { recursive: true, mode: 0o700 });
  const path = terminalModelPath(env);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      `provider: ${selection.provider}\nmodel: ${selection.model}\n${selection.effort ? `effort: ${selection.effort}\n` : ""}`,
      { mode: 0o600, flag: "wx" }
    );
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** File-only read for a Desktop-negotiated catalog. No env/shared fallback. */
export function readTerminalModelFile(
  env: NodeJS.ProcessEnv = process.env
): TerminalModelSelection | undefined {
  const path = terminalModelPath(env);
  if (!existsSync(path)) return undefined;
  const value = parseSimpleYaml(readFileSync(path, "utf8"));
  if (
    (value.provider !== "codex" && value.provider !== "claude") ||
    !/^[a-z][a-z0-9.-]{0,99}$/.test(value.model ?? "") ||
    (value.effort !== undefined &&
      !["low", "medium", "high", "xhigh", "max"].includes(value.effort))
  )
    throw new Error(
      "Invalid saved terminal model. Use /model default to clear it."
    );
  return {
    provider: value.provider,
    model: value.model,
    ...(value.effort ? { effort: value.effort as ModelEffort } : {})
  };
}
export function clearTerminalModelSelection(
  env: NodeJS.ProcessEnv = process.env
): void {
  rmSync(terminalModelPath(env), { force: true });
}
