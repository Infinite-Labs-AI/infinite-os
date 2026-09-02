import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const contractsRoot = resolve(packageRoot, "contracts")
const schemaPath = resolve(contractsRoot, "browser-collect-v1.schema.json")
const fixturePath = resolve(contractsRoot, "browser-collect-v1.fixture.json")
const structuralTokenPattern = "^[A-Za-z0-9_-]{1,64}$"

const utmKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const
const clickIdPresenceKeys = ["has_gclid", "has_fbclid", "has_ttclid", "has_msclkid"] as const
const campaignKeys = [...utmKeys, ...clickIdPresenceKeys]

type JsonSchema = boolean | Record<string, unknown>

/**
 * A deliberately small evaluator for the subset of JSON Schema 2020-12 this contract uses
 * (type, properties incl. `false`, additionalProperties, maxProperties, required, enum, const,
 * pattern, min/maxLength, local `$ref`, allOf/if/then, not). It exists so the tests can prove
 * VALIDATION outcomes against the shipped file, not just its shape, without adding a dependency.
 */
function validateAgainstContract(root: Record<string, unknown>, value: unknown): boolean {
  const resolve = (ref: string): JsonSchema =>
    ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root) as JsonSchema
  const check = (schema: JsonSchema, node: unknown): boolean => {
    if (schema === true) return true
    if (schema === false) return false
    if (typeof schema.$ref === "string") return check(resolve(schema.$ref), node)
    if (schema.type === "object") {
      if (node === null || typeof node !== "object" || Array.isArray(node)) return false
    }
    if (schema.type === "string" && typeof node !== "string") return false
    if (typeof node === "string") {
      if (typeof schema.minLength === "number" && node.length < schema.minLength) return false
      if (typeof schema.maxLength === "number" && node.length > schema.maxLength) return false
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(node)) return false
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(node)) return false
    if ("const" in schema && schema.const !== node) return false
    if (node !== null && typeof node === "object" && !Array.isArray(node)) {
      const record = node as Record<string, unknown>
      const keys = Object.keys(record)
      if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) return false
      for (const key of (schema.required as string[] | undefined) ?? []) {
        if (!(key in record)) return false
      }
      const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {}
      for (const key of keys) {
        if (key in properties) {
          if (!check(properties[key]!, record[key])) return false
        } else if (schema.additionalProperties === false) {
          return false
        }
      }
    }
    for (const sub of (schema.allOf as JsonSchema[] | undefined) ?? []) {
      if (!check(sub, node)) return false
    }
    if (schema.if !== undefined) {
      if (check(schema.if as JsonSchema, node)) {
        if (schema.then !== undefined && !check(schema.then as JsonSchema, node)) return false
      } else if (schema.else !== undefined && !check(schema.else as JsonSchema, node)) {
        return false
      }
    }
    if (schema.not !== undefined && check(schema.not as JsonSchema, node)) return false
    return true
  }
  return check(root, value)
}

function pageView(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    siteSourceKey: "site_public_fixture",
    eventId: "00000000-0000-4000-8000-000000000003",
    eventName: "site_page_view",
    occurredAt: "2026-08-02T09:00:00.000Z",
    anonymousId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    url: "https://example.com/pricing/",
    properties
  }
}

