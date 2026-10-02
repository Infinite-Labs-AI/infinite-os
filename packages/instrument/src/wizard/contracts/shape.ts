// Exact key lists for the contract types, checked at COMPILE time against the TypeScript type and at
// RUN time against JSON (the cross-repo fixtures, and any strict decoder that wants it).
//
// Why this exists: the contract JSON crosses the repo boundary (1bu-1 vendors it), so a fixture that
// drifts from the TS type would silently teach the other side the wrong shape. `shapeOf<T>()` refuses
// to compile unless `required` lists exactly T's required keys and `optional` exactly its optional
// keys; `shapeErrors` then rejects a JSON value with an unknown key or a missing required key, at
// every nested level the shape names. Pure; no I/O; zero dependencies.

/** The nested structure of one field whose value is an object (or an array / record of objects). */
export type FieldShape =
  | ObjectShape
  | { readonly arrayOf: FieldShape }
  | { readonly recordOf: FieldShape }
  /** A union: the value must satisfy at least one member exactly. */
  | { readonly oneOf: readonly ObjectShape[] }

export interface ObjectShape {
  readonly name: string
  readonly required: readonly string[]
  readonly optional: readonly string[]
  readonly fields: Readonly<Record<string, FieldShape>>
}

type RequiredKeyOf<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T] & string
type OptionalKeyOf<T> = Exclude<keyof T, RequiredKeyOf<T>> & string

type ExactlyCovers<All extends string, Listed extends readonly string[], Label extends string> = [
  Exclude<All, Listed[number]>
] extends [never]
  ? unknown
  : { [K in Label]: Exclude<All, Listed[number]> }

/**
 * `shapeOf<T>()(name, required, optional, fields?)`: an ObjectShape whose key lists are proven
 * exhaustive for T. Omitting a key from either list is a compile error naming the missing key;
 * listing a key T does not have is a compile error too.
 */
export function shapeOf<T>() {
  return <
    const R extends readonly RequiredKeyOf<T>[],
    const O extends readonly OptionalKeyOf<T>[]
  >(
    name: string,
    required: R & ExactlyCovers<RequiredKeyOf<T>, R, "__missingRequiredKeys">,
    optional: O & ExactlyCovers<OptionalKeyOf<T>, O, "__missingOptionalKeys">,
    fields: Partial<Record<keyof T & string, FieldShape>> = {}
  ): ObjectShape =>
    Object.freeze({
      name,
      required: Object.freeze([...required]),
      optional: Object.freeze([...optional]),
      fields: Object.freeze({ ...fields }) as Readonly<Record<string, FieldShape>>
    })
}

/** All keys a shape allows. */
export function shapeKeys(shape: ObjectShape): string[] {
  return [...shape.required, ...shape.optional]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function fieldErrors(value: unknown, field: FieldShape, path: string): string[] {
  if (value === null || value === undefined) return []
  if ("arrayOf" in field) {
    if (!Array.isArray(value)) return [`${path}: expected an array`]
    return value.flatMap((item, index) => fieldErrors(item, field.arrayOf, `${path}[${index}]`))
  }
  if ("recordOf" in field) {
    if (!isPlainObject(value)) return [`${path}: expected an object`]
    return Object.entries(value).flatMap(([key, item]) => fieldErrors(item, field.recordOf, `${path}.${key}`))
  }
  if ("oneOf" in field) {
    const perMember = field.oneOf.map((member) => shapeErrors(value, member, path))
    if (perMember.some((errors) => errors.length === 0)) return []
    return [`${path}: matches none of ${field.oneOf.map((member) => member.name).join(" | ")} (${perMember.map((e) => e[0]).join("; ")})`]
  }
  return shapeErrors(value, field, path)
}

/**
 * Every way `value` breaks `shape`: not an object, an unknown key, a missing required key, and the
 * same for every nested field the shape names. An empty array means it conforms. Values themselves
 * (strings, enums, numbers) are not checked here; the contract tests check those where it matters.
 */
export function shapeErrors(value: unknown, shape: ObjectShape, path = "$"): string[] {
  if (!isPlainObject(value)) return [`${path}: expected a ${shape.name} object`]
  const allowed = new Set(shapeKeys(shape))
  const errors: string[] = []
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}: unknown key ${JSON.stringify(key)} in ${shape.name}`)
  }
  for (const key of shape.required) {
    if (!(key in value)) errors.push(`${path}: missing required key ${JSON.stringify(key)} in ${shape.name}`)
  }
  for (const [key, field] of Object.entries(shape.fields)) {
    if (key in value) errors.push(...fieldErrors(value[key], field, `${path}.${key}`))
  }
  return errors
}

/** A FieldShape for an array of objects. */
export function arrayOf(field: FieldShape): FieldShape {
  return { arrayOf: field }
}

/** A FieldShape for a string-keyed record of objects. */
export function recordOf(field: FieldShape): FieldShape {
  return { recordOf: field }
}

/** A FieldShape for a union of object shapes. */
export function oneOf(...members: ObjectShape[]): FieldShape {
  return { oneOf: members }
}
