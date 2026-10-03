import { cookies } from "next/headers"

import { createUser, SESSION_COOKIE, startSession } from "@/lib/users"

export async function POST(request: Request) {
  const { email, password } = (await request.json()) as { email?: string; password?: string }
  const user = createUser(email ?? "", password ?? "")
  if (!user) return Response.json({ ok: false }, { status: 400 })
  ;(await cookies()).set(SESSION_COOKIE, startSession(user), { httpOnly: true, sameSite: "lax", path: "/" })
  return Response.json({ ok: true, accountId: user.id })
}
