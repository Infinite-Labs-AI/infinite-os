import type { NextApiRequest, NextApiResponse } from "next";

const ALLOWED_INTERESTS = new Set(["new-releases", "studio-events", "care-and-repair"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function redact(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = (req.body ?? {}) as { email?: unknown; interests?: unknown };
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

  res.status(200).json({ ok: true });
}
