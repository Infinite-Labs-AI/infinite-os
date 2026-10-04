// Job 9 (`identify_reset`) trigger detector (lane O8): a login exists, so visits can be joined to
// accounts — `infiniteIdentify(accountId)` after a VERIFIED login, `infiniteReset()` in EVERY logout.
//
// - `login`: the success path of a sign-in (password, OTP verify, magic link, OAuth code exchange).
//   An OAuth return counts only when the file EXCHANGES the code with an auth call: a `?code=` promo or
//   referral route is not a login.
// - `logout`: every sign-out / logout call or handler, and every file-routed logout route.
// - `clientHooks`: the client auth state hooks where an identify can run once the session is known.
// Test, story, mock and fixture files are never evidence (a `signOut` in a test is ignored).
import type { RepoSnapshot } from "../repo-files.js"
import { codeMatches, isCodeFile, isNonProductPath, routePathOf, sortFindings, type Finding } from "./shared.js"

export interface AuthDetection {
  login: Finding[]
  logout: Finding[]
  clientHooks: Finding[]
}

const LOGIN_PATTERNS: Array<{ detail: string; pattern: RegExp }> = [
  { detail: "password sign-in", pattern: /\.auth\s*\.\s*signInWith(?:Password|IdToken)\s*\(/g },
  { detail: "OTP verify", pattern: /\.auth\s*\.\s*verifyOtp\s*\(/g },
  { detail: "Firebase sign-in", pattern: /\bsignInWith(?:EmailAndPassword|Popup|Redirect|EmailLink|Credential)\s*\(/g },
  { detail: "Auth.js signIn callback", pattern: /\b(?:callbacks|events)\s*:\s*\{[\s\S]{0,400}?\bsignIn\s*[:(]/g },
  { detail: "Better Auth sign-in", pattern: /\.api\s*\.\s*signIn(?:Email|Social|Username)\s*\(/g },
  { detail: "session created on login", pattern: /\b(?:lucia|auth)\s*\.\s*createSession\s*\(/g },
  { detail: "Clerk sign-in complete", pattern: /\bsetActive\s*\(\s*\{\s*session\b/g }
]

const OAUTH_EXCHANGE = /\bexchangeCodeForSession\s*\(|\bgetToken\s*\(\s*(?:code|\{)|\bvalidateAuthorizationCode\s*\(|grant_type["'`]?\s*[:=,]\s*["'`]authorization_code/
const CODE_PARAM = /\bsearchParams\s*\.\s*get\s*\(\s*["'`]code["'`]\s*\)|\bquery\s*\.\s*code\b|\burl\s*\.\s*searchParams\s*\.\s*get\s*\(\s*["'`]code["'`]/

const LOGOUT_CALL = /\b(?:signOut|signout|logOut|logout)\s*\(|\.auth\s*\.\s*signOut\s*\(|\b(?:invalidateSession|destroySession|invalidateUserSessions)\s*\(|\bsession\s*\.\s*destroy\s*\(|\breq\s*\.\s*logout\s*\(/g
const LOGOUT_ROUTE = /(?:^|\/)(?:log-?out|sign-?out)(?:\/|$)/i

const CLIENT_HOOKS = /\b(?:onAuthStateChange|onAuthStateChanged|onIdTokenChanged)\s*\(|\buse(?:Session|User|Auth)\s*\(\s*\)/g

/** Pure. */
export function detectAuth(snapshot: RepoSnapshot): AuthDetection {
  const login: Finding[] = []
  const logout: Finding[] = []
  const clientHooks: Finding[] = []
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path) || !isCodeFile(path)) continue
    for (const { detail, pattern } of LOGIN_PATTERNS) {
      const match = codeMatches(text, new RegExp(pattern.source, "g"))[0]
      if (match) login.push({ file: path, line: match.line, detail })
    }
    if (CODE_PARAM.test(text) && OAUTH_EXCHANGE.test(text)) {
      const exchange = codeMatches(text, /\bexchangeCodeForSession\s*\(|\bgetToken\s*\(|\bvalidateAuthorizationCode\s*\(/g)[0]
      if (exchange) login.push({ file: path, line: exchange.line, detail: "OAuth code exchange" })
    }
    for (const match of codeMatches(text, LOGOUT_CALL)) {
      // A function DEFINITION named logout is a handler too; a call is the sign-out itself.
      logout.push({ file: path, line: match.line, detail: "sign-out" })
    }
    const route = routePathOf(path, snapshot.appRoot)
    if (route !== null && LOGOUT_ROUTE.test(route)) logout.push({ file: path, line: 1, detail: "logout route" })
    for (const match of codeMatches(text, CLIENT_HOOKS)) clientHooks.push({ file: path, line: match.line, detail: "auth state hook" })
  }
  // One finding per file and kind keeps the brief short; every file is still listed.
  const firstPerFile = (findings: Finding[]): Finding[] => {
    const seen = new Set<string>()
    return sortFindings(findings).filter((finding) => (seen.has(finding.file) ? false : (seen.add(finding.file), true)))
  }
  return { login: firstPerFile(login), logout: firstPerFile(logout), clientHooks: firstPerFile(clientHooks) }
}

/** True when the repo has a login the wizard can join visits to. */
export function hasLogin(auth: AuthDetection): boolean {
  return auth.login.length > 0
}
