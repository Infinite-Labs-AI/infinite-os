/** Exact fixed-emitter provenance. The worker deny list protects this local run record. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const GENERATED_API_RECORD = ".infinite/wizard/generated-api.json"
type GeneratedRecord = { schema: 1; entries: Array<{ file: string; text: string }> }

export function generatedApiTexts(root: string, file: string): string[] {
  const path = join(root, GENERATED_API_RECORD)
  if (!existsSync(path)) return []
  const record = JSON.parse(readFileSync(path, "utf8")) as GeneratedRecord
  if (record?.schema !== 1 || !Array.isArray(record.entries) || record.entries.some(entry => typeof entry.file !== "string" || typeof entry.text !== "string")) throw new Error("The trusted generated-code record is unreadable")
  return record.entries.filter(entry => entry.file === file).map(entry => entry.text)
}

/** Called only with the fixed builder's output, before writing those exact bytes. */
export function recordGeneratedApi(root: string, file: string, text: string): void {
  const path = join(root, GENERATED_API_RECORD)
  let record: GeneratedRecord = { schema: 1, entries: [] }
  if (existsSync(path)) {
    generatedApiTexts(root, file) // Validate before carrying the previous entries forward.
    record = JSON.parse(readFileSync(path, "utf8")) as GeneratedRecord
  }
  if (record.entries.some(entry => entry.file === file && entry.text === text)) return
  record.entries.push({ file, text })
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}
