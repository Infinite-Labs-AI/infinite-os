import { withNote } from "./state-machine.js"
/** Relocate an unchanged frozen unit after unrelated code was inserted. Never search for a new placement. */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ChecklistItem } from "../wizard/contracts/jobs.js"
import { sourceUnits } from "./consent-units.js"
import { frozenJobNote } from "./owner-boundary.js"

export async function reanchorOwnerLocations(root: string, items: readonly ChecklistItem[]): Promise<ChecklistItem[]> {
  const sources = new Map<string, string | null>()
  const result: ChecklistItem[] = []
  for (const item of items) {
    const proof = item.ownerBoundary
    if (proof?.kind !== "frozen_unit" || !proof.file || !proof.unitHash || proof.lineOffset === undefined || proof.file.startsWith("/") || proof.file.split("/").includes("..")) { result.push(item); continue }
    if (!sources.has(proof.file)) sources.set(proof.file, await readFile(join(root, proof.file), "utf8").catch(() => null))
    const source = sources.get(proof.file)
    const unit = source === null || source === undefined ? null : sourceUnits(source).units.filter(unit => unit.hash === proof.unitHash)[proof.unitOrdinal ?? 0]
    if (!unit) { result.push(item); continue } // Final-diff measurement will refuse a changed/missing unit.
    const line = unit.startLine + proof.lineOffset
    if (line === proof.line) { result.push(item); continue }
    const oldLocation = `${proof.file}:${proof.line}`
    const newLocation = `${proof.file}:${line}`
    result.push(withNote({ ...item, ownerBoundary: { ...proof, line },
      trigger: { finding: item.trigger.finding.replaceAll(oldLocation, newLocation), evidence: item.trigger.evidence.map(entry => "file" in entry && entry.file === proof.file && entry.line === proof.line ? { ...entry, line } : entry) } }, frozenJobNote(item, { file: proof.file, line })))
  }
  return result
}
