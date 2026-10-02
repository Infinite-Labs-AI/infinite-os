// The wizard UIs, for lane O1's `command.ts` (the routing: a TTY → the TTY UI; `--json` → the JSON UI; neither
// → "needs an interactive terminal", exit 2 — that decision is O1's).
import { createJsonUi, type JsonInput, type JsonOutput, type JsonUi } from "./json-ui.js"
import type { KeyboardInput } from "./keys.js"
import { createTtyUi, type TtyOutput, type TtyUi } from "./tty-ui.js"
import type { UntrustedSanitizer } from "./ui.js"

export type { UntrustedSanitizer, WizardStoreView, WizardUi } from "./ui.js"
export { JsonUi } from "./json-ui.js"
export { TtyUi } from "./tty-ui.js"

export interface WizardUiStreams {
  stdin: KeyboardInput & JsonInput
  stdout: TtyOutput & JsonOutput
  stderr: JsonOutput
}

/** The TTY UI or the JSON UI, both taking O3's `sanitizeUntrusted` (required; there is no second sanitiser). */
export function createWizardUi(
  mode: "tty",
  options: WizardUiStreams & { env: Readonly<Record<string, string | undefined>>; sanitize: UntrustedSanitizer; onInterrupt?: () => void }
): TtyUi
export function createWizardUi(mode: "json", options: WizardUiStreams & { sanitize: UntrustedSanitizer }): JsonUi
export function createWizardUi(
  mode: "tty" | "json",
  options: WizardUiStreams & { env?: Readonly<Record<string, string | undefined>>; sanitize: UntrustedSanitizer; onInterrupt?: () => void }
): TtyUi | JsonUi {
  if (mode === "json") return createJsonUi({ stdin: options.stdin, stdout: options.stdout, stderr: options.stderr, sanitize: options.sanitize })
  return createTtyUi({
    stdin: options.stdin,
    stdout: options.stdout,
    env: options.env ?? {},
    sanitize: options.sanitize,
    ...(options.onInterrupt ? { onInterrupt: options.onInterrupt } : {})
  })
}
