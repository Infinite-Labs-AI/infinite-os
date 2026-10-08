import Layout from "../components/Layout";

export default function PrivacyPage() {
  return (
    <Layout title="Privacy">
      <div className="container section narrow prose">
        <h1>Privacy policy</h1>
        <p className="muted">Last updated October 2026</p>
        <p>
          Halden Audio Co. collects only what we need to sell you speakers and keep in touch if you ask us to. This page
          explains what that is.
        </p>
        <h2>Orders</h2>
        <p>
          Payments are handled by Stripe. We receive your name, email, shipping address and what you bought. We never see
          or store your card number.
        </p>
        <h2>Mailing list</h2>
        <p>
          If you join the list we keep your email and the topics you picked. Every email has an unsubscribe link, and we
          delete your address when you use it.
        </p>
        <h2>Cookies and analytics</h2>
        <p>
          With your permission we use Google Analytics, PostHog and the Meta pixel to understand how visitors find and use
          the shop. Nothing loads until you accept the cookie banner, and you can change your choice any time from the
          “Cookie settings” link in the footer.
        </p>
        <h2>Contact</h2>
        <p>Questions about your data: privacy@halden-audio.example.</p>
      </div>
    </Layout>
  );
}
