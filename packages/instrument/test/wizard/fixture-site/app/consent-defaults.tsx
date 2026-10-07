import Script from "next/script"

export function ConsentDefaults() {
  return (
        <Script id="consent-default" strategy="beforeInteractive">
          {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', { analytics_storage: 'granted' });`}
        </Script>
  )
}
