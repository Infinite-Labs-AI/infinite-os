import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { adMatchFromRequest, reportInfiniteOutcome } from "../../lib/infinite-outcome";

export const config = { api: { bodyParser: false } };

async function rawBody(req: NextApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

/**
 * The buyer's match data for Meta: the ad-click context the checkout route saved on the session (only when the
 * visitor allowed tracking), plus the payer's own details from Stripe, hashed by the helper before anything leaves.
 */
async function buyerMatch(session: Stripe.Checkout.Session) {
  const saved = session.metadata ?? {};
  const cookie = [saved.infinite_fbc ? `_fbc=${saved.infinite_fbc}` : "", saved.infinite_fbp ? `_fbp=${saved.infinite_fbp}` : ""].filter(Boolean).join("; ");
  const details = session.customer_details;
  return adMatchFromRequest(
    { headers: { cookie, "user-agent": saved.infinite_ua ?? "", "x-forwarded-for": saved.infinite_ip ?? "" } },
    {
      trackingAllowed: Boolean(saved.infinite_ua),
      email: details?.email ?? undefined,
      fullName: details?.name ?? undefined,
      city: details?.address?.city ?? undefined,
      state: details?.address?.state ?? undefined,
      postcode: details?.address?.postal_code ?? undefined,
      country: details?.address?.country ?? undefined,
    },
  );
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const key = process.env.STRIPE_SECRET_KEY;
  // Does nothing until the site is set up, so Stripe never retries for days before then.
  if (!secret || !key || !process.env.INFINITE_SERVER_LANE_SECRET) {
    res.status(200).json({ skipped: true });
    return;
  }
  let event: Stripe.Event;
  try {
    event = new Stripe(key).webhooks.constructEvent(await rawBody(req), String(req.headers["stripe-signature"] ?? ""), secret);
  } catch {
    res.status(400).send("Bad signature");
    return;
  }
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    res.status(200).json({ ignored: event.type });
    return;
  }
  const session = event.data.object as Stripe.Checkout.Session;
  // Test payments and sessions this site did not create are not purchases.
  if (!session.livemode || session.payment_status !== "paid" || !session.metadata?.skus) {
    res.status(200).json({ ignored: "not a paid order of this shop" });
    return;
  }
  const report = await reportInfiniteOutcome({
    type: "purchase",
    eventId: `purchase:${session.id}`,
    path: "/success",
    properties: {
      value: (session.amount_total ?? 0) / 100,
      currency: (session.currency ?? "usd").toUpperCase(),
      content_ids: session.metadata.skus,
    },
    adMatch: await buyerMatch(session),
  });
  // Not delivered, or Infinite asked to try again: Stripe retries the webhook.
  if (report.status === null || report.status >= 500 || report.status === 401 || report.status === 403 || report.status === 429) {
    res.status(500).json({ retry: true });
    return;
  }
  res.status(200).json({ ok: true });
}
