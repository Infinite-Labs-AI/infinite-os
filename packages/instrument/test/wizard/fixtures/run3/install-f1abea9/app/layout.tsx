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
        <Script src="https://www.googletagmanager.com/gtag/js?id=G-TEST0000000" strategy="afterInteractive" />
        <Script id="ga4" strategy="afterInteractive">
          {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-TEST0000000');`}
        </Script>
        {/* Added later by a contractor "to make sure GA works" */}
        <Script src="https://www.googletagmanager.com/gtag/js?id=G-TEST0000000" strategy="afterInteractive" />
        <Script id="ga4-again" strategy="afterInteractive">
          {`gtag('config', 'G-TEST0000000');`}
        </Script>
        {/* Meta Pixel (added by the marketing agency) */}
        <Script id="meta-pixel" strategy="afterInteractive">
          {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '7777000011112222');
fbq('track', 'PageView');`}
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
