/** Pure fixed-entry transforms shared by the preview and the adapters. No repository reads. */
import type { InstallInstruction } from "../types.js"
import { buildManagedHtmlBlock } from "./managed-html.js"

export const CLIENT_IMPORT_LINE = 'import { InfiniteAnalyticsClient } from "../lib/infinite-analytics-client"'
export const CLIENT_TAG = "<InfiniteAnalyticsClient />"
export function upsertLayoutSource(source: string): string {
  if (!source.includes("<body")) throw new Error("The root layout does not render a body element")
  let next = source
  if (!next.includes(CLIENT_IMPORT_LINE)) next = `${CLIENT_IMPORT_LINE}\n${next}`
  if (!next.includes(CLIENT_TAG)) next = next.replace(/<body\b[^>]*>/, match => `${match}\n        ${CLIENT_TAG}`)
  return next
}
export function upsertAppSource(source: string): string {
  if ((source.match(/<Component\b[^>]*\/>/g) ?? []).length !== 1) throw new Error("The app entry does not render its Component exactly once")
  let next = source
  if (!next.includes(CLIENT_IMPORT_LINE)) next = `${CLIENT_IMPORT_LINE}\n${next}`
  if (!next.includes(CLIENT_TAG)) next = next.replace(/<Component\b[^>]*\/>/, match => `<>\n      ${CLIENT_TAG}\n      ${match}\n    </>`)
  return next
}
export function managedBlockFor(instructions: readonly InstallInstruction[]): string {
  return buildManagedHtmlBlock(instructions.filter(instruction => (instruction.provider || instruction.helpers) && instruction.path.endsWith("index.html")).map(instruction => instruction.snippet.trim()).filter(Boolean))
}
export function staticManagedBlockFor(instructions: readonly InstallInstruction[]): string {
  return buildManagedHtmlBlock(instructions.filter(instruction => (instruction.provider || instruction.helpers) && /\.html?$/i.test(instruction.path)).map(instruction => instruction.snippet.trim()).filter(Boolean))
}
