import { supabase } from "../../../lib/supabase"

export async function POST(request: Request) {
  const { email, password } = (await request.json()) as { email: string; password: string }
  const { data, error } = await supabase.auth.signUp({ email, password })
  if (error || !data.user) return Response.json({ ok: false }, { status: 400 })
  return Response.json({ ok: true, accountId: data.user.id })
}
