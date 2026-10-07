import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { WIZARD_EXIT } from "./contracts/codes.js"
import { nodeWizardFs } from "./fs.js"
import { acquireRunLock, lockFilePath } from "./lock.js"
import { RunStateFile, createRunState, firstOpenStep, loadRunState, setStateAside, stateFilePath } from "./run-state.js"
import { installInterruptHandlers, runInterruptSequence, type SignalSource } from "./signals.js"

const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wizard-state-"))
  roots.push(root)
  return root
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

const NOW = new Date("2026-10-02T09:00:00Z")

describe("run state (.infinite/wizard/state.json)", () => {
  it("loads a legacy v1 state without inventing measured commits", async () => {
    const root = tempRoot()
    const state = createRunState({ tagVersion: "0.12.0", root, appRoot: ".", now: NOW })
    delete state.wizardCommits
    delete state.commitHistory
    mkdirSync(join(root, ".infinite/wizard"), { recursive: true })
    writeFileSync(stateFilePath(root), JSON.stringify(state))
    const loaded = await loadRunState(nodeWizardFs, root)
    expect(loaded.kind).toBe("ok")
    if (loaded.kind === "ok") {
      expect(loaded.state.wizardCommits).toBeUndefined()
      expect(loaded.state.commitHistory).toBeUndefined()
    }
  })
  it("saves atomically at 0600 (no temp file left) and loads back to the same state", async () => {
    const root = tempRoot()
    const file = new RunStateFile(nodeWizardFs, root, createRunState({ tagVersion: "0.12.0", root, appRoot: ".", now: NOW, displayId: "r-7f3c" }))
    file.update((state) => {
      state.runId = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
      state.steps.link = { outcome: "ok", inputHash: "h1", at: NOW.toISOString() }
    })
    await file.save()
    expect(statSync(stateFilePath(root)).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(root, ".infinite/wizard"))).toEqual(["state.json"])
    const loaded = await loadRunState(nodeWizardFs, root)
    expect(loaded).toMatchObject({ kind: "ok", state: { displayId: "r-7f3c", runId: "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80" } })
    if (loaded.kind === "ok") expect(firstOpenStep(loaded.state)).toBe("agent")
  })

  it("a corrupt file is reported, never silently reset; setting it aside keeps it", async () => {
    const root = tempRoot()
    mkdirSync(join(root, ".infinite/wizard"), { recursive: true })
    writeFileSync(stateFilePath(root), "{ not json")
    const loaded = await loadRunState(nodeWizardFs, root)
    expect(loaded.kind).toBe("corrupt")
    expect(readFileSync(stateFilePath(root), "utf8")).toBe("{ not json")

    writeFileSync(stateFilePath(root), JSON.stringify({ schema: "infinite-tag.wizard-state.v1", runId: null, extra: 1 }))
    const wrongShape = await loadRunState(nodeWizardFs, root)
    expect(wrongShape.kind).toBe("corrupt")
    if (wrongShape.kind === "corrupt") expect(wrongShape.problems.join(" ")).toMatch(/unknown key "extra"|missing required key/)

    const aside = await setStateAside(root, "corrupt-1")
    expect(aside).toMatch(/state\.json\.corrupt-1$/)
    expect(readFileSync(aside!, "utf8")).toContain("extra")
    expect(await loadRunState(nodeWizardFs, root)).toEqual({ kind: "none" })
  })

  it("refuses an update that would break the state schema (negative)", () => {
    const root = tempRoot()
    const file = new RunStateFile(nodeWizardFs, root, createRunState({ tagVersion: "0.12.0", root, appRoot: ".", now: NOW }))
    expect(() =>
      file.update((state) => {
        ;(state as unknown as Record<string, unknown>).surprise = true
      })
    ).toThrow(/breaks the state schema/)
    expect(file.get()).not.toHaveProperty("surprise")
  })
})

describe("run state saves after a failed write (O1-17)", () => {
  it("one failed write never poisons the saves after it", async () => {
    const root = tempRoot()
    let failNext = true
    const written: string[] = []
    const fs = {
      ...nodeWizardFs,
      async writeTextAtomic(path: string, text: string) {
        if (failNext) {
          failNext = false
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })
        }
        written.push(text)
      }
    }
    const file = new RunStateFile(fs, root, createRunState({ tagVersion: "0.12.0", root, appRoot: ".", now: NOW, displayId: "r-7f3c" }))
    await expect(file.save()).rejects.toThrow("ENOSPC")
    file.update((state) => {
      state.runId = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
    })
    await expect(file.save()).resolves.toBeUndefined()
    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0]!).runId).toBe("7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80")
  })
})

