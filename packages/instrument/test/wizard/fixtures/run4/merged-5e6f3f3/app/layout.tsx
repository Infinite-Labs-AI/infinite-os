import { InfiniteAnalyticsClient } from "../lib/infinite-analytics-client"
import type { Metadata } from "next"
import Link from "next/link"
import Script from "next/script"

import "./globals.css"

export const metadata: Metadata = {
  title: "Smoke Co. | Plan your week in minutes",
  description: "A throwaway test site for npx infinite-tag."
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <Script id="consent-default" strategy="beforeInteractive">
          {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', { analytics_storage: 'granted' });`}
        </Script>
        {/* Google Analytics 4 */}
        <Script src="https://www.googletagmanager.com/gtag/js?id=G-QWERT67890" strategy="afterInteractive" />
        <Script id="ga4" strategy="afterInteractive">
          {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
if ((function (h) { var n = (function (h) { h = String(h == null ? "" : h).replace(/^\\s+|\\s+$/g, "").toLowerCase(); return h.charAt(h.length - 1) === "." ? h.slice(0, -1) : h; })(h), i; var x = ["shop.examplebrand.com"], d = ["localhost","127.0.0.1","::1","[::1]","0.0.0.0"], s = [".localhost",".local",".vercel.app",".netlify.app",".pages.dev"]; for (i = 0; i < x.length; i += 1) if (x[i] === n) return true; for (i = 0; i < d.length; i += 1) if (d[i] === n) return false; for (i = 0; i < s.length; i += 1) if (n.length > s[i].length && n.slice(n.length - s[i].length) === s[i]) return false; return true; })(location.hostname)) {
gtag('config', 'G-QWERT67890');
}`}
        </Script>
        {/* Meta ad-click id (_fbc) capture — runs on every host, before the pixel bootstrap */}
        <Script id="meta-fbc-capture" strategy="afterInteractive">
          {`(function () {
  try {
    var params = new URLSearchParams(location.search || '');
    var fbclid = params.get('fbclid');
    if (!fbclid) return;
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i].replace(/^ +/, '');
      if (part.indexOf('_fbc=') === 0) { window.infiniteMetaClickId = part.slice(5); return; }
    }
    var fbc = 'fb.1.' + Date.now() + '.' + fbclid;
    document.cookie = '_fbc=' + fbc + ';path=/;max-age=7776000;samesite=Lax' + (location.protocol === 'https:' ? ';secure' : '');
    window.infiniteMetaClickId = fbc;
  } catch (_error) {}
})();`}
        </Script>
        {/* Meta Pixel (added by the marketing agency) */}
        <Script id="meta-pixel" strategy="afterInteractive">
          {`(function () {
if (!((function (h) { var n = (function (h) { h = String(h == null ? "" : h).replace(/^\\s+|\\s+$/g, "").toLowerCase(); return h.charAt(h.length - 1) === "." ? h.slice(0, -1) : h; })(h), i; var x = ["shop.examplebrand.com"], d = ["localhost","127.0.0.1","::1","[::1]","0.0.0.0"], s = [".localhost",".local",".vercel.app",".netlify.app",".pages.dev"]; for (i = 0; i < x.length; i += 1) if (x[i] === n) return true; for (i = 0; i < d.length; i += 1) if (d[i] === n) return false; for (i = 0; i < s.length; i += 1) if (n.length > s[i].length && n.slice(n.length - s[i].length) === s[i]) return false; return true; })(location.hostname))) { if (typeof window.fbq !== 'function') { window.fbq = function () {}; window.fbq.__infiniteSilenced = true; } return; }
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('set', 'autoConfig', false, '7777000011112222');
fbq('init', '7777000011112222');
fbq('track', 'PageView');
})();`}
        </Script>
      </head>
      <body>
        <InfiniteAnalyticsClient />
        <header className="nav">
          <Link href="/" className="brand">
            Smoke Co.
          </Link>
          <nav>
            <Link href="/pricing">Pricing</Link>
            <Link href="/login">Log in</Link>
            <Link href="/signup" className="button small">
              Start free trial
            </Link>
          </nav>
        </header>
        {children}
        <footer className="footer">Throwaway test site for npx infinite-tag.</footer>
      </body>
    </html>
  )
}
