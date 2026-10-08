import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { loadDescriptorExample } from "../../test/wizard/fake-bridge.js"
import { readBridgeDescriptor, type DiscoveryOptions } from "./descriptor.js"
import { BridgeDiscoveryError } from "./errors.js"

const homes: string[] = []

function makeHome(options: { descriptor?: Record<string, unknown> | null; dirMode?: number; fileMode?: number; state?: string } = {}): string {
  const home = mkdtempSync(join(tmpdir(), "infinite-tag-desc-"))
  homes.push(home)
  const dir = join(home, "desktop-tag")
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, options.dirMode ?? 0o700)
  if (options.descriptor !== null) {
    const descriptor = options.descriptor ?? { ...loadDescriptorExample(), pid: process.pid }
    const file = join(dir, "bridge.json")
    writeFileSync(file, JSON.stringify(descriptor))
    chmodSync(file, options.fileMode ?? 0o600)
  }
  if (options.state) {
    const stateFile = join(dir, "state.json")
    writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, state: options.state, updatedAt: "2026-10-02T09:00:00.000Z" }))
    chmodSync(stateFile, 0o600)
  }
  return home
}

function read(home: string, extra: Partial<DiscoveryOptions> = {}) {
  return readBridgeDescriptor({ env: { GROWTH_OS_HOME: home }, platform: "darwin", ...extra })
}

function refusal(fn: () => unknown): BridgeDiscoveryError {
  try {
    fn()
  } catch (error) {
    if (error instanceof BridgeDiscoveryError) return error
    throw error
  }
  throw new Error("expected a BridgeDiscoveryError")
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe("readBridgeDescriptor", () => {
  it("reads a safe descriptor and keeps the token in memory", () => {
    const descriptor = read(makeHome())
    expect(descriptor.service).toBe("infinite-desktop-tag")
    expect(descriptor.url).toBe("http://127.0.0.1:53917")
    expect(descriptor.runtime.variant).toBe("prod")
  })

  it("refuses a file that is not 0600", () => {
    const error = refusal(() => read(makeHome({ fileMode: 0o644 })))
    expect(error.reason).toBe("descriptor_unsafe")
    expect(error.wizardCode).toBe("INF_WIZ_NO_APP")
  })

  it("refuses a directory that is not 0700", () => {
    expect(refusal(() => read(makeHome({ dirMode: 0o755 }))).reason).toBe("descriptor_unsafe")
  })

  it("refuses a symlinked descriptor (O_NOFOLLOW)", () => {
    const real = makeHome()
    const home = makeHome({ descriptor: null })
    symlinkSync(join(real, "desktop-tag", "bridge.json"), join(home, "desktop-tag", "bridge.json"))
    expect(refusal(() => read(home)).reason).toBe("descriptor_unsafe")
  })

  it("refuses a file owned by another uid (injected uid)", () => {
    const home = makeHome()
    expect(refusal(() => read(home, { getuid: () => (process.getuid?.() ?? 0) + 4242 })).reason).toBe("descriptor_unsafe")
    // Negative: the same file with the right uid is accepted.
    expect(read(home).service).toBe("infinite-desktop-tag")
  })

  it("refuses a url that is not http://127.0.0.1:<port>", () => {
    for (const url of ["http://localhost:53917", "http://0.0.0.0:53917", "https://127.0.0.1:53917", "http://127.0.0.1:53917/x", "http://127.0.0.1"]) {
      expect(refusal(() => read(makeHome({ descriptor: { ...loadDescriptorExample(), pid: process.pid, url } }))).reason).toBe("descriptor_invalid")
    }
  })

  it("refuses a token without the bridge token's shape", () => {
    expect(refusal(() => read(makeHome({ descriptor: { ...loadDescriptorExample(), pid: process.pid, token: "short" } }))).reason).toBe("descriptor_invalid")
  })

  it("no descriptor on darwin → no_app; on another OS → not_mac", () => {
    const home = makeHome({ descriptor: null })
    expect(refusal(() => read(home)).wizardCode).toBe("INF_WIZ_NO_APP")
    const notMac = refusal(() => read(home, { platform: "linux" }))
    expect(notMac.reason).toBe("not_mac")
    expect(notMac.wizardCode).toBe("INF_WIZ_NOT_MAC")
  })

  it("no descriptor and state.json signed_out → signed_out", () => {
    const error = refusal(() => read(makeHome({ descriptor: null, state: "signed_out" })))
    expect(error.wizardCode).toBe("INF_WIZ_SIGNED_OUT")
  })
})
