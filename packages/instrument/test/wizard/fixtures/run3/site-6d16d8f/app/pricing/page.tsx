import Link from "next/link"

const plans = [
  { name: "Starter", price: "$0", blurb: "For trying it out." },
  { name: "Pro", price: "$12/mo", blurb: "For people who plan every week." },
  { name: "Team", price: "$29/mo", blurb: "Shared calendars for small teams." }
]

export default function Pricing() {
  return (
    <main>
      <h1>Pricing</h1>
      <p className="muted">Every plan starts with a 14-day free trial.</p>
      <div className="grid">
        {plans.map((plan) => (
          <div className="card" key={plan.name}>
            <h3>{plan.name}</h3>
            <div className="price">{plan.price}</div>
            <p className="muted">{plan.blurb}</p>
            <Link href={`/signup?plan=${plan.name.toLowerCase()}`} className="button small">
              Start free trial
            </Link>
          </div>
        ))}
      </div>
    </main>
  )
}
