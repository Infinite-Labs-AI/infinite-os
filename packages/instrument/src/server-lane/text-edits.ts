// Reversible text edits, recorded in the manifest so `uninstall` restores a patched file
// byte-for-byte. Offsets are in ORIGINAL-file coordinates, ascending and non-overlapping;
// `removed` is the exact original text replaced by `inserted` (either may be empty).
import type { ManagedTextEdit } from "../types.js"

export function applyTextEdits(original: string, edits: ManagedTextEdit[]): string {
  let cursor = 0
  let output = ""
  for (const edit of sortedEdits(edits)) {
    if (edit.offset < cursor) {
      throw new Error("Text edits overlap; refusing to apply.")
    }
    if (original.slice(edit.offset, edit.offset + edit.removed.length) !== edit.removed) {
      throw new Error("Text edit does not match the original file; refusing to apply.")
    }
    output += original.slice(cursor, edit.offset) + edit.inserted
    cursor = edit.offset + edit.removed.length
  }
  return output + original.slice(cursor)
}

/**
 * Undo `applyTextEdits`: every inserted segment must still be present exactly where it was put.
 * Reversing in ascending order returns the prefix to original coordinates each step, so each
 * edit's original offset is exactly where its inserted text sits in the partially restored string.
 */
export function reverseTextEdits(installed: string, edits: ManagedTextEdit[]): string {
  let output = installed
  for (const edit of sortedEdits(edits)) {
    const position = edit.offset
    if (output.slice(position, position + edit.inserted.length) !== edit.inserted) {
      throw new Error("An installer-owned edit no longer matches; refusing to reverse.")
    }
    output = output.slice(0, position) + edit.removed + output.slice(position + edit.inserted.length)
  }
  return output
}

function sortedEdits(edits: ManagedTextEdit[]): ManagedTextEdit[] {
  return [...edits].sort((left, right) => left.offset - right.offset)
}
