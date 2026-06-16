import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createPlaywrightBrowserFactory } from "./playwright.js";

interface BrowserHandoffLaunchArgs {
  provider: string;
  url: string;
  contextRef?: string;
  timeoutMs?: number;
  sessionKey?: string;
}

export async function runBrowserHandoffLauncher(args: BrowserHandoffLaunchArgs): Promise<void> {
  const browserFactory = createPlaywrightBrowserFactory();
  const browser = await browserFactory.create({
    provider: args.provider,
    purpose: "provider_auth",
    contextRef: args.contextRef,
    sessionKey: args.sessionKey
  });

  try {
    await browser.goto(args.url);
    await delay(args.timeoutMs ?? 15 * 60 * 1000);
  } finally {
    await browser.destroy().catch(() => undefined);
  }
}

function parseArgs(argv: string[]): BrowserHandoffLaunchArgs {
  const provider = argv[0]?.trim();
  const url = argv[1]?.trim();
  if (!provider || !url) {
    throw new Error("usage: browser-handoff-launcher <provider> <url> [contextRef] [timeoutMs] [sessionKey]");
  }

  const contextRef = argv[2]?.trim() || undefined;
  const timeoutValue = argv[3]?.trim();
  const timeoutMs = timeoutValue && /^\d+$/u.test(timeoutValue) ? Number(timeoutValue) : undefined;
  const sessionKey = argv[4]?.trim() || undefined;

  return {
    provider,
    url,
    contextRef,
    timeoutMs,
    sessionKey
  };
}

async function main(): Promise<void> {
  await runBrowserHandoffLauncher(parseArgs(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
