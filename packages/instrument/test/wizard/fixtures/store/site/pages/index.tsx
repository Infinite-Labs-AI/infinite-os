import Link from "next/link";
import { useRouter } from "next/router";
import Layout from "../components/Layout";
import { addToCart } from "../src/analytics/events";
import { formatPrice, getProduct, STOREFRONT_SLUGS, type Product } from "../src/catalog/products";
import { useCart } from "../src/cart/CartContext";

const storefront = STOREFRONT_SLUGS.map((slug) => getProduct(slug)).filter((p): p is Product => Boolean(p));

export default function Home() {
  const router = useRouter();
  const cart = useCart();

  const buy = (product: Product) => {
    cart.add(product.slug);
    addToCart(product);
    void router.push("/cart");
  };

  return (
    <Layout>
      <section className="hero">
        <div className="container hero-inner">
          <div>
            <p className="eyebrow">Made by hand in small batches</p>
            <h1>Honest sound from solid wood.</h1>
            <p className="lede">
              Halden speakers are built one at a time from oak and paper cones, tuned by ear, and made to sit in a
              living room for twenty years.
            </p>
            <div className="hero-actions">
              <Link href="#speakers" className="btn btn-primary">
                Shop speakers
              </Link>
              <Link href="/products/halden-studio-reservation" className="btn btn-ghost">
                Book a listening session
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section id="speakers" className="container section">
        <h2>The speakers</h2>
        <div className="product-grid">
          {storefront.map((product) => (
            <article key={product.slug} className="product-card">
              <div className="product-card-body">
                <div className="product-card-head">
                  <h3>
                    <Link href={`/products/${product.slug}`}>{product.name}</Link>
                  </h3>
                  <span className="price">{formatPrice(product.priceCents)}</span>
                </div>
                <p className="muted">{product.tagline}</p>
                <button type="button" className="btn btn-primary btn-block" onClick={() => buy(product)}>
                  Buy
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

    </Layout>
  );
}
