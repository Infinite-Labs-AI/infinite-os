"use client"

import Link from "next/link"
import { useState } from "react"

export default function Signup() {
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const form = new FormData(event.currentTarget)
    const response = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(form))
    })
    if (response.ok) window.location.assign("/account")
    else setError("Could not create that account. Use a new email and a password of 6+ characters.")
  }

  return (
    <main>
      <h1>Start your free trial</h1>
      <p className="muted">14 days free. No card needed.</p>
      <form onSubmit={onSubmit}>
        <input name="email" type="email" placeholder="you@example.com" required />
        <input name="password" type="password" placeholder="Password (6+ characters)" required />
        <button type="submit" className="button">
          Create account
        </button>
        {error ? <p className="error">{error}</p> : null}
      </form>
      <p className="muted">
        Already have an account? <Link href="/login">Log in</Link>
      </p>
    </main>
  )
}
