// Every credential-shaped value in this file is synthetic.
import { describe, expect, it } from "vitest"
import { createScanner } from "./scan.js"

const VALUE = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY"
const scanner = createScanner({ literals: [], allowedIds: [] })
const commitHits = (text: string) => scanner.findInCommit([{ path: "src/config.ts", added: text.split("\n").map((line, index) => ({ line: index + 1, text: line })) }], () => false)

describe("explicit assignment secret names", () => {
  it("redacts the value under each credential name shape", () => {
    for (const name of ["stripeSecretKey", "apiKey", "db_password", "client_secret", "serviceToken", "AUTH", "SIGNING_KEY", "PRIVATE_KEY"]) {
      for (const text of [`${name}=${VALUE}`, `"${name}": "${VALUE}"`]) {
        expect(scanner.redact(text).text, text).not.toContain(VALUE)
        expect(commitHits(text), text).toHaveLength(1)
      }
    }
  })

  it("redacts a base64 value with punctuation inside a quoted named credential", () => {
    const text = `NEXTAUTH_SECRET="${VALUE}/+=${VALUE}"`
    expect(scanner.redact(text).text).toBe('NEXTAUTH_SECRET="[redacted: generic_secret]"')
    expect(commitHits(text)).toHaveLength(1)
  })

  it("preserves an explicit source expression but still redacts a literal beside it", () => {
    for (const text of ["const API_KEY = config.providers.key;", "configure({ token: process.env.SERVICE_TOKEN });", 'record({ request, secret: Netlify.env.get("SERVER_SECRET"), sourceKey: env.PUBLIC_ID });']) {
      expect(scanner.redact(text), text).toEqual({ text, hits: [] })
      expect(commitHits(text), text).toEqual([])
    }
    const text = `record({ request, secret: "${VALUE}", sourceKey: env.PUBLIC_ID });`
    expect(scanner.redact(text).text).toBe('record({ request, secret: "[redacted: generic_secret]", sourceKey: env.PUBLIC_ID });')
    expect(commitHits(text)).toEqual([{ kind: "generic_secret", file: "src/config.ts", line: 1 }])
  })

  it("keeps settings whose names only mention auth or tokens, and placeholder values", () => {
    for (const name of ["AUTHOR", "OAUTH_CALLBACK_PATH", "TOKEN_URL", "TOKEN_EXPIRY_MS", "passwordHashAlgorithm"]) {
      const text = `${name}=${VALUE}`
      expect(scanner.redact(text), text).toEqual({ text, hits: [] })
      expect(commitHits(text), text).toEqual([])
    }
    for (const value of ["changeme", "<replace_with_a_secret>", "${SERVICE_SECRET}", "your_api_key_here", "86400000", "true", "https://auth.example/callback?code=test"]) {
      const text = `API_KEY: "${value}"`
      expect(scanner.redact(text), text).toEqual({ text, hits: [] })
      expect(commitHits(text), text).toEqual([])
    }
  })
})

describe("credential shape boundaries", () => {
  it("redacts URL passwords", () => {
    for (const scheme of ["https", "postgresql", "custom+transport"]) {
      const text = `${scheme}://user:password@host`
      expect(scanner.redact(text).text).toBe(`${scheme}://user:[redacted: url_password]@host`)
      expect(commitHits(text)).toEqual([{ kind: "url_password", file: "src/config.ts", line: 1 }])
    }
  })

  it("preserves bearer prose and ordinary asset names", () => {
    for (const text of ["Bearer authentication", "sprite@2x.png"]) {
      expect(scanner.redact(text), text).toEqual({ text, hits: [] })
      expect(commitHits(text), text).toEqual([])
    }
  })

  it("redacts a PEM private key block but preserves a public key or certificate", () => {
    for (const label of ["PRIVATE KEY", "EC PRIVATE KEY"]) {
      const text = [`-----BEGIN ${label}-----`, "MII" + VALUE.repeat(3), `-----END ${label}-----`].join("\n")
      expect(scanner.redact(text).text, label).toBe("[redacted: private_key]")
      expect(commitHits(text), label).toEqual([{ kind: "private_key", file: "src/config.ts", line: 1 }])
    }
    for (const label of ["PUBLIC KEY", "CERTIFICATE"]) {
      const text = [`-----BEGIN ${label}-----`, "MII" + VALUE.repeat(3), VALUE + "==", `-----END ${label}-----`].join("\n")
      expect(scanner.redact(text), label).toEqual({ text, hits: [] })
      expect(commitHits(text), label).toEqual([])
    }
  })
})
