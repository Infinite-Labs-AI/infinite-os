/**
 * Funnel events. GA4 for the funnel reports, PostHog for product analytics.
 * We track counts of each step; revenue lives in Stripe.
 */
import type { Product } from "../catalog/products";
import { infiniteTrack } from "../../lib/infinite-analytics";
import { capturePosthog, sendGa } from "./tracking";

export interface EventLine {
  product: Product;
  qty: number;
}

function gaItem(product: Product, qty?: number) {
  return {
    item_id: product.slug,
    item_name: product.name,
    item_category: product.category,
    ...(qty && qty > 1 ? { quantity: qty } : {}),
  };
}

/**
 * Meta and Infinite get the product events with the product and its price. GA4 and PostHog already get them from
 * the calls above, so they are left out of these: one event per tool, never two.
 */
function productProps(product: Product, qty = 1) {
  return { item_id: product.slug, item_name: product.name, price: product.priceCents / 100, quantity: qty, currency: "USD" };
}

export function viewItem(product: Product) {
  sendGa("view_item", { items: [gaItem(product)] });
  capturePosthog("product_viewed", { sku: product.slug, name: product.name, category: product.category });
  infiniteTrack("view_item", productProps(product), { destinations: ["meta", "infinite"] });
}

export function addToCart(product: Product, qty = 1) {
  sendGa("add_to_cart", { items: [gaItem(product, qty)] });
  capturePosthog("product_added", { sku: product.slug, name: product.name, quantity: qty });
  infiniteTrack("add_to_cart", productProps(product, qty), { destinations: ["meta", "infinite"] });
}

export function beginCheckout(lines: EventLine[]) {
  sendGa("begin_checkout", { items: lines.map((l) => gaItem(l.product, l.qty)) });
  capturePosthog("checkout_started", {
    skus: lines.map((l) => l.product.slug),
    item_count: lines.reduce((n, l) => n + l.qty, 0),
  });
}

export function purchase(sessionId: string, lines: EventLine[]) {
  sendGa("purchase", {
    transaction_id: sessionId,
    items: lines.map((l) => gaItem(l.product, l.qty)),
  });
  capturePosthog("purchase_completed", {
    session_id: sessionId,
    skus: lines.map((l) => l.product.slug),
  });
}

export function generateLead(interests: string[]) {
  sendGa("generate_lead", { lead_source: "mailing_list", interests: interests.join(",") });
  capturePosthog("mailing_list_joined", { interests });
}
