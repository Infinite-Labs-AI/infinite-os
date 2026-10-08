// Stripe → Infinite: each paid checkout is reported once, as a purchase, and Infinite relays it to Meta.
// Stripe endpoint: https://<your-domain>/api/stripe-webhook, events checkout.session.completed + checkout.session.async_payment_succeeded.
// STRIPE_WEBHOOK_SECRET is that endpoint's signing secret (Stripe → Developers → Webhooks).
// Inert until Infinite's environment variables are set: it answers 200 and reports nothing.
import type { NextApiRequest, NextApiResponse } from "next"
import Stripe from "stripe"
import { reportStripeCheckoutPurchase } from "../../lib/infinite-outcome"

// Use the site's existing Stripe client here instead, if it already has one.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "")

// Stripe signs the raw bytes, so Next must not parse the body.
export const config = { api: { bodyParser: false } }

async function rawBody(req: NextApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST")
    return res.status(405).end()
  }
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(await rawBody(req), String(req.headers["stripe-signature"] ?? ""), process.env.STRIPE_WEBHOOK_SECRET ?? "")
  } catch {
    return res.status(400).end() // not signed by Stripe
  }
  // 500 only when a retry can deliver the report; 200 for everything else (test mode, other sessions, before setup).
  return res.status(await reportStripeCheckoutPurchase(event, { path: "/success" })).json({ received: true })
}
