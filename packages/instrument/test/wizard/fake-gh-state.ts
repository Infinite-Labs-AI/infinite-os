// The fake gh's files, read and written the way `fake-gh.mjs` does (review P2-2): the state JSON is replaced
// atomically (a temp file renamed over it) and never holds the call log; the calls are an append-only JSONL file
// beside it (`<state>.calls.jsonl`). A test that edits the state while the wizard runs (the merge button) can then
// never be overwritten by a concurrent read-only gh call, and never loses a call the wizard made meanwhile.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"

export interface FakeGhCallRecord {
  argv: string[]
  stdin: string | null
}

export function fakeGhCallsPath(statePath: string): string {
  return `${statePath}.calls.jsonl`
}

/** Every call the fake gh recorded, in order. */
export function readFakeGhCalls(statePath: string): FakeGhCallRecord[] {
  const path = fakeGhCallsPath(statePath)
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FakeGhCallRecord)
}

/** The state with `calls` filled from the call log (any `calls` in the JSON itself is ignored). */
export function readFakeGhState(statePath: string): Record<string, unknown> & { calls: FakeGhCallRecord[] } {
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>
  delete parsed.calls
  return { ...parsed, calls: readFakeGhCalls(statePath) }
}

/** Replaces the state file atomically, without the call log. */
export function writeFakeGhState(statePath: string, state: object): void {
  const { calls: _calls, ...rest } = state as { calls?: unknown }
  const temp = `${statePath}.${process.pid}.test.tmp`
  writeFileSync(temp, `${JSON.stringify(rest, null, 2)}\n`)
  renameSync(temp, statePath)
}
