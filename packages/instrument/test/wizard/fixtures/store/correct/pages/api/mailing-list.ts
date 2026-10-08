import type { NextApiRequest, NextApiResponse } from "next";
import { reportInfiniteLead } from "../../lib/infinite-outcome";

const ALLOWED_INTERESTS = new Set(["new-releases", "studio-events", "care-and-repair"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function redact(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = (req.body ?? {}) as { email?: unknown; interests?: unknown; adMatch?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) {
    res.status(400).json({ error: "Please enter a valid email address." });
    return;
  }

  const interests = Array.isArray(body.interests)
    ? body.interests.filter((i): i is string => typeof i === "string" && ALLOWED_INTERESTS.has(i))
    : [];

  // No email provider wired up yet: log it so we can import the list later.
  console.log(`[mailing-list] signup ${redact(email)} interests=${interests.join("|") || "none"}`);

  // Once the sign-up is REAL (stored, subscribed), never on the click:
  await reportInfiniteLead(req, {
    type: "lead",
    email, // the submitted address: hashed in the helper, never sent, stored or logged
    trackingAllowed: body.adMatch === true, // the page's signal that the visitor allowed tracking
    fallbackPath: "/mailing-list", // used when the request carries no same-site Referer
  });

  res.status(200).json({ ok: true });
}
