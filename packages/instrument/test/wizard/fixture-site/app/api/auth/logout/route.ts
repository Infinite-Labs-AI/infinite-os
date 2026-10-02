import { supabase } from "../../../../lib/supabase"

export async function POST() {
  await supabase.auth.signOut()
  return Response.json({ ok: true })
}
