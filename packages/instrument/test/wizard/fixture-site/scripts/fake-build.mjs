/* global console */
// The fixture site's build (offline E2E only). It never compiles anything: it records which
// next.config.mjs it was run on ("" before the wizard creates its managed one) (a hash and whether it reaches for child_process) in .next/, the
// build output folder a real Next build writes, and exits 0.
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"

const config = existsSync("next.config.mjs") ? readFileSync("next.config.mjs", "utf8") : ""
mkdirSync(".next", { recursive: true })
appendFileSync(
  ".next/e2e-builds.jsonl",
  `${JSON.stringify({ configSha256: createHash("sha256").update(config).digest("hex"), childProcess: config.includes("child_process") })}\n`
)
console.log("built")
