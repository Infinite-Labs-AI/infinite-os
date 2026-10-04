import Script from "next/script"

import { Providers } from "./providers"

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <Script id="consent-default" strategy="beforeInteractive">
          {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', { analytics_storage: 'granted' });`}
        </Script>
        <Script src="https://www.googletagmanager.com/gtag/js?id=G-FAKE00001" strategy="afterInteractive" />
        <Script id="ga4" strategy="afterInteractive">
          {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-FAKE00001');`}
        </Script>
        <Script src="https://www.googletagmanager.com/gtag/js?id=G-FAKE00001" strategy="afterInteractive" />
        <Script id="ga4-again" strategy="afterInteractive">
          {`gtag('config', 'G-FAKE00001');`}
        </Script>
        <Script id="meta-pixel" strategy="afterInteractive">
          {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '1234567890123456');
fbq('track', 'PageView');`}
        </Script>
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
