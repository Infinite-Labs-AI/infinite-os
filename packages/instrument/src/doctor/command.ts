// `infinite-tag doctor [--json] [--url <https>] [--expect-… <id>] [--probe-server-lane]`: the static +
// live (T1) checks with no browser, for CI and for a quick look (exit codes in §3d.5:
// 0 clean · 1 a problem · 3 no problem but something undetermined · 2 usage).
//
// FOUNDATION STUB (lane F0). Lane O9 fills it. Until then it checks nothing and exits 2 (usage), so a
// CI job wired to `doctor` fails loudly instead of reading a silent 0 as "clean".
import { DOCTOR_EXIT_CODES } from "../wizard/contracts/codes.js"

export async function runDoctorCommand(argv: readonly string[]): Promise<number> {
  void argv
  console.error("infinite-tag doctor is not built yet.")
  return DOCTOR_EXIT_CODES.usage
}
