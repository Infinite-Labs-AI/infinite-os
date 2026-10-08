import { createHmac } from "node:crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import { adMatchFromRequest, reportInfiniteOutcome } from "../../lib/infinite-outcome";

const ALLOWED_INTERESTS = new Set(["new-releases", "studio-events", "care-and-repair"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function redact(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

/** One stable id per subscriber, keyed with a secret only this site holds (never the address itself). */
function subscriberId(email: string): string {
  return createHmac("sha256", process.env.LEAD_ID_SECRET ?? "").update(email).digest("hex").slice(0, 32);
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

  // The signup is real now. The form says whether the visitor allowed tracking; only then does the lead carry the
  // hashed email and the subscriber id for Meta.
  const id = subscriberId(email);
  void reportInfiniteOutcome({
    type: "lead",
    eventId: `lead:${id}`,
    path: "/mailing-list",
    adMatch: await adMatchFromRequest(req, { trackingAllowed: body.adMatch === true, email, externalId: id }),
  });

  res.status(200).json({ ok: true });
}
