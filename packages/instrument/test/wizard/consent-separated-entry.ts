// Synthetic free-entry world for job accounting/retry tests. Historical run fixtures stay untouched.
// The owner already placed consent and API definitions in their own bootstrap; jobs edit only calls.
export const OWNER_BOOTSTRAP_PATH = "public/owner-tracking.js"
export const OWNER_BOOTSTRAP = "window.dataLayer = window.dataLayer || [];\nfunction gtag(){ dataLayer.push(arguments); }\ngtag('consent', 'default', { analytics_storage: 'denied' });\n"

export function consentSeparatedEntry(ga4Id: string, capture = false) {
  const ga4 = `gtag('js', new Date());\ngtag('config', '${ga4Id}');`
  const meta = "fbq('init', '7777000011112222');\nfbq('track', 'PageView');"
  const guard = "location.hostname === 'shop.examplebrand.com' || (!location.hostname.endsWith('.vercel.app') && location.hostname !== 'localhost')"
  const duplicate = `        <Script id="ga4-again" strategy="afterInteractive">\n          {\`gtag('config', '${ga4Id}');\`}\n        </Script>\n`
  // The gap keeps independent GA4 and Meta edits in distinct diff hunks for attribution checks.
  const base = `import Script from "next/script"

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <Script src="/owner-tracking.js" strategy="beforeInteractive" />
        <Script src="https://www.googletagmanager.com/gtag/js?id=${ga4Id}" strategy="afterInteractive" />
        <Script id="ga4" strategy="afterInteractive">
          {\`${ga4}\`}
        </Script>
${duplicate}${"\n".repeat(8)}        <Script id="meta-pixel" strategy="afterInteractive">
          {\`${meta}\`}
        </Script>
      </head>
      <body>
        {children}
      </body>
    </html>
  )
}
`
  const installed = 'import { InfiniteAnalyticsClient } from "../lib/infinite-analytics-client"\n' + base.replace("      <body>\n", "      <body>\n        <InfiniteAnalyticsClient />\n")
  const captureScript = `        <Script id="meta-fbc-capture" strategy="afterInteractive">
          {\`(function () {
  var fbclid = new URLSearchParams(location.search).get('fbclid');
  if (fbclid) document.cookie = '_fbc=fb.1.' + Date.now() + '.' + fbclid + ';path=/;samesite=Lax';
})();\`}
        </Script>
`
  const edited = installed.replace(duplicate, "")
    .replace(ga4, `gtag('js', new Date());\nif (${guard}) {\ngtag('config', '${ga4Id}');\n}`)
    .replace(meta, `if (${guard}) {\n${capture ? "fbq('set', 'autoConfig', false, '7777000011112222');\n" : ""}${meta}\n}`)
    .replace('        <Script id="meta-pixel"', `${capture ? captureScript : ""}        <Script id="meta-pixel"`)
  return { base, installed, edited }
}
