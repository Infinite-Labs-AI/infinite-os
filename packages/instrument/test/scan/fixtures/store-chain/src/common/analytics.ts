import { capturePostHog, trackGoogleEvent } from "./tracking";

type Sku = "lamp" | "lamp-pair";

// Core send. No-ops unless analytics consent is given.
function track(event: string, params?: Record<string, unknown>): boolean {
  return trackGoogleEvent(event, params);
}

export function viewItem(sku: Sku): boolean {
  return track("view_item", { items: [{ item_id: sku }] });
}

export function addToCartEvent(sku: Sku): void {
  track("add_to_cart", { items: [{ item_id: sku }] });
  void capturePostHog("product_added_to_cart", { product_sku: sku });
}

export function beginCheckout(skus: Sku[], onComplete: () => void): void {
  track("begin_checkout", { items: skus.map((sku) => ({ item_id: sku })), event_callback: onComplete });
  void capturePostHog("checkout_started", { product_skus: skus }, true);
}

export function purchaseEvent(transactionId: string, skus: string[]): void {
  track("purchase", { transaction_id: transactionId, items: skus.map((sku) => ({ item_id: sku })) });
  void capturePostHog("purchase_completed", { product_skus: skus }, true);
}

export function generateLead(interests: string[]): void {
  track("generate_lead", { method: "mailing_list", lead_interests: interests.join(",") });
  void capturePostHog("mailing_list_joined", { interests }, true);
}
