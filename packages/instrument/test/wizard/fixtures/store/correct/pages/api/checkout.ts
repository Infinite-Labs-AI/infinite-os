import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { getProduct, parseSkuList } from "../../src/catalog/products";
import { adMatchFromRequest, reportInfiniteOutcome, type InfiniteAdMatch } from "../../lib/infinite-outcome";

/**
 * Direct buy links we send to existing customers (email, SMS, support replies).
 * They skip the cart and go straight to Stripe.
 *   /api/checkout?existing=<token>
 */
const DIRECT_BUY_LINKS: Record<string, string> = {
  "owner-second-speaker": "halden-one",
  "owner-upgrade-pair": "halden-pair",
  "owner-studio-visit": "halden-studio-reservation",
};

function originOf(req: NextApiRequest): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:3000";
  return `${proto}://${host}`;
}

/** The buyer's own ad-click context, carried to the Stripe webhook (it reports the purchase from Stripe's request). */
function matchMetadata(adMatch: InfiniteAdMatch): Record<string, string> {
  return {
    infinite_fbc: adMatch.fbc ?? "",
    infinite_fbp: adMatch.fbp ?? "",
    infinite_ip: adMatch.client_ip_address ?? "",
    infinite_ua: adMatch.client_user_agent ?? "",
  };
}

let stripeClient: Stripe | null = null;
function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!stripeClient) stripeClient = new Stripe(key);
  return stripeClient;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  let rawSkus: string | string[] | undefined;
  let source: "cart" | "direct_link";

  if (req.method === "POST") {
    rawSkus = (req.body as { skus?: string | string[] } | undefined)?.skus;
    source = "cart";
  } else if (req.method === "GET" && typeof req.query.existing === "string") {
    rawSkus = DIRECT_BUY_LINKS[req.query.existing];
    source = "direct_link";
    if (!rawSkus) {
      res.status(404).send("This link has expired. Please visit the shop.");
      return;
    }
  } else {
    res.setHeader("Allow", "GET, POST");
    res.status(405).send("Method not allowed");
    return;
  }

  const lines = parseSkuList(rawSkus);
  if (lines.length === 0) {
    res.redirect(303, "/cart");
    return;
  }

  const stripe = getStripe();
  if (!stripe) {
    console.error("[checkout] STRIPE_SECRET_KEY is not set");
    res.status(500).send("Checkout is not configured.");
    return;
  }

  const skuList = lines.flatMap((l) => Array<string>(l.qty).fill(l.slug)).join(",");
  const origin = originOf(req);
  // The cart form says whether the visitor allowed tracking; only then does match data ride along.
  const trackingAllowed = (req.body as { adMatch?: string } | undefined)?.adMatch === "1";
  const adMatch = await adMatchFromRequest(req, { trackingAllowed });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lines.map(({ slug, qty }) => {
        const product = getProduct(slug)!;
        return {
          quantity: qty,
          price_data: {
            currency: "usd",
            unit_amount: product.priceCents,
            product_data: {
              name: product.name,
              description: product.tagline,
              metadata: { sku: product.slug },
            },
          },
        };
      }),
      shipping_address_collection: { allowed_countries: ["US"] },
      metadata: { skus: lines.map((l) => l.slug).join(","), source, ...matchMetadata(adMatch) },
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}&skus=${encodeURIComponent(skuList)}`,
      cancel_url: `${origin}/cart`,
    });

    if (!session.url) {
      res.status(500).send("Stripe did not return a checkout URL.");
      return;
    }
    // Sent beside the redirect: it never blocks the buyer, and it never throws.
    void reportInfiniteOutcome({
      type: "begin_checkout",
      eventId: `begin_checkout:${session.id}`,
      path: "/cart",
      properties: {
        value: (session.amount_total ?? 0) / 100,
        currency: (session.currency ?? "usd").toUpperCase(),
        content_ids: lines.map((l) => l.slug).join(","),
        num_items: lines.reduce((n, l) => n + l.qty, 0),
      },
      adMatch,
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error("[checkout] failed to create session", err instanceof Error ? err.message : err);
    res.status(500).send("Could not start checkout. Please try again.");
  }
}
