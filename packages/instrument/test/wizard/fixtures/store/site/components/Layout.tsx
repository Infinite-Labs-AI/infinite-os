import Head from "next/head";
import Link from "next/link";
import type { ReactNode } from "react";
import { useCart } from "../src/cart/CartContext";
import { openCookieSettings } from "../src/analytics/tracking";

export default function Layout({ children, title }: { children: ReactNode; title?: string }) {
  const { count, hydrated } = useCart();
  const pageTitle = title ? `${title} | Halden Audio` : "Halden Audio | Speakers made by hand";

  return (
    <>
      <Head>
        <title>{pageTitle}</title>
      </Head>
      <div className="announce">Free US shipping on every speaker. 60-night home trial.</div>
      <header className="site-header">
        <div className="container header-inner">
          <Link href="/" className="wordmark">
            HALDEN<span>audio</span>
          </Link>
          <nav className="nav">
            <Link href="/#speakers">Speakers</Link>
            <Link href="/products/halden-studio-reservation">Studio</Link>
            <Link href="/mailing-list">Newsletter</Link>
            <Link href="/cart" className="cart-link">
              Cart{hydrated && count > 0 ? <span className="cart-count">{count}</span> : null}
            </Link>
          </nav>
        </div>
      </header>
      <main>{children}</main>
      <footer className="site-footer">
        <div className="container footer-inner">
          <div>
            <div className="wordmark small">
              HALDEN<span>audio</span>
            </div>
            <p className="muted">Small-batch speakers, built and tuned in North Carolina.</p>
          </div>
          <div className="footer-links">
            <Link href="/privacy">Privacy</Link>
            <button type="button" className="link-button" onClick={openCookieSettings}>
              Cookie settings
            </button>
            <Link href="/mailing-list">Join the list</Link>
          </div>
        </div>
        <div className="container muted fine">© {new Date().getFullYear()} Halden Audio Co.</div>
      </footer>
    </>
  );
}
