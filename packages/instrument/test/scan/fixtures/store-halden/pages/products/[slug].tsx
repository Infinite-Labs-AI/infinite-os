import type { GetStaticPaths, GetStaticProps } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect } from "react";
import Layout from "../../components/Layout";
import ProductArt from "../../components/ProductArt";
import { addToCart, viewItem } from "../../src/analytics/events";
import { formatPrice, getProduct, PRODUCTS } from "../../src/catalog/products";
import { useCart } from "../../src/cart/CartContext";

interface Props {
  slug: string;
}

export default function ProductPage({ slug }: Props) {
  const router = useRouter();
  const cart = useCart();
  const product = getProduct(slug);

  useEffect(() => {
    if (product) viewItem(product);
  }, [product]);

  if (!product) return null;
  const isReservation = product.kind === "reservation";

  const onBuy = () => {
    cart.add(product.slug);
    addToCart(product);
    void router.push("/cart");
  };

  return (
    <Layout title={product.name}>
      <div className="container section">
        <nav className="crumbs">
          <Link href="/">Home</Link> / <span>{product.name}</span>
        </nav>
        <div className="pdp">
          <div className="pdp-art">
            <ProductArt product={product} />
          </div>
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
            <button type="button" className="btn btn-primary btn-large" onClick={onBuy}>
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
