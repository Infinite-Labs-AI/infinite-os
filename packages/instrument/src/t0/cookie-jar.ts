// A browser-faithful cookie jar for T0 pages (lane O6). Ported from infinite-site
// `.github/scripts/fixtures/browser-cookie-jar.mjs` @ 9f65b47 (already ported once into
// `providers/meta-browser/click-id.test.ts`; this is the shipped copy the T0 engine runs pages against).
//
// It keeps the parts of RFC 6265bis that decide WHICH `_fbc` a page reads (the two-cookie incident,
// infinite-site 06b2ce8):
//   1. A HOST-ONLY cookie and a DOMAIN cookie are different cookies, even on the apex host.
//   2. Overwriting keeps the ORIGINAL creation time.
//   3. `document.cookie` lists longer paths first and, within a path, OLDEST FIRST.
// It refuses a Domain attribute naming a public suffix or a domain the page is not on. Any single-label
// domain counts as a public suffix (browsers refuse a cookie on a bare TLD), plus the multi-label
// suffixes below, so a customer on an unusual TLD still gets the right subdomain index.
//
// The jar is per T0 SESSION, not per page: it survives page loads and storage wipes (F24: the in-app
// browser wiped web storage but kept cookies), keyed by the page's current hostname.

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "github.io",
  "web.app",
  "firebaseapp.com",
  "herokuapp.com",
  "onrender.com",
  "fly.dev",
  "co.uk",
  "org.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "co.nz",
  "co.jp",
  "com.br",
  "co.in",
  "co.za",
  "com.mx"
])

export function isPublicSuffix(domain: string): boolean {
  return !domain.includes(".") || MULTI_LABEL_PUBLIC_SUFFIXES.has(domain)
}

const domainMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

export interface StoredCookie {
  name: string
  value: string
  domain: string
  hostOnly: boolean
  path: string
  created: number
}

export interface CookieView {
  name: string
  value: string
  /** `.acme.com` for a Domain cookie, `www.acme.com` for a host-only one. */
  domain: string
}

export class CookieJar {
  private store: StoredCookie[] = []
  private created = 0
  /** Every raw `document.cookie = …` assignment, in order (the write log). */
  readonly writes: Array<{ host: string; value: string }> = []
  hostname = ""

  private host(): string {
    return this.hostname.toLowerCase()
  }

  write(written: string): void {
    this.writes.push({ host: this.host(), value: String(written) })
    const [pair = "", ...attributes] = String(written).split(";")
    const separator = pair.indexOf("=")
    if (separator === -1) return
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1)
    let domain: string | null = null
    let path = "/"
    let maxAge: number | null = null
    let expired = false
    for (const attribute of attributes) {
      const at = attribute.indexOf("=")
      const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase()
      const raw = at === -1 ? "" : attribute.slice(at + 1).trim()
      if (key === "domain") domain = raw.replace(/^\./, "").toLowerCase()
      if (key === "path") path = raw || "/"
      if (key === "max-age") maxAge = Number(raw)
      if (key === "expires") {
        const when = Date.parse(raw)
        if (Number.isFinite(when) && when < Date.UTC(2000, 0, 1)) expired = true
      }
    }
    let hostOnly = true
    if (domain !== null && domain !== "") {
      if (isPublicSuffix(domain) && domain !== this.host()) return
      if (!domainMatches(this.host(), domain)) return
      hostOnly = domain === this.host() && isPublicSuffix(domain)
    } else {
      domain = this.host()
    }
    const index = this.store.findIndex(
      (cookie) => cookie.name === name && cookie.domain === domain && cookie.hostOnly === hostOnly && cookie.path === path
    )
    if ((maxAge !== null && maxAge <= 0) || expired) {
      if (index !== -1) this.store.splice(index, 1)
      return
    }
    if (index !== -1) {
      this.store[index]!.value = value
      return
    }
    this.store.push({ name, value, domain, hostOnly, path, created: this.created++ })
  }

  private visible(): StoredCookie[] {
    const host = this.host()
    return this.store
      .filter((cookie) => (cookie.hostOnly ? cookie.domain === host : domainMatches(host, cookie.domain)))
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created)
  }

  read(): string {
    return this.visible()
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ")
  }

  /** The cookies the current host sees, newest-last, with the scope each lives on. */
  entries(name?: string): CookieView[] {
    return this.visible()
      .filter((cookie) => name === undefined || cookie.name === name)
      .map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.hostOnly ? cookie.domain : `.${cookie.domain}` }))
  }

  /** Every stored cookie regardless of the current host. */
  all(): CookieView[] {
    return this.store.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.hostOnly ? cookie.domain : `.${cookie.domain}` }))
  }

  /** Seed cookies the browser already holds (`name=value; Domain=…`), without logging them as writes. */
  seed(cookies: readonly string[]): void {
    for (const cookie of cookies) {
      this.write(cookie)
      this.writes.pop()
    }
  }
}
