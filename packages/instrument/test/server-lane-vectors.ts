// Fixed server-lane vectors, shared by the helper, recipe, generated-source and verify tests.
// Kept out of any *.test.ts file: importing a test file re-registers all of its tests.

/**
 * FIXED VECTORS — shared with the receiving side (1bu-1) so both ends prove the same recipe.
 *   secret      = "test-secret"
 *   clientIp    = "203.0.113.9"
 *   userAgent   = Chrome 126 on macOS (below)
 *   nowMs       = 1755500000123  → epochSeconds 1755500000 → bucket floor(1755500000/1800) = 975277
 *   path        = "/pricing"
 */
export const VECTORS = {
  secret: "test-secret",
  clientIp: "203.0.113.9",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  nowMs: 1755500000123,
  path: "/pricing",
  host: "example.com",
  referrer: "https://google.com/search?q=infinite",
  bucket: 975277,
  visitKey: "b16eaccc3fc131a1fc6428105bf366164c1f8fff3e0de56d0da7bbfa1712005e",
  eventId: "doc:85c11b1b1ed121d9f91da03777ea890b895033f7a383dceca0694d59ceda8b67",
  emptyBodySignature: "a41bc6d81d6413576ae0994995e0ad89a416ec97389515c3604f47722122eeeb",
  helloSignature: "bcc889a40667cab715e1dc22ad280692cf4bf1c3a280eeeca60d8dbcd8e4b993",
  body:
    '{"eventId":"doc:85c11b1b1ed121d9f91da03777ea890b895033f7a383dceca0694d59ceda8b67","eventName":"site_document_request","occurredAt":"2025-08-18T06:53:20.123Z","properties":{"path":"/pricing","host":"example.com","visitKey":"b16eaccc3fc131a1fc6428105bf366164c1f8fff3e0de56d0da7bbfa1712005e","userAgentFamily":"browser","referrerHost":"google.com"}}',
  bodySignature: "679b2a1bd1e69c49f57534707df1c20e890c17a93ff5fa312fb45519950ddf03",
  /** verify --server-lane: the receipt GET signs its raw query string `since=<encoded iso>`. */
  receiptSince: "2026-08-18T20:00:00.000Z",
  receiptQuery: "since=2026-08-18T20%3A00%3A00.000Z",
  receiptSignature: "2d07572d2a6385584160e88deda6acab37233af2e6ec497b4340572d41aa9b16"
} as const
