// The real `WizardFs` and `Clock` (§3d.8): atomic writes (temp + rename) with an explicit mode, so
// `.infinite/wizard/state.json` is never seen half-written and never wider than 0600.
import { randomBytes } from "node:crypto"
import { promises as fsp } from "node:fs"
import { dirname, join, basename } from "node:path"

import type { Clock, WizardFs } from "./contracts/deps.js"
import { WIZARD_STATE_FILE_MODE } from "./contracts/state.js"

export const WIZARD_DIR_MODE = 0o700

export const nodeWizardFs: WizardFs = {
  async readText(path) {
    try {
      return await fsp.readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  },
  async writeTextAtomic(path, text, mode = WIZARD_STATE_FILE_MODE) {
    await fsp.mkdir(dirname(path), { recursive: true, mode: WIZARD_DIR_MODE })
    const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
    try {
      await fsp.writeFile(temp, text, { mode, flag: "wx" })
      // writeFile's mode is masked by the umask; chmod makes it exact.
      await fsp.chmod(temp, mode)
      await fsp.rename(temp, path)
    } catch (error) {
      await fsp.rm(temp, { force: true })
      throw error
    }
  },
  async exists(path) {
    try {
      await fsp.access(path)
      return true
    } catch {
      return false
    }
  },
  async mkdirp(path, mode = WIZARD_DIR_MODE) {
    await fsp.mkdir(path, { recursive: true, mode })
  }
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal))
        return
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        reject(abortError(signal!))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
    })
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error("The wizard was interrupted.")
  error.name = "AbortError"
  return error
}
