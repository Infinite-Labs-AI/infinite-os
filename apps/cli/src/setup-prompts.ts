import { createInterface } from "node:readline/promises";
import * as readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";

interface PromptIo {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

export type SetupProviderId = "ga4" | "posthog" | "x";
export type ProviderInstallState = "installed" | "not_installed" | "unknown";

export interface ProviderInventoryRow {
  provider: SetupProviderId;
  hasAccount: boolean;
  installState: ProviderInstallState;
  selected: boolean;
  recommended: boolean;
}

const DEFAULT_IO: PromptIo = {
  input,
  output
};

export function shouldUseInteractivePrompts(io: PromptIo = DEFAULT_IO): boolean {
  return process.env.GROWTH_OS_CLI_FANCY_PROMPTS !== "0" && io.input.isTTY && io.output.isTTY;
}

export async function promptChoice(
  question: string,
  choices: string[],
  defaultIndex = 0,
  options: {
    description?: string;
    io?: PromptIo;
  } = {}
): Promise<number> {
  const io = options.io ?? DEFAULT_IO;
  if (shouldUseInteractivePrompts(io)) {
    return promptChoiceInteractive(question, choices, defaultIndex, options.description, io);
  }
  return promptChoiceFallback(question, choices, defaultIndex, options.description, io);
}

export async function promptChecklist(
  title: string,
  items: string[],
  preSelected: number[] = [],
  options: {
    io?: PromptIo;
  } = {}
): Promise<number[]> {
  const io = options.io ?? DEFAULT_IO;
  if (shouldUseInteractivePrompts(io)) {
    return promptChecklistInteractive(title, items, preSelected, io);
  }
  return promptChecklistFallback(title, items, preSelected, io);
}

export async function promptYesNo(
  question: string,
  defaultValue = true,
  options: {
    io?: PromptIo;
  } = {}
): Promise<boolean> {
  const io = options.io ?? DEFAULT_IO;
  const labels = defaultValue ? ["yes", "no"] : ["no", "yes"];
  const selected = await promptChoice(question, labels, 0, {
    description: defaultValue ? "Press Enter to accept the recommended Yes." : "Press Enter to keep No.",
    io
  });
  return labels[selected] === "yes";
}

export async function promptText(
  question: string,
  defaultValue = "",
  options: {
    io?: PromptIo;
  } = {}
): Promise<string> {
  const io = options.io ?? DEFAULT_IO;
  return promptLine(question, defaultValue, io);
}

export async function promptUrl(
  question: string,
  defaultValue = "",
  options: {
    io?: PromptIo;
  } = {}
): Promise<string> {
  const io = options.io ?? DEFAULT_IO;

  for (;;) {
    const value = await promptLine(question, defaultValue, io, { preview: defaultValue || "https://" });
    if (!value) {
      return "";
    }
    if (isValidUrlInput(value)) {
      return value;
    }
    io.output.write("Enter a full URL or host name, for example https://acme.test.\n");
  }
}

export async function promptProviderMatrix(
  rows: ProviderInventoryRow[],
  options: {
    io?: PromptIo;
  } = {}
): Promise<ProviderInventoryRow[]> {
  const io = options.io ?? DEFAULT_IO;
  const selected = await promptChecklist(
    "Which of these should we help you set up first?",
    rows.map((row) => providerSelectionLabel(row)),
    rows.flatMap((row, index) => row.selected ? [index] : []),
    { io }
  );

  const selectedSet = new Set(selected);
  const updatedRows = rows.map((row, index) => ({
    ...row,
    selected: selectedSet.has(index)
  }));

  const finalizedRows: ProviderInventoryRow[] = [];
  for (const row of updatedRows) {
    if (!row.selected) {
      finalizedRows.push(row);
      continue;
    }

    const label = providerLabel(row.provider);
    const hasAccount = await promptYesNo(`Are you already using ${label}?`, row.hasAccount, { io });
    finalizedRows.push({
      ...row,
      hasAccount,
      installState: row.installState === "installed" && !hasAccount ? "unknown" : row.installState
    });
  }

  return finalizedRows;
}

async function promptChoiceFallback(
  question: string,
  choices: string[],
  defaultIndex: number,
  description: string | undefined,
  io: PromptIo
): Promise<number> {
  io.output.write(`${question}\n`);
  if (description) {
    io.output.write(`${description}\n`);
  }
  choices.forEach((choice, index) => {
    io.output.write(`  ${index === defaultIndex ? "*" : " "} ${index + 1}. ${choice}\n`);
  });
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    for (;;) {
      const value = (await rl.question(`Select [1-${choices.length}] (${defaultIndex + 1}): `)).trim();
      if (!value) {
        return defaultIndex;
      }
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= choices.length) {
        return parsed - 1;
      }
      io.output.write(`Choose a number between 1 and ${choices.length}.\n`);
    }
  } finally {
    rl.close();
  }
}

