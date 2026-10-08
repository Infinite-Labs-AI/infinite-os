import { useState, type FormEvent } from "react";
import Layout from "../components/Layout";
import { generateLead } from "../src/analytics/events";
import { getConsent } from "../src/analytics/tracking";

const INTERESTS = [
  { id: "new-releases", label: "New speakers and limited runs" },
  { id: "studio-events", label: "Listening room evenings" },
  { id: "care-and-repair", label: "Care, repair and firmware notes" },
];

type Status = "idle" | "sending" | "done" | "error";

export default function MailingListPage() {
  const [email, setEmail] = useState("");
  const [interests, setInterests] = useState<string[]>(["new-releases"]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  const toggle = (id: string) =>
    setInterests((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setStatus("sending");
    setError("");
    try {
      const res = await fetch("/api/mailing-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, interests, adMatch: getConsent() === "granted" }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Something went wrong. Please try again.");
        setStatus("error");
        return;
      }
      generateLead(interests);
      setStatus("done");
    } catch {
      setError("Could not reach the server. Please try again.");
      setStatus("error");
    }
  };

  return (
    <Layout title="Mailing list">
      <div className="container section narrow">
        <p className="eyebrow">The Halden letter</p>
        <h1>One email a month. No noise.</h1>
        <p className="lede">New runs sell out fast. Members hear first, and get early access to listening room dates.</p>

        {status === "done" ? (
          <div className="notice">
            <strong>You are on the list.</strong> Look out for a welcome note from us.
          </div>
        ) : (
          <form className="form" onSubmit={onSubmit} noValidate>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                name="email"
                autoComplete="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <fieldset className="field">
              <legend>I would like to hear about</legend>
              {INTERESTS.map((i) => (
                <label key={i.id} className="check">
                  <input
                    type="checkbox"
                    name="interests"
                    value={i.id}
                    checked={interests.includes(i.id)}
                    onChange={() => toggle(i.id)}
                  />
                  {i.label}
                </label>
              ))}
            </fieldset>
            {error ? <p className="form-error">{error}</p> : null}
            <button type="submit" className="btn btn-primary btn-large" disabled={status === "sending"}>
              {status === "sending" ? "Joining…" : "Join the list"}
            </button>
            <p className="muted fine">Unsubscribe any time. We never sell your email.</p>
          </form>
        )}
      </div>
    </Layout>
  );
}
