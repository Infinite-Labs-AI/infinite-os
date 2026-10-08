import { Head, Html, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta name="description" content="Halden Audio makes small-batch wooden speakers by hand." />
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23c49a6c'/%3E%3Ccircle cx='16' cy='19' r='7' fill='%231f1d1a'/%3E%3Ccircle cx='16' cy='9' r='3' fill='%231f1d1a'/%3E%3C/svg%3E"
        />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
