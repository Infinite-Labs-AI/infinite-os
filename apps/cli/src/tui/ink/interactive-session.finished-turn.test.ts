// A finished turn that FITS the live region stays live until the next line, so
// its views keep their keys (the other half of "finished turns never page":
// transcript-static.test.ts covers the turn that does not fit). Fake TTY, real
// Ink; colour is pinned on so the selected row's background can be read.
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ToolViewFrameV1 } from "@infinite-os/types";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const pinnedEnv = vi.hoisted(() => {
  // chalk reads FORCE_COLOR when it loads: pin truecolor before any import.
  const pins: Record<string, string | undefined> = {
    FORCE_COLOR: "3", COLORTERM: "truecolor", TERM: "xterm-256color", INFINITE_COLOR: "truecolor",
    NO_COLOR: undefined, INFINITE_THEME: undefined, INFINITE_PLAIN_OUTPUT: undefined
  };
  const saved = Object.fromEntries(Object.keys(pins).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(pins)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return saved;
});

import { decodeAnswerView } from "../../desktop/answer-view-decode.js";
import { getTurnState, resetTurnState } from "../app/turn-store.js";
import { runInkInteractiveSession } from "./interactive-session.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (value: string) => value.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");
/** A 24-bit background on the row (the selection's `sel`; table rows carry no other background). */
const BACKGROUND = new RegExp(`${ESC}\\[48;2;\\d+;\\d+;\\d+m`, "u");

function numbersFrame(): ToolViewFrameV1 {
  const raw = readFileSync(fileURLToPath(new URL("../views/__fixtures__/numbers-ads.json", import.meta.url)), "utf8");
  const view = decodeAnswerView(JSON.parse(raw));
  if (!view) throw new Error("numbers-ads fixture does not decode");
  return { type: "tool.view", stage: "tool", message: view.title, viewId: "n1", name: view.tool, view };
}

afterEach(() => {
  resetTurnState();
});

afterAll(() => {
  for (const [key, value] of Object.entries(pinnedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("a finished turn that fits stays live (fake TTY; skipped on CI like the other PTY tests)", () => {
  it.skipIf(process.env.CI === "true")("a short numbers view is not sent to scrollback, and j / k still move its row", { timeout: 30_000 }, async () => {
    resetTurnState();
    const input = ttyInput();
    const output = ttyOutput(100, 40);
    const lines: string[] = [];
    const session = runInkInteractiveSession({
      errorOutput: ttyOutput(100, 40),
      input,
      async onSubmitLine(line, _onProgress, _signal, onView) {
        lines.push(line);
        if (line === "/exit") return { exit: true, messages: [] };
        onView?.(numbersFrame());
        return { messages: [{ role: "assistant", text: "Three ad sets spent this week." }] };
      },
      output,
      title: "Infinite TUI"
    });

    await waitFor(() => output.text().includes("Ask Infinite"), 4_000, output.text);
    await sendKeys(input, "how are the ads?\r");
    await waitFor(() => stripAnsi(output.text()).includes("j k  row"), 4_000, output.text);
    // The turn is live: drawn under the top bar, nothing printed above it, no pager hint.
    const frame = lastFrame(output.text());
    const rows = stripAnsi(frame).split("\n");
    expect(rows.findIndex((row) => row.includes("❯ how are the ads?"))).toBeGreaterThan(rows.findIndex((row) => row.includes("∞ Infinite")));
    expect(stripAnsi(output.text())).not.toMatch(/more lines|lines above/u);
    expect(getTurnState().views).toHaveLength(1);
    // The bar offers the view's keys and, with details on screen, `tab switch side`.
    expect(rows.filter((row) => row.trim()).at(-1)).toContain("j k  row    tab  switch side    /  commands");
    // Nothing is selected until the user moves.
    expect(selectedRows(frame)).toEqual([]);

    // The view opens on its first row: j moves to the second, j again to the third, k back up. None of them types.
    let mark = output.text().length;
    await sendKeys(input, "j");
    await waitFor(() => selectedRows(lastFrame(output.text().slice(mark))).length === 1, 4_000, output.text);
    const first = selectedRows(lastFrame(output.text().slice(mark)));
    mark = output.text().length;
    await sendKeys(input, "j");
    await waitFor(() => {
      const now = selectedRows(lastFrame(output.text().slice(mark)));
      return now.length === 1 && now[0] !== first[0];
    }, 4_000, output.text);
    const second = selectedRows(lastFrame(output.text().slice(mark)));
    expect([first[0], second[0]]).toEqual(["Ad set 02", "Ad set 03"]);
    mark = output.text().length;
    await sendKeys(input, "k");
    await waitFor(() => selectedRows(lastFrame(output.text().slice(mark)))[0] === "Ad set 02", 4_000, output.text);
    expect(stripAnsi(lastFrame(output.text()))).toContain("❯ Ask Infinite…");
    expect(lines).toEqual(["how are the ads?"]);

    // Leaving (like the next line) is what commits it to scrollback.
    await sendKeys(input, "\t/exit\r");
    await session;
    expect(getTurnState().views).toEqual([]);
    expect(lines).toEqual(["how are the ads?"]);
    expect(stripAnsi(output.text())).not.toMatch(/more lines|lines above/u);
  });
});

/** The last frame Ink wrote: what follows its last erase of the previous frame. */
function lastFrame(raw: string): string {
  const erase = raw.lastIndexOf(`${ESC}[2K`);
  return erase < 0 ? raw : raw.slice(erase);
}

/** The table rows drawn on the selection background, by their first cell. */
function selectedRows(frame: string): string[] {
  return frame.split("\n")
    .filter((row) => /│ Ad set \d+ /u.test(stripAnsi(row)) && BACKGROUND.test(row))
    .map((row) => /Ad set \d+/u.exec(stripAnsi(row))![0]);
}

function ttyInput() {
  const stream = new PassThrough() as PassThrough & NodeJS.ReadStream & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (enabled: boolean) => void;
    unref: () => void;
  };
  stream.isTTY = true;
  stream.ref = vi.fn();
  stream.setRawMode = vi.fn();
  stream.unref = vi.fn();
  return stream;
}

function ttyOutput(columns: number, rows: number) {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & NodeJS.WriteStream & {
    columns: number;
    isTTY: boolean;
    rows: number;
    text: () => string;
  };
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  stream.on("data", (chunk) => chunks.push(String(chunk)));
  stream.text = () => chunks.join("");
  return stream;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000, debug?: () => string) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate(), debug?.()).toBe(true);
}

async function sendKeys(input: NodeJS.WritableStream, keys: string) {
  for (const k of keys) {
    input.write(k);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
