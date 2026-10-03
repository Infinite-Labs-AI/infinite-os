// Drives the fake `gh` (test/wizard/bin/gh → fake-gh.mjs) from a test: its JSON state file, the env that puts it
// first on PATH, and helpers to read what the wizard sent it.
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const FAKE_GH_BIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "bin")

export interface FakeGhCall {
  argv: string[]
  stdin: string | null
}

export interface FakeGhState {
  login?: string
  authOk?: boolean
  repo?: { nameWithOwner?: string; isPrivate?: boolean; defaultBranch?: string | null; viewerPermission?: string }
  draftUnsupported?: boolean
  rejectInlineThreads?: boolean
  reviewDecision?: string
  prs?: Array<Record<string, unknown>>
  threads?: Array<{ id: string; prNumber: number; isResolved: boolean; path: string | null; line: number | null; comments: Array<{ author: string; authorAssociation: string; body: string }> }>
  deployments?: Array<{ id: number; sha: string; environment: string; creator: string; statuses: Array<{ state: string; environment_url: string | null }> }>
  rules?: Record<string, Array<{ type: string; parameters?: Record<string, unknown> }>>
  checks?: Record<string, Array<{ name: string; bucket: string; state: string }>>
  calls?: FakeGhCall[]
  nextPrNumber?: number
}

export interface FakeGh {
  statePath: string
  env: Record<string, string>
  read(): FakeGhState & { calls: FakeGhCall[]; prs: Array<Record<string, unknown>>; threads: NonNullable<FakeGhState["threads"]> }
  update(mutate: (state: FakeGhState) => void): void
  /** Every argv and stdin the wizard sent gh, as one string (for "a secret never reached gh" assertions). */
  traffic(): string
}

export function createFakeGh(input: { dir: string; remote: string; env: Record<string, string>; state?: FakeGhState }): FakeGh {
  const statePath = join(input.dir, "fake-gh-state.json")
  writeFileSync(statePath, `${JSON.stringify({ login: "acme-dev", authOk: true, ...input.state }, null, 2)}\n`)
  const nodeDir = dirname(process.execPath)
  const env = {
    ...input.env,
    PATH: `${FAKE_GH_BIN_DIR}:${nodeDir}:/usr/bin:/bin`,
    FAKE_GH_STATE: statePath,
    FAKE_GH_REMOTE: input.remote,
    FAKE_GH_NODE: process.execPath
  }
  const read = () => {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"))
    return { calls: [], prs: [], threads: [], ...parsed }
  }
  return {
    statePath,
    env,
    read,
    update(mutate) {
      const state = read()
      mutate(state)
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
    },
    traffic() {
      return read()
        .calls.map((call: FakeGhCall) => `${call.argv.join(" ")}\n${call.stdin ?? ""}`)
        .join("\n")
    }
  }
}
