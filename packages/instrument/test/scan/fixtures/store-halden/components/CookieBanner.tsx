import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { acceptTracking, declineTracking, getConsent, OPEN_COOKIE_SETTINGS_EVENT } from "../src/analytics/tracking";

export default function CookieBanner() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (getConsent() === "unset") setOpen(true);
    const reopen = () => setOpen(true);
    window.addEventListener(OPEN_COOKIE_SETTINGS_EVENT, reopen);
    return () => window.removeEventListener(OPEN_COOKIE_SETTINGS_EVENT, reopen);
  }, []);

  if (!open) return null;

  return (
    <div className="cookie-banner" role="dialog" aria-live="polite" aria-label="Cookie preferences">
      <p>
        We use cookies to understand how people find us and to improve the shop. You can say no and everything still
        works. <Link href="/privacy">Privacy policy</Link>
      </p>
      <div className="cookie-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            declineTracking();
            setOpen(false);
          }}
        >
          Decline
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            acceptTracking(router.asPath);
            setOpen(false);
          }}
        >
          Accept
        </button>
      </div>
    </div>
  );
}
