import { useState } from "react";
import { generateLead } from "../src/common/analytics";

export default function MailingListForm() {
  const [email, setEmail] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/mailing-list", { method: "POST", body: JSON.stringify({ email }) });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.success) {
      generateLead(["lamps"]);
    }
  };
  return <form onSubmit={submit}><input value={email} onChange={(e) => setEmail(e.target.value)} /></form>;
}
