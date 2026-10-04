/**
 * `infinite contacts …` — entry + production wiring for the contacts-sync flow.
 *
 * Bridge discovery and auth are the EXISTING client's (`resolveLiveBridge`
 * reads the owner-only descriptor at `<infiniteOsHome>/desktop-cmdl/bridge.json`
 * and carries its bearer token) — nothing here reinvents discovery. The
 * `contacts.import.v1` capability is gated with `includes()` INSIDE this
 * command only; it is deliberately NOT part of the client's
 * REQUIRED_CAPABILITIES handshake, which would brick `infinite app` against
 * older desktops.
 */
import { stdin, stdout, stderr } from "node:process";
import { createInterface } from "node:readline/promises";

import {
  resolveLiveBridge,
  type DesktopBridgeDescriptor,
  type DesktopStatus
} from "../desktop-app-client.js";
import { postContactsImport, type ContactsImportRequest } from "./import-transport.js";
import { runContactsSync, type ContactsSyncIo } from "./sync-command.js";

const USAGE = "Usage: infinite contacts sync";

interface ContactsCommandEnv {
  GROWTH_OS_HOME?: string;
  GROWTH_OS_CLI_NONINTERACTIVE?: string;
  HOME?: string;
}

function defaultIo(env: ContactsCommandEnv): ContactsSyncIo {
  return {
    interactive:
      env.GROWTH_OS_CLI_NONINTERACTIVE !== "1" &&
      stdin.isTTY === true &&
      stdout.isTTY === true,
    writeOut: (text: string) => {
      stdout.write(`${text}\n`);
    },
    writeErr: (text: string) => {
      stderr.write(`${text}\n`);
    },
    prompt: async (question: string) => {
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        return await prompt.question(question);
      } finally {
        prompt.close();
      }
    }
  };
}

export async function runContactsCommand(
  args: string[],
  env: ContactsCommandEnv
): Promise<void> {
  const [subcommand] = args;
  if (subcommand !== "sync" || args.length > 1) {
    stdout.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  // Per-run live-bridge resolution — never a client captured earlier: a
  // desktop restart changes both the port and the bearer token.
  let live: { descriptor: DesktopBridgeDescriptor; client: { status(): Promise<DesktopStatus> } } | null;
  live = resolveLiveBridge(env);

  const code = await runContactsSync({
    cwd: process.cwd(),
    io: defaultIo(env),
    readDescriptor: () => live?.descriptor ?? null,
    desktopStatus: () => {
      if (!live) throw new Error("Infinite Desktop is not running.");
      return live.client.status();
    },
    postImport: (request: ContactsImportRequest) => {
      if (!live) throw new Error("Infinite Desktop is not running.");
      return postContactsImport({
        bridgeUrl: live.descriptor.url,
        token: live.descriptor.token,
        request
      });
    }
  });
  if (code !== 0) process.exitCode = code;
}
