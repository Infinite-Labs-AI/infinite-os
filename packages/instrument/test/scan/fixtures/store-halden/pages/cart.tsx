import Link from "next/link";
import Layout from "../components/Layout";
import { beginCheckout, type EventLine } from "../src/analytics/events";
import { formatPrice, getProduct } from "../src/catalog/products";
import { useCart } from "../src/cart/CartContext";

export default function CartPage() {
  const cart = useCart();

  const lines = cart.lines
    .map((l) => ({ product: getProduct(l.slug), qty: l.qty }))
    .filter((l): l is EventLine => Boolean(l.product));

  // One entry per unit, e.g. "halden-one,halden-one,halden-pair"
  const skus = lines.flatMap((l) => Array<string>(l.qty).fill(l.product.slug)).join(",");

  return (
    <Layout title="Your cart">
      <div className="container section narrow">
        <h1>Your cart</h1>

        {!cart.hydrated ? (
          <p className="muted">Loading your cart…</p>
        ) : lines.length === 0 ? (
          <div className="empty">
            <p>Your cart is empty.</p>
            <Link href="/#speakers" className="btn btn-primary">
              Browse speakers
            </Link>
          </div>
        ) : (
          <>
            <ul className="cart-lines">
              {lines.map(({ product, qty }) => (
                <li key={product.slug} className="cart-line">
                  <div>
                    <Link href={`/products/${product.slug}`} className="cart-line-name">
                      {product.name}
                    </Link>
                    <div className="muted fine">
                      {formatPrice(product.priceCents)}
                      {product.kind === "reservation" ? " deposit" : " each"}
                    </div>
                  </div>
                  <div className="qty">
                    <button type="button" aria-label="Decrease" onClick={() => cart.setQty(product.slug, qty - 1)}>
                      −
                    </button>
                    <span>{qty}</span>
                    <button type="button" aria-label="Increase" onClick={() => cart.setQty(product.slug, qty + 1)}>
                      +
                    </button>
                  </div>
                  <div className="cart-line-total">{formatPrice(product.priceCents * qty)}</div>
                  <button type="button" className="link-button" onClick={() => cart.remove(product.slug)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>

            <div className="cart-summary">
              <div className="cart-total">
                <span>Total</span>
                <strong>{formatPrice(cart.subtotalCents)}</strong>
              </div>
              <p className="muted fine">Shipping is free. Taxes are calculated at checkout.</p>
              <form method="POST" action="/api/checkout" onSubmit={() => beginCheckout(lines)}>
                <input type="hidden" name="skus" value={skus} />
                <button type="submit" className="btn btn-primary btn-block btn-large">
                  Checkout
                </button>
              </form>
              <p className="muted fine center">Secure payment by Stripe</p>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