describe("run lock (.infinite/wizard/run.lock)", () => {
  it("a second concurrent run is refused while the first holds the lock (INF_WIZ_LOCKED)", async () => {
    const root = tempRoot()
    const first = await acquireRunLock(root, { pid: process.pid })
    expect(first.ok).toBe(true)
    const second = await acquireRunLock(root, { pid: process.pid + 1 })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.holder?.pid).toBe(process.pid)
    if (first.ok) await first.handle.release()
    const third = await acquireRunLock(root)
    expect(third.ok).toBe(true)
    if (third.ok) await third.handle.release()
  })

  it("a lock whose pid is dead on this host is stale and taken over; one from another host never is", async () => {
    const root = tempRoot()
    mkdirSync(join(root, ".infinite/wizard"), { recursive: true })
    writeFileSync(lockFilePath(root), JSON.stringify({ pid: 999_999, startedAt: "2026-10-01T00:00:00Z", hostname: "this-host" }))
    const taken = await acquireRunLock(root, { hostname: "this-host", isPidAlive: () => false })
    expect(taken.ok).toBe(true)
    if (taken.ok) {
      expect(taken.tookOverStale?.pid).toBe(999_999)
      await taken.handle.release()
    }
    writeFileSync(lockFilePath(root), JSON.stringify({ pid: 999_999, startedAt: "2026-10-01T00:00:00Z", hostname: "other-host" }))
    const refused = await acquireRunLock(root, { hostname: "this-host", isPidAlive: () => false })
    expect(refused.ok).toBe(false)
  })

  it("a racer that judged the lock stale never deletes the fresh lock another process just took: exactly one holder (O1-13)", async () => {
    const root = tempRoot()
    const STALE_PID = 4_000_001
    mkdirSync(join(root, ".infinite/wizard"), { recursive: true })
    writeFileSync(lockFilePath(root), `${JSON.stringify({ pid: STALE_PID, startedAt: "2026-10-01T00:00:00.000Z", hostname: "mac" })}\n`)
    const isPidAlive = (pid: number) => pid !== STALE_PID
    let releaseA!: () => void
    const aPaused = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    let aReachedTakeover!: () => void
    const aAtTakeover = new Promise<void>((resolve) => {
      aReachedTakeover = resolve
    })
    // A reads the stale lock, then pauses right before taking it over…
    const a = acquireRunLock(root, {
      pid: 4_000_002,
      hostname: "mac",
      isPidAlive,
      beforeTakeover: async () => {
        aReachedTakeover()
        await aPaused
      }
    })
    await aAtTakeover
    // …while B takes the stale lock over and holds it.
    const b = await acquireRunLock(root, { pid: 4_000_003, hostname: "mac", isPidAlive })
    expect(b.ok).toBe(true)
    releaseA()
    const resultA = await a
    expect(resultA.ok).toBe(false)
    if (!resultA.ok) expect(resultA.holder?.pid).toBe(4_000_003)
    expect(JSON.parse(readFileSync(lockFilePath(root), "utf8")).pid).toBe(4_000_003)
    expect(readdirSync(join(root, ".infinite/wizard"))).toEqual(["run.lock"])
    if (b.ok) await b.handle.release()
  })

  it("release removes only this run's lock", async () => {
    const root = tempRoot()
    const mine = await acquireRunLock(root, { pid: 111, isPidAlive: () => true })
    if (!mine.ok) throw new Error("expected the lock")
    writeFileSync(lockFilePath(root), JSON.stringify({ pid: 222, startedAt: "2026-10-02T00:00:00Z", hostname: "h" }))
    await mine.handle.release()
    expect(JSON.parse(readFileSync(lockFilePath(root), "utf8")).pid).toBe(222)
  })
})

describe("SIGINT / SIGTERM", () => {
  it("abort → kill the agents → fence abort (snapshot restore) → release the lock → exit 130, in that order", async () => {
    const order: string[] = []
    await runInterruptSequence({
      abort: () => order.push("abort"),
      killAgents: async () => {
        order.push("killAll")
      },
      fenceAbort: async () => {
        order.push("fenceAbort")
      },
      releaseLock: async () => {
        order.push("releaseLock")
      },
      exit: (code) => order.push(`exit ${code}`)
    })
    expect(order).toEqual(["abort", "killAll", "fenceAbort", "releaseLock", `exit ${WIZARD_EXIT.interrupted}`])
  })

  it("every later stage still runs when one throws (negative: a failing killAll never skips the restore or the lock)", async () => {
    const order: string[] = []
    const notices: string[] = []
    await runInterruptSequence({
      abort: () => order.push("abort"),
      killAgents: async () => {
        throw new Error("kill failed")
      },
      fenceAbort: async () => {
        order.push("fenceAbort")
      },
      releaseLock: async () => {
        order.push("releaseLock")
      },
      exit: (code) => order.push(`exit ${code}`),
      notice: (text) => notices.push(text)
    })
    expect(order).toEqual(["abort", "fenceAbort", "releaseLock", "exit 130"])
    expect(notices.join(" ")).toContain("kill failed")
  })

  it("the handler runs the sequence once; a second signal exits at once", async () => {
    const listeners = new Map<string, () => void>()
    const source: SignalSource = {
      on: (signal, listener) => listeners.set(signal, listener),
      off: (signal) => listeners.delete(signal)
    }
    const exits: number[] = []
    let kills = 0
    const remove = installInterruptHandlers(
      {
        abort() {},
        killAgents: async () => {
          kills += 1
          await new Promise((resolve) => setTimeout(resolve, 5))
        },
        releaseLock: async () => {},
        exit: (code) => exits.push(code)
      },
      source
    )
    listeners.get("SIGINT")!()
    listeners.get("SIGTERM")!()
    expect(exits).toEqual([130])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(kills).toBe(1)
    expect(exits).toEqual([130, 130])
    remove()
    expect(listeners.size).toBe(0)
  })
})
