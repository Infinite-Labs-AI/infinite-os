// Every credential-shaped value in this file is synthetic.
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { createScanner } from "./scan.js"

const VALUE = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY"
const scanner = createScanner({ literals: [], allowedIds: [] })
const commitHits = (text: string) => scanner.findInCommit([{ path: "src/config.ts", added: text.split("\n").map((line, index) => ({ line: index + 1, text: line })) }], () => false)

describe("explicit assignment secret names", () => {
  it.each([
    "stripeSecretKey", "apiKey", "secret_key", "db_password", "password", "passwd", "apikey",
    "api_key", "privatekey", "private_key", "auth_token", "client_secret", "serviceToken", "AUTH",
    "SESSION_KEY", "ENCRYPTION_KEY", "SIGNING_KEY", "MASTER_KEY", "PRIVATE_KEY", "SERVICE_SIGNING_KEY"
  ])("redacts the value under %s", name => {
    for (const text of [`${name}=${VALUE}`, `"${name}": "${VALUE}"`]) {
      expect(scanner.redact(text).text).not.toContain(VALUE)
      expect(commitHits(text)).toHaveLength(1)
    }
  })

  it.each(["/", "+", "=", "_", "-", "."])("accepts %s within a quoted named credential", character => {
    const value = `${VALUE}${character}${VALUE}`
    const text = `NEXTAUTH_SECRET="${value}"`
    expect(scanner.redact(text).text).toBe('NEXTAUTH_SECRET="[redacted: generic_secret]"')
    expect(commitHits(text)).toHaveLength(1)
  })

  it("redacts every value in a generated base64 assignment corpus", () => {
    for (let index = 0; index < 2_000; index += 1) {
      const value = createHash("sha256").update(`synthetic-credential-${index}`).digest("base64")
      for (const quote of ["", '"']) {
        const text = `NEXTAUTH_SECRET=${quote}${value}${quote}`
        expect(scanner.redact(text).text, `synthetic sample ${index}`).not.toContain(value)
        expect(commitHits(text), `synthetic sample ${index}`).toHaveLength(1)
      }
    }
  })

  it.each(["AUTHOR", "GIT_AUTHOR_NAME", "OAUTH_CALLBACK_PATH", "AUTH_PROVIDER", "PASSWORD_HASH_ALGORITHM",
    "TOKEN_NAME", "TOKEN_PATH", "TOKEN_URL", "TOKEN_PROVIDER", "TOKEN_EXPIRY_MS", "TOKEN_TTL",
    "TOKEN_ALGORITHM", "TOKEN_HEADER", "TOKEN_TYPE", "authProvider", "passwordHashAlgorithm"])("keeps the setting named %s", name => {
    const text = `${name}=${VALUE}`
    expect(scanner.redact(text)).toEqual({ text, hits: [] })
    expect(commitHits(text)).toEqual([])
  })

  it.each(["changeme", "<replace_with_a_secret>", "${SERVICE_SECRET}", "xxxx", "xxxxxxxxxxxxxxxx",
    "your_api_key_here", "", "86400000", "01234567", "123.456", "true", "false",
    "https://auth.example/callback", "https://auth.example/callback?code=test", "custom://auth.example/value"])("keeps the ordinary named value %s", value => {
    for (const name of ["API_KEY", "secret", "x-api-key"]) {
      const text = `${name}: "${value}"`
      expect(scanner.redact(text)).toEqual({ text, hits: [] })
      expect(commitHits(text)).toEqual([])
    }
  })
})

describe("credential shape boundaries", () => {
  it.each(["https", "http", "postgresql", "mysql", "redis", "custom+transport"])("redacts URL passwords for the %s scheme", scheme => {
    const text = `${scheme}://user:password@host`
    expect(scanner.redact(text).text).toBe(`${scheme}://user:[redacted: url_password]@host`)
    expect(commitHits(text)).toEqual([{ kind: "url_password", file: "src/config.ts", line: 1 }])
  })

  it.each(["Bearer authentication", "bearer authentication", "sprite@2x.png", "re_initializeAnalyticsClient"])("preserves %s", text => {
    expect(scanner.redact(text)).toEqual({ text, hits: [] })
    expect(commitHits(text)).toEqual([])
  })

  it.each(["PUBLIC KEY", "RSA PUBLIC KEY", "CERTIFICATE"])("preserves a PEM %s", label => {
    const text = [`-----BEGIN ${label}-----`, "MII" + VALUE.repeat(3), VALUE + "==", `-----END ${label}-----`].join("\n")
    expect(scanner.redact(text)).toEqual({ text, hits: [] })
    expect(commitHits(text)).toEqual([])
  })

  it.each(["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "ENCRYPTED PRIVATE KEY"])("still redacts a PEM %s", label => {
    const text = [`-----BEGIN ${label}-----`, "MII" + VALUE.repeat(3), `-----END ${label}-----`].join("\n")
    expect(scanner.redact(text).text).toBe("[redacted: private_key]")
    expect(commitHits(text)).toEqual([{ kind: "private_key", file: "src/config.ts", line: 1 }])
  })
})
