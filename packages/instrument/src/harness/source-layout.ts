import { lstatSync, readFileSync } from "node:fs"
import { join, posix } from "node:path"

export interface SourceLayout {
  outputDirectory?: string
  generatedTarget: boolean
  notes: string[]
}
function config(root: string, name: string): Record<string, unknown> {
  try {
    const path = join(root, name),
      stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 512 * 1024) return {}
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function older(a: string, b: string): boolean {
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i]
  }
  return false
}
/** Read configuration only. Never run a build, inspect secrets, or mutate generated files. */
export function inspectSourceLayout(
  root: string,
  appRoot: string,
  toolVersion: string
): SourceLayout {
  const vercel = config(root, "vercel.json"),
    pkg = config(root, "package.json")
  const notes: string[] = []
  const pin =
    record(pkg.devDependencies)["infinite-tag"] ?? record(pkg.dependencies)["infinite-tag"]
  if (
    typeof pin === "string" &&
    /^\d+\.\d+\.\d+$/.test(pin) &&
    /^\d+\.\d+\.\d+$/.test(toolVersion) &&
    older(pin, toolVersion)
  ) {
    notes.push(
      `INF_TAG_VERSION_DRIFT — This project pins infinite-tag ${pin}; the running tool is ${toolVersion}. Adopting existing tags does not upgrade that dependency or regenerate its build output. Review the package changes, update the existing owner, rebuild, and verify the deployed runtime before claiming coverage.`
    )
  }
  const command = vercel.buildCommand ?? record(pkg.scripts).build
  const raw = vercel.outputDirectory
  let outputDirectory: string | undefined
  if (
    typeof command === "string" &&
    command.trim() &&
    typeof raw === "string" &&
    raw.length <= 256 &&
    /^[A-Za-z0-9._/-]+$/.test(raw) &&
    !posix.isAbsolute(raw)
  ) {
    const normalized = posix.normalize(raw)
    if (normalized !== "." && normalized !== ".." && !normalized.startsWith("../"))
      outputDirectory = normalized.replace(/\/$/, "")
  }
  const target = posix.normalize(appRoot.replaceAll("\\", "/"))
  const generatedTarget =
    !!outputDirectory && (target === outputDirectory || target.startsWith(outputDirectory + "/"))
  if (outputDirectory) {
    notes.push(
      `INF_SOURCE_OUTPUT_SPLIT — vercel.json publishes ${outputDirectory} after a build. Map editable source templates/components and build-time analytics injection to the generated routes. Change that source owner, not generated output; rebuild and inspect every affected deployed route for missing or duplicate bootstraps. A subdirectory audit does not cover the whole site.`
    )
    if (generatedTarget)
      notes.push(
        "The selected app root is generated output: inspection is allowed, but installation and conversion marking must target editable source. Do not fabricate an install manifest for an independently managed build."
      )
  }
  return { outputDirectory, generatedTarget, notes }
}
