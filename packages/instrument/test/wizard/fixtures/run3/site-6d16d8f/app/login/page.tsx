"use client"

import Link from "next/link"
import { useState } from "react"

export default function Login() {
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const form = new FormData(event.currentTarget)
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(form))
    })
    if (response.ok) window.location.assign("/account")
    else setError("Wrong email or password.")
  }

  return (
    <main>
      <h1>Log in</h1>
      <form onSubmit={onSubmit}>
        <input name="email" type="email" placeholder="you@example.com" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit" className="button">
          Log in
        </button>
        {error ? <p className="error">{error}</p> : null}
      </form>
      <p className="muted">
        New here? <Link href="/signup">Start free trial</Link>
      </p>
    </main>
  )
}
