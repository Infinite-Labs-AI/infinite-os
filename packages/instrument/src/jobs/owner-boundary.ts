/** Customer-owned policy is outside every installer, worker, reviewer and check. */
export const OWNER_BOUNDARY = "Consent and your privacy policy are yours; this run changed neither."
export const CONSENT_LEFT_FOR_YOU = "Left for you: this file’s consent code is in the way."
export const OWNER_BOUNDARY_INSTRUCTION = "Consent, cookie banners, CMP code, privacy policies and terms pages belong to the site owner. Do not edit, move, wrap, reindent, evaluate, grade or comment on them. If a task cannot be completed without touching them, skip it with: left for you: this file’s consent code is in the way. No exceptions for preview guards or formatting."

/** Conservative path boundary, shared by planning, allowlists and the post-turn fence. */
export function isPolicyPath(path: string): boolean {
  return /(?:^|\/)(?:privacy(?:[-_]?(?:policy|notice))?|terms(?:[-_]?(?:of[-_]?(?:service|use)|conditions))?|cookie[-_]?(?:policy|notice))(?:\.[^/]+|\/|$)/i.test(path.replaceAll("\\", "/"))
}

/** Review prose about this owner-only domain is omitted, never turned into a fix or approval ask. */
export function isOwnerOnlyFinding(input: { item?: string | null; path?: string | null; body: string; suggestedFix?: string | null; suggested_fix?: string | null }): boolean {
  return input.item === "R6" || isPolicyPath(input.path ?? "") || /\bconsent\b|cookie[ -]banner|\bCMP\b|\b(?:OneTrust|Optanon|Cookiebot|CookieConsent|Didomi|UC_UI|usercentrics|klaro|__tcfapi|__uspapi|__gpp|__cmp)\b|privacy[ -](?:policy|notice|page|paragraph|text)|terms[ -](?:of[ -](?:service|use)|page|conditions)/i.test(`${input.body} ${input.suggestedFix ?? input.suggested_fix ?? ""}`)
}
