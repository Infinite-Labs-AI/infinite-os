import type { GetStaticPaths, GetStaticProps } from "next";
import Link from "next/link";
import { useEffect } from "react";
import Layout from "../../components/Layout";
import { addToCart, viewItem } from "../../src/analytics/events";
import { formatPrice, getProduct, PRODUCTS } from "../../src/catalog/products";
import { useCart } from "../../src/cart/CartContext";
import { infiniteLeaveAfter } from "../../lib/infinite-analytics";

interface Props {
  slug: string;
}

export default function ProductPage({ slug }: Props) {
  const cart = useCart();
  const product = getProduct(slug);

  useEffect(() => {
    if (product) viewItem(product);
  }, [product]);

  if (!product) return null;
  const isReservation = product.kind === "reservation";

  const onBuy = () =>
    infiniteLeaveAfter(
      () => {
        cart.add(product.slug);
        return addToCart(product);
      },
      () => window.location.assign("/cart")
    );

  return (
    <Layout title={product.name}>
      <div className="container section">
        <nav className="crumbs">
          <Link href="/">Home</Link> / <span>{product.name}</span>
        </nav>
        <div className="pdp">
          <div className="pdp-info">
            <p className="eyebrow">{isReservation ? "Listening room" : product.category}</p>
            <h1>{product.name}</h1>
            <p className="pdp-price">
              {formatPrice(product.priceCents)}
              {isReservation ? <span className="muted"> deposit</span> : null}
            </p>
            <p className="lede">{product.tagline}</p>
            <p>{product.description}</p>
            <ul className="features">
              {product.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <button type="button" className="btn btn-primary btn-large" data-infinite-conversion="add_to_cart" onClick={onBuy}>
              {isReservation ? "Reserve" : "Buy"}
            </button>
            <p className="muted fine">
              {isReservation
                ? "We will email within one business day to pick a time."
                : "Ships in 3 to 5 business days. Free US shipping."}
            </p>
          </div>
        </div>
      </div>
    </Layout>
  );
}

export const getStaticPaths: GetStaticPaths = async () => ({
  paths: PRODUCTS.map((p) => ({ params: { slug: p.slug } })),
  fallback: false,
});

export const getStaticProps: GetStaticProps<Props> = async ({ params }) => {
  const slug = typeof params?.slug === "string" ? params.slug : "";
  if (!getProduct(slug)) return { notFound: true };
  return { props: { slug } };
};
