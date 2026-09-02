// `infinite-tag harness …` — the standalone front door. Parses the flags, builds the terminal
// I/O, applies the one argument rule the runbook cannot (a non-interactive run must say what
// to do about conversions), runs the runbook with NoneBackend, and maps the outcome to an exit
// code: 0 clean, 1 a step failed, 2 arguments.
import { stderr, stdin, stdout } from "node:process"
import { createInterface } from "node:readline"

import { parseHarnessArgs, type HarnessArgs } from "./args.js"
import { runHarness, type HarnessDeps, type HarnessIo } from "./run.js"

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_ARGS = 2

export const CONVERSIONS_REQUIRED_MESSAGE =
  "Non-interactive run: pass --conversions <file> (an approved proposal from --plan) or --no-mark. --yes never approves conversion marking."

export function isInteractiveTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GROWTH_OS_CLI_NONINTERACTIVE !== "1" && stdin.isTTY === true && stdout.isTTY === true
}

export function terminalIo(interactive: boolean): HarnessIo {
  return {
    interactive,
    out: (line) => {
      stdout.write(`${line}\n`)
    },
    err: (line) => {
      stderr.write(`${line}\n`)
    },
    confirm: async (question, defaultYes) => {
      const rl = createInterface({ input: stdin, output: stderr })
      try {
        const answer = await new Promise<string>((resolveAnswer) => {
          rl.question(question, resolveAnswer)
        })
        const normalized = answer.trim().toLowerCase()
        if (normalized === "") return defaultYes
        return normalized === "y" || normalized === "yes"
      } finally {
        rl.close()
      }
    }
  }
}

/** Machine-parseable failure line on stderr (the wizard's `phw-error:` pattern). */
export function infErrorLine(code: string, message: string): string {
  return `inf-error: ${code} — ${message}`
}

/**
 * The argument rule from teardown §5.1: with neither --conversions nor --no-mark, a
 * non-interactive apply cannot guess — it exits with INF_ARGS_CONVERSIONS_REQUIRED.
 */
export function conversionsArgumentError(args: HarnessArgs, interactive: boolean): string | null {
  if (args.mode !== "apply" || args.brief) return null
  if (args.noMark || args.conversions !== undefined) return null
  return interactive ? null : CONVERSIONS_REQUIRED_MESSAGE
}

export interface RunHarnessCommandOptions {
  io?: HarnessIo
  deps?: HarnessDeps
  env?: NodeJS.ProcessEnv
}

export async function runHarnessCommand(argv: readonly string[], options: RunHarnessCommandOptions = {}): Promise<number> {
  const interactive = options.io?.interactive ?? isInteractiveTerminal(options.env)
  const io = options.io ?? terminalIo(interactive)
  let args: HarnessArgs
  try {
    args = parseHarnessArgs(argv)
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return EXIT_ARGS
  }
  const conversionsError = conversionsArgumentError(args, io.interactive)
  if (conversionsError) {
    io.err(infErrorLine("INF_ARGS_CONVERSIONS_REQUIRED", conversionsError))
    return EXIT_ARGS
  }
  try {
    const result = await runHarness(args, io, options.deps ?? {})
    if (result.report.failure) {
      io.err(infErrorLine(result.report.failure.code, result.report.failure.message))
    }
    return result.exitCode === 0 ? EXIT_OK : EXIT_FAILED
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return EXIT_FAILED
  }
}
