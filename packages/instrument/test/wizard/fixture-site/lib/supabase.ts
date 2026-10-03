// A stand-in for the site's Supabase client (the fixture's build never resolves it).
type AuthResult = { data: { user: { id: string } | null }; error: Error | null }

export const supabase = {
  auth: {
    signUp: async (input: { email: string; password: string }): Promise<AuthResult> => ({ data: { user: { id: `acct_${input.email.length}` } }, error: null }),
    signInWithPassword: async (input: { email: string; password: string }): Promise<AuthResult> => ({ data: { user: { id: `acct_${input.email.length}` } }, error: null }),
    signOut: async (): Promise<{ error: Error | null }> => ({ error: null })
  }
}
