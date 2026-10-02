// The T0 child process entry (lane O6). `run.ts` spawns `node <dist>/src/t0/child.js` behind
// `sandboxedSpawn` (minimal env, temp HOME, and on macOS no network and no reads of the user's secrets),
// writes ONE `T0ChildRequest` JSON to stdin, and reads ONE `T0ChildResponse` JSON line from stdout.
// Page code runs here and only here. Nothing in this file grades anything.
import { runSession } from "./session.js"
import { T0_PROTOCOL_VERSION, type T0ChildRequest, type T0ChildResponse } from "./protocol.js"

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer))
  return Buffer.concat(chunks).toString("utf8")
}

export async function main(): Promise<void> {
  const raw = await readStdin()
  const request = JSON.parse(raw) as T0ChildRequest
  if (request.protocol !== T0_PROTOCOL_VERSION || !Array.isArray(request.sessions)) throw new Error("unsupported T0 request")
  const sessions = []
  for (const session of request.sessions) sessions.push(await runSession(session))
  const response: T0ChildResponse = { protocol: T0_PROTOCOL_VERSION, pid: process.pid, sessions }
  await new Promise<void>((resolve, reject) => process.stdout.write(`${JSON.stringify(response)}\n`, (error) => (error ? reject(error) : resolve())))
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`t0 child failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(70)
  }
)
