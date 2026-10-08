import { useRouter } from "next/router";
import { useEffect } from "react";
import { purchaseEvent } from "../src/common/analytics";

export default function Success() {
  const router = useRouter();
  const sessionId = typeof router.query.session_id === "string" ? router.query.session_id : "";
  useEffect(() => {
    if (!router.isReady || !sessionId) return;
    const key = `purchase:${sessionId}`;
    if (!window.sessionStorage.getItem(key)) {
      window.sessionStorage.setItem(key, "1");
      purchaseEvent(sessionId, ["lamp"]);
    }
  }, [router.isReady, sessionId]);
  return <p>Thank you for your order.</p>;
}
