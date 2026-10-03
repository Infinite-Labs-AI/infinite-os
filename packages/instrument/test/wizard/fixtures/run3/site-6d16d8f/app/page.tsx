import Link from "next/link"

export default function Home() {
  return (
    <main>
      <h1>Plan your week in minutes.</h1>
      <p className="muted">Smoke Co. turns your to-do pile into a calendar you will actually follow.</p>
      <div className="cta-row">
        <Link href="/signup" className="button">
          Start free trial
        </Link>
        <Link href="/pricing" className="button ghost">
          See pricing
        </Link>
      </div>
      <div className="grid">
        <div className="card">
          <h3>Auto-schedule</h3>
          <p className="muted">Drop in tasks and we find the time.</p>
        </div>
        <div className="card">
          <h3>Focus blocks</h3>
          <p className="muted">Protect deep work from meetings.</p>
        </div>
        <div className="card">
          <h3>Weekly review</h3>
          <p className="muted">See what got done and what slipped.</p>
        </div>
      </div>
    </main>
  )
}
