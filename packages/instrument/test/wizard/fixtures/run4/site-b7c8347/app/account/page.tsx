import { cookies } from "next/headers"
import Link from "next/link"

import { SESSION_COOKIE, sessionFromCookie } from "@/lib/users"

import { LogoutButton } from "./logout-button"

export const dynamic = "force-dynamic"

export default async function Account() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  const user = sessionFromCookie(token)

  if (!user) {
    return (
      <main>
        <h1>You are signed out</h1>
        <div className="cta-row">
          <Link href="/login" className="button">
            Log in
          </Link>
          <Link href="/signup" className="button ghost">
            Start free trial
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main>
      <h1>Welcome, {user.email}</h1>
      <p className="muted">Your free trial is active. Account id: {user.id}</p>
      <LogoutButton />
    </main>
  )
}
