// An in-memory user store. No database: it resets whenever the server process restarts, which is
// fine for a throwaway test site.
import { randomUUID } from "node:crypto"

export type User = { id: string; email: string; password: string; createdAt: string }

const users = new Map<string, User>()

export const SESSION_COOKIE = "smoke_session"

export function createUser(email: string, password: string): User | null {
  const key = email.trim().toLowerCase()
  if (!key || password.length < 6 || users.has(key)) return null
  const user: User = { id: `acct_${randomUUID()}`, email: key, password, createdAt: new Date().toISOString() }
  users.set(key, user)
  return user
}

export function verifyUser(email: string, password: string): User | null {
  const user = users.get(email.trim().toLowerCase())
  return user && user.password === password ? user : null
}

// The session cookie carries the account id and email itself (unsigned: this is a test site), so the
// account page still works when Vercel serves it from a different instance than the signup.
export type Session = { id: string; email: string }

export function startSession(user: User): string {
  return Buffer.from(JSON.stringify({ id: user.id, email: user.email })).toString("base64url")
}

export function sessionFromCookie(token: string | undefined): Session | null {
  if (!token) return null
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Partial<Session>
    return typeof parsed.id === "string" && typeof parsed.email === "string" ? { id: parsed.id, email: parsed.email } : null
  } catch {
    return null
  }
}
