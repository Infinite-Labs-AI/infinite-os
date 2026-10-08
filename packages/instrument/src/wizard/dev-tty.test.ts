// The wizard's own /dev/tty prompt, driven through a REAL pseudo-terminal (python3's pty module runs a
// node child with a controlling terminal). It exercises the BUILT module, like cli-entrypoint.test.ts:
// build the package before running it.
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { openDevTtyPrompter } from "./dev-tty.js"

const here = dirname(fileURLToPath(import.meta.url))
const builtDevTty = join(here, "../../dist/src/wizard/dev-tty.js")
const hasPython = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0

// Runs `node <script>` on a fresh pty; answers `reply` once `when` appears; returns the pty output + exit.
const DRIVER = `
import os, pty, select, sys, time
node, script, when, reply = sys.argv[1], sys.argv[2], sys.argv[3].encode(), sys.argv[4].encode()
pid, fd = pty.fork()
if pid == 0:
    os.execv(node, [node, script])
out, sent, deadline = b"", False, time.time() + 20
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        out += data
        if when and when in out and not sent:
            os.write(fd, reply)
            sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode(errors="replace"))
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 99)
`

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function onPty(body: string, when = "", reply = ""): { status: number | null; output: string } {
  if (!existsSync(builtDevTty)) throw new Error(`Build the package before running this test — missing ${builtDevTty}. Run: pnpm -C packages/instrument run build`)
  const dir = mkdtempSync(join(tmpdir(), "wizard-devtty-"))
  dirs.push(dir)
  const script = join(dir, "child.mjs")
  writeFileSync(script, `import { openDevTtyPrompter } from ${JSON.stringify(pathToFileURL(builtDevTty).href)}\n${body}\n`)
  const driver = join(dir, "driver.py")
  writeFileSync(driver, DRIVER)
  const result = spawnSync("python3", [driver, process.execPath, script, when, reply], { encoding: "utf8", timeout: 30_000 })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe("the wizard's own /dev/tty prompt (O1-10)", () => {
  it("no controlling terminal (or not a tty) → null, so the user-only asks park", () => {
    expect(openDevTtyPrompter("/nonexistent/tty")).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), "wizard-devtty-"))
    dirs.push(dir)
    writeFileSync(join(dir, "plain"), "")
    expect(openDevTtyPrompter(join(dir, "plain"))).toBeNull()
  })

  it.skipIf(!hasPython)("an unanswered prompt gives up after its timeout (never a default yes)", () => {
    const { status, output } = onPty(`
const prompter = openDevTtyPrompter("/dev/tty", { timeoutMs: 200 })
if (!prompter) { console.log("NO_TTY"); process.exit(5) }
const answer = await prompter.ask("confirm", { question: "Remove it?", defaultYes: true })
console.log("ANSWER=" + JSON.stringify(answer))
prompter.close()
`)
    expect(output).toContain('ANSWER="__timeout__"')
    expect(status).toBe(0)
  })
})
