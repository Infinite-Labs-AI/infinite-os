import type { AppProps } from "next/app";
import { useRouter } from "next/router";
import { useEffect } from "react";
import CookieBanner from "../components/CookieBanner";
import { initTracking, trackPageView } from "../src/analytics/tracking";
import { CartProvider } from "../src/cart/CartContext";
import "../styles/globals.css";

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();

  useEffect(() => {
    initTracking(router.asPath);
    const onRouteChange = (url: string) => trackPageView(url);
    router.events.on("routeChangeComplete", onRouteChange);
    return () => router.events.off("routeChangeComplete", onRouteChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <CartProvider>
      <Component {...pageProps} />
      <CookieBanner />
    </CartProvider>
  );
}
