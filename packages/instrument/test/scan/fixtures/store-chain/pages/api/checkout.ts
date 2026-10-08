import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      line_items: [{ price: process.env.STRIPE_LAMP_PRICE_ID, quantity: Number(req.query.lamp ?? 1) }],
      success_url: `https://shop.example.com/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://shop.example.com/cart`,
    };
    const session = await stripe.checkout.sessions.create(params);
    if (!session.url) return res.status(500).json({ error: "Could not start checkout" });
    return res.redirect(303, session.url);
  } catch (err) {
    return res.status(500).json({ error: "Checkout failed" });
  }
}
