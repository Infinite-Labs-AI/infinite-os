/** These are the reviewer's explicit labels. The wizard does not reinterpret their wording. */
export interface FindingScope {
  category?: string
  severity?: string
}

export const OWNER_INFORMATION_HEADING = "About your consent or privacy pages (yours to decide)"

/** A blocker stays open regardless of its category. */
export function protectedFinding(finding: FindingScope): boolean {
  return finding.severity === "blocker"
}

/** Every non-blocker owner-category finding is shown as information, never sent to a worker. */
export function ownerInformationOnly(finding: FindingScope): boolean {
  return finding.category === "owner_consent_privacy" && !protectedFinding(finding)
}
