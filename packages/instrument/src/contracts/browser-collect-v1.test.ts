import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const contractsRoot = resolve(packageRoot, "contracts")
const schemaPath = resolve(contractsRoot, "browser-collect-v1.schema.json")
const fixturePath = resolve(contractsRoot, "browser-collect-v1.fixture.json")
const structuralTokenPattern = "^[A-Za-z0-9_-]{1,64}$"

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
    // app_download_click's destination is either per-source parameterized (cloud-configured) or a
    // bounded external conversion bucket; the contract bounds the SHAPE and must not re-pin the
    // platform default.
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
      "properties"
    ])
    expect(schemaProperties).not.toHaveProperty("path")
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

  it("site_page_view may carry ONLY the bounded nav enum (0.6.0: navigate | history), optional for older tags", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      properties: { properties: { properties: Record<string, unknown> } }
      allOf: Array<{
        if: { properties: { eventName: { const: string } } }
        then: { properties: { properties: Record<string, unknown> } }
      }>
    }
    expect(schema.properties.properties.properties.nav).toEqual({
      type: "string",
      enum: ["navigate", "history"]
    })
    const pageView = schema.allOf.find((branch) => branch.if.properties.eventName.const === "site_page_view")
    expect(pageView?.then.properties.properties).toEqual({
      type: "object",
      maxProperties: 1,
      properties: { nav: { $ref: "#/properties/properties/properties/nav" } }
    })
    // Not required: a 0.5.x tag sends no properties on a page view and must keep validating.
    expect(pageView?.then.properties.properties).not.toHaveProperty("required")
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
    expect(new RegExp(propertySchemas.destination_path?.pattern ?? "$^").test("/external/stripe")).toBe(true)

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
