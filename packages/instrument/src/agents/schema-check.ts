import { isReviewResult } from "../review/brief.js"
// Validates an agent's structured output against `claims.schema.json` / `review.schema.json` (§3e.3,
// §3f.8) before anything reads it: the subset those two schemas use (type incl. arrays of types, enum,
// required, properties, additionalProperties:false, items, maxLength, maxItems, pattern). Zero
// dependencies. An agent's output that fails is "unparseable", never half-used.
import { CLAIMS_SCHEMA, type ReviewResult } from "../wizard/contracts/agents.js"

type Schema = Record<string, unknown>

export function schemaErrors(value: unknown, schema: Schema, path = "$"): string[] {
  const errors: string[] = []
  const types = schema.type === undefined ? null : Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string]
  if (types && !types.some((type) => matchesType(value, type))) return [`${path}: expected ${types.join(" | ")}`]
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) return [`${path}: not one of ${schema.enum.join(", ")}`]
  if (typeof value === "string") {
    if (typeof schema.maxLength === "number" && Array.from(value).length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`)
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`)
    if (typeof schema.items === "object" && schema.items !== null) {
      value.forEach((entry, index) => errors.push(...schemaErrors(entry, schema.items as Schema, `${path}[${index}]`)))
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const properties = (schema.properties ?? {}) as Record<string, Schema>
    for (const key of (schema.required ?? []) as string[]) if (!(key in record)) errors.push(`${path}.${key}: missing`)
    for (const [key, entry] of Object.entries(record)) {
      if (properties[key]) errors.push(...schemaErrors(entry, properties[key]!, `${path}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`)
    }
  }
  return errors
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value)
    case "array":
      return Array.isArray(value)
    case "string":
      return typeof value === "string"
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    default:
      return false
  }
}

export interface StructuredClaims {
  claims: Array<{ job_id: string; status: "done" | "blocked" | "not_needed"; note: string }>
  questions: Array<{ job_id: string; question: string; options: Array<{ label: string; value: string }> | null; why: string }>
}

/** The claims fallback, or null when it does not match `claims.schema.json` exactly. */
export function parseStructuredClaims(value: unknown): StructuredClaims | null {
  const parsed = typeof value === "string" ? tryJson(value) : value
  if (parsed === undefined || schemaErrors(parsed, CLAIMS_SCHEMA as unknown as Schema).length > 0) return null
  return parsed as StructuredClaims
}

/** The review, or null when it does not match `review.schema.json` exactly. */
export function parseReview(value: unknown): ReviewResult | null {
  const parsed = typeof value === "string" ? tryJson(value) : value
  if (!isReviewResult(parsed)) return null
  return parsed as ReviewResult
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
