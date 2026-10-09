import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect } from "react";
import Layout from "../components/Layout";
import { purchase, type EventLine } from "../src/analytics/events";
import { getProduct, parseSkuList } from "../src/catalog/products";
import { useCart } from "../src/cart/CartContext";

export default function SuccessPage() {
  const router = useRouter();
  const { clear, hydrated } = useCart();

  const sessionId = typeof router.query.session_id === "string" ? router.query.session_id : "";
  const lines = parseSkuList(router.query.skus)
    .map((l) => ({ product: getProduct(l.slug), qty: l.qty }))
    .filter((l): l is EventLine => Boolean(l.product));
  const isReservation = lines.length > 0 && lines.every((l) => l.product.kind === "reservation");

  useEffect(() => {
    if (!router.isReady || !sessionId) return;
    const key = `halden_purchase_tracked_${sessionId}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      // no sessionStorage: track anyway
    }
    purchase(sessionId, lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, sessionId]);

  useEffect(() => {
    if (hydrated && sessionId) clear();
  }, [hydrated, sessionId, clear]);

  return (
    <Layout title="Thank you">
      <div className="container section narrow center">
        <div className="success-mark" aria-hidden="true">
          ✓
        </div>
        <h1>{isReservation ? "Your session is reserved." : "Thank you for your order."}</h1>
        <p className="lede">
          {isReservation
            ? "We will email you within one business day to pick a time in the listening room."
            : "A receipt is on its way to your inbox. We will email tracking as soon as your speakers leave the bench."}
        </p>
        {lines.length > 0 ? (
          <ul className="success-lines">
            {lines.map((l) => (
              <li key={l.product.slug}>
                {l.qty} × {l.product.name}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="hero-actions center-row">
          <Link href="/" className="btn btn-ghost">
            Back to the shop
          </Link>
          <Link href="/mailing-list" className="btn btn-primary">
            Join the mailing list
          </Link>
        </div>
        {sessionId ? <p className="muted fine">Order reference {sessionId.slice(-10)}</p> : null}
      </div>
    </Layout>
  );
}