describe("browser-collect-v1 public contract", () => {
  it("ships a versioned schema and fixture with the exact cloud-safe shape", () => {
    expect(existsSync(schemaPath), schemaPath).toBe(true)
    expect(existsSync(fixturePath), fixturePath).toBe(true)

    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>
    expect(schema).toMatchObject({
      $id: "https://infinite.fast/contracts/browser-collect-v1.schema.json",
      type: "object",
      additionalProperties: false,
      required: [
        "siteSourceKey",
        "eventId",
        "eventName",
        "occurredAt",
        "anonymousId",
        "sessionId",
        "url"
      ]
    })
    const schemaProperties = schema.properties as Record<string, unknown>
    // The locked browser event enum — the runtime may emit EXACTLY these (intent-grade names
    // only; the sign-up OUTCOME name sign_up never enters the browser contract).
    expect(schemaProperties.eventName).toMatchObject({
      enum: ["site_page_view", "site_click", "app_download_click", "sign_up_click"]
    })
    expect(
      (schemaProperties.eventName as { enum: string[] }).enum
    ).not.toContain("sign_up")
    // app_download_click's destination is per-source parameterized (cloud-configured); hosted
    // external checkout intent stays in site_click with bounded destination buckets. The contract
    // bounds the SHAPE and must not re-pin the platform default.
    expect(JSON.stringify(schema.allOf)).not.toContain('"const":"/download"')
    expect(Object.keys(schemaProperties)).toEqual([
      "siteSourceKey",
      "eventId",
      "eventName",
      "occurredAt",
      "anonymousId",
      "sessionId",
      "url",
      "referrer",
      "properties",
      "automation"
    ])
    expect(schemaProperties).not.toHaveProperty("path")
    // automation is an OPTIONAL top-level marker (alongside referrer/properties): the pixel sets it
    // true ONLY when it deliberately fired under navigator.webdriver for a synthetic sandbox source.
    expect(schemaProperties.automation).toEqual({ type: "boolean" })
    expect(schemaProperties.url).toMatchObject({
      pattern: "^https?://[^@/?#\\s]+(?:/[^?#\\s]*)?$"
    })
    expect(schemaProperties.referrer).toMatchObject({
      maxLength: 253,
      pattern: "^[a-z0-9._:\\[\\]-]+$"
    })
    const eventBranches = schema.allOf as Array<{
      then?: { properties?: { properties?: Record<string, unknown> } }
    }>
    for (const branch of eventBranches) {
      const propertyBranch = branch.then?.properties?.properties
      expect(propertyBranch).toMatchObject({ type: "object" })
      const required = propertyBranch?.required as string[] | undefined
      const definitions = propertyBranch?.properties as Record<string, unknown> | undefined
      for (const key of required ?? []) {
        expect(definitions, `conditional property definition for ${key}`).toBeDefined()
        expect(definitions!).toHaveProperty(key)
      }
    }
    expect(Object.keys(fixture)).toEqual([
      "siteSourceKey",
      "eventId",
      "eventName",
      "occurredAt",
      "anonymousId",
      "sessionId",
      "url",
      "referrer",
      "properties"
    ])
    expect(fixture).toEqual({
      siteSourceKey: "site_public_fixture",
      eventId: "00000000-0000-4000-8000-000000000003",
      eventName: "site_click",
      occurredAt: "2026-08-02T09:00:00.000Z",
      anonymousId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      url: "https://example.com/pricing/",
      referrer: "referrer.example",
      properties: {
        cta_id: "pricing_primary",
        cta_location: "hero",
        destination_path: "/download"
      }
    })
    expect(JSON.stringify(fixture)).not.toMatch(/[?#]|workspace|environment|authority|"path"/)

    const originHost = new URL("https://example.com").hostname
    const eventUrl = new URL(String(fixture.url))
    const referrerHost = new URL(`https://${String(fixture.referrer)}`).hostname
    expect(eventUrl.hostname).toBe(originHost)
    expect(eventUrl.pathname).toBe("/pricing/")
    expect(referrerHost).toBe("referrer.example")
  })

  it("app_download_click explicitly permits structural CTA fields plus destination_path", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      allOf: Array<{
        if: { properties: { eventName: { const: string } } }
        then: { properties: { properties: Record<string, unknown> } }
      }>
    }
    const appDownload = schema.allOf.find(
      (branch) => branch.if.properties.eventName.const === "app_download_click"
    )

    expect(appDownload?.then.properties.properties).toEqual({
      type: "object",
      required: ["destination_path"],
      properties: {
        cta_id: { $ref: "#/properties/properties/properties/cta_id" },
        cta_location: { $ref: "#/properties/properties/properties/cta_location" },
        destination_path: { $ref: "#/properties/properties/properties/destination_path" }
      }
    })
  })

  it("site_page_view may carry the bounded nav enum plus the allowlisted campaign block (0.7.0), all optional", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      properties: { properties: { maxProperties: number; properties: Record<string, unknown> } }
      allOf: Array<{
        if: { properties: { eventName: { const?: string; enum?: string[] } } }
        then: { properties: { properties: Record<string, unknown> } }
      }>
    }
    const definitions = schema.properties.properties.properties
    expect(definitions.nav).toEqual({ type: "string", enum: ["navigate", "history"] })
    for (const key of utmKeys) {
      expect(definitions[key], key).toEqual({
        type: "string",
        minLength: 1,
        maxLength: 100,
        pattern: "^[^\\u0000-\\u001f]+$"
      })
    }
    for (const key of clickIdPresenceKeys) {
      expect(definitions[key], key).toEqual({ const: true })
    }
    // 4 structural keys + 9 campaign keys — the cloud's PROPERTY_KEYS parity test pins the same count.
    expect(Object.keys(definitions)).toHaveLength(13)
    expect(schema.properties.properties.maxProperties).toBe(13)

    const pageView = schema.allOf.find((branch) => branch.if.properties.eventName.const === "site_page_view")
    expect(pageView?.then.properties.properties).toEqual({
      type: "object",
      maxProperties: 10,
      properties: Object.fromEntries(
        ["nav", ...campaignKeys].map((key) => [key, { $ref: `#/properties/properties/properties/${key}` }])
      )
    })
    // Not required: a 0.5.x tag sends no properties on a page view and must keep validating.
    expect(pageView?.then.properties.properties).not.toHaveProperty("required")

    // The shared file has exactly the three event branches the cloud pins by hash — campaign keys on
    // click events are rejected by the cloud INGEST, not by the schema (kept permissive so both
    // repos' copies stay byte-identical).
    expect(schema.allOf.map((branch) => branch.if.properties.eventName.const)).toEqual([
      "site_page_view",
      "site_click",
      "app_download_click"
    ])
  })

  it("validates the campaign rules against the shipped file: page views accept the block, click events reject it, presence is literal true", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"))

    expect(validateAgainstContract(schema, fixture)).toBe(true)
    expect(validateAgainstContract(schema, pageView({ nav: "navigate" }))).toBe(true)
    expect(
      validateAgainstContract(
        schema,
        pageView({
          nav: "navigate",
          utm_source: "x.com",
          utm_medium: "social",
          utm_campaign: "launch",
          utm_content: "hero",
          utm_term: "cmo",
          has_gclid: true,
          has_fbclid: true,
          has_ttclid: true,
          has_msclkid: true
        })
      )
    ).toBe(true)

    // Bounds.
    expect(validateAgainstContract(schema, pageView({ nav: "navigate", utm_source: "" }))).toBe(false)
    expect(validateAgainstContract(schema, pageView({ nav: "navigate", utm_source: "a".repeat(101) }))).toBe(false)
    expect(validateAgainstContract(schema, pageView({ nav: "navigate", utm_source: "a\u0001b" }))).toBe(false)
    expect(validateAgainstContract(schema, pageView({ nav: "navigate", has_gclid: false }))).toBe(false)
    expect(validateAgainstContract(schema, pageView({ nav: "navigate", has_gclid: "true" }))).toBe(false)
    // The value of a click id never has a key to live in.
    expect(validateAgainstContract(schema, pageView({ nav: "navigate", gclid: "abc123" }))).toBe(false)
    expect(validateAgainstContract(schema, pageView({ nav: "navigate", campaign: "launch" }))).toBe(false)

    // Click events keep validating with their structural properties.
    for (const eventName of ["site_click", "app_download_click", "sign_up_click"]) {
      expect(
        validateAgainstContract(schema, {
          ...fixture,
          eventName,
          properties: { cta_id: "pricing_primary", cta_location: "hero", destination_path: "/download" }
        }),
        eventName
      ).toBe(true)
    }
  })

  it("documents where the SHARED schema stays permissive: the cloud ingest, not the file, rejects a campaign block on a click event or a cta beside it", () => {
    // Pinned on purpose (coordination decision 2026-09-02): both repos carry this file byte-for-byte
    // and the cloud's ingest parser is the gate for these two cases. If either copy starts encoding
    // them, the hash pin on the cloud side changes with it.
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"))
    expect(
      validateAgainstContract(schema, {
        ...fixture,
        properties: { cta_id: "pricing_primary", cta_location: "hero", utm_source: "x.com" }
      })
    ).toBe(true)
    expect(validateAgainstContract(schema, pageView({ nav: "navigate", cta_id: "hero" }))).toBe(true)
  })

  it("matches the runtime structural token contract for CTA properties", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      properties: {
        properties: {
          properties: Record<string, { pattern?: string }>
        }
      }
    }
    const propertySchemas = schema.properties.properties.properties

    expect(propertySchemas.cta_id?.pattern).toBe(structuralTokenPattern)
    expect(propertySchemas.cta_location?.pattern).toBe(structuralTokenPattern)
    expect(new RegExp(propertySchemas.destination_path?.pattern ?? "$^").test("/external/stripe_payment_link")).toBe(true)

    const structuralToken = new RegExp(structuralTokenPattern)
    for (const value of ["a", "Hero_2-primary", "A".repeat(64)]) {
      expect(structuralToken.test(value), `expected valid structural token: ${value}`).toBe(true)
    }
    for (const value of [
      "",
      "free form text",
      "email@example.com",
      "pricing?plan=pro",
      "cta_location=hero",
      "café",
      "価格",
      "A".repeat(65)
    ]) {
      expect(structuralToken.test(value), `expected invalid structural token: ${value}`).toBe(false)
    }
  })
})
