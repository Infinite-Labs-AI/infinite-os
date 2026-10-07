/** Our artifacts' activation contract. This does not inspect or grade the owner's consent choices. */
import { isConsentText } from "../jobs/consent-units.js"
import { lexicalStates } from "../lexical-states.js"
import type { WizardContext, WizardDeps } from "../wizard/contracts/deps.js"

export const CONSENT_YES = 'window.dispatchEvent(new CustomEvent("infinite:analytics-consent-change", { detail: { granted: true } }));'
export const CONSENT_NO = 'window.dispatchEvent(new CustomEvent("infinite:analytics-consent-change", { detail: { granted: false } }));'
export const CONSENT_WAITING = "NOT ACTIVE YET (waiting on your banner signal)"
export const CAPTURE_WAITING = "Installed, waiting on your banner signal. Offline check: works when consent is granted; banner integration has not been checked."
export interface ConsentActivation { mode: "required" | "not_required"; infinite: boolean; capture: boolean }

export function recognizedConsentHandling(sources: Readonly<Record<string, string>> = {}): boolean {
  return Object.entries(sources).some(([path, source]) => {
    if (isConsentText(source)) return true
    if (!/\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(path)) return false
    const basename = path.split("/").at(-1)!.replace(/[-_]/g, "")
    if (/^(?:cookie|consent)(?:banner|notice|dialog|modal|manager)\./i.test(basename)) return true
    const states = lexicalStates(source)
    return [...source.matchAll(/\b(?:Cookie|Consent)(?:Banner|Notice|Dialog|Modal|Manager)\b/g)].some(match => states[match.index!] === 0)
  })
}
export function consentHandoff(activation: ConsentActivation): string | null {
  if (activation.mode !== "required" || (!activation.infinite && !activation.capture)) return null
  const subject = activation.infinite && activation.capture ? "Infinite's tag and the ad-click capture stay" : activation.infinite ? "Infinite's tag stays" : "The ad-click capture stays"
  return `${subject} off until your banner tells them the visitor said yes. Add this one line where your banner records a yes (and the matching line for a no):\n\nIn your actual yes/no button handler, immediately after the visitor's click or key press. A background restored-consent callback is not enough; the signal requires a recent user gesture. The wizard does not edit your banner.\n\nYes:\n${CONSENT_YES}\n\nNo or revoke:\n${CONSENT_NO}`
}
export function consentActivationNotes(activation?: ConsentActivation): string[] {
  if (activation?.mode !== "required") return []
  return [activation.infinite ? `Infinite tag: ${CONSENT_WAITING}` : null, activation.capture ? `Meta ad-click capture: ${CONSENT_WAITING}` : null].filter((note): note is string => note !== null)
}
/** These exact wizard summaries survive the existing report wire; no new cloud fields are needed. */
export function consentActivationFromNotes(notes: readonly string[]): ConsentActivation | undefined {
  const infinite = notes.includes(`Infinite tag: ${CONSENT_WAITING}`)
  const capture = notes.includes(`Meta ad-click capture: ${CONSENT_WAITING}`)
  return infinite || capture ? { mode: "required", infinite, capture } : undefined
}

/** Read our installation metadata only. Neither a banner's implementation nor its choices are evaluated. */
export async function consentActivationFor(ctx: WizardContext, deps: Pick<WizardDeps, "fs">): Promise<ConsentActivation | undefined> {
  const mode = ctx.state.get().plan?.answers.consentMode
  if (mode !== "required" && mode !== "not_required") return undefined
  const raw = await deps.fs.readText(`${ctx.root}/.infinite/install.json`)
  if (!raw) return undefined
  const receipt = JSON.parse(raw) as { ids?: { infinite?: { siteSourceKey?: string }; meta?: string[] }; managedCapture?: { mode?: string; module?: string } }
  return { mode, infinite: typeof receipt.ids?.infinite?.siteSourceKey === "string", capture: typeof receipt.managedCapture?.module === "string" || (Array.isArray(receipt.ids?.meta) && receipt.ids.meta.length > 0) }
}