async function promptChecklistFallback(
  title: string,
  items: string[],
  preSelected: number[],
  io: PromptIo
): Promise<number[]> {
  io.output.write(`${title}\n`);
  items.forEach((item, index) => {
    io.output.write(`  ${preSelected.includes(index) ? "[x]" : "[ ]"} ${index + 1}. ${item}\n`);
  });
  io.output.write("Enter comma-separated numbers, or press Enter to keep the current selection.\n");
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    const value = (await rl.question("Select: ")).trim();
    if (!value) {
      return [...preSelected];
    }
    const selected = new Set<number>();
    for (const part of value.split(",")) {
      const parsed = Number(part.trim());
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= items.length) {
        selected.add(parsed - 1);
      }
    }
    return [...selected].sort((left, right) => left - right);
  } finally {
    rl.close();
  }
}

async function promptLine(
  question: string,
  defaultValue: string,
  io: PromptIo,
  options: {
    preview?: string;
  } = {}
): Promise<string> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    const previewValue = options.preview && !defaultValue ? options.preview : undefined;
    const suffix = defaultValue ? ` [${defaultValue}]` : previewValue ? ` [${previewValue}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

async function promptChoiceInteractive(
  question: string,
  choices: string[],
  defaultIndex: number,
  description: string | undefined,
  io: PromptIo
): Promise<number> {
  return withRawPrompt(io, async () => {
    let current = defaultIndex;
    const render = () => {
      io.output.write("\x1b[2J\x1b[H");
      io.output.write(`${question}\n`);
      if (description) {
        io.output.write(`${description}\n`);
      }
      io.output.write("  ↑↓ navigate  ENTER select  ESC keep current\n\n");
      choices.forEach((choice, index) => {
        io.output.write(`${index === current ? "➜" : " "} ${choice}\n`);
      });
    };
    render();
    for (;;) {
      const key = await readKeypress(io.input);
      if (key.name === "up") {
        current = current === 0 ? choices.length - 1 : current - 1;
        render();
        continue;
      }
      if (key.name === "down") {
        current = current === choices.length - 1 ? 0 : current + 1;
        render();
        continue;
      }
      if (key.name === "return") {
        io.output.write("\n");
        return current;
      }
      if (key.name === "escape") {
        io.output.write("\n");
        return defaultIndex;
      }
      if (key.ctrl && key.name === "c") {
        throw new Error("setup_cancelled");
      }
    }
  });
}

async function promptChecklistInteractive(
  title: string,
  items: string[],
  preSelected: number[],
  io: PromptIo
): Promise<number[]> {
  return withRawPrompt(io, async () => {
    let current = 0;
    const selected = new Set(preSelected);
    const render = () => {
      io.output.write("\x1b[2J\x1b[H");
      io.output.write(`${title}\n`);
      io.output.write("  ↑↓ navigate  SPACE toggle  ENTER confirm  ESC keep current\n\n");
      items.forEach((item, index) => {
        const prefix = index === current ? "➜" : " ";
        const marker = selected.has(index) ? "[x]" : "[ ]";
        io.output.write(`${prefix} ${marker} ${item}\n`);
      });
    };
    render();
    for (;;) {
      const key = await readKeypress(io.input);
      if (key.name === "up") {
        current = current === 0 ? items.length - 1 : current - 1;
        render();
        continue;
      }
      if (key.name === "down") {
        current = current === items.length - 1 ? 0 : current + 1;
        render();
        continue;
      }
      if (key.name === "space") {
        if (selected.has(current)) {
          selected.delete(current);
        } else {
          selected.add(current);
        }
        render();
        continue;
      }
      if (key.name === "return") {
        io.output.write("\n");
        return [...selected].sort((left, right) => left - right);
      }
      if (key.name === "escape") {
        io.output.write("\n");
        return [...preSelected].sort((left, right) => left - right);
      }
      if (key.ctrl && key.name === "c") {
        throw new Error("setup_cancelled");
      }
    }
  });
}

async function withRawPrompt<T>(io: PromptIo, fn: () => Promise<T>): Promise<T> {
  readline.emitKeypressEvents(io.input);
  io.input.setRawMode?.(true);
  io.input.resume();
  try {
    return await fn();
  } finally {
    io.input.setRawMode?.(false);
    io.input.pause();
  }
}

function readKeypress(stream: NodeJS.ReadStream): Promise<readline.Key> {
  return new Promise((resolve) => {
    const onKeypress = (_value: string, key: readline.Key) => {
      stream.off("keypress", onKeypress);
      resolve(key);
    };
    stream.on("keypress", onKeypress);
  });
}

function isValidUrlInput(value: string): boolean {
  try {
    const candidate = value.includes("://") ? value : `https://${value}`;
    new URL(candidate);
    return true;
  } catch {
    return false;
  }
}

function providerLabel(provider: SetupProviderId): string {
  if (provider === "ga4") {
    return "GA4";
  }
  if (provider === "posthog") {
    return "PostHog";
  }
  return "X";
}

function providerSelectionLabel(row: ProviderInventoryRow): string {
  if (row.provider === "x") {
    return "X (optional / advanced)";
  }
  return `${providerLabel(row.provider)} (recommended)`;
}
