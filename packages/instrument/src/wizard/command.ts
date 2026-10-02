// `npx infinite-tag` (and `npx infinite-tag wizard …`, and any flag-first argv such as
// `npx infinite-tag --json`): the setup wizard's entry point.
//
// FOUNDATION STUB (lane F0). The CLI already routes here (see `routeCliArgv` in ../cli.ts); lane O1
// replaces the bodies below with the real wizard (flags, TTY/JSON routing, nested mode, the engine).
// Until then both entry points say so plainly and exit 2 (`INF_WIZ_NOT_BUILT`, a usage/environment
// exit per the §3d.5 table), so a published build can never pretend the wizard ran.
import { exitCodeFor } from "./contracts/codes.js"

export const WIZARD_NOT_BUILT_MESSAGE =
  "The infinite-tag setup wizard is not built yet. Use `npx infinite-tag harness` or `npx infinite-tag install` for now."

/** `npx infinite-tag [wizard] [flags…]`. `argv` arrives without a leading "wizard". */
export async function runWizardCommand(argv: readonly string[]): Promise<number> {
  void argv
  console.error(WIZARD_NOT_BUILT_MESSAGE)
  return exitCodeFor("INF_WIZ_NOT_BUILT")
}

/** `npx infinite-tag uninstall --pr [flags…]`: the PR-based uninstall flow (lane O1 fills it). */
export async function runWizardUninstall(argv: readonly string[]): Promise<number> {
  void argv
  console.error(WIZARD_NOT_BUILT_MESSAGE)
  return exitCodeFor("INF_WIZ_NOT_BUILT")
}
